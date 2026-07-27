/**
 * Package a synthesized/real routing network (`net_junction` + `net_path`
 * WGS84 GeoJSON, produced by the Rust `export_network`) into a File
 * Geodatabase `.gdb.zip`, byte-for-byte re-importable through this server's
 * own `/api/gdb/inspect-network` path.
 *
 * GDAL stays behind this module (the boundary rule); the GDAL-touching body
 * (two `ogr2ogr` calls writing the two feature classes into one OpenFileGDB
 * directory, then zipping under a `net.gdb/` root) runs in the worker
 * (`gdalWorker.mjs`) via the serial, cancelling process queue.
 */
import { gdalDeadlineMs, runGdalOperation } from "./gdalProcess";

/**
 * Package `net_junction`/`net_path` GeoJSON into a `.gdb.zip` with exclusive,
 * cancellable access to the shared GDAL runtime.
 */
export function packageNetworkGdbZip(
  junctionsGeoJson: string,
  pathsGeoJson: string,
): Promise<Uint8Array> {
  return runGdalOperation<Uint8Array>(
    { op: "export", junctionsGeoJson, pathsGeoJson },
    { deadlineMs: gdalDeadlineMs() },
  );
}
