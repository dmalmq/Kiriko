import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { api, ApiError, datasetBundleUrl, gdbErrorMessage, publishErrorMessage, viewerHref } from "./api";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe("gallery api client", () => {
  it("builds dataset bundle URLs", () => {
    expect(datasetBundleUrl("tokyo-station")).toBe("/v/default/tokyo-station/bundle");
  });

  it("appends a 64-hex public version id as a pinned bundle URL, ignoring invalid ids", () => {
    const id = "a".repeat(64);
    expect(datasetBundleUrl("tokyo-station", id)).toBe(`/v/default/tokyo-station/bundle@${id}`);
    expect(datasetBundleUrl("tokyo-station")).toBe("/v/default/tokyo-station/bundle");
    expect(datasetBundleUrl("tokyo-station", "4")).toBe("/v/default/tokyo-station/bundle"); // legacy numeric
    expect(datasetBundleUrl("tokyo-station", "A".repeat(64))).toBe("/v/default/tokyo-station/bundle"); // uppercase
    expect(datasetBundleUrl("tokyo-station", "a".repeat(63))).toBe("/v/default/tokyo-station/bundle"); // short
  });

  it("builds a locale-tagged viewer link that pins a valid public version id", () => {
    const id = "a".repeat(64);
    expect(viewerHref("tokyo-station", id, "ja")).toBe(`/?dataset=tokyo-station&lang=ja&version=${id}`);
    expect(viewerHref("tokyo-station", id, "en", { review: true })).toBe(
      `/?dataset=tokyo-station&lang=en&version=${id}&review=1`,
    );
  });

  it("omits the version for an absent or invalid public version id", () => {
    expect(viewerHref("tokyo-station", null, "en")).toBe("/?dataset=tokyo-station&lang=en");
    expect(viewerHref("tokyo-station", "4", "ja")).toBe("/?dataset=tokyo-station&lang=ja");
    expect(viewerHref("tokyo-station", "A".repeat(64), "ja")).toBe("/?dataset=tokyo-station&lang=ja");
    expect(viewerHref("tokyo-station", null, "ja", { review: true })).toBe(
      "/?dataset=tokyo-station&lang=ja&review=1",
    );
  });

  it("opts the viewer into 3D with the same parameter the viewer parses", () => {
    // A gallery link is the only discoverable way into the scene, so the
    // spelling here has to be the one `parseViewerParams` accepts.
    expect(viewerHref("tokyo-station", null, "en", { scene: true })).toBe(
      "/?dataset=tokyo-station&lang=en&scene=1",
    );
    const id = "a".repeat(64);
    expect(viewerHref("tokyo-station", id, "ja", { scene: true, review: true })).toBe(
      `/?dataset=tokyo-station&lang=ja&version=${id}&review=1&scene=1`,
    );
    expect(viewerHref("tokyo-station", null, "en", { scene: false })).toBe(
      "/?dataset=tokyo-station&lang=en",
    );
  });

  it("me() returns null on 401 instead of throwing", async () => {
    mockFetch(401, { error: "unauthorized" });
    expect(await api.me()).toBeNull();
  });

  it("listVenues unwraps the venues array and throws ApiError on failure", async () => {
    mockFetch(200, { venues: [{ id: 1, slug: "a", name: "A", createdAt: "", latest: null }] });
    expect((await api.listVenues())[0]?.slug).toBe("a");

    mockFetch(500, { error: "boom" });
    await expect(api.listVenues()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("publishErrorMessage", () => {
  it("maps known structured importer codes to corrective copy without JSON or details", () => {
    const message = publishErrorMessage(
      JSON.stringify({
        code: "missing_required_file",
        message: "importer: manifest.json is missing",
        details: { entry: "manifest.json" },
      }),
    );
    expect(message).toContain("missing a required IMDF file");
    expect(message).not.toContain("{");
    expect(message).not.toContain("manifest.json");
  });

  it("maps every stable publish code to non-JSON corrective copy", () => {
    const codes = [
      "unsupported_file",
      "archive_too_large",
      "unsafe_archive_path",
      "invalid_archive",
      "missing_required_file",
      "invalid_json",
      "invalid_manifest_version",
      "invalid_feature_collection",
      "duplicate_feature_id",
      "stale_version",
    ];
    for (const code of codes) {
      const message = publishErrorMessage(JSON.stringify({ code, message: "raw importer text" }));
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("{");
      expect(message).not.toContain(code);
      expect(message).not.toContain("raw importer text");
    }
  });

  it("hides unknown structured codes and internal messages behind generic copy", () => {
    for (const raw of [
      JSON.stringify({ code: "internal_error", message: "SQLITE_BUSY: locked" }),
      JSON.stringify({ code: "bridge_error", message: "napi panic: unreachable" }),
      JSON.stringify({ code: "some_future_code", message: "???" }),
    ]) {
      const message = publishErrorMessage(raw);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("{");
      expect(message).not.toContain("SQLITE_BUSY");
      expect(message).not.toContain("panic");
    }
  });

  it("never returns raw JSON for structured payloads of the wrong shape", () => {
    for (const raw of ['{"unexpected":true}', "[1,2,3]", '"quoted"', "42", "null"]) {
      const message = publishErrorMessage(raw);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("{");
      expect(message).not.toContain("[");
      expect(message).not.toContain("unexpected");
    }
  });

  it("passes legacy plain error text through unchanged", () => {
    expect(publishErrorMessage("not a ZIP archive")).toBe("not a ZIP archive");
    expect(publishErrorMessage("timed out")).toBe("timed out");
    expect(publishErrorMessage("unknown error")).toBe("unknown error");
  });
});

describe("gdb api", () => {
  it("publishGdb posts the plan and returns the job envelope", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          jobId: "j1",
          versionId: 7,
          seq: 1,
          excludedLayers: [{ layer: "Bad_Layer", reason: "empty or geometry-less layer" }],
        }),
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await api.publishGdb(7, "a".repeat(64), {
      venueName: "V", buildings: [], layers: [],
    });
    expect(result).toEqual({
      jobId: "j1",
      versionId: 7,
      seq: 1,
      excludedLayers: [{ layer: "Bad_Layer", reason: "empty or geometry-less layer" }],
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ venueId: 7, blobHash: "a".repeat(64) });
  });

  it("gdbErrorMessage maps known codes and names the blamed layer", () => {
    expect(gdbErrorMessage({ code: "invalid_geodatabase", message: "x" }, "en")).toContain("File Geodatabase");
    const conv = gdbErrorMessage(
      { code: "gdb_conversion_failed", message: "x", details: { layer: "Station_1_Space", reason: "empty or geometry-less layer" } },
      "en",
    );
    expect(conv).toContain("Station_1_Space");
  });

  it("maps no_routable_network to actionable copy", () => {
    expect(gdbErrorMessage({ code: "no_routable_network", message: "x" }, "en")).toContain("walkable");
  });
});

describe("waitForJob", () => {
  it("polls queued/running jobs until they finish", async () => {
    vi.useFakeTimers({ now: 0 });
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "queued", error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "running", error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "done", error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = api.waitForJob("job-done");
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toEqual({ status: "done" });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("keeps polling through transient status fetch failures", async () => {
    vi.useFakeTimers({ now: 0 });
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network hiccup"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "done", error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = api.waitForJob("job-flaky", { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toEqual({ status: "done" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns terminal server errors without treating them as timeouts", async () => {
    vi.useFakeTimers({ now: 0 });
    const structured = JSON.stringify({ code: "no_routable_network", message: "empty graph" });
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "running", error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "error", error: structured }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = api.waitForJob("job-error");
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toEqual({ status: "error", error: structured });
  });

  it("returns timeout as a non-terminal client result", async () => {
    vi.useFakeTimers({ now: 0 });
    const fetchSpy = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ status: "running", error: null }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = api.waitForJob("job-timeout", { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toEqual({ status: "timeout" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("times out a stalled status fetch at the overall deadline", async () => {
    vi.useFakeTimers({ now: 0 });
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let fetchSignal: AbortSignal | undefined;
    const fetchSpy = vi.fn<typeof fetch>((_url, init) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = api.waitForJob("job-stalled", { timeoutMs: 1_000, signal: controller.signal });
    const settled = vi.fn();
    const rejected = vi.fn();
    void result.then(settled, rejected);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    try {
      expect(fetchSignal?.aborted).toBe(true);
      expect(settled).toHaveBeenCalledWith({ status: "timeout" });
      expect(rejected).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      controller.abort();
      await result.catch(() => {});
    }
  });

  it("aborts the in-flight status fetch", async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    const fetchSpy = vi.fn<typeof fetch>((_url, init) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      // Executor form required: tsconfig lib predates Promise.withResolvers.
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = api.waitForJob("job-abort-fetch", { signal: controller.signal });
    await Promise.resolve();
    expect(fetchSignal).not.toBe(controller.signal);
    expect(fetchSignal?.aborted).toBe(false);
    controller.abort();
    expect(fetchSignal?.aborted).toBe(true);

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts the polling delay without waiting for the next interval", async () => {
    vi.useFakeTimers({ now: 0 });
    const controller = new AbortController();
    const fetchSpy = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ status: "running", error: null }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = api.waitForJob("job-abort-delay", { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("augmentGdb", () => {
  it("posts venueId + blob hashes and returns the accepted job", async () => {
    const fetchSpy = vi.fn(
      (..._args: unknown[]) =>
        Promise.resolve(
          new Response(JSON.stringify({ jobId: "j1", versionId: 2, seq: 2 }), { status: 202 }),
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const out = await api.augmentGdb(7, { networkBlobHash: "n".repeat(64) });
    expect(out).toEqual({ jobId: "j1", versionId: 2, seq: 2 });
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe("/api/gdb/augment");
    const init = call[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ venueId: 7, networkBlobHash: "n".repeat(64) });
  });

  it("throws the parsed GdbError on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "no_base_version" }), { status: 404 })),
    );
    await expect(api.augmentGdb(7, { networkBlobHash: "n".repeat(64) })).rejects.toMatchObject({
      error: "no_base_version",
    });
  });
});

describe("generateNetwork", () => {
  it("posts venueId and returns the accepted job with its duration estimate", async () => {
    const fetchSpy = vi.fn(
      (..._args: unknown[]) =>
        Promise.resolve(
          new Response(JSON.stringify({ jobId: "j2", versionId: 3, seq: 3, estimatedDurationSeconds: 45 }), { status: 202 }),
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const out = await api.generateNetwork(9);
    expect(out).toEqual({ jobId: "j2", versionId: 3, seq: 3, estimatedDurationSeconds: 45 });
    expectTypeOf(out).toEqualTypeOf<{
      jobId: string;
      versionId: number;
      seq: number;
      estimatedDurationSeconds: number | null;
    }>();
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe("/api/gdb/generate-network");
    const init = call[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ venueId: 9 });
  });

  it("rejects a malformed duration estimate from the server", async () => {
    mockFetch(202, {
      jobId: "j2",
      versionId: 3,
      seq: 3,
      estimatedDurationSeconds: 0,
    });

    await expect(api.generateNetwork(9)).rejects.toMatchObject({
      status: 502,
    });
  });

  it("throws the parsed GdbError on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "no_base_version" }), { status: 404 })),
    );
    await expect(api.generateNetwork(9)).rejects.toMatchObject({ error: "no_base_version" });
  });
});

describe("importNetwork", () => {
  it("posts the edited graph keyed by slug and returns the accepted job", async () => {
    const fetchSpy = vi.fn(
      (..._args: unknown[]) =>
        Promise.resolve(
          new Response(JSON.stringify({ jobId: "j3", versionId: 7, seq: 4, publicVersionId: "b".repeat(64) }), { status: 202 }),
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const id = "a".repeat(64);
    const out = await api.importNetwork("shinjuku", id, '{"j":1}', '{"p":1}');
    expect(out).toEqual({ jobId: "j3", versionId: 7, seq: 4, publicVersionId: "b".repeat(64) });
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe("/api/gdb/import-network");
    const init = call[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      slug: "shinjuku",
      publicVersionId: id,
      junctions: '{"j":1}',
      paths: '{"p":1}',
    });
  });

  it("throws the parsed GdbError on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "no_base_version" }), { status: 404 })),
    );
    await expect(api.importNetwork("shinjuku", "a".repeat(64), "{}", "{}")).rejects.toMatchObject({
      error: "no_base_version",
    });
  });
});

describe("exportNetwork", () => {
  it("posts venueId and returns the blob + filename from content-disposition", async () => {
    const fetchSpy = vi.fn((..._args: unknown[]) =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="tokyo-network.gdb.zip"',
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const out = await api.exportNetwork(7);
    expect(out.filename).toBe("tokyo-network.gdb.zip");
    expect(out.blob).toBeInstanceOf(Blob);
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe("/api/gdb/export-network");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ venueId: 7 });
  });

  it("throws the parsed GdbError on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "no_graph" }), { status: 404 })),
    );
    await expect(api.exportNetwork(7)).rejects.toMatchObject({ error: "no_graph" });
  });
});

describe("getGdbMapping", () => {
  it("GETs the venue mapping endpoint and returns the parsed body", async () => {
    const body = {
      blobHash: "b".repeat(64),
      inspection: { databases: [], warnings: [] },
      plan: { venueName: "X", buildings: [], layers: [] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((..._args: unknown[]) =>
        Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
      ),
    );
    const out = await api.getGdbMapping(42);
    expect(out).toEqual(body);
  });
});
