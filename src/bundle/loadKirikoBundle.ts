import { VenueLoadError } from "../errors/VenueLoadError";
import type { LoadedVenue } from "../imdf/types";
import { hydrateVenue } from "./hydrateVenue";
import { BUNDLE_WORKER_FAILED_MESSAGE } from "./types";
import type { BundleDecodeRequest, BundleWorkerFailureCode, BundleWorkerResponse } from "./types";
import type { FacilityDto, NetworkQaDto } from "./wasm";
import BundleWorker from "./bundle.worker?worker&inline";

const PUBLIC_VERSION_ID = /^[0-9a-f]{64}$/;

export interface KirikoBundleLoadResult {
  venue: LoadedVenue;
  metadata: {
    datasetId: string;
    version: number;
  };
  publicVersionId: string | null;
  /**
   * Server publication sequence from `Kiriko-Version-Seq`. Positive integer
   * when the response identifies its exact version; `null` when the header is
   * missing or malformed. A `null` sequence is never pin-safe provenance.
   */
  seq: number | null;
  /** Whether the bundle carries a §5 network graph (Directions mode gate). */
  hasGraph: boolean;
  /** Whether the bundle carries a §7 facilities section (marker UI gate). */
  hasFacilities: boolean;
  /** Point facilities from §7; empty when absent. */
  facilities: FacilityDto[];
  /** §11 network QA from decode; `null` when the section is absent or unreadable. */
  networkQa: NetworkQaDto | null;
}

/**
 * The only codes a bundle-worker `{type:"failed"}` response may legitimately
 * carry: the four `kvb1` domain codes plus the shared runtime/protocol
 * `worker_failed`. ZIP-only codes (`fetch_failed`, `invalid_archive`, …)
 * never originate from `bundle.worker.ts` and are rejected as malformed.
 */
const BUNDLE_WORKER_FAILURE_CODES: Record<string, true> = {
  invalid_bundle: true,
  unsupported_bundle_version: true,
  bundle_integrity_failed: true,
  bundle_too_large: true,
  worker_failed: true,
};

function parseNetworkQa(value: unknown): NetworkQaDto | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (("findings" in value) === false || Array.isArray(value.findings) === false) {
    return null;
  }
  let stretch: NetworkQaDto["stretch"] = null;
  if (
    "stretch" in value &&
    value.stretch !== null &&
    value.stretch !== undefined &&
    typeof value.stretch === "object" &&
    Array.isArray(value.stretch) === false
  ) {
    stretch = value.stretch as NetworkQaDto["stretch"];
  }
  return {
    findings: value.findings as NetworkQaDto["findings"],
    stretch,
  };
}

function isBundleWorkerFailureCode(value: unknown): value is BundleWorkerFailureCode {
  return typeof value === "string" && BUNDLE_WORKER_FAILURE_CODES[value] === true;
}

/**
 * `details`, when present, must be a plain object: not `null`, not an
 * array, and not a `Map`/`Set`/`Date`/class instance (only a literal
 * `{...}` or `Object.create(null)` prototype is accepted).
 */
function isValidErrorDetails(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: object | null = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isWorkerResponse(value: unknown): value is BundleWorkerResponse {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (!("type" in value)) {
    return false;
  }
  if (value.type === "loaded") {
    return (
      "venue" in value &&
      value.venue !== null &&
      typeof value.venue === "object" &&
      (!("hasGraph" in value) || typeof value.hasGraph === "boolean")
    );
  }
  if (value.type === "failed") {
    if (!("error" in value) || value.error === null || typeof value.error !== "object") {
      return false;
    }
    const error = value.error;
    return (
      "code" in error &&
      isBundleWorkerFailureCode(error.code) &&
      "message" in error &&
      typeof error.message === "string" &&
      (!("details" in error) || isValidErrorDetails(error.details))
    );
  }
  return false;
}

function rebuildVenueLoadError(payload: {
  code: BundleWorkerFailureCode;
  message: string;
  details?: Record<string, unknown>;
}): VenueLoadError {
  return new VenueLoadError(payload.code, payload.message, payload.details, "bundle");
}

function workerFailedError(): VenueLoadError {
  return new VenueLoadError("worker_failed", BUNDLE_WORKER_FAILED_MESSAGE, undefined, "bundle");
}

/**
 * Fetches and decodes a Kiriko `.kvb` bundle on a dedicated module worker.
 * Creates one worker per call, transfers the fetched buffer to it (never
 * cloned), and always terminates it on every terminal path. `AbortSignal`
 * termination — before the fetch starts, mid-fetch, or mid-decode — rejects
 * with `DOMException("Aborted", "AbortError")`. Responses arriving after an
 * abort (or after any other terminal path) are ignored.
 */
export async function loadKirikoBundle(
  src: string,
  signal?: AbortSignal,
): Promise<KirikoBundleLoadResult> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  let response: Response;
  try {
    response = await fetch(src, { signal: signal ?? null });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new VenueLoadError("fetch_failed", "Could not download the Kiriko bundle.", { src }, "bundle");
  }
  if (!response.ok) {
    throw new VenueLoadError(
      "fetch_failed",
      "Could not download the Kiriko bundle.",
      { src, status: response.status },
      "bundle",
    );
  }

  const publicVersionIdHeader = response.headers.get("Kiriko-Version-Id");
  const publicVersionId =
    publicVersionIdHeader !== null && PUBLIC_VERSION_ID.test(publicVersionIdHeader)
      ? publicVersionIdHeader
      : null;

  // Provenance is pin-safe only when this header agrees with the decoded §1
  // dataset version (publish embeds the DB seq as that version). Parse the
  // header now; the equality check happens once the venue is decoded.
  const seqHeader = response.headers.get("Kiriko-Version-Seq")?.trim() ?? "";
  const seqNum = /^\d+$/.test(seqHeader) ? Number(seqHeader) : Number.NaN;
  const headerSeq = Number.isSafeInteger(seqNum) && seqNum > 0 ? seqNum : null;

  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new VenueLoadError("fetch_failed", "Could not download the Kiriko bundle.", { src }, "bundle");
  }

  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  // The Worker constructor itself can throw synchronously (e.g. a CSP that
  // blocks blob/inline workers); no worker exists yet, so there is nothing
  // to terminate — surface the sanitized bundle-provenance error.
  let worker: Worker;
  try {
    worker = new BundleWorker();
  } catch {
    throw workerFailedError();
  }

  return new Promise<KirikoBundleLoadResult>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
      signal?.removeEventListener("abort", onAbort);
    };

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = (): void => {
      settle(() => {
        worker.terminate();
        reject(new DOMException("Aborted", "AbortError"));
      });
    };

    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = event.data;
      if (!isWorkerResponse(data)) {
        settle(() => {
          worker.terminate();
          reject(workerFailedError());
        });
        return;
      }
      if (data.type === "failed") {
        settle(() => {
          worker.terminate();
          reject(rebuildVenueLoadError(data.error));
        });
        return;
      }
      if (data.type !== "loaded") {
        // A `routed` response can never answer a decode request.
        settle(() => {
          worker.terminate();
          reject(workerFailedError());
        });
        return;
      }
      let venue: LoadedVenue;
      try {
        venue = hydrateVenue(data.venue);
      } catch (error) {
        settle(() => {
          worker.terminate();
          reject(error instanceof VenueLoadError ? error : workerFailedError());
        });
        return;
      }
      settle(() => {
        worker.terminate();
        resolve({
          venue,
          metadata: {
            datasetId: data.venue.datasetId,
            version: data.venue.version,
          },
          publicVersionId,
          seq: headerSeq !== null && headerSeq === data.venue.version ? headerSeq : null,
          hasGraph: data.hasGraph === true,
          hasFacilities: data.hasFacilities === true,
          facilities: Array.isArray(data.facilities) ? data.facilities : [],
          networkQa: parseNetworkQa("networkQa" in data ? data.networkQa : null),
        });
      });
    };

    const onError = (): void => {
      settle(() => {
        worker.terminate();
        reject(workerFailedError());
      });
    };

    const onMessageError = (): void => {
      settle(() => {
        worker.terminate();
        reject(workerFailedError());
      });
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
    signal?.addEventListener("abort", onAbort, { once: true });

    const request: BundleDecodeRequest = { type: "decode", buffer };
    try {
      worker.postMessage(request, [buffer]);
    } catch {
      settle(() => {
        worker.terminate();
        reject(workerFailedError());
      });
    }
  });
}
