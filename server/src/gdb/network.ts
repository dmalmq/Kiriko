/**
 * Server-side routing-network extraction request builder: pulls the
 * `net_junction` and `net_path` layers out of a staged network `.gdb.zip` as
 * WGS84 RFC7946 GeoJSON text, plus the node/edge/floor summary shown in the
 * import review dialog.
 *
 * The boundary rule from the route-slice design applies: GDAL stays behind
 * this module and the server never interprets the network — parsing the
 * GeoJSON into a graph, floor mapping, and A* all live in the Rust
 * `kiriko-route` crate. The GDAL-touching body runs in the worker
 * (`gdalWorker.mjs`) via the serial, cancelling process queue.
 */
import { gdalDeadlineMs, runGdalOperation } from "./gdalProcess";
import type { NetworkExtraction } from "./types";

/**
 * Extract `net_junction`/`net_path` from a staged `.gdb.zip` (absolute
 * filesystem path) with exclusive, cancellable access to the GDAL runtime.
 * Throws `GdbSourceError("missing_network_layers")` when either layer is absent.
 */
export function extractNetworkGeoJson(path: string): Promise<NetworkExtraction> {
  return runGdalOperation<NetworkExtraction>(
    { op: "network", path },
    { deadlineMs: gdalDeadlineMs() },
  );
}
