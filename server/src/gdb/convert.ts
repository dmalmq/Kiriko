/**
 * Server-side GDB inspect + convert request builders.
 *
 * The GDAL-touching bodies now live in the plain-ESM worker
 * (`gdalWorker.mjs`); these functions only build a request and run it through
 * the serial, cancelling process queue (`gdalProcess.ts`). The queue guarantees
 * one GDAL operation at a time (the Emscripten output namespace is
 * single-tenant), a real cancelling deadline, and that the returned promise
 * settles only after the worker has exited — so a caller may delete the staged
 * `.gdb.zip` immediately afterward.
 */
import { gdalDeadlineMs, runGdalOperation } from "./gdalProcess";
import type { GdbConversionResult, GdbInspection } from "./types";

/**
 * Inspect a staged `.gdb.zip` (absolute filesystem path) and return one layer
 * descriptor per OGR layer in the first dataset.
 */
export function inspectGdbArchive(path: string, sourceName: string): Promise<GdbInspection> {
  return runGdalOperation<GdbInspection>(
    { op: "inspect", path, sourceName },
    { deadlineMs: gdalDeadlineMs() },
  );
}

/**
 * Convert every included layer named in `selectedLayerNames` to a WGS84
 * RFC7946 GeoJSON FeatureCollection. Layers that produce no spatial features
 * fail conversion. Caller filters by the plan's `included` flag first.
 */
export function convertGdbLayers(
  path: string,
  selectedLayerNames: readonly string[],
): Promise<GdbConversionResult> {
  return runGdalOperation<GdbConversionResult>(
    { op: "convert", path, selectedLayerNames },
    { deadlineMs: gdalDeadlineMs() },
  );
}
