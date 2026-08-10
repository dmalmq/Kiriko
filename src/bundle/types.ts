/**
 * Message protocol for the Kiriko bundle decode worker (`bundle.worker.ts`).
 * The decoded venue DTO itself is Task 4's `@kiriko/wasm` contract (see
 * `./wasm`); this module defines only the request/response envelope shared
 * by the worker and its caller, `loadKirikoBundle.ts`.
 */
import type { VenueLoadErrorCode } from "../errors/VenueLoadError";
import type { DecodedVenueDto, FacilityDto, RouteEndpoint, RouteResultDto } from "./wasm";

/** `buffer` is always transferred (not cloned) to the worker. */
export interface BundleDecodeRequest {
  type: "decode";
  buffer: ArrayBuffer;
}

/**
 * Route query over an already-published bundle. `buffer` is transferred (not
 * cloned) to the worker, which re-decodes it statelessly inside wasm — the
 * worker retains no bundle bytes between messages.
 */
export interface BundleRouteRequest {
  type: "route";
  buffer: ArrayBuffer;
  origin: RouteEndpoint;
  destination: RouteEndpoint;
}

/**
 * Compile the bundle's generated §9 scene into the shared render document.
 * `buffer` is transferred (not cloned); the worker re-decodes statelessly, so
 * the compile — the heaviest wasm call in the client — never runs on the main
 * thread while the map is interactive.
 */
export interface BundleSceneRequest {
  type: "scene";
  buffer: ArrayBuffer;
  /**
   * Which producer wrote the bytes. A bundle needs its §9 compiled; an
   * activated package's document was derived server-side and only needs
   * decoding. Both end as the same render document, which is why one request
   * carries both rather than the client growing a second scene path.
   */
  source?: "generated" | "package";
}

export type BundleWorkerRequest =
  | BundleDecodeRequest
  | BundleRouteRequest
  | BundleSceneRequest;

export interface BundleDecodeSuccess {
  type: "loaded";
  venue: DecodedVenueDto;
  /** Whether the decoded bundle carries a §5 network graph (routing UI gate). */
  hasGraph: boolean;
  /** Whether the decoded bundle carries a §7 facilities section (marker UI gate). */
  hasFacilities: boolean;
  /** Point facilities from §7; empty when the section is absent. */
  facilities: FacilityDto[];
}

/** `route` is `null` when the bundle has no graph or no path connects the endpoints. */
export interface BundleRouteSuccess {
  type: "routed";
  route: RouteResultDto | null;
}

/**
 * The compiled render document: a JSON description plus the packed geometry
 * payload, whose buffer is transferred back to the caller.
 */
export interface BundleSceneSuccess {
  type: "scene";
  meta: string;
  payload: Uint8Array;
}

/**
 * The only `VenueLoadErrorCode` values a `bundle.worker.ts` failure response
 * may legitimately carry: the four `kvb1` domain codes plus the shared
 * runtime/protocol `worker_failed`. ZIP-only codes (`fetch_failed`,
 * `invalid_archive`, …) can never inhabit this type — see
 * `loadKirikoBundle.test.ts`'s compile-time assertions.
 */
export type BundleWorkerFailureCode = Extract<
  VenueLoadErrorCode,
  | "invalid_bundle"
  | "unsupported_bundle_version"
  | "bundle_integrity_failed"
  | "bundle_too_large"
  | "worker_failed"
>;

export interface BundleDecodeFailure {
  type: "failed";
  error: {
    code: BundleWorkerFailureCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type BundleWorkerResponse =
  | BundleDecodeSuccess
  | BundleRouteSuccess
  | BundleSceneSuccess
  | BundleDecodeFailure;

/**
 * Shared wire `message` for `worker_failed` bundle-worker failures (WASM
 * init/decode exceptions, worker protocol violations). Deliberately
 * separate from `venueLoadErrorCopy.worker_failed` in `../errors/VenueLoadError`,
 * which is the ZIP-loader-flavored corrective copy shared across every
 * `VenueLoadError` code and must stay unchanged.
 */
export const BUNDLE_WORKER_FAILED_MESSAGE =
  "The venue could not be processed. Try loading the bundle again.";
