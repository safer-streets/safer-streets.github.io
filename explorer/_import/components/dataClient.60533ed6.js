// Live client-side queries against Azure Blob Storage, replacing the old build-time static export.
// The browser talks to Azure directly on every interaction — no server, but also no pre-aggregation
// step: this runs (almost) the same SQL as prototypes/streamlit-app's database.py/main.py, just from
// duckdb-wasm instead of native DuckDB, over https + per-blob SAS tokens instead of the az://
// protocol (which has no wasm build — see the account's storage account docs / assessment notes).
//
// Auth: a same-origin `azure-sas.json` manifest maps each blob path this app needs to a short-lived,
// read-only, single-blob SAS query string. It's minted by CI (publish-explorer.yml) from the same
// connection string safer-streets-tooling already uses server-side, scoped to only the ~16 blobs
// below — never the whole `phase2` container, which also holds licensed datasets (buildings, land
// cover) this app doesn't use and mustn't expose. For local dev, `scripts/generate-sas-manifest.mjs`
// mints the same shape of file using the same connection string, kept out of git.

import { AsyncDuckDB, ConsoleLogger, LogLevel, getJsDelivrBundles, selectBundle } from "../../_npm/@duckdb/duckdb-wasm@1.29.0/d167315f.js";

const STORAGE_ACCOUNT = "saferstreets";
const cache = new Map();

async function cached(key, load) {
  if (!cache.has(key)) cache.set(key, load().catch((e) => (cache.delete(key), Promise.reject(e))));
  return cache.get(key);
}

// Mirrors the old dataBase() resolution: `data/` in production, `_file/data/` under `observable
// preview`. The manifest is the only same-origin asset left; everything else is a live Azure query.
let manifestPromise;
function loadManifest() {
  manifestPromise ??= (async () => {
    for (const candidate of ["data/azure-sas.json", "_file/data/azure-sas.json"]) {
      const url = new URL(candidate, document.baseURI).href;
      const response = await fetch(url);
      if (response.ok) return response.json();
    }
    throw new Error(
      "azure-sas.json not found (looked in data/ and _file/data/) — run scripts/generate-sas-manifest.mjs first"
    );
  })();
  return manifestPromise;
}

async function blobUrl(path) {
  const manifest = await loadManifest();
  const sas = manifest.blobs[path];
  if (!sas) throw new Error(`no SAS token in azure-sas.json for ${path}`);
  return `https://${manifest.account ?? STORAGE_ACCOUNT}.blob.core.windows.net/${path}?${sas}`;
}

let dbPromise;
export function getConnection() {
  // matches cached()'s retry-on-failure behaviour below: a rejected init must not get stuck cached
  // forever, or every later call would silently replay the same stale failure.
  dbPromise ??= (async () => {
    const bundle = await selectBundle(getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
    const worker = new Worker(workerUrl);
    const db = new AsyncDuckDB(new ConsoleLogger(LogLevel.WARNING), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    const conn = await db.connect();
    await conn.query(`INSTALL spatial; LOAD spatial; INSTALL h3 FROM community; LOAD h3;`);
    return conn;
  })().catch((e) => {
    dbPromise = undefined;
    throw e;
  });
  return dbPromise;
}

// duckdb-wasm surfaces a failed remote read (wrong URL, expired/invalid SAS token, CORS not
// configured on the storage account) as a raw WebAssembly.Exception with no usable .message — it
// prints the real reason (e.g. "403" from Azure) to the console via its own logger, but that detail
// never reaches the JS Error a caller can catch, so it renders as the unhelpful
// "Invalid Error: [object WebAssembly.Exception]". Since we can't recover the real reason here, at
// least replace it with an actionable one covering the actual common causes.
function explainQueryFailure(e) {
  const message = typeof e?.message === "string" ? e.message : String(e);
  if (message.includes("WebAssembly.Exception") || message.includes("HEAD and GET requests failed")) {
    return new Error(
      "Azure query failed (see the browser console just above this for duckdb-wasm's own log line with " +
        "the real HTTP status). Most likely causes: the SAS manifest has expired — regenerate it with " +
        "`npm run sas` (local dev tokens default to a 4-hour expiry) — or CORS isn't configured on the " +
        "storage account for this origin (see the README's CORS section)."
    );
  }
  return e;
}

async function run(conn, sql, ...params) {
  // conn.prepare() itself resolves the file schema to bind the statement — with read_parquet()
  // inline in the SQL, that's already a remote fetch, so a bad SAS token or missing CORS can throw
  // here too, not just from stmt.query() below.
  let stmt;
  try {
    stmt = await conn.prepare(sql);
    return await stmt.query(...params);
  } catch (e) {
    throw explainQueryFailure(e);
  } finally {
    await stmt?.close();
  }
}

const toGeoFeature = (row) => ({
  type: "Feature",
  geometry: JSON.parse(row.geojson),
  properties: { spatial_id: row.spatial_id, area_km2: row.area_km2 },
});

/** All months present in the crime data, ascending — mirrors main.py's all_months(). */
export async function fetchMonths(conn) {
  return cached("months", async () => {
    const url = await blobUrl("phase2/extract/crime_data.parquet");
    try {
      const table = await conn.query(`SELECT DISTINCT _month FROM read_parquet('${url}') ORDER BY _month`);
      return table.toArray().map((r) => r._month);
    } catch (e) {
      throw explainQueryFailure(e);
    }
  });
}

/**
 * The selected force's boundary, centroid and area — mirrors main.py's get_boundary(), but folds in
 * the centroid/area fields the old static meta.json used to carry per-force, since they're right
 * there in the same source row (police_force_areas.parquet already has lat/long columns).
 */
export async function fetchForceBoundary(conn, force, fixForceName) {
  return cached(`boundary/${force}`, async () => {
    const url = await blobUrl("phase2/extract/police_force_areas.parquet");
    const table = await run(
      conn,
      `SELECT spatial_id AS pfa23cd, long, lat, ST_Area(geom) / 1000000 AS area_km2,
              ST_AsGeoJSON(ST_Transform(geom, 'EPSG:27700', 'EPSG:4326', always_xy := true)) AS geojson
       FROM read_parquet('${url}') WHERE pfa23nm = ?`,
      fixForceName(force)
    );
    const row = table.toArray()[0];
    if (!row) throw new Error(`no PFA boundary found for force ${force}`);
    return {
      pfa23cd: row.pfa23cd,
      name: force,
      centroid: [row.long, row.lat],
      areaKm2: row.area_km2,
      geojson: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: JSON.parse(row.geojson), properties: { spatial_id: row.pfa23cd, name: force } }],
      },
    };
  });
}

/**
 * Feature geometries + areas for one force x geography — mirrors the feature half of main.py's
 * get_counts_and_features(). H3 geographies compute their own cell boundary; ONS geographies look up
 * the ids present in the force via the h3_8_geogs crosswalk, then join into the real boundary table.
 */
export async function fetchGeo(conn, pfa23cd, geographyKey, geog) {
  return cached(`geo/${pfa23cd}/${geographyKey}`, async () => {
    const featureUrl = await blobUrl(`phase2/transform/${geog.featureTable}.parquet`);
    let table;
    if (geog.boundaryTable === null) {
      table = await run(
        conn,
        `SELECT spatial_id, cell_area / 1000000 AS area_km2,
                ST_AsGeoJSON(ST_GeomFromText(h3_cell_to_boundary_wkt(spatial_id))) AS geojson
         FROM read_parquet('${featureUrl}') WHERE pfa23cd = ?`,
        pfa23cd
      );
    } else {
      const boundaryUrl = await blobUrl(`phase2/extract/${geog.boundaryTable}.parquet`);
      table = await run(
        conn,
        `WITH ids AS (
           SELECT DISTINCT ${geog.spatialUnit} AS spatial_id FROM read_parquet('${featureUrl}') WHERE pfa23cd = ?
         )
         SELECT b.spatial_id, ST_Area(b.geom) / 1000000 AS area_km2,
                ST_AsGeoJSON(ST_Transform(b.geom, 'EPSG:27700', 'EPSG:4326', always_xy := true)) AS geojson
         FROM read_parquet('${boundaryUrl}') AS b
         WHERE b.spatial_id IN (SELECT spatial_id FROM ids)`,
        pfa23cd
      );
    }
    const features = table.toArray().map(toGeoFeature);
    return { features, byId: new Map(features.map((f) => [f.properties.spatial_id, f])) };
  });
}

/**
 * Counts rows [{spatial_id, month, count}] for one force x geography x crime type, all months —
 * mirrors the counts half of get_counts_and_features(), minus its month filter (kept here so
 * capture.js's existing client-side month-window logic — already parity-tested against main.py —
 * doesn't need to change, and moving the month/lookback sliders never needs a new Azure round trip).
 */
export async function fetchCounts(conn, pfa23cd, geographyKey, geog, crimeType) {
  const key = `counts/${pfa23cd}/${geographyKey}/${crimeType}`;
  return cached(key, async () => {
    const countsUrl = await blobUrl(`phase2/transform/crime_counts_${geog.countTable}.parquet`);
    const featureUrl = await blobUrl(`phase2/transform/${geog.featureTable}.parquet`);
    const idsSubquery =
      geog.boundaryTable === null
        ? `SELECT spatial_id FROM read_parquet('${featureUrl}') WHERE pfa23cd = ?`
        : `SELECT DISTINCT ${geog.spatialUnit} FROM read_parquet('${featureUrl}') WHERE pfa23cd = ?`;
    const table = await run(
      conn,
      `SELECT spatial_id, month, count::INT AS count
       FROM read_parquet('${countsUrl}')
       WHERE crime_type = ? AND spatial_id IN (${idsSubquery})`,
      crimeType,
      pfa23cd
    );
    return table.toArray().map((row) => ({ ...row }));
  });
}
