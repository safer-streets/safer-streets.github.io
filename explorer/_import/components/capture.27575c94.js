// The crime-capture computation, ported 1:1 from prototypes/streamlit-app/main.py so the static
// app reproduces the Streamlit prototype's numbers exactly (guarded by the shared parity fixture
// in safer-streets-tooling/tests/fixtures/capture_parity.json).

/**
 * The lookback window: the `lookback` months of `monthsList` ending at `endMonth`.
 * `monthsList` is the sorted, contiguous month range from meta.json.
 */
export function monthsWindow(monthsList, endMonth, lookback) {
  const end = monthsList.indexOf(endMonth);
  if (end === -1) throw new Error(`month ${endMonth} not in months list`);
  return new Set(monthsList.slice(Math.max(0, end - lookback + 1), end + 1));
}

/**
 * Given features [{spatial_id, area_km2}] and counts rows [{spatial_id, month, count}], find the
 * highest-density features whose *exclusive* cumulative area stays under the threshold — the
 * feature that crosses the threshold is included, matching main.py's shift(fill_value=0) cumsum.
 * Features with no counts in the window drop out entirely (the prototype's right-join semantics).
 */
export function computeCapture({ features, counts, monthsList, month, lookback, thresholdKm2 }) {
  const window = monthsWindow(monthsList, month, lookback);
  const area = new Map(features.map((f) => [f.spatial_id, f.area_km2]));

  const sums = new Map();
  for (const row of counts) {
    if (window.has(row.month)) sums.set(row.spatial_id, (sums.get(row.spatial_id) ?? 0) + row.count);
  }

  const ordered = [...sums.entries()]
    .map(([spatial_id, n]) => ({ spatial_id, n, area_km2: area.get(spatial_id), density: n / area.get(spatial_id) }))
    .sort((a, b) => b.density - a.density);

  const captured = [];
  const missed = [];
  let cumArea = 0;
  for (const row of ordered) {
    if (cumArea < thresholdKm2 && row.n > 0) captured.push(row);
    else if (row.n > 0) missed.push(row);
    cumArea += row.area_km2;
  }

  return {
    totalCrimes: [...sums.values()].reduce((a, b) => a + b, 0),
    captured,
    missed,
    capturedCrimes: captured.reduce((a, r) => a + r.n, 0),
    capturedAreaKm2: captured.reduce((a, r) => a + r.area_km2, 0),
  };
}

/** The month slider label, matching the prototype's display_name: "2025-04" or "2024-11 to 2025-04". */
export function monthLabel(monthsList, endMonth, lookback) {
  if (lookback === 1) return endMonth;
  const end = monthsList.indexOf(endMonth);
  return `${monthsList[Math.max(0, end - lookback + 1)]} to ${endMonth}`;
}
