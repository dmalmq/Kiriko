import { VenueLoadError } from "../errors/VenueLoadError";
import { BUNDLE_WORKER_FAILED_MESSAGE } from "./types";
import type { BundleRouteRequest } from "./types";
import type { RouteEndpoint, RouteProfileDto, RouteResultDto } from "./wasm";
import BundleWorker from "./bundle.worker?worker&inline";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLonLat(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
}

function isTriple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
}

function isSegment(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const seg = value as Record<string, unknown>;
  return (
    isFiniteNumber(seg["ordinal"]) &&
    Array.isArray(seg["coordinates"]) &&
    seg["coordinates"].every(isLonLat)
  );
}

function isRouteResult(value: unknown): value is RouteResultDto {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const route = value as Record<string, unknown>;
  return (
    Array.isArray(route["segments"]) &&
    route["segments"].every(isSegment) &&
    isFiniteNumber(route["totalWeight"]) &&
    isTriple(route["originProjected"]) &&
    isTriple(route["destProjected"])
  );
}

function workerFailedError(): VenueLoadError {
  return new VenueLoadError("worker_failed", BUNDLE_WORKER_FAILED_MESSAGE, undefined, "bundle");
}

/**
 * Routes over a published Kiriko `.kvb` bundle on a dedicated module worker,
 * mirroring `loadKirikoBundle`: one worker per call, the fetched buffer
 * transferred (never cloned) with the `route` message, and the worker always
 * terminated on every terminal path. The worker re-decodes the bytes
 * statelessly inside wasm (`routeBundle`), so no bundle state is retained
 * between calls. Resolves `null` when the bundle has no §5 graph or no path
 * connects the snapped endpoints. `AbortSignal` termination rejects with
 * `DOMException("Aborted", "AbortError")`; responses arriving after an abort
 * are ignored.
 */
export async function routeKirikoBundle(
  src: string,
  origin: RouteEndpoint,
  destination: RouteEndpoint,
  signal?: AbortSignal,
  profile?: RouteProfileDto | null,
): Promise<RouteResultDto | null> {
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

  let worker: Worker;
  try {
    worker = new BundleWorker();
  } catch {
    throw workerFailedError();
  }

  return new Promise<RouteResultDto | null>((resolve, reject) => {
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

    const fail = (): void => {
      settle(() => {
        worker.terminate();
        reject(workerFailedError());
      });
    };

    const onAbort = (): void => {
      settle(() => {
        worker.terminate();
        reject(new DOMException("Aborted", "AbortError"));
      });
    };

    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = event.data;
      if (data === null || typeof data !== "object" || !("type" in data)) {
        fail();
        return;
      }
      if (data.type === "routed" && "route" in data) {
        const route: unknown = data.route;
        if (route !== null && !isRouteResult(route)) {
          fail();
          return;
        }
        settle(() => {
          worker.terminate();
          resolve(route);
        });
        return;
      }
      // A `failed` response, an unexpected `loaded`, or anything else: the
      // route path never reconstructs domain errors — one sanitized failure.
      fail();
    };

    const onError = (): void => {
      fail();
    };

    const onMessageError = (): void => {
      fail();
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
    signal?.addEventListener("abort", onAbort, { once: true });

    const request: BundleRouteRequest =
      profile == null
        ? { type: "route", buffer, origin, destination }
        : { type: "route", buffer, origin, destination, profile };
    try {
      worker.postMessage(request, [buffer]);
    } catch {
      fail();
    }
  });
}
