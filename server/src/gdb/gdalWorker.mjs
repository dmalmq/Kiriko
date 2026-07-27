/**
 * Real GDAL worker: the single, shared implementation of every GDAL-touching
 * operation, run inside a dedicated `node:worker_threads` thread so the parent
 * queue (`gdalProcess.ts`) can terminate a runaway/timed-out call by killing
 * the whole thread — the only way to reclaim gdal3.js's in-process
 * Emscripten/WASM runtime.
 *
 * This file is plain ESM on purpose: a worker thread must load without any TS
 * transpile step, so it imports no `.ts`. It owns its own lazy gdal3.js
 * instance (`getGdal`) and exports `runGdalRequest(request, gdal)` — the same
 * body the worker runs — so tests can drive the identical logic in-process
 * against a fake gdal instance instead of spawning the real thread.
 *
 * Lifecycle: read the request from `workerData`, dispatch by `request.op`,
 * post one `{ ok, result | error }` message (zip bytes transferred), then exit
 * so the parent's `exit` event fires and it can safely delete the staged file.
 */
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parentPort, workerData } from "node:worker_threads";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

const require = createRequire(import.meta.url);

/**
 * Cap on total WGS84 GeoJSON bytes generated per operation. Mirrors
 * `GDB_MAX_GENERATED_BYTES` in sourceValidation.ts (kept in sync manually
 * because this plain-ESM worker cannot import the TS module).
 */
const GDB_MAX_GENERATED_BYTES = 1_000 * 1024 * 1024;

/** The `.gdb` root directory name inside a produced network export archive. */
const EXPORT_GDB_ROOT = "net.gdb";

const NETWORK_JUNCTION_LAYER = "net_junction";
const NETWORK_PATH_LAYER = "net_path";
const NETWORK_LAYERS = [NETWORK_JUNCTION_LAYER, NETWORK_PATH_LAYER];
const FACILITY_LAYER = "Facility_Merge";

/**
 * A structured, cross-thread source error. `name === "GdbSourceError"` lets the
 * parent queue rebuild a real `GdbSourceError` with the same `code`/`details`.
 */
function sourceError(code, message, details) {
  const error = new Error(message);
  error.name = "GdbSourceError";
  error.code = code;
  if (details) error.details = details;
  return error;
}

// --- Value narrowing at the gdal3.js boundary (plain JS objects). ---

function asRecord(value) {
  return value && typeof value === "object" ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Resolve the gdal3.js dist package directory. `require.resolve` follows
 * pnpm's symlinks to the real `.pnpm/gdal3.js@<ver>/...` location, so the
 * WASM/data assets always come from the actually-installed package.
 */
function resolveGdalDistPackage() {
  const entry = require.resolve("gdal3.js/node");
  const wasm = require.resolve("gdal3.js/dist/package/gdal3WebAssembly.wasm", {
    paths: [dirname(entry)],
  });
  return dirname(wasm);
}

let cachedGdal = null;

/** Lazily initialize the one gdal3.js instance for this worker thread. */
export function getGdal() {
  if (cachedGdal) return cachedGdal;
  cachedGdal = (async () => {
    const loaded = require("gdal3.js/node");
    const init = typeof loaded === "function" ? loaded : loaded?.default;
    if (typeof init !== "function") {
      throw new Error("gdal3.js initializer not found in `gdal3.js/node`.");
    }
    const distPkg = resolveGdalDistPackage();
    return init({
      path: relative(process.cwd(), distPkg),
      useWorker: false,
      logHandler: () => {},
      errorHandler: () => {},
    });
  })();
  return cachedGdal;
}

/** Open the staged `.gdb.zip` via GDAL's `/vsizip/` virtual filesystem. */
async function openGdbZip(gdal, path) {
  try {
    const opened = await gdal.open(path, [], ["vsizip"]);
    const datasets = asArray(asRecord(opened).datasets);
    if (datasets[0] !== undefined) return datasets[0];
  } catch {
    /* fall through to explicit /vsizip/ form */
  }
  const opened = await gdal.open(`/vsizip/${path}`);
  const datasets = asArray(asRecord(opened).datasets);
  if (datasets[0] === undefined) {
    throw new Error("GDAL returned no datasets from the uploaded archive.");
  }
  return datasets[0];
}

async function openGeoJson(gdal, path) {
  const opened = asRecord(await gdal.open(path));
  const dataset = asArray(opened.datasets)[0];
  if (dataset === undefined) {
    throw new Error(`GDAL returned no dataset from ${basename(path)}.`);
  }
  return dataset;
}

function classifyGeometry(layer) {
  const families = new Set();
  for (const field of asArray(layer.geometryFields)) {
    const type = asString(asRecord(field).type).toLowerCase();
    if (type.includes("point")) families.add("point");
    else if (type.includes("line")) families.add("line");
    else if (type.includes("polygon")) families.add("polygon");
  }
  if (families.size === 0) {
    const type = asString(layer.geometry).toLowerCase();
    if (type.includes("point")) families.add("point");
    else if (type.includes("line")) families.add("line");
    else if (type.includes("polygon")) families.add("polygon");
  }
  if (families.size === 0) return "none";
  if (families.size === 1) return [...families][0];
  return "mixed";
}

function hasFiniteCoordinatePair(value) {
  if (!Array.isArray(value)) return false;
  if (typeof value[0] === "number") {
    const lon = value[0];
    const lat = value[1];
    return typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat);
  }
  for (const nested of value) {
    if (hasFiniteCoordinatePair(nested)) return true;
  }
  return false;
}

function geometryHasFiniteCoordinates(geometry) {
  const record = asRecord(geometry);
  const type = asString(record.type);
  if (!type) return false;
  if (type === "GeometryCollection") {
    for (const nested of asArray(record.geometries)) {
      if (geometryHasFiniteCoordinates(nested)) return true;
    }
    return false;
  }
  return hasFiniteCoordinatePair(record.coordinates);
}

function hasGeometry(feature) {
  return geometryHasFiniteCoordinates(asRecord(feature).geometry);
}

/** Sanitize an output layer name into a safe GDAL output stem. */
function sanitizeOutputName(layerName) {
  const sanitized = String(layerName || "")
    .replace(/[\\/:*?"<>|\0]/g, "_")
    .trim()
    .replace(/\.+$/g, "")
    .slice(0, 80);
  return sanitized || "layer";
}

/** Convert one OGR layer to WGS84 RFC7946 GeoJSON text via `ogr2ogr`. */
async function extractLayerGeoJson(gdal, dataset, layerName, outputName) {
  const output = await gdal.ogr2ogr(
    dataset,
    [
      "-f", "GeoJSON",
      "-t_srs", "EPSG:4326",
      "-lco", "RFC7946=YES",
      "-nlt", "CONVERT_TO_LINEAR",
      "-dim", "XY",
      layerName,
    ],
    outputName,
  );
  const bytes = await gdal.getFileBytes(output);
  return new TextDecoder().decode(bytes);
}

/** Read a feature's floor label case-insensitively (FLOOR or floor). */
function floorLabel(properties) {
  for (const [key, value] of Object.entries(properties)) {
    if (key.toLowerCase() === "floor") return value;
  }
  return undefined;
}

/** Count features and collect distinct floor values from a converted layer. */
function summarizeLayer(geojson, layerName) {
  let parsed;
  try {
    parsed = JSON.parse(geojson);
  } catch {
    throw new Error(`Layer "${layerName}" did not convert to GeoJSON.`);
  }
  const record = asRecord(parsed);
  if (asString(record.type) !== "FeatureCollection") {
    throw new Error(`Layer "${layerName}" did not convert to a FeatureCollection.`);
  }
  const features = asArray(record.features);
  const floors = [];
  for (const feature of features) {
    const floor = floorLabel(asRecord(asRecord(feature).properties));
    if (typeof floor === "string" && floor.trim().length > 0) {
      floors.push(floor);
    }
  }
  return { featureCount: features.length, floors };
}

/** Zip entry path for a gdal3.js output file at `.../net.gdb/<name>`. */
function gdbEntryPath(local) {
  const marker = `/${EXPORT_GDB_ROOT}/`;
  const idx = local.indexOf(marker);
  return idx >= 0
    ? `${EXPORT_GDB_ROOT}/${local.slice(idx + marker.length)}`
    : `${EXPORT_GDB_ROOT}/${basename(local)}`;
}

// --- Operation bodies (previously the `*Unlocked` functions). ---

async function inspectGdbArchive(gdal, path, sourceName) {
  const dataset = await openGdbZip(gdal, path);
  try {
    const infoRecord = asRecord(await gdal.ogrinfo(dataset, ["-so", "-al"]));
    const ogrLayers = asArray(infoRecord.layers).map(asRecord);
    if (ogrLayers.length === 0) {
      throw new Error("GDAL returned no layers from the uploaded archive.");
    }

    const layers = [];
    for (const layer of ogrLayers) {
      const layerName = asString(layer.name);
      if (!layerName) continue;
      const fields = asArray(layer.fields).map((field) => {
        const record = asRecord(field);
        return { name: asString(record.name), type: asString(record.type) };
      });
      layers.push({
        key: { databaseId: "gdb-1", layerName },
        databaseName: sourceName,
        featureCount: asNumber(layer.featureCount),
        geometryFamily: classifyGeometry(layer),
        fields,
      });
    }

    if (layers.length === 0) {
      throw new Error("GDAL returned no named layers from the uploaded archive.");
    }

    return {
      sourceName,
      databases: [{ id: "gdb-1", name: sourceName }],
      layers,
      warnings: [],
    };
  } finally {
    try {
      await gdal.close(dataset);
    } catch {
      /* Best-effort close. */
    }
  }
}

async function convertGdbLayers(gdal, path, selectedLayerNames) {
  if (selectedLayerNames.length === 0) {
    return { layers: [], warnings: [] };
  }

  const dataset = await openGdbZip(gdal, path);
  const layers = [];
  const warnings = [];
  let generatedBytes = 0;

  try {
    for (let i = 0; i < selectedLayerNames.length; i += 1) {
      const layerName = selectedLayerNames[i];
      const outputName = `gdb_gdb-1_${i}_${sanitizeOutputName(layerName)}`;

      const output = await gdal.ogr2ogr(
        dataset,
        [
          "-f", "GeoJSON",
          "-t_srs", "EPSG:4326",
          "-lco", "RFC7946=YES",
          "-nlt", "CONVERT_TO_LINEAR",
          "-dim", "XY",
          layerName,
        ],
        outputName,
      );

      const bytes = await gdal.getFileBytes(output);
      generatedBytes += bytes.byteLength;
      if (generatedBytes > GDB_MAX_GENERATED_BYTES) {
        throw new Error(
          `GDB conversion exceeded the ${GDB_MAX_GENERATED_BYTES}-byte output cap.`,
        );
      }

      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      const record = asRecord(parsed);
      if (asString(record.type) !== "FeatureCollection") {
        throw new Error(`Layer "${layerName}" did not convert to a FeatureCollection.`);
      }
      const features = asArray(record.features);
      const spatial = features.filter(hasGeometry);
      if (spatial.length === 0) {
        throw new Error(`Layer "${layerName}" produced no spatial features.`);
      }
      const skipped = features.length - spatial.length;
      if (skipped > 0) {
        warnings.push(`Layer "${layerName}" skipped ${skipped} feature(s) without geometry.`);
      }
      layers.push({
        key: { databaseId: "gdb-1", layerName },
        featureCollection: { type: "FeatureCollection", features: spatial },
        skippedGeometryCount: skipped,
      });
    }
  } finally {
    try {
      await gdal.close(dataset);
    } catch {
      /* Best-effort close. */
    }
  }

  return { layers, warnings };
}

async function extractNetworkGeoJson(gdal, path) {
  const dataset = await openGdbZip(gdal, path);
  try {
    const info = asRecord(await gdal.ogrinfo(dataset, ["-so", "-al"]));
    const layerNames = new Set(
      asArray(info.layers).map((layer) => asString(asRecord(layer).name)),
    );
    const missing = NETWORK_LAYERS.filter((name) => !layerNames.has(name));
    if (missing.length > 0) {
      throw sourceError(
        "missing_network_layers",
        "Archive is missing the routing network layers (net_junction, net_path).",
        { missing },
      );
    }

    const junctions = await extractLayerGeoJson(
      gdal,
      dataset,
      NETWORK_JUNCTION_LAYER,
      "network_net_junction",
    );
    const paths = await extractLayerGeoJson(gdal, dataset, NETWORK_PATH_LAYER, "network_net_path");
    const generatedBytes =
      Buffer.byteLength(junctions, "utf8") + Buffer.byteLength(paths, "utf8");
    if (generatedBytes > GDB_MAX_GENERATED_BYTES) {
      throw new Error(
        `Network extraction exceeded the ${GDB_MAX_GENERATED_BYTES}-byte output cap.`,
      );
    }

    const junctionSummary = summarizeLayer(junctions, NETWORK_JUNCTION_LAYER);
    const pathSummary = summarizeLayer(paths, NETWORK_PATH_LAYER);
    const floors = [...new Set([...junctionSummary.floors, ...pathSummary.floors])].sort();
    return {
      junctions,
      paths,
      nodeCount: junctionSummary.featureCount,
      edgeCount: pathSummary.featureCount,
      floors,
    };
  } finally {
    try {
      await gdal.close(dataset);
    } catch {
      /* Best-effort close. */
    }
  }
}

async function extractFacilitiesGeoJson(gdal, path) {
  const dataset = await openGdbZip(gdal, path);
  try {
    const info = asRecord(await gdal.ogrinfo(dataset, ["-so", "-al"]));
    const layerNames = new Set(
      asArray(info.layers).map((layer) => asString(asRecord(layer).name)),
    );
    if (!layerNames.has(FACILITY_LAYER)) {
      throw sourceError(
        "missing_facility_layer",
        "Archive is missing the point-facility layer (Facility_Merge).",
        { missing: [FACILITY_LAYER] },
      );
    }

    const geojson = await extractLayerGeoJson(
      gdal,
      dataset,
      FACILITY_LAYER,
      "facilities_facility_merge",
    );
    const generatedBytes = Buffer.byteLength(geojson, "utf8");
    if (generatedBytes > GDB_MAX_GENERATED_BYTES) {
      throw new Error(
        `Facility extraction exceeded the ${GDB_MAX_GENERATED_BYTES}-byte output cap.`,
      );
    }

    const summary = summarizeLayer(geojson, FACILITY_LAYER);
    return {
      geojson,
      facilityCount: summary.featureCount,
      floors: [...new Set(summary.floors)].sort(),
    };
  } finally {
    try {
      await gdal.close(dataset);
    } catch {
      /* Best-effort close. */
    }
  }
}

async function packageNetworkGdbZip(gdal, junctionsGeoJson, pathsGeoJson) {
  const dir = mkdtempSync(join(tmpdir(), "kiriko-netexport-"));
  try {
    const junctionsPath = join(dir, "net_junction.geojson");
    const pathsPath = join(dir, "net_path.geojson");
    writeFileSync(junctionsPath, junctionsGeoJson);
    writeFileSync(pathsPath, pathsGeoJson);

    // First layer creates the .gdb; second appends into the same directory.
    const junctionsDataset = await openGeoJson(gdal, junctionsPath);
    try {
      await gdal.ogr2ogr(
        junctionsDataset,
        ["-f", "OpenFileGDB", "-nln", "net_junction", "-t_srs", "EPSG:4326"],
        "net",
      );
    } finally {
      await gdal.close(junctionsDataset).catch(() => undefined);
    }

    const pathsDataset = await openGeoJson(gdal, pathsPath);
    let output;
    try {
      output = await gdal.ogr2ogr(
        pathsDataset,
        ["-f", "OpenFileGDB", "-update", "-append", "-nln", "net_path", "-t_srs", "EPSG:4326"],
        "net",
      );
    } finally {
      await gdal.close(pathsDataset).catch(() => undefined);
    }

    const outputRecord = asRecord(output);
    const files = asArray(outputRecord.all)
      .map((entry) => asRecord(entry).local)
      .filter((local) => typeof local === "string" && local.length > 0);
    if (files.length === 0) {
      throw new Error("GDAL produced no File Geodatabase output files.");
    }

    const writer = new ZipWriter(new Uint8ArrayWriter());
    const seen = new Set();
    for (const local of files) {
      const entry = gdbEntryPath(local);
      if (seen.has(entry)) continue;
      seen.add(entry);
      const bytes = await gdal.getFileBytes({ local });
      await writer.add(entry, new Uint8ArrayReader(bytes));
    }
    return await writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Dispatch one request against a gdal instance. Shared verbatim by the worker
 * thread and by tests (which pass a fake gdal), so there is a single GDAL
 * implementation with no separate in-process serializer.
 */
export async function runGdalRequest(request, gdal) {
  switch (request.op) {
    case "inspect":
      return inspectGdbArchive(gdal, request.path, request.sourceName);
    case "convert":
      return convertGdbLayers(gdal, request.path, request.selectedLayerNames);
    case "network":
      return extractNetworkGeoJson(gdal, request.path);
    case "facilities":
      return extractFacilitiesGeoJson(gdal, request.path);
    case "export":
      return packageNetworkGdbZip(gdal, request.junctionsGeoJson, request.pathsGeoJson);
    default:
      throw new Error(`Unknown GDAL request op: ${String(request?.op)}`);
  }
}

function serializeError(error) {
  if (error && typeof error === "object") {
    return {
      name: typeof error.name === "string" ? error.name : "Error",
      code: typeof error.code === "string" ? error.code : undefined,
      message: typeof error.message === "string" ? error.message : String(error),
      details: error.details && typeof error.details === "object" ? error.details : undefined,
    };
  }
  return { name: "Error", message: String(error) };
}

// Worker entry: only runs inside a worker thread (parentPort present). Importing
// this module in the main thread (tests) skips this and just exposes the funcs.
if (parentPort) {
  const port = parentPort;
  (async () => {
    try {
      const gdal = await getGdal();
      const result = await runGdalRequest(workerData, gdal);
      const transfer = result instanceof Uint8Array ? [result.buffer] : [];
      port.postMessage({ ok: true, result }, transfer);
    } catch (error) {
      port.postMessage({ ok: false, error: serializeError(error) });
    } finally {
      // Give the message a tick to flush to the parent, then exit so the
      // parent's `exit` event fires and it can delete the staged file.
      setImmediate(() => process.exit(0));
    }
  })();
}
