/**
 * Server-side point-facility extraction request builder: pulls the
 * `Facility_Merge` layer (the icon-bearing POI layer:
 * `name`/`category`/`floor`/`image`) out of a staged facilities `.gdb.zip` as
 * WGS84 RFC7946 GeoJSON text, plus the facility/floor summary shown in the
 * import review dialog.
 *
 * GDAL stays behind this module and the server never interprets the
 * facilities: parsing the GeoJSON into the facility index lives in the Rust
 * compiler. The GDAL-touching body runs in the worker (`gdalWorker.mjs`) via
 * the serial, cancelling process queue.
 */
import { gdalDeadlineMs, runGdalOperation } from "./gdalProcess";
import type { FacilitiesExtraction } from "./types";

/**
 * Extract `Facility_Merge` from a staged facilities `.gdb.zip` (absolute
 * filesystem path) with exclusive, cancellable access to the GDAL runtime.
 * Throws `GdbSourceError("missing_facility_layer")` when the layer is absent.
 */
export function extractFacilitiesGeoJson(path: string): Promise<FacilitiesExtraction> {
  return runGdalOperation<FacilitiesExtraction>(
    { op: "facilities", path },
    { deadlineMs: gdalDeadlineMs() },
  );
}
