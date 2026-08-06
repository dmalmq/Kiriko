/**
 * Loads a published bundle's generated 3D scene, compiled off the main thread.
 *
 * Mirrors `routeKirikoBundle`: one worker per call, the fetched buffer
 * transferred (never cloned), the worker terminated on every terminal path, and
 * the bytes re-decoded statelessly inside wasm. The compile is the heaviest
 * wasm call the client makes, so it never runs where it could stall an
 * interactive map, and the geometry payload is transferred back rather than
 * copied.
 *
 * Resolves `null` when the bundle carries no renderable scene — a venue
 * without 3D data is an absent capability, not a load failure, and the caller
 * keeps showing 2D exactly as before.
 */
import { VenueLoadError } from "../errors/VenueLoadError";
import { BUNDLE_WORKER_FAILED_MESSAGE } from "./types";
import type { BundleSceneRequest } from "./types";
import type { DescribedSceneDto } from "./wasm";
import BundleWorker from "./bundle.worker?worker&inline";

function workerFailedError(): VenueLoadError {
  return new VenueLoadError("worker_failed", BUNDLE_WORKER_FAILED_MESSAGE, undefined, "bundle");
}

function fetchFailedError(src: string, status?: number): VenueLoadError {
  return new VenueLoadError(
    "fetch_failed",
    "Could not download the Kiriko bundle.",
    status === undefined ? { src } : { src, status },
    "bundle",
  );
}

export async function loadKirikoScene(
  src: string,
  signal?: AbortSignal,
): Promise<DescribedSceneDto | null> {
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
    throw fetchFailedError(src);
  }
  if (!response.ok) {
    throw fetchFailedError(src, response.status);
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw fetchFailedError(src);
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

  return new Promise<DescribedSceneDto | null>((resolve, reject) => {
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
      if (data === null || typeof data !== "object" || !("type" in data)) {
        settle(() => {
          worker.terminate();
          reject(workerFailedError());
        });
        return;
      }
      if (
        data.type === "scene" &&
        "meta" in data &&
        typeof data.meta === "string" &&
        "payload" in data &&
        data.payload instanceof Uint8Array
      ) {
        const described: DescribedSceneDto = { meta: data.meta, payload: data.payload };
        settle(() => {
          worker.terminate();
          resolve(described);
        });
        return;
      }
      // A `failed` response means the bundle carries no scene (or the compile
      // rejected it). Either way there is nothing to render, and the venue's
      // 2D view is unaffected — so this resolves absent rather than throwing.
      settle(() => {
        worker.terminate();
        resolve(null);
      });
    };

    const onError = (): void => {
      settle(() => {
        worker.terminate();
        reject(workerFailedError());
      });
    };

    const onMessageError = onError;

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
    signal?.addEventListener("abort", onAbort, { once: true });

    const request: BundleSceneRequest = { type: "scene", buffer };
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
