/**
 * Deterministic, self-contained builder for a compact File Geodatabase
 * (`.gdb.zip`) fixture, authored entirely in-process with the installed
 * gdal3.js OpenFileGDB writer.
 *
 * It reuses the exact driver/flow the server's network exporter uses
 * (`packageNetworkGdbZip` in `server/src/gdb/gdalWorker.mjs`): write each layer
 * as WGS84 GeoJSON, create the `.gdb` with the first layer, `-update -append`
 * every subsequent layer into the same OpenFileGDB directory, then zip the
 * produced files under the `.gdb` root. Because the writer emits the real
 * FileGDB system catalog (`a00000001.gdbtable`/`.gdbtablx`), the archive passes
 * the server's pre-GDAL `validateGdbArchive` and round-trips through GDAL with
 * no external file.
 *
 * The layer set is the smallest that exercises the whole GDB publish path:
 *   - `Station_0_Floor`  polygon → IMDF level  (ordinal 0, floor token `0`)
 *   - `Station_0_Space`  polygon → IMDF unit   (level via `floor_id` reference)
 *   - `net_junction`     point   → routing nodes (NODEID / FLOOR)
 *   - `net_path`         line    → routing edges (FNODEID / TNODEID / cost …)
 *   - `Facility_Merge`   point   → point-facility layer (NAME / FLOOR / CATEGORY)
 *
 * The venue level ordinal (0, from the `_0_` floor token) matches the network
 * node ordinal (`floor_to_ordinal("F1") === 0`), so imported nodes land on the
 * imported level and the compiled bundle carries a non-empty §5 graph.
 *
 * It lives in the server workspace (not repo-root `tests/fixtures/`) because it
 * imports the server's gdal3.js worker; the server tsconfig already carries
 * gdal3.js and the server libs, and the web program never compiles it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { getGdal } from "../../src/gdb/gdalWorker.mjs";

/**
 * The minimal surface of the untyped gdal3.js instance this builder drives.
 * `getGdal()` lives in a plain-ESM worker module with no type declarations, so
 * the returned instance is narrowed here to exactly the four calls used.
 */
interface GdalHandle {
  open(path: string): Promise<{ datasets: unknown[] }>;
  ogr2ogr(
    dataset: unknown,
    args: readonly string[],
    outputName: string,
  ): Promise<{ all?: Array<{ local?: unknown }> }>;
  close(dataset: unknown): Promise<unknown>;
  getFileBytes(ref: { local: string }): Promise<Uint8Array>;
}

/** The `.gdb` directory name gdal3.js produces from the `"net"` output stem. */
const GDB_ROOT = "net.gdb";

/** Source id of the single level; the unit's `floor_id` references it. */
export const GDB_LEVEL_SOURCE_ID = "b1000001-0000-4000-8000-0000000000b1";
/** Source id of the single unit. */
export const GDB_UNIT_SOURCE_ID = "b2000002-0000-4000-8000-0000000000b2";

interface LayerSpec {
  name: string;
  featureCollection: GeoJSON.FeatureCollection;
}

// The forward edge polyline; the reverse feature is its exact reverse so the
// two directed `net_path` features form one reciprocal (undirected) edge.
const EDGE_FORWARD: [number, number][] = [
  [139.767, 35.681],
  [139.768, 35.681],
];

/**
 * The fixed layer set, in the order they are written into the OpenFileGDB.
 * Geometry is small, finite WGS84 around Tokyo Station. Field names use the
 * exact case the case-sensitive Rust graph builder reads (`NODEID`, `FLOOR`,
 * `FNODEID`, `TNODEID`, `cost`, `PATHID`, `RPATHID`).
 */
const LAYER_SPECS: readonly LayerSpec[] = [
  {
    name: "Station_0_Floor",
    featureCollection: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { id: GDB_LEVEL_SOURCE_ID, name: "1F" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [139.7665, 35.6805],
                [139.7685, 35.6805],
                [139.7685, 35.6815],
                [139.7665, 35.6815],
                [139.7665, 35.6805],
              ],
            ],
          },
        },
      ],
    },
  },
  {
    name: "Station_0_Space",
    featureCollection: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            id: GDB_UNIT_SOURCE_ID,
            category: "walkway",
            floor_id: GDB_LEVEL_SOURCE_ID,
          },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [139.7668, 35.6808],
                [139.7682, 35.6808],
                [139.7682, 35.6813],
                [139.7668, 35.6813],
                [139.7668, 35.6808],
              ],
            ],
          },
        },
      ],
    },
  },
  {
    name: "net_junction",
    featureCollection: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { NODEID: 1, FLOOR: "F1" },
          geometry: { type: "Point", coordinates: [139.767, 35.681] },
        },
        {
          type: "Feature",
          properties: { NODEID: 2, FLOOR: "F1" },
          geometry: { type: "Point", coordinates: [139.768, 35.681] },
        },
      ],
    },
  },
  {
    name: "net_path",
    featureCollection: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { FNODEID: 1, TNODEID: 2, cost: 90000, PATHID: 1, RPATHID: 2, FLOOR: "F1" },
          geometry: { type: "LineString", coordinates: EDGE_FORWARD },
        },
        {
          type: "Feature",
          properties: { FNODEID: 2, TNODEID: 1, cost: 90000, PATHID: 2, RPATHID: 1, FLOOR: "F1" },
          geometry: { type: "LineString", coordinates: [...EDGE_FORWARD].reverse() },
        },
      ],
    },
  },
  {
    name: "Facility_Merge",
    featureCollection: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { NAME: "Info", FLOOR: "F1", CATEGORY: "information" },
          geometry: { type: "Point", coordinates: [139.7675, 35.6811] },
        },
      ],
    },
  },
];

/** Zip entry path for a gdal3.js output file at `.../net.gdb/<name>`. */
function gdbEntryPath(local: string): string {
  const marker = `/${GDB_ROOT}/`;
  const idx = local.indexOf(marker);
  return idx >= 0
    ? `${GDB_ROOT}/${local.slice(idx + marker.length)}`
    : `${GDB_ROOT}/${basename(local)}`;
}

/**
 * Build the compact `.gdb.zip` fixture as a Buffer. Deterministic: identical
 * layer geometry/fields in, byte-stable OpenFileGDB out (gdal3.js does not
 * stamp wall-clock times into the catalog tables it writes here).
 */
export async function buildMinimalGdbZip(): Promise<Buffer> {
  // gdal3.js is untyped JS; narrow the shared instance to the surface used.
  const gdal = (await getGdal()) as GdalHandle;
  const dir = mkdtempSync(join(tmpdir(), "kiriko-gdbfixture-"));
  try {
    let output: { all?: Array<{ local?: unknown }> } | undefined;
    for (let i = 0; i < LAYER_SPECS.length; i += 1) {
      const spec = LAYER_SPECS[i]!;
      const geojsonPath = join(dir, `${spec.name}.geojson`);
      writeFileSync(geojsonPath, JSON.stringify(spec.featureCollection));

      const opened = await gdal.open(geojsonPath);
      const dataset = opened.datasets[0];
      if (dataset === undefined) {
        throw new Error(`gdal returned no dataset for layer ${spec.name}`);
      }
      try {
        // First layer creates the `.gdb`; every later layer appends into it.
        const args =
          i === 0
            ? ["-f", "OpenFileGDB", "-nln", spec.name, "-t_srs", "EPSG:4326"]
            : ["-f", "OpenFileGDB", "-update", "-append", "-nln", spec.name, "-t_srs", "EPSG:4326"];
        output = await gdal.ogr2ogr(dataset, args, "net");
      } finally {
        await gdal.close(dataset).catch(() => undefined);
      }
    }

    const files = (output?.all ?? [])
      .map((entry) => entry?.local)
      .filter((local): local is string => typeof local === "string" && local.length > 0);
    if (files.length === 0) {
      throw new Error("gdal produced no File Geodatabase output files.");
    }

    const writer = new ZipWriter(new Uint8ArrayWriter());
    const seen = new Set<string>();
    for (const local of files) {
      const entry = gdbEntryPath(local);
      if (seen.has(entry)) continue;
      seen.add(entry);
      const bytes = await gdal.getFileBytes({ local });
      await writer.add(entry, new Uint8ArrayReader(bytes));
    }
    return Buffer.from(await writer.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
