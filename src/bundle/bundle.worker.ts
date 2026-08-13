/// <reference lib="webworker" />

import { venueLoadErrorCopy } from "../errors/VenueLoadError";
import { BUNDLE_WORKER_FAILED_MESSAGE } from "./types";
import type {
  BundleDecodeRequest,
  BundleRouteRequest,
  BundleSceneRequest,
  BundleWorkerResponse,
} from "./types";
import {
  decodeBundle,
  decodeScene,
  facilities,
  generatedScene,
  initKirikoWasm,
  routeBundle,
} from "./wasm";

declare const self: DedicatedWorkerGlobalScope;

/**
 * Decodes one transferred bundle `ArrayBuffer` through the sole
 * `@kiriko/wasm` adapter (`initKirikoWasm`/`decodeBundle` in `./wasm`).
 * Never throws: every failure — domain (bundle-format) or runtime (WASM
 * init/decode exception) — resolves to a `{type:"failed"}` response carrying
 * corrective copy, never the raw WASM/Rust message. Domain failures use the
 * per-code corrective copy (`venueLoadErrorCopy`); runtime/protocol
 * failures use the shared bundle-specific `worker_failed` wording
 * (`BUNDLE_WORKER_FAILED_MESSAGE`), not the ZIP loader's copy.
 */
export async function decodeBundleMessage(
  request: BundleDecodeRequest,
): Promise<BundleWorkerResponse> {
  try {
    await initKirikoWasm();
    const bytes = new Uint8Array(request.buffer);
    const response = decodeBundle(bytes);
    if (response.ok && response.venue !== null) {
      return {
        type: "loaded",
        venue: response.venue,
        hasGraph: response.hasGraph === true,
        hasFacilities: response.hasFacilities === true,
        facilities: response.hasFacilities === true ? facilities(bytes) : [],
      };
    }
    const code = response.error?.code ?? "invalid_bundle";
    return { type: "failed", error: { code, message: venueLoadErrorCopy[code] } };
  } catch {
    return {
      type: "failed",
      error: { code: "worker_failed", message: BUNDLE_WORKER_FAILED_MESSAGE },
    };
  }
}

/**
 * Routes over one transferred bundle `ArrayBuffer` through the same
 * `@kiriko/wasm` adapter (`routeBundle` in `./wasm`). The worker is
 * stateless: the bytes ride every request and are re-decoded inside wasm.
 * Never throws — like `decodeBundleMessage`, every failure (wasm init
 * rejection or a thrown bundle-format `JsError` from `route_bundle`)
 * resolves to the shared `{type:"failed"}` `worker_failed` response. A
 * wasm `null` (no §5 graph, or no connecting path) crosses as
 * `{type:"routed", route:null}`, not as a failure.
 */
export async function routeBundleMessage(
  request: BundleRouteRequest,
): Promise<BundleWorkerResponse> {
  try {
    await initKirikoWasm();
    const route = routeBundle(
      new Uint8Array(request.buffer),
      request.origin,
      request.destination,
    );
    return { type: "routed", route };
  } catch {
    return {
      type: "failed",
      error: { code: "worker_failed", message: BUNDLE_WORKER_FAILED_MESSAGE },
    };
  }
}

/**
 * Compiles one transferred `ArrayBuffer` into the shared render document:
 * a bundle's §9 through `generatedScene`, or an activated package's
 * server-derived document through `decodeScene`. Stateless like the others.
 * A bundle with no §9 scene or no §8 spatial context is not a failure of the
 * worker but an absent capability: it resolves to `{type:"failed"}` with the
 * shared code, and the caller decides from the scene projection whether 3D was
 * ever on offer.
 */
export async function sceneBundleMessage(
  request: BundleSceneRequest,
): Promise<BundleWorkerResponse> {
  try {
    await initKirikoWasm();
    const bytes = new Uint8Array(request.buffer);
    const described =
      request.source === "package" ? decodeScene(bytes) : generatedScene(bytes);
    return { type: "scene", meta: described.meta, payload: described.payload };
  } catch {
    return {
      type: "failed",
      error: { code: "worker_failed", message: BUNDLE_WORKER_FAILED_MESSAGE },
    };
  }
}

// Register the worker message handler only inside a real worker scope.
// Importing this module under vitest/jsdom must not throw or register.
// `WorkerGlobalScope` is defined in every worker scope (including module
// workers) and undefined in window/jsdom.
declare const WorkerGlobalScope: (new () => unknown) | undefined;
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = (
    event: MessageEvent<BundleDecodeRequest | BundleRouteRequest | BundleSceneRequest>,
  ): void => {
    const data = event.data;
    if (
      data === null ||
      typeof data !== "object" ||
      (data.type !== "decode" && data.type !== "route" && data.type !== "scene")
    ) {
      const response: BundleWorkerResponse = {
        type: "failed",
        error: { code: "worker_failed", message: BUNDLE_WORKER_FAILED_MESSAGE },
      };
      self.postMessage(response);
      return;
    }
    const pending =
      data.type === "decode"
        ? decodeBundleMessage(data)
        : data.type === "route"
          ? routeBundleMessage(data)
          : sceneBundleMessage(data);
    void pending.then((response) => {
      // The scene payload is large and freshly allocated: transfer it rather
      // than cloning it across the boundary.
      if (response.type === "scene") {
        self.postMessage(response, [response.payload.buffer as ArrayBuffer]);
        return;
      }
      self.postMessage(response);
    });
  };
}
