import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { api, TileApiError } from "./api";
import { tileErrorMessage, tileGateMessage } from "./tileGates";
import type { TilePackageListEntry } from "./tileTypes";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown): Mock {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const REPORT = {
  profileId: "default",
  profileVersion: 1,
  levels: [],
  floors: [],
  unmappedLevels: [],
  appliedVerticalOffsetM: 0,
  venueWide: { samples: 10, p50M: 0.1, p90M: 0.2, maxM: 0.3 },
};

describe("tile package api", () => {
  it("lists a venue's packages", async () => {
    const entry: TilePackageListEntry = {
      packageId: 7,
      sourceHash: "a".repeat(64),
      rootTileset: "tileset.json",
      assetVersions: ["1.1"],
      extensions: [],
      ignored: [],
      totalBytes: 1024,
      memberCount: 2,
      createdAt: "2026-08-10 00:00:00",
      evaluation: null,
      serving: false,
    };
    const fetchMock = mockFetch(200, { packages: [entry] });

    expect(await api.listTilePackages(3)).toEqual([entry]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/venues/3/tiles");
  });

  it("sends only the levers the producer actually set", async () => {
    // An empty profile must not become `{verticalOffsetM: 0}`: zero is a real
    // producer decision about the datum, and sending it unasked would record one
    // that was never made.
    const fetchMock = mockFetch(200, { state: "evaluated", report: REPORT, floorMappings: [], gates: [] });

    await api.evaluateTilePackage(3, 7, { capabilityProfile: "webgl2-mrt-float" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/venues/3/tiles/7/registration");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ capabilityProfile: "webgl2-mrt-float" });
  });

  it("sends the vertical offset, per-floor bands, and contextual objects when set", async () => {
    const fetchMock = mockFetch(200, { state: "evaluated", report: REPORT, floorMappings: [], gates: [] });

    await api.evaluateTilePackage(3, 7, {
      capabilityProfile: "webgl2-mrt-float",
      contextualSourceObjects: ["obj-1", "obj-2"],
      profile: { verticalOffsetM: -3.02, floorP90MaxM: { "level-b1": 0.95 } },
    });

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual({
      capabilityProfile: "webgl2-mrt-float",
      contextualSourceObjects: ["obj-1", "obj-2"],
      profile: { verticalOffsetM: -3.02, floorP90MaxM: { "level-b1": 0.95 } },
    });
  });

  it("surfaces the gates a blocked activation returns", async () => {
    // The blocked response carries the same gate shape an evaluation does, so
    // one presentation serves both rather than two that can drift.
    mockFetch(409, {
      error: "activation_blocked",
      code: "activation_blocked",
      message: "activation_blocked",
      details: {
        gates: [{ code: "registrationOutOfBand", subject: "level-b1", measured: 0.92, band: 0.5 }],
      },
    });

    const error = await api.activateTilePackage(3, 7).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TileApiError);
    const failure = error as TileApiError;
    expect(failure.code).toBe("activation_blocked");
    expect(failure.gates).toHaveLength(1);
    expect(failure.gates[0]?.measured).toBe(0.92);
  });

  it("carries the code for a refusal that has no gates", async () => {
    mockFetch(409, {
      error: "no_published_version",
      code: "no_published_version",
      message: "no_published_version",
    });

    const error = (await api
      .evaluateTilePackage(3, 7, {})
      .catch((thrown: unknown) => thrown)) as TileApiError;

    expect(error.code).toBe("no_published_version");
    expect(error.gates).toEqual([]);
    expect(error.status).toBe(409);
  });

  it("falls back to a code rather than inventing one when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502</html>", { status: 502 })),
    );

    const error = (await api.listTilePackages(3).catch((thrown: unknown) => thrown)) as TileApiError;

    expect(error).toBeInstanceOf(TileApiError);
    expect(error.status).toBe(502);
    // Unknown to the copy table, so it lands on the fallback sentence rather
    // than printing a server string at a producer.
    expect(tileErrorMessage(error.code, "en")).toBe("That could not be completed. Try again.");
  });

  it("accepts an activation and reports the version it will publish", async () => {
    mockFetch(202, { jobId: "job-1", versionId: 12, seq: 3 });

    expect(await api.activateTilePackage(3, 7)).toEqual({ jobId: "job-1", versionId: 12, seq: 3 });
  });

  it("discards a package", async () => {
    // 204 forbids a body, so this cannot go through `mockFetch`.
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.discardTilePackage(3, 7);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/venues/3/tiles/7");
    expect(init?.method).toBe("DELETE");
  });
});

describe("tile producer copy", () => {
  it("answers every route refusal in both languages", () => {
    const codes = [
      "file_required",
      "venue_not_found",
      "package_not_found",
      "package_in_use",
      "no_published_version",
      "not_evaluated",
      "evaluation_stale",
      "activation_blocked",
      "unsafe_archive_path",
      "invalid_archive",
    ];
    for (const code of codes) {
      for (const locale of ["ja", "en"] as const) {
        const message = tileErrorMessage(code, locale);
        expect(message.length).toBeGreaterThan(0);
        // A code is not copy. Leaking one means the table is missing an entry.
        expect(message).not.toContain(code);
      }
    }
  });

  it("prints a numeric gate's measurement beside the band it failed", () => {
    const message = tileGateMessage(
      { code: "registrationOutOfBand", subject: "level-b1", measured: 0.92, band: 0.5 },
      "en",
    );
    expect(message).toContain("0.92");
    expect(message).toContain("0.50");
    expect(message).toContain("level-b1");
  });
});
