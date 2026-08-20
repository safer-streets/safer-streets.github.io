// MapLibre basemap + deck.gl overlay, replicating the pydeck layer styling of
// prototypes/streamlit-app/main.py exactly (colors, opacity scaling, stroke widths, tooltip,
// pitch) so the two apps are visually interchangeable.
//
// Palette note (dataviz skill): captured #C9F100 / missed #003FF5 / boundary #C04040 validate with
// CVD ΔE ≥ 29 on every adjacent pair; the low fill-vs-basemap contrast is relieved by the 3px
// strokes, per-feature tooltips and the hotspot table, and per-feature opacity is a single-hue
// alpha ramp (sequential by magnitude).

import { MapLibreMap, NavigationControl, setWorkerUrl } from "../../_npm/maplibre-gl@6.4.1/78628c50.js";
import { MapboxOverlay } from "../../_npm/@deck.gl/mapbox@9.3.10/d76e8440.js";
import { GeoJsonLayer } from "../../_npm/@deck.gl/layers@9.3.10/4ed8ee3f.js";

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

function featuresWithCounts(geo, rows, opacityScale) {
  const maxN = Math.max(...rows.map((r) => r.n));
  return rows
    .filter((row) => geo.byId.has(row.spatial_id))
    .map((row) => {
      const feature = geo.byId.get(row.spatial_id);
      return {
        ...feature,
        properties: {
          ...feature.properties,
          n_crimes: row.n,
          opacity: Math.round((opacityScale * row.n) / maxN),
        },
      };
    });
}

/** The three GeoJsonLayers of main.py: boundary stroke, captured (yellow), missed (blue). */
export function buildLayers({ boundary, geo, captured, missed, showMissed }) {
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
        id: "missed",
        data: { type: "FeatureCollection", features: featuresWithCounts(geo, missed, 96) },
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
      id: "captured",
      data: { type: "FeatureCollection", features: featuresWithCounts(geo, captured, 192) },
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
