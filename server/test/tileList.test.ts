/**
 * Listing a venue's tile packages (#80).
 *
 * The rows have existed since #71 and #74; nothing could read them back. Without
 * this route a producer's `packageId` lives only in a React state variable, so a
 * reload orphans an upload whose recovery is re-sending up to 172 MiB.
 *
 * The interesting assertions are about what the list says beyond the record:
 * whether a stored evaluation still describes the geometry it was measured
 * against, and whether a *published* version serves the package. Both are
 * answers the server already computes for activation and could not report.
 */
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildMinimalImdfZip } from "../../tests/fixtures/buildMinimalImdfZip";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";
import { corridorPackageGlb, rootTransform } from "../../tests/fixtures/tileRegistration";
import { venuePlaneFromBundle } from "./tileRegistrationFixtures";
import { tilesetFixture } from "../../tests/fixtures/tileFixtures";

afterEach(cleanupTestApps);

const LEVEL_B1 = "b1000001-0000-4000-8000-0000000000b1";

function multipart(bytes: Uint8Array, filename: string, type: string) {
  const boundary = "----kirikoTileListBoundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`,
  );
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

interface Venue {
  app: FastifyInstance;
  cookie: string;
  venueId: number;
  bundleHash: string;
}

async function publishedVenue(name: string, app?: FastifyInstance, cookie?: string): Promise<Venue> {
  const server = app ?? (await makeTestApp()).app;
  const session = cookie ?? (await loginCookie(server));
  const created = await server.inject({
    method: "POST",
    url: "/api/venues",
    headers: { cookie: session },
    payload: { name },
  });
  const venue = created.json<{ venue: { id: number } }>().venue;
  const upload = multipart(await buildMinimalImdfZip(), "v.zip", "application/zip");
  await server.inject({
    method: "POST",
    url: `/api/venues/${venue.id}/versions`,
    headers: { cookie: session, ...upload.headers },
    payload: upload.payload,
  });
  await server.queue.idle();
  const version = server.db
    .prepare(
      `SELECT bundle_hash AS bundleHash FROM versions
       WHERE venue_id = ? AND status = 'published'`,
    )
    .get(venue.id) as { bundleHash: string };
  return { app: server, cookie: session, venueId: venue.id, bundleHash: version.bundleHash };
}

async function ingestCorridor(venue: Venue, inset = 0): Promise<number> {
  const plane = await venuePlaneFromBundle(venue.app.blobs.read(venue.bundleHash), LEVEL_B1);
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0 });
  await writer.add("tileset.json", new Uint8ArrayReader(tilesetFixture("content/model.glb", rootTransform())));
  await writer.add("content/model.glb", new Uint8ArrayReader(corridorPackageGlb(inset, plane)));
  const zip = Buffer.from(await writer.close());
  const upload = multipart(zip, "tiles.zip", "application/zip");
  const response = await venue.app.inject({
    method: "POST",
    url: `/api/venues/${venue.venueId}/tiles/inspect`,
    headers: { cookie: venue.cookie, ...upload.headers },
    payload: upload.payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ packageId: number }>().packageId;
}

interface ListedPackage {
  packageId: number;
  sourceHash: string;
  rootTileset: string;
  totalBytes: number;
  memberCount: number;
  serving: boolean;
  evaluation: {
    state: string;
    current: boolean;
    gates: unknown[];
    report: { floors: { canonicalLevelId: string }[] };
    activatedAt: string | null;
    capabilityProfile: string | null;
  } | null;
}

async function list(venue: Venue): Promise<ListedPackage[]> {
  const response = await venue.app.inject({
    method: "GET",
    url: `/api/venues/${venue.venueId}/tiles`,
    headers: { cookie: venue.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ packages: ListedPackage[] }>().packages;
}

async function republish(venue: Venue): Promise<void> {
  const upload = multipart(await buildMinimalImdfZip(), "again.zip", "application/zip");
  await venue.app.inject({
    method: "POST",
    url: `/api/venues/${venue.venueId}/versions`,
    headers: { cookie: venue.cookie, ...upload.headers },
    payload: upload.payload,
  });
  await venue.app.queue.idle();
}

describe("tile package list", () => {
  it("describes an ingested package that has not been evaluated", async () => {
    const venue = await publishedVenue("Listing");
    const packageId = await ingestCorridor(venue);

    const packages = await list(venue);

    expect(packages).toHaveLength(1);
    const entry = packages[0]!;
    expect(entry.packageId).toBe(packageId);
    expect(entry.rootTileset).toBe("tileset.json");
    expect(entry.memberCount).toBe(2);
    expect(entry.totalBytes).toBeGreaterThan(0);
    expect(entry.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    // Nothing has measured it, which is different from measuring it as bad.
    expect(entry.evaluation).toBeNull();
    expect(entry.serving).toBe(false);
  });

  it("carries the stored evaluation, its gates, and its report", async () => {
    const venue = await publishedVenue("Evaluated");
    const packageId = await ingestCorridor(venue);
    await venue.app.inject({
      method: "POST",
      url: `/api/venues/${venue.venueId}/tiles/${packageId}/registration`,
      headers: { cookie: venue.cookie },
      payload: { capabilityProfile: "webgl2-mrt-float" },
    });

    const entry = (await list(venue))[0]!;

    expect(entry.evaluation).not.toBeNull();
    expect(entry.evaluation!.state).toBe("evaluated");
    expect(entry.evaluation!.gates).toEqual([]);
    expect(entry.evaluation!.capabilityProfile).toBe("webgl2-mrt-float");
    expect(entry.evaluation!.activatedAt).toBeNull();
    // The report is the reason this route exists: a producer reads the numbers
    // back after a reload rather than re-uploading to see them again.
    expect(entry.evaluation!.report.floors[0]?.canonicalLevelId).toBe(LEVEL_B1);
    expect(entry.evaluation!.current).toBe(true);
  });

  it("reports an evaluation as no longer current once the venue republishes", async () => {
    // Exactly the condition `activate` refuses with `evaluation_stale`. The
    // client must not re-derive that rule; two answers to "may this activate"
    // is one too many.
    const venue = await publishedVenue("Stale");
    const packageId = await ingestCorridor(venue);
    await venue.app.inject({
      method: "POST",
      url: `/api/venues/${venue.venueId}/tiles/${packageId}/registration`,
      headers: { cookie: venue.cookie },
      payload: { capabilityProfile: "webgl2-mrt-float" },
    });
    expect((await list(venue))[0]!.evaluation!.current).toBe(true);

    await republish(venue);

    const entry = (await list(venue))[0]!;
    expect(entry.evaluation).not.toBeNull();
    expect(entry.evaluation!.current).toBe(false);
  });

  it("marks a package as serving once activation publishes a version", async () => {
    const venue = await publishedVenue("Serving");
    const packageId = await ingestCorridor(venue);
    await venue.app.inject({
      method: "POST",
      url: `/api/venues/${venue.venueId}/tiles/${packageId}/registration`,
      headers: { cookie: venue.cookie },
      payload: { capabilityProfile: "webgl2-mrt-float" },
    });
    const activated = await venue.app.inject({
      method: "POST",
      url: `/api/venues/${venue.venueId}/tiles/${packageId}/activate`,
      headers: { cookie: venue.cookie },
      payload: { mappingConfirmed: true },
    });
    expect(activated.statusCode, activated.body).toBe(202);
    await venue.app.queue.idle();

    const entry = (await list(venue))[0]!;
    expect(entry.serving).toBe(true);
    expect(entry.evaluation!.state).toBe("activated");
    expect(entry.evaluation!.activatedAt).not.toBeNull();
  });

  it("stops calling a historical package serving after a plain publication supersedes it", async () => {
    const venue = await publishedVenue("Superseded serving");
    const packageId = await ingestCorridor(venue);
    await venue.app.inject({
      method: "POST",
      url: `/api/venues/${venue.venueId}/tiles/${packageId}/registration`,
      headers: { cookie: venue.cookie },
      payload: { capabilityProfile: "webgl2-mrt-float" },
    });
    const activated = await venue.app.inject({
      method: "POST",
      url: `/api/venues/${venue.venueId}/tiles/${packageId}/activate`,
      headers: { cookie: venue.cookie },
      payload: { mappingConfirmed: true },
    });
    expect(activated.statusCode, activated.body).toBe(202);
    await venue.app.queue.idle();
    expect((await list(venue))[0]!.serving).toBe(true);

    await republish(venue);

    expect((await list(venue))[0]!.serving).toBe(false);
  });

  it("lists newest first", async () => {
    const venue = await publishedVenue("Ordering");
    const first = await ingestCorridor(venue, 0);
    const second = await ingestCorridor(venue, 0.05);

    const packages = await list(venue);

    expect(packages.map((entry) => entry.packageId)).toEqual([second, first]);
  });

  it("never lists another venue's packages", async () => {
    const mine = await publishedVenue("Mine");
    const theirs = await publishedVenue("Theirs", mine.app, mine.cookie);
    await ingestCorridor(theirs);

    expect(await list(mine)).toEqual([]);
    expect(await list(theirs)).toHaveLength(1);
  });

  it("answers 404 for a venue that does not exist", async () => {
    const venue = await publishedVenue("Absent");

    const response = await venue.app.inject({
      method: "GET",
      url: `/api/venues/${venue.venueId + 9999}/tiles`,
      headers: { cookie: venue.cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe("venue_not_found");
  });

  it("requires a producer session", async () => {
    const venue = await publishedVenue("Guarded");

    const response = await venue.app.inject({
      method: "GET",
      url: `/api/venues/${venue.venueId}/tiles`,
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("venue summary tiles", () => {
  async function summary(venue: Venue): Promise<{
    tiles?: { packages: number; activeOnLatest: boolean };
  }> {
    const response = await venue.app.inject({
      method: "GET",
      url: "/api/venues",
      headers: { cookie: venue.cookie },
    });
    expect(response.statusCode).toBe(200);
    const venues = response.json<{
      venues: { id: number; tiles?: { packages: number; activeOnLatest: boolean } }[];
    }>().venues;
    const found = venues.find((entry) => entry.id === venue.venueId);
    expect(found).toBeDefined();
    return found!;
  }

  it("counts nothing for a venue that has never had a package", async () => {
    const venue = await publishedVenue("Plain");

    expect((await summary(venue)).tiles).toEqual({ packages: 0, activeOnLatest: false });
  });

  it("counts an ingested package without claiming the latest version renders it", async () => {
    // The distinction the gallery needs: a venue can hold a package for a week
    // without a single reviewer seeing tiles, because activation is explicit.
    const venue = await publishedVenue("Ingested");
    await ingestCorridor(venue);

    expect((await summary(venue)).tiles).toEqual({ packages: 1, activeOnLatest: false });
  });

  it("reports the latest version as rendering tiles once activated", async () => {
    const venue = await publishedVenue("Activated");
    const packageId = await ingestCorridor(venue);
    await venue.app.inject({
      method: "POST",
      url: `/api/venues/${venue.venueId}/tiles/${packageId}/registration`,
      headers: { cookie: venue.cookie },
      payload: { capabilityProfile: "webgl2-mrt-float" },
    });
    await venue.app.inject({
      method: "POST",
      url: `/api/venues/${venue.venueId}/tiles/${packageId}/activate`,
      headers: { cookie: venue.cookie },
      payload: { mappingConfirmed: true },
    });
    await venue.app.queue.idle();

    expect((await summary(venue)).tiles).toEqual({ packages: 1, activeOnLatest: true });
  });

  it("stops claiming tiles once a plain version is published over the activated one", async () => {
    // #30 section 1: every version retains a generated scene, and a new version
    // published from IMDF alone carries no descriptor. The latest version is what
    // a viewer opens, so the gallery must follow it rather than the venue's
    // history.
    const venue = await publishedVenue("Superseded");
    const packageId = await ingestCorridor(venue);
    await venue.app.inject({
      method: "POST",
      url: `/api/venues/${venue.venueId}/tiles/${packageId}/registration`,
      headers: { cookie: venue.cookie },
      payload: { capabilityProfile: "webgl2-mrt-float" },
    });
    await venue.app.inject({
      method: "POST",
      url: `/api/venues/${venue.venueId}/tiles/${packageId}/activate`,
      headers: { cookie: venue.cookie },
      payload: { mappingConfirmed: true },
    });
    await venue.app.queue.idle();
    expect((await summary(venue)).tiles?.activeOnLatest).toBe(true);

    await republish(venue);

    expect((await summary(venue)).tiles).toEqual({ packages: 1, activeOnLatest: false });
  });
});
