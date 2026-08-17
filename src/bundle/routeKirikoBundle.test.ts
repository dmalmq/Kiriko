import { afterEach, describe, expect, it, vi } from "vitest";
import { VenueLoadError } from "../errors/VenueLoadError";

const { createdWorkers, FakeBundleWorker } = vi.hoisted(() => {
  class BaseFakeBundleWorker extends EventTarget {
    postMessage = vi.fn((..._args: unknown[]) => {});
    terminate = vi.fn();
    addEventListener = vi.fn(
      (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) => {
        EventTarget.prototype.addEventListener.call(this, type, listener, options);
      },
    );
    removeEventListener = vi.fn(
      (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ) => {
        EventTarget.prototype.removeEventListener.call(this, type, listener, options);
      },
    );
  }
  const created: BaseFakeBundleWorker[] = [];
  class TrackedFakeBundleWorker extends BaseFakeBundleWorker {
    constructor() {
      super();
      created.push(this);
    }
  }
  return { createdWorkers: created, FakeBundleWorker: TrackedFakeBundleWorker };
});

vi.mock("./bundle.worker?worker&inline", () => ({ default: FakeBundleWorker }));

import { routeKirikoBundle } from "./routeKirikoBundle";

const SRC = "/v/default/minimal/bundle";
const ORIGIN = { longitude: 139.0, latitude: 35.0, ordinal: 0 };
const DESTINATION = { longitude: 139.001, latitude: 35.0, ordinal: 1 };

const ROUTE = {
  segments: [
    { ordinal: 0, coordinates: [[139.0, 35.0], [139.0005, 35.0]] },
    { ordinal: 1, coordinates: [[139.0005, 35.0], [139.001, 35.0]] },
  ],
  totalWeight: 142.5,
  originProjected: [139.0, 35.0, 0],
  destProjected: [139.001, 35.0, 1],
};

function okResponse(buffer: ArrayBuffer): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    arrayBuffer: vi.fn().mockResolvedValue(buffer),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  createdWorkers.length = 0;
});

describe("routeKirikoBundle", () => {
  it("posts a route request with the buffer transferred and resolves the polyline", async () => {
    const buffer = new TextEncoder().encode("kvb1-fixture").buffer;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(buffer)));

    const promise = routeKirikoBundle(SRC, ORIGIN, DESTINATION);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));

    const worker = createdWorkers[0]!;
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const [message, transfer] = worker.postMessage.mock.calls[0]!;
    expect(message).toEqual({
      type: "route",
      buffer,
      origin: ORIGIN,
      destination: DESTINATION,
    });
    expect(transfer).toEqual([buffer]);

    worker.dispatchEvent(new MessageEvent("message", { data: { type: "routed", route: ROUTE } }));

    await expect(promise).resolves.toEqual(ROUTE);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("includes profile on the route request when given", async () => {
    const buffer = new TextEncoder().encode("kvb1-fixture").buffer;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(buffer)));

    const profile = { accessible: true };
    const promise = routeKirikoBundle(SRC, ORIGIN, DESTINATION, undefined, profile);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));

    const worker = createdWorkers[0]!;
    const [message] = worker.postMessage.mock.calls[0]!;
    expect(message).toEqual({
      type: "route",
      buffer,
      origin: ORIGIN,
      destination: DESTINATION,
      profile,
    });

    worker.dispatchEvent(new MessageEvent("message", { data: { type: "routed", route: ROUTE } }));
    await expect(promise).resolves.toEqual(ROUTE);
  });

  it("resolves null when the worker reports no path (or no graph)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));

    const promise = routeKirikoBundle(SRC, ORIGIN, DESTINATION);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "routed", route: null } }));

    await expect(promise).resolves.toBeNull();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["non-array segments", { segments: "nope", totalWeight: 1, originProjected: [139, 35, 0], destProjected: [139, 35, 1] }],
    ["a bad segment coordinate", { segments: [{ ordinal: 0, coordinates: [["x", 35]] }], totalWeight: 1, originProjected: [139, 35, 0], destProjected: [139, 35, 1] }],
    ["a missing destProjected", { segments: [], totalWeight: 1, originProjected: [139, 35, 0] }],
  ])("rejects worker_failed and terminates on a routed payload with %s", async (_label, route) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));

    const promise = routeKirikoBundle(SRC, ORIGIN, DESTINATION);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "routed", route } }));

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("worker_failed");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects worker_failed on a failed worker response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));

    const promise = routeKirikoBundle(SRC, ORIGIN, DESTINATION);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "failed", error: { code: "worker_failed", message: "x" } },
      }),
    );

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("worker_failed");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects worker_failed on a worker error event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));

    const promise = routeKirikoBundle(SRC, ORIGIN, DESTINATION);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(new Event("error"));

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("worker_failed");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects fetch_failed on a non-ok response and never spawns a worker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 } as unknown as Response),
    );

    const error = await routeKirikoBundle(SRC, ORIGIN, DESTINATION).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("fetch_failed");
    expect(createdWorkers).toHaveLength(0);
  });

  it("rejects AbortError before the fetch when already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    const error = await routeKirikoBundle(SRC, ORIGIN, DESTINATION, controller.signal).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createdWorkers).toHaveLength(0);
  });

  it("aborts mid-route, terminates the worker, and ignores a stale response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));
    const controller = new AbortController();

    const promise = routeKirikoBundle(SRC, ORIGIN, DESTINATION, controller.signal);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;

    controller.abort();

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(worker.terminate).toHaveBeenCalledTimes(1);

    worker.dispatchEvent(new MessageEvent("message", { data: { type: "routed", route: ROUTE } }));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
