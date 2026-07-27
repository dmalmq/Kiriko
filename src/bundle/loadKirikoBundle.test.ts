import { afterEach, describe, expect, it, vi } from "vitest";
import { VenueLoadError } from "../errors/VenueLoadError";

const { createdWorkers, FakeBundleWorker, workerBehavior } = vi.hoisted(() => {
  const behavior: { throwOnPostMessage: boolean; throwOnConstruct: boolean } = {
    throwOnPostMessage: false,
    throwOnConstruct: false,
  };
  class BaseFakeBundleWorker extends EventTarget {
    postMessage = vi.fn((..._args: unknown[]) => {
      if (behavior.throwOnPostMessage) {
        throw new Error("postMessage failed");
      }
    });
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
      if (behavior.throwOnConstruct) {
        throw new DOMException(
          "Failed to construct 'Worker': blocked by Content Security Policy",
          "SecurityError",
        );
      }
      created.push(this);
    }
  }
  return {
    createdWorkers: created,
    FakeBundleWorker: TrackedFakeBundleWorker,
    workerBehavior: behavior,
  };
});

vi.mock("./bundle.worker?worker&inline", () => ({ default: FakeBundleWorker }));

const hydrateVenueMock = vi.fn();
vi.mock("./hydrateVenue", () => ({
  hydrateVenue: (...args: unknown[]) => hydrateVenueMock(...args),
}));

import { loadKirikoBundle } from "./loadKirikoBundle";

const SRC = "/v/default/minimal/bundle";

function okResponse(
  buffer: ArrayBuffer,
  publicVersionId?: string,
  seq?: number | string,
): Response {
  const headers = new Headers();
  if (publicVersionId !== undefined) {
    headers.set("Kiriko-Version-Id", publicVersionId);
  }
  if (seq !== undefined) {
    headers.set("Kiriko-Version-Seq", String(seq));
  }
  return {
    ok: true,
    status: 200,
    headers,
    arrayBuffer: vi.fn().mockResolvedValue(buffer),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  hydrateVenueMock.mockReset();
  createdWorkers.length = 0;
  workerBehavior.throwOnPostMessage = false;
  workerBehavior.throwOnConstruct = false;
});

describe("loadKirikoBundle", () => {
  it("returns hydrated venue, decoded metadata, and a valid public version identity", async () => {
    const buffer = new TextEncoder().encode("kvb1-fixture").buffer;
    const publicVersionId = "a".repeat(64);
    const response = okResponse(buffer, publicVersionId);
    const arrayBuffer = vi.mocked(response.arrayBuffer);
    arrayBuffer.mockImplementationOnce(async () => {
      response.headers.set("Kiriko-Version-Id", "B".repeat(64));
      return buffer;
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));

    expect(fetchMock).toHaveBeenCalledWith(SRC, { signal: null });

    const worker = createdWorkers[0]!;
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const [message, transfer] = worker.postMessage.mock.calls[0]!;
    expect(message).toEqual({ type: "decode", buffer });
    expect(transfer).toEqual([buffer]);

    const dto = { venueId: "v1", datasetId: "default/minimal", version: 1 };
    const hydrated = { venue: { id: "v1" } };
    hydrateVenueMock.mockReturnValueOnce(hydrated);
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "loaded", venue: dto, hasGraph: true } }));

    await expect(promise).resolves.toEqual({
      venue: hydrated,
      metadata: { datasetId: "default/minimal", version: 1 },
      publicVersionId,
      hasGraph: true,
      hasFacilities: false,
      facilities: [],
      seq: null,
    });
    expect(hydrateVenueMock).toHaveBeenCalledWith(dto);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", undefined],
    ["uppercase", "A".repeat(64)],
    ["short", "a".repeat(63)],
    ["non-hex", `${"a".repeat(63)}g`],
  ])("loads the venue but returns null identity for a %s header", async (_label, header) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4), header)));
    const hydrated = { venue: { id: "v1" } };
    hydrateVenueMock.mockReturnValueOnce(hydrated);

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    createdWorkers[0]!.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "loaded",
          venue: { venueId: "v1", datasetId: "default/minimal", version: 1 },
        },
      }),
    );

    await expect(promise).resolves.toEqual({
      venue: hydrated,
      metadata: { datasetId: "default/minimal", version: 1 },
      publicVersionId: null,
      hasGraph: false,
      hasFacilities: false,
      facilities: [],
      seq: null,
    });
    expect(createdWorkers[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it("admits the response sequence when the header matches the decoded version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4), "a".repeat(64), 5)),
    );
    hydrateVenueMock.mockReturnValueOnce({ venue: { id: "v1" } });

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    createdWorkers[0]!.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "loaded",
          venue: { venueId: "v1", datasetId: "default/minimal", version: 5 },
        },
      }),
    );

    await expect(promise).resolves.toMatchObject({
      publicVersionId: "a".repeat(64),
      seq: 5,
    });
  });

  it("does not admit a pin-safe sequence when the header disagrees with the decoded version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4), "a".repeat(64), 5)),
    );
    hydrateVenueMock.mockReturnValueOnce({ venue: { id: "v1" } });

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    createdWorkers[0]!.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "loaded",
          venue: { venueId: "v1", datasetId: "default/minimal", version: 7 },
        },
      }),
    );

    await expect(promise).resolves.toMatchObject({ seq: null });
  });

  it.each([
    ["missing", undefined],
    ["zero", "0"],
    ["negative", "-3"],
    ["fractional", "2.5"],
    ["non-numeric", "abc"],
    ["empty", ""],
  ])("never admits a pin-safe sequence for a %s header", async (_label, seq) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4), "a".repeat(64), seq)),
    );
    hydrateVenueMock.mockReturnValueOnce({ venue: { id: "v1" } });

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    createdWorkers[0]!.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "loaded",
          venue: { venueId: "v1", datasetId: "default/minimal", version: 1 },
        },
      }),
    );

    await expect(promise).resolves.toMatchObject({ seq: null });
  });

  it("creates a new worker for each call", async () => {
    const buffer1 = new ArrayBuffer(4);
    const buffer2 = new ArrayBuffer(4);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(okResponse(buffer1)).mockResolvedValueOnce(okResponse(buffer2)),
    );

    const first = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    hydrateVenueMock.mockReturnValueOnce({ n: 1 });
    createdWorkers[0]!.dispatchEvent(
      new MessageEvent("message", { data: { type: "loaded", venue: {} } }),
    );
    await first;

    const second = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(2));
    hydrateVenueMock.mockReturnValueOnce({ n: 2 });
    createdWorkers[1]!.dispatchEvent(
      new MessageEvent("message", { data: { type: "loaded", venue: {} } }),
    );
    await second;

    expect(createdWorkers[0]).not.toBe(createdWorkers[1]);
    expect(createdWorkers[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(createdWorkers[1]!.terminate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid_bundle", "This venue bundle is corrupted and could not be read."],
    [
      "unsupported_bundle_version",
      "This venue bundle was published for a newer viewer. Refresh the page to update.",
    ],
    [
      "bundle_integrity_failed",
      "This venue bundle failed an integrity check and could not be trusted.",
    ],
    ["bundle_too_large", "This venue bundle exceeds the viewer\u2019s size limit."],
  ] as const)(
    "rejects with a reconstructed VenueLoadError and terminates the worker for %s",
    async (code, message) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));

      const promise = loadKirikoBundle(SRC);
      await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
      const worker = createdWorkers[0]!;
      worker.dispatchEvent(
        new MessageEvent("message", { data: { type: "failed", error: { code, message } } }),
      );

      const error = await promise.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VenueLoadError);
      expect((error as VenueLoadError).code).toBe(code);
      expect((error as VenueLoadError).message).toBe(message);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects with a worker_failed VenueLoadError and terminates on a malformed message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(new MessageEvent("message", { data: { totally: "unexpected" } }));

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("worker_failed");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects with a worker_failed VenueLoadError and terminates on a worker error event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(new Event("error"));

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("worker_failed");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects with a fetch_failed VenueLoadError on a non-ok response and never spawns a worker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 } as unknown as Response),
    );

    const error = await loadKirikoBundle(SRC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("fetch_failed");
    expect((error as VenueLoadError).details).toMatchObject({ status: 404 });
    expect(createdWorkers).toHaveLength(0);
  });

  it("rejects with a fetch_failed VenueLoadError on a network rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const error = await loadKirikoBundle(SRC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("fetch_failed");
    expect(createdWorkers).toHaveLength(0);
  });

  it("rejects with AbortError before starting the fetch when already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    const error = await loadKirikoBundle(SRC, controller.signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createdWorkers).toHaveLength(0);
  });

  it("rethrows an AbortError raised during the fetch unchanged and never spawns a worker", async () => {
    const abort = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    const controller = new AbortController();

    const error = await loadKirikoBundle(SRC, controller.signal).catch((e: unknown) => e);
    expect(error).toBe(abort);
    expect(createdWorkers).toHaveLength(0);
  });

  it("aborts during worker decode, terminates the worker, and ignores a stale response afterward", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));
    const controller = new AbortController();

    const promise = loadKirikoBundle(SRC, controller.signal);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;

    controller.abort();

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect((error as DOMException).message).toBe("Aborted");
    expect(worker.terminate).toHaveBeenCalledTimes(1);

    // Stale success arriving after the abort must be ignored: no hydration,
    // no unhandled rejection, no double termination.
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "loaded", venue: {} } }));
    expect(hydrateVenueMock).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects with a fetch_failed VenueLoadError when reading the response body fails", async () => {
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: vi.fn().mockRejectedValue(new TypeError("body stream error")),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const error = await loadKirikoBundle(SRC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("fetch_failed");
    expect(createdWorkers).toHaveLength(0);
  });

  it("rethrows an AbortError raised while reading the response body unchanged", async () => {
    const abort = new DOMException("Aborted", "AbortError");
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: vi.fn().mockRejectedValue(abort),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const error = await loadKirikoBundle(SRC).catch((e: unknown) => e);
    expect(error).toBe(abort);
    expect(createdWorkers).toHaveLength(0);
  });

  it("aborts a pending fetch through the supplied signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, options?: { signal?: AbortSignal | null }) => {
        return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }),
    );
    const controller = new AbortController();

    const promise = loadKirikoBundle(SRC, controller.signal);
    controller.abort();

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(createdWorkers).toHaveLength(0);
  });

  it("rejects with a worker_failed VenueLoadError and terminates when postMessage throws synchronously", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));
    workerBehavior.throwOnPostMessage = true;

    const error = await loadKirikoBundle(SRC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("worker_failed");
    expect(createdWorkers).toHaveLength(1);
    expect(createdWorkers[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects with a worker_failed VenueLoadError and terminates on a messageerror event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(new Event("messageerror"));

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("worker_failed");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects with the exact VenueLoadError thrown by hydrateVenue, passed through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));
    const hydrationFailure = new VenueLoadError("invalid_bundle", "bad references", { featureId: "x" });
    hydrateVenueMock.mockImplementationOnce(() => {
      throw hydrationFailure;
    });

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "loaded", venue: {} } }));

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBe(hydrationFailure);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("wraps a generic hydrateVenue throw into a worker_failed VenueLoadError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));
    hydrateVenueMock.mockImplementationOnce(() => {
      throw new TypeError("unexpected shape");
    });

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "loaded", venue: {} } }));

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("worker_failed");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("treats a failed message carrying a ZIP-only code as malformed, not a reconstructed VenueLoadError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "failed", error: { code: "fetch_failed", message: "should never happen" } },
      }),
    );

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("worker_failed");
    expect((error as VenueLoadError).message).not.toBe("should never happen");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["null", null],
    ["an array", ["oops"]],
    ["a scalar", "oops"],
    ["a Map instance", new Map([["a", 1]])],
    ["a Set instance", new Set(["a"])],
    ["a Date instance", new Date(0)],
  ] as const)(
    "treats a failed message with %s details as malformed, not a reconstructed VenueLoadError",
    async (_label, details) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));

      const promise = loadKirikoBundle(SRC);
      await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
      const worker = createdWorkers[0]!;
      worker.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "failed", error: { code: "invalid_bundle", message: "x", details } },
        }),
      );

      const error = await promise.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VenueLoadError);
      expect((error as VenueLoadError).code).toBe("worker_failed");
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts a failed message with valid plain-object details and preserves them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "failed",
          error: { code: "bundle_too_large", message: "too big", details: { bytes: 999 } },
        },
      }),
    );

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("bundle_too_large");
    expect((error as VenueLoadError).details).toEqual({ bytes: 999 });
  });

  it("ignores a stale event after a normal successful resolution", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));
    const hydrated = { n: "final" };
    hydrateVenueMock.mockReturnValueOnce(hydrated);

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "loaded",
          venue: { datasetId: "default/minimal", version: 1 },
        },
      }),
    );
    await expect(promise).resolves.toEqual({
      venue: hydrated,
      metadata: { datasetId: "default/minimal", version: 1 },
      publicVersionId: null,
      hasGraph: false,
      hasFacilities: false,
      facilities: [],
      seq: null,
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);

    worker.dispatchEvent(new Event("error"));
    worker.dispatchEvent(
      new MessageEvent("message", { data: { type: "failed", error: { code: "worker_failed", message: "x" } } }),
    );
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it("marks fetch_failed rejections with bundle provenance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 } as unknown as Response),
    );

    const error = await loadKirikoBundle(SRC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("fetch_failed");
    expect((error as VenueLoadError).source).toBe("bundle");
  });

  it("marks worker_failed rejections with bundle provenance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(new Event("error"));

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("worker_failed");
    expect((error as VenueLoadError).source).toBe("bundle");
  });

  it("marks rebuilt structured worker failures with bundle provenance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));

    const promise = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "failed",
          error: { code: "bundle_integrity_failed", message: "sha mismatch", details: { expected: "aa" } },
        },
      }),
    );

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("bundle_integrity_failed");
    expect((error as VenueLoadError).details).toMatchObject({ expected: "aa" });
    expect((error as VenueLoadError).source).toBe("bundle");
  });
  it("rejects with a sanitized bundle-provenance worker_failed when the worker constructor throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));
    workerBehavior.throwOnConstruct = true;

    const error = await loadKirikoBundle(SRC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueLoadError);
    expect((error as VenueLoadError).code).toBe("worker_failed");
    expect((error as VenueLoadError).source).toBe("bundle");
    expect((error as VenueLoadError).message).toContain("bundle");
    expect((error as VenueLoadError).message).not.toContain("SecurityError");
    expect((error as VenueLoadError).message).not.toContain("Content Security Policy");
    expect(createdWorkers).toHaveLength(0);
  });

  it("creates independent workers for truly concurrent calls, each resolving and terminating independently", async () => {
    const buffer1 = new ArrayBuffer(4);
    const buffer2 = new ArrayBuffer(4);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okResponse(buffer1, "1".repeat(64)))
        .mockResolvedValueOnce(okResponse(buffer2, "2".repeat(64))),
    );

    const first = loadKirikoBundle(SRC);
    const second = loadKirikoBundle(SRC);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(2));

    hydrateVenueMock.mockReturnValueOnce({ n: 1 }).mockReturnValueOnce({ n: 2 });
    createdWorkers[0]!.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "loaded", venue: { datasetId: "default/one", version: 1 } },
      }),
    );
    createdWorkers[1]!.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "loaded", venue: { datasetId: "default/two", version: 2 } },
      }),
    );

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual({
      venue: { n: 1 },
      metadata: { datasetId: "default/one", version: 1 },
      publicVersionId: "1".repeat(64),
      hasGraph: false,
      hasFacilities: false,
      facilities: [],
      seq: null,
    });
    expect(r2).toEqual({
      venue: { n: 2 },
      metadata: { datasetId: "default/two", version: 2 },
      publicVersionId: "2".repeat(64),
      hasGraph: false,
      hasFacilities: false,
      facilities: [],
      seq: null,
    });
    expect(createdWorkers[0]).not.toBe(createdWorkers[1]);
    expect(createdWorkers[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(createdWorkers[1]!.terminate).toHaveBeenCalledTimes(1);
  });

  it("removes every worker listener and the abort listener after a successful resolution", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));
    const controller = new AbortController();
    const addSignalSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSignalSpy = vi.spyOn(controller.signal, "removeEventListener");
    hydrateVenueMock.mockReturnValueOnce({ n: "ok" });

    const promise = loadKirikoBundle(SRC, controller.signal);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "loaded", venue: {} } }));
    await promise;

    const addCalls = vi.mocked(worker.addEventListener).mock.calls;
    const removeCalls = vi.mocked(worker.removeEventListener).mock.calls;
    expect(addCalls.map((call) => call[0]).sort()).toEqual(["error", "message", "messageerror"]);
    expect(removeCalls.map((call) => call[0]).sort()).toEqual(["error", "message", "messageerror"]);
    for (const type of ["message", "error", "messageerror"]) {
      const added = addCalls.find((call) => call[0] === type)?.[1];
      const removed = removeCalls.find((call) => call[0] === type)?.[1];
      expect(removed).toBe(added);
    }

    expect(addSignalSpy).toHaveBeenCalledTimes(1);
    expect(addSignalSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeSignalSpy).toHaveBeenCalledTimes(1);
    expect(removeSignalSpy.mock.calls[0]?.[1]).toBe(addSignalSpy.mock.calls[0]?.[1]);
  });

  it("removes every worker listener and the abort listener after a structured domain failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));
    const controller = new AbortController();
    const addSignalSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSignalSpy = vi.spyOn(controller.signal, "removeEventListener");

    const promise = loadKirikoBundle(SRC, controller.signal);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "failed", error: { code: "invalid_bundle", message: "bad" } },
      }),
    );
    await promise.catch(() => {});

    const addCalls = vi.mocked(worker.addEventListener).mock.calls;
    const removeCalls = vi.mocked(worker.removeEventListener).mock.calls;
    expect(removeCalls.map((call) => call[0]).sort()).toEqual(["error", "message", "messageerror"]);
    for (const type of ["message", "error", "messageerror"]) {
      const added = addCalls.find((call) => call[0] === type)?.[1];
      const removed = removeCalls.find((call) => call[0] === type)?.[1];
      expect(removed).toBe(added);
    }
    expect(removeSignalSpy).toHaveBeenCalledTimes(1);
    expect(removeSignalSpy.mock.calls[0]?.[1]).toBe(addSignalSpy.mock.calls[0]?.[1]);
  });

  it("removes every worker listener and the abort listener after an abort", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(new ArrayBuffer(4))));
    const controller = new AbortController();
    const addSignalSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSignalSpy = vi.spyOn(controller.signal, "removeEventListener");

    const promise = loadKirikoBundle(SRC, controller.signal);
    await vi.waitFor(() => expect(createdWorkers).toHaveLength(1));
    const worker = createdWorkers[0]!;
    controller.abort();
    await promise.catch(() => {});

    const addCalls = vi.mocked(worker.addEventListener).mock.calls;
    const removeCalls = vi.mocked(worker.removeEventListener).mock.calls;
    expect(removeCalls.map((call) => call[0]).sort()).toEqual(["error", "message", "messageerror"]);
    for (const type of ["message", "error", "messageerror"]) {
      const added = addCalls.find((call) => call[0] === type)?.[1];
      const removed = removeCalls.find((call) => call[0] === type)?.[1];
      expect(removed).toBe(added);
    }
    expect(removeSignalSpy).toHaveBeenCalledTimes(1);
    expect(removeSignalSpy.mock.calls[0]?.[1]).toBe(addSignalSpy.mock.calls[0]?.[1]);
  });
});
