/**
 * Type surface for the plain-ESM GDAL worker. The runtime lives in
 * `gdalWorker.mjs`; this declares the two functions imported by tests and any
 * direct caller. The worker also self-executes when loaded inside a worker
 * thread (guarded by `parentPort`), which has no typed surface.
 */
import type { GdalRequest } from "./gdalProcess";

/** Run one request against a gdal instance (real or fake). Shared worker body. */
export function runGdalRequest(request: GdalRequest, gdal: unknown): Promise<unknown>;

/** Lazily initialize this thread's gdal3.js instance. */
export function getGdal(): Promise<unknown>;
