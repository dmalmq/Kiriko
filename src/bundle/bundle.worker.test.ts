import { afterEach, describe, expect, it, vi } from "vitest";
import { venueLoadErrorCopy } from "../errors/VenueLoadError";
import { BUNDLE_WORKER_FAILED_MESSAGE } from "./types";

const initKirikoWasmMock = vi.fn();
const decodeBundleMock = vi.fn();
const routeBundleMock = vi.fn();
const facilitiesMock = vi.fn((..._args: unknown[]) => [] as unknown[]);
vi.mock("./wasm", () => ({
  initKirikoWasm: (...args: unknown[]) => initKirikoWasmMock(...args),
  decodeBundle: (...args: unknown[]) => decodeBundleMock(...args),
  routeBundle: (...args: unknown[]) => routeBundleMock(...args),
  facilities: (...args: unknown[]) => facilitiesMock(...args),
}));

import { decodeBundleMessage, routeBundleMessage } from "./bundle.worker";

function request(buffer: ArrayBuffer = new Uint8Array([1, 2, 3]).buffer as ArrayBuffer): {
  type: "decode";
  buffer: ArrayBuffer;
} {
  return { type: "decode", buffer };
}

const ORIGIN = { longitude: 139.0, latitude: 35.0, ordinal: 0 };
const DESTINATION = { longitude: 139.001, latitude: 35.0, ordinal: 1 };

function routeRequest(buffer: ArrayBuffer = new Uint8Array([1, 2, 3]).buffer as ArrayBuffer): {
  type: "route";
  buffer: ArrayBuffer;
  origin: typeof ORIGIN;
  destination: typeof DESTINATION;
} {
  return { type: "route", buffer, origin: ORIGIN, destination: DESTINATION };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("decodeBundleMessage", () => {
  it("awaits initKirikoWasm before calling decodeBundle (catches a dropped `await`)", async () => {
    let resolveInit!: () => void;
    initKirikoWasmMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInit = resolve;
      }),
    );
    decodeBundleMock.mockReturnValue({ ok: true, venue: { id: "v" }, error: null, hasGraph: false });

    const promise = decodeBundleMessage(request());
    await Promise.resolve();
    await Promise.resolve();
    expect(decodeBundleMock).not.toHaveBeenCalled();

    resolveInit();
    const response = await promise;
    expect(decodeBundleMock).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ type: "loaded", venue: { id: "v" }, hasGraph: false, hasFacilities: false, facilities: [] });
  });

  it("maps a successful decode to a loaded response carrying the decoded venue", async () => {
    initKirikoWasmMock.mockResolvedValue(undefined);
    const venue = { id: "v1", features: [] };
    decodeBundleMock.mockReturnValue({ ok: true, venue, error: null, hasGraph: false });

    const response = await decodeBundleMessage(request());
    expect(response).toEqual({ type: "loaded", venue, hasGraph: false, hasFacilities: false, facilities: [] });
  });

  it("carries the bundle's §5 graph presence flag on the loaded response", async () => {
    initKirikoWasmMock.mockResolvedValue(undefined);
    decodeBundleMock.mockReturnValue({ ok: true, venue: { id: "v" }, error: null, hasGraph: true });

    const response = await decodeBundleMessage(request());
    expect(response).toEqual({ type: "loaded", venue: { id: "v" }, hasGraph: true, hasFacilities: false, facilities: [] });
  });

  it.each([
    "invalid_bundle",
    "unsupported_bundle_version",
    "bundle_integrity_failed",
    "bundle_too_large",
  ] as const)(
    "maps a structured %s domain failure to its corrective copy, discarding the raw WASM message",
    async (code) => {
      initKirikoWasmMock.mockResolvedValue(undefined);
      decodeBundleMock.mockReturnValue({
        ok: false,
        venue: null,
        error: { code, message: "raw rust panic text" },
      });

      const response = await decodeBundleMessage(request());
      expect(response).toEqual({ type: "failed", error: { code, message: venueLoadErrorCopy[code] } });
      expect(response.type === "failed" && response.error.message).not.toBe("raw rust panic text");
    },
  );

  it("falls back to worker_failed with the shared bundle wording when initKirikoWasm rejects", async () => {
    initKirikoWasmMock.mockRejectedValue(new Error("wasm module fetch failed"));

    const response = await decodeBundleMessage(request());
    expect(response).toEqual({
      type: "failed",
      error: { code: "worker_failed", message: BUNDLE_WORKER_FAILED_MESSAGE },
    });
    expect(decodeBundleMock).not.toHaveBeenCalled();
  });

  it("falls back to worker_failed with the shared bundle wording when decodeBundle throws synchronously", async () => {
    initKirikoWasmMock.mockResolvedValue(undefined);
    decodeBundleMock.mockImplementation(() => {
      throw new Error("unexpected wasm panic");
    });

    const response = await decodeBundleMessage(request());
    expect(response).toEqual({
      type: "failed",
      error: { code: "worker_failed", message: BUNDLE_WORKER_FAILED_MESSAGE },
    });
  });

  it("uses the shared bundle-specific worker_failed wording, not the ZIP loader's global copy", () => {
    expect(BUNDLE_WORKER_FAILED_MESSAGE).not.toBe(venueLoadErrorCopy.worker_failed);
  });
});

describe("routeBundleMessage", () => {
  it("awaits initKirikoWasm before calling routeBundle", async () => {
    let resolveInit!: () => void;
    initKirikoWasmMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInit = resolve;
      }),
    );
    routeBundleMock.mockReturnValue(null);

    const promise = routeBundleMessage(routeRequest());
    await Promise.resolve();
    await Promise.resolve();
    expect(routeBundleMock).not.toHaveBeenCalled();

    resolveInit();
    const response = await promise;
    expect(routeBundleMock).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ type: "routed", route: null });
  });

  it("passes the bundle bytes and endpoints to wasm and returns the polyline", async () => {
    initKirikoWasmMock.mockResolvedValue(undefined);
    const route = {
      nodes: [
        { lon: 139.0, lat: 35.0, ordinal: 0 },
        { lon: 139.001, lat: 35.0, ordinal: 1 },
      ],
      totalWeight: 100,
    };
    routeBundleMock.mockReturnValue(route);

    const buffer = new Uint8Array([9, 8, 7]).buffer as ArrayBuffer;
    const response = await routeBundleMessage(routeRequest(buffer));
    expect(routeBundleMock).toHaveBeenCalledWith(new Uint8Array(buffer), ORIGIN, DESTINATION, null);
    expect(response).toEqual({ type: "routed", route });
  });

  it("passes an accessible profile through to wasm", async () => {
    initKirikoWasmMock.mockResolvedValue(undefined);
    routeBundleMock.mockReturnValue(null);

    const buffer = new Uint8Array([9, 8, 7]).buffer as ArrayBuffer;
    const profile = { accessible: true };
    const response = await routeBundleMessage({
      type: "route",
      buffer,
      origin: ORIGIN,
      destination: DESTINATION,
      profile,
    });
    expect(routeBundleMock).toHaveBeenCalledWith(
      new Uint8Array(buffer),
      ORIGIN,
      DESTINATION,
      profile,
    );
    expect(response).toEqual({ type: "routed", route: null });
  });

  it("maps a null wasm route (no graph or no path) to a routed response carrying null", async () => {
    initKirikoWasmMock.mockResolvedValue(undefined);
    routeBundleMock.mockReturnValue(null);

    const response = await routeBundleMessage(routeRequest());
    expect(response).toEqual({ type: "routed", route: null });
  });

  it("falls back to worker_failed with the shared bundle wording when routeBundle throws", async () => {
    initKirikoWasmMock.mockResolvedValue(undefined);
    routeBundleMock.mockImplementation(() => {
      throw new Error("bundle-format failure crosses as a thrown JsError");
    });

    const response = await routeBundleMessage(routeRequest());
    expect(response).toEqual({
      type: "failed",
      error: { code: "worker_failed", message: BUNDLE_WORKER_FAILED_MESSAGE },
    });
  });

  it("falls back to worker_failed with the shared bundle wording when initKirikoWasm rejects", async () => {
    initKirikoWasmMock.mockRejectedValue(new Error("wasm module fetch failed"));

    const response = await routeBundleMessage(routeRequest());
    expect(response).toEqual({
      type: "failed",
      error: { code: "worker_failed", message: BUNDLE_WORKER_FAILED_MESSAGE },
    });
    expect(routeBundleMock).not.toHaveBeenCalled();
  });
});
