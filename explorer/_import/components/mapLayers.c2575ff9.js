// MapLibre basemap + deck.gl overlay, replicating the pydeck layer styling of
// prototypes/streamlit-app/main.py exactly (colors, opacity scaling, stroke widths, tooltip,
// pitch) so the two apps are visually interchangeable.
//
// Palette note (dataviz skill): captured #C9F100 / missed #003FF5 / boundary #C04040 validate with
// CVD ΔE ≥ 29 on every adjacent pair; the low fill-vs-basemap contrast is relieved by the 3px
// strokes, per-feature tooltips and the hotspot table, and per-feature opacity is a single-hue
// alpha ramp (sequential by magnitude).

import { MapLibreMap, NavigationControl, setWorkerUrl } from "../../_npm/maplibre-gl@6.11.1/bc1eb40c.js";
import { MapboxOverlay } from "../../_npm/@deck.gl/mapbox@9.4.0/0793edb6.js";
import { GeoJsonLayer } from "../../_npm/@deck.gl/layers@9.4.0/cb2425d8.js";

const BASEMAP = {
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};

// MapLibre v6's bundle resolves its worker script against a hardcoded root-relative
// "/npm/maplibre-gl@<version>/dist/..." path (a jsDelivr/unpkg CDN layout assumption), but
// Observable Framework serves proxied npm packages under "/_npm/...", so the worker 404s and
// vector tiles silently never render. Rebase it from the maplibre-gl stylesheet link's already
// Framework-rewritten href instead of hardcoding a version.
function fixWorkerUrl() {
  const cssHref = document.querySelector('link[href*="/maplibre-gl@"][href$=".css"]')?.href;
  if (cssHref) setWorkerUrl(new URL("maplibre-gl-worker.mjs", cssHref).href);
}

export function createMap(container, { center, zoom = 9, pitch = 30, dark = false }) {
  fixWorkerUrl();
  const map = new MapLibreMap({
    container,
    style: BASEMAP[dark ? "dark" : "light"],
    center,
    zoom,
    pitch,
    attributionControl: { compact: true },
  });
  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(overlay);
  map.addControl(new NavigationControl(), "top-right");
  return {
    map,
    overlay,
    destroy() {
      overlay.finalize();
      map.remove();
    },
  };
}

// Properties are rebuilt explicitly rather than spread from the source feature: deck.gl serialises
// every property of every feature into the layer, so anything carried here is paid for per feature
// across a whole force. These three are the complete set the layers read — spatial_id and n_crimes
// for the tooltip, opacity for getFillColor. area_km2 deliberately does not come along: capture.js
// reads it straight off geo.features, upstream of any layer.
// maxN is passed in rather than derived per layer: captured and missed have to share one scale or
// their alphas mean different things. Normalised separately, the missed layer divides by its own
// (always smaller) maximum, which inflates it — one month of West Yorkshire burglary gives captured
// maxN=7 against missed maxN=2, so a missed cell holding a single crime rendered at alpha 48 where a
// captured cell holding two rendered at 55. On the Metropolitan force it inverted outright: one
// crime scored 32 as missed but only 21 as captured, so the layer meaning "this is a hotspot" came
// out fainter than the layer meaning the opposite. It moves with force, crime type, month and
// lookback, so it reads as erratic rather than as a fixed bias. 192 vs 96 remains the captured/missed
// distinction and is now the only difference between them.
function featuresWithCounts(geo, rows, opacityScale, maxN) {
  return rows
    .filter((row) => geo.byId.has(row.spatial_id))
    .map((row) => ({
      type: "Feature",
      geometry: geo.byId.get(row.spatial_id).geometry,
      properties: {
        spatial_id: row.spatial_id,
        n_crimes: row.n,
        opacity: Math.round((opacityScale * row.n) / maxN),
      },
    }));
}

/**
 * The three GeoJsonLayers of main.py: boundary stroke, captured (yellow), missed (blue).
 *
 * The fill layers MUST carry layerKey in their ids. deck.gl reconciles layers by id, so a constant
 * id made every change re-feed a different-length feature array into the same layer, leaving its
 * SolidPolygonLayer to resize the tessellated position and index buffers in place. Stale vertices
 * left in those buffers got indexed into triangles spanning unrelated cells — long translucent
 * slivers fanning across the force, while the strokes stayed correct. Varying the key retires the
 * layer instead of resizing it.
 *
 * Only the grid geographies showed it, because their feature counts swing by thousands between
 * selections where MSOA moves by a handful. That made it look like a geometry problem, and it is
 * worth recording that it isn't: the source geometry is clean (7552 BEAHIV cells for West Yorkshire,
 * every one a closed single-ring hexagon of 7 points, uniform 0.106 km², all rings CCW, all
 * positions 2D), and GeoJsonLayer hands that same array to its PathLayer, whose strokes always drew
 * correctly. Winding, coordinate precision and ring orientation were each investigated and cleared.
 *
 * The boundary keeps a fixed id: one polygon, and it is stroked, never filled.
 */
export function buildLayers({ boundary, geo, captured, missed, showMissed, layerKey = "" }) {
  // One scale across both fill layers. Floored at 1 so an empty or all-zero set gives alpha 0 rather
  // than the NaN a -Infinity (Math.max of nothing) or a divide by zero would put in the buffer.
  // reduce, not Math.max(...rows): the spread passes one argument per cell and a force carries >12k.
  const maxN = Math.max(
    1,
    captured.reduce((a, r) => (r.n > a ? r.n : a), 0),
    missed.reduce((a, r) => (r.n > a ? r.n : a), 0)
  );
  const layers = [
    new GeoJsonLayer({
      id: "boundary",
      data: boundary,
      opacity: 0.5,
      stroked: true,
      filled: false,
      pickable: true,
      lineWidthMinPixels: 3,
      getLineColor: [192, 64, 64, 255],
    }),
  ];
  if (showMissed) {
    layers.push(
      new GeoJsonLayer({
        id: `missed-${layerKey}`,
        data: { type: "FeatureCollection", features: featuresWithCounts(geo, missed, 96, maxN) },
        stroked: true,
        filled: true,
        getFillColor: (f) => [0, 63, 245, f.properties.opacity],
        getLineColor: [0x00, 0x39, 0xf5, 0x50],
        lineWidthMinPixels: 3,
        pickable: true,
      })
    );
  }
  layers.push(
    new GeoJsonLayer({
      id: `captured-${layerKey}`,
      data: { type: "FeatureCollection", features: featuresWithCounts(geo, captured, 192, maxN) },
      stroked: true,
      filled: true,
      getFillColor: (f) => [201, 241, 0, f.properties.opacity],
      getLineColor: [0xc9, 0xf1, 0x00, 0xa0],
      lineWidthMinPixels: 3,
      pickable: true,
    })
  );
  return layers;
}

export function updateLayers(ctx, layers, { totalCrimes }) {
  ctx.overlay.setProps({
    layers,
    getTooltip: ({ object }) => {
      if (!object) return null;
      const props = object.properties ?? {};
      const id = props.spatial_id ?? "";
      const n = props.n_crimes ?? totalCrimes; // the force outline reports the force-wide total
      return { html: `<b>${id}</b><br/>crimes: ${n}` };
    },
  });
}
