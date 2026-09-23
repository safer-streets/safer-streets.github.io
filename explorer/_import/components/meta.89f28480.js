// Static config ported 1:1 from prototypes/streamlit-app/utils.py (Force, CrimeType, DEFAULT_FORCE,
// fix_force_name) and main.py's `geographies` dict. None of this varies at runtime, so — like the
// Python app — it never needs a network round trip; only the live query results (months, boundary,
// features, counts) come from Azure.

export const FORCES = [
  "Avon and Somerset",
  "Bedfordshire",
  "Cambridgeshire",
  "Cheshire",
  "City of London",
  "Cleveland",
  "Cumbria",
  "Derbyshire",
  "Devon and Cornwall",
  "Dorset",
  "Durham",
  "Dyfed Powys",
  "Essex",
  "Gloucestershire",
  "Greater Manchester",
  "Gwent",
  "Hampshire",
  "Hertfordshire",
  "Humberside",
  "Kent",
  "Lancashire",
  "Leicestershire",
  "Lincolnshire",
  "Merseyside",
  "Metropolitan",
  "Norfolk",
  "North Wales",
  "North Yorkshire",
  "Northamptonshire",
  "Northumbria",
  "Nottinghamshire",
  "South Wales",
  "South Yorkshire",
  "Staffordshire",
  "Suffolk",
  "Surrey",
  "Sussex",
  "Thames Valley",
  "Warwickshire",
  "West Mercia",
  "West Midlands",
  "West Yorkshire",
  "Wiltshire",
];

export const DEFAULT_FORCE = "West Yorkshire";

const FORCE_NAME_ADJUSTMENTS = {
  Metropolitan: "Metropolitan Police",
  "Devon and Cornwall": "Devon & Cornwall",
  "City of London": "London, City of",
  "Dyfed Powys": "Dyfed-Powys",
};

/** Only use this for the PFA boundary parquet's pfa24nm column, which spells a few forces differently. */
export function fixForceName(force) {
  return FORCE_NAME_ADJUSTMENTS[force] ?? force;
}

export const CRIME_TYPES = [
  "Drugs",
  "Shoplifting",
  "Robbery",
  "Burglary",
  "Criminal damage and arson",
  "Anti-social behaviour",
  "Bicycle theft",
  "Violence and sexual offences",
  "Theft from the person",
  "Other crime",
  "Public order",
  "Vehicle crime",
  "Other theft",
  "Possession of weapons",
];

// key -> { label, spatialUnit, featureTable, countTable, boundaryTable }
// spatialUnit: column in featureTable holding the spatial id (h3 geographies use spatial_id directly)
// featureTable: phase2/transform table used to find the ids within a force (crosswalk for ONS
//   geographies; the geometry+id source itself for H3 geographies)
// countTable: phase2/transform/<countTable>_crime_counts.parquet
// boundaryTable: phase2/extract/<boundaryTable>.parquet holding the actual geometry; null for H3,
//   whose cell geometry is computed from the cell id via h3_cell_to_boundary_wkt
export const GEOGRAPHIES = new Map([
  [
    "msoa",
    {
      label: "Middle layer Super Output Areas (census)",
      spatialUnit: "msoa21cd",
      featureTable: "h3r9_geogs",
      countTable: "msoa21cd",
      boundaryTable: "msoa_2021",
    },
  ],
  [
    "lsoa",
    {
      label: "Lower layer Super Output Areas (census)",
      spatialUnit: "lsoa21cd",
      featureTable: "h3r9_geogs",
      countTable: "lsoa21cd",
      boundaryTable: "lsoa_2021",
    },
  ],
  [
    "oa",
    {
      label: "Output Areas (census)",
      spatialUnit: "oa21cd",
      featureTable: "h3r9_geogs",
      countTable: "oa21cd",
      boundaryTable: "output_areas_2021",
    },
  ],
  ["H3r9", { label: "H3r9", spatialUnit: "spatial_id", featureTable: "h3r9_geogs", countTable: "h3r9", boundaryTable: null }],
  // Not an H3 unit despite the identical `spatial_id` shape: a BEAHIV id decodes to a polygon only
  // through beahiv's own `cell_polygons`, a Python UDF the tooling registers server-side. There is no
  // browser equivalent, so unlike H3 this geography cannot reconstruct its cells from the id and must
  // read them from the `beahiv202` extract, which carries the hex outlines as real geometry.
  // boundaryForceColumn: that extract holds one row per (cell, force), so a cell straddling a force
  // boundary appears once per force it touches — filter on it or straddlers get drawn twice.
  [
    "BEAHIV202",
    {
      label: "BEAHIV202",
      spatialUnit: "spatial_id",
      featureTable: "beahiv202_geogs",
      countTable: "beahiv202",
      boundaryTable: "beahiv202",
      boundaryForceColumn: "pfa24cd",
    },
  ],
]);
