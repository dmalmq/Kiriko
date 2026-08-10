/**
 * Tile-package ingestion through the real route and the real native bridge
 * (#71): what a producer can upload, what is refused, and what ends up stored.
 *
 * The packages here are built in memory, so every guarantee is provable without
 * the registered dataset. The GLB is a genuine glTF binary — ingestion validates
 * decode support by decoding, so a stub would be rejected for the wrong reason.
 */
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";
import { glbFixture as glb, tilesetFixture as tileset } from "../../tests/fixtures/tileFixtures";

afterEach(cleanupTestApps);

async function packageZip(entries: [string, Uint8Array][]): Promise<Buffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0 });
  for (const [path, bytes] of entries) {
    await writer.add(path, new Uint8ArrayReader(bytes));
  }
  return Buffer.from(await writer.close());
}

function multipart(bytes: Buffer): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----kirikoTileIngestBoundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="tiles.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  return {
    payload: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function venue(app: FastifyInstance, cookie: string, name: string): Promise<number> {
  const created = await app.inject({
    method: "POST",
    url: "/api/venues",
    headers: { cookie },
    payload: { name },
  });
  expect(created.statusCode).toBe(201);
  return created.json<{ venue: { id: number } }>().venue.id;
}

async function ingest(
  app: FastifyInstance,
  cookie: string,
  venueId: number,
  zip: Buffer,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const upload = multipart(zip);
  const response = await app.inject({
    method: "POST",
    url: `/api/venues/${venueId}/tiles/inspect`,
    headers: { cookie, ...upload.headers },
    payload: upload.payload,
  });
  return { statusCode: response.statusCode, body: response.json<Record<string, unknown>>() };
}

describe("tile package ingestion", () => {
  it("accepts a minimal package and records every member", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await venue(app, cookie, "Tiles Minimal");

    const zip = await packageZip([
      ["tileset.json", tileset("content/model.glb")],
      ["content/model.glb", glb(1)],
    ]);
    const { statusCode, body } = await ingest(app, cookie, venueId, zip);

    expect(statusCode, JSON.stringify(body)).toBe(201);
    expect(body["rootTileset"]).toBe("tileset.json");
    expect(body["assetVersions"]).toEqual(["1.1"]);

    const members = body["members"] as {
      path: string;
      hash: string;
      contentType: string;
      kind: string;
      byteSize: number;
    }[];
    expect(members.map((m) => m.path)).toEqual(["content/model.glb", "tileset.json"]);
    expect(members.find((m) => m.kind === "content")?.contentType).toBe("model/gltf-binary");
    expect(members.find((m) => m.kind === "tileset")?.contentType).toBe("application/json");

    // Every accepted member's bytes are in the content-addressed store, under
    // exactly the hash the validator recorded.
    for (const member of members) {
      expect(app.blobs.has(member.hash), `${member.path} stored`).toBe(true);
      expect(app.blobs.read(member.hash).byteLength).toBe(member.byteSize);
    }

    // And the record is queryable: ingestion attached it to the venue.
    const rows = app.db
      .prepare(
        `SELECT path, kind FROM tile_package_members
         WHERE package_id = (SELECT id FROM tile_packages WHERE venue_id = ?)
         ORDER BY path`,
      )
      .all(venueId);
    expect(rows).toHaveLength(2);
  });

  it("resolves a transitive graph and stores every member it reaches", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await venue(app, cookie, "Tiles Transitive");

    const child = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: "1.1" },
        geometricError: 0,
        root: {
          boundingVolume: { box: [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5] },
          geometricError: 0,
          content: { uri: "../content/deep.glb" },
        },
      }),
    );
    const zip = await packageZip([
      ["tileset.json", tileset("levels/child.json")],
      ["levels/child.json", child],
      ["content/deep.glb", glb(2)],
    ]);
    const { statusCode, body } = await ingest(app, cookie, venueId, zip);

    expect(statusCode, JSON.stringify(body)).toBe(201);
    const members = body["members"] as { path: string }[];
    expect(members.map((m) => m.path)).toEqual([
      "content/deep.glb",
      "levels/child.json",
      "tileset.json",
    ]);
  });

  it("stores a member shared with an earlier package only once", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const first = await venue(app, cookie, "Tiles Shared A");
    const second = await venue(app, cookie, "Tiles Shared B");

    const shared = glb(3);
    const zipA = await packageZip([
      ["tileset.json", tileset("content/model.glb")],
      ["content/model.glb", shared],
    ]);
    const zipB = await packageZip([
      ["tileset.json", tileset("content/model.glb")],
      ["content/model.glb", shared],
    ]);

    const a = await ingest(app, cookie, first, zipA);
    expect(a.statusCode, JSON.stringify(a.body)).toBe(201);
    const b = await ingest(app, cookie, second, zipB);
    expect(b.statusCode, JSON.stringify(b.body)).toBe(201);

    const memberOf = (body: Record<string, unknown>): { hash: string; reused: boolean } => {
      const members = body["members"] as { path: string; hash: string; reused: boolean }[];
      const found = members.find((m) => m.path === "content/model.glb");
      if (found === undefined) {
        throw new Error("shared member missing");
      }
      return found;
    };
    // Same bytes, same address — and the second ingest says so.
    expect(memberOf(b.body).hash).toBe(memberOf(a.body).hash);
    expect(memberOf(a.body).reused).toBe(false);
    expect(memberOf(b.body).reused).toBe(true);
  });

  it("is idempotent for identical bytes", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await venue(app, cookie, "Tiles Idempotent");

    const zip = await packageZip([
      ["tileset.json", tileset("content/model.glb")],
      ["content/model.glb", glb(4)],
    ]);
    const first = await ingest(app, cookie, venueId, zip);
    const second = await ingest(app, cookie, venueId, zip);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body["packageId"]).toBe(first.body["packageId"]);
    expect(second.body["sourceHash"]).toBe(first.body["sourceHash"]);

    const packages = app.db
      .prepare("SELECT COUNT(*) AS count FROM tile_packages WHERE venue_id = ?")
      .get(venueId);
    expect(packages).toMatchObject({ count: 1 });
  });

  it("reports entries the graph never references without storing them", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await venue(app, cookie, "Tiles Ignored");

    const stray = new TextEncoder().encode("export scratch");
    const zip = await packageZip([
      ["tileset.json", tileset("content/model.glb")],
      ["content/model.glb", glb(5)],
      ["NOTES.txt", stray],
    ]);
    const { statusCode, body } = await ingest(app, cookie, venueId, zip);

    expect(statusCode, JSON.stringify(body)).toBe(201);
    expect(body["ignored"]).toEqual(["NOTES.txt"]);
    const members = body["members"] as { path: string }[];
    expect(members.map((m) => m.path)).not.toContain("NOTES.txt");
  });

  it("refuses hostile and unusable packages with a typed reason", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await venue(app, cookie, "Tiles Hostile");

    const cases: [string, string, [string, Uint8Array][]][] = [
      [
        "pathTraversal",
        "escapes the package",
        [
          ["tileset.json", tileset("../../etc/passwd")],
          ["content/model.glb", glb(6)],
        ],
      ],
      [
        "absolutePath",
        "absolute reference",
        [
          ["tileset.json", tileset("/etc/passwd")],
          ["content/model.glb", glb(6)],
        ],
      ],
      [
        "externalReference",
        "reference outside the package",
        [
          ["tileset.json", tileset("https://tiles.example.com/model.glb")],
          ["content/model.glb", glb(6)],
        ],
      ],
      ["unresolvedMember", "dangling reference", [["tileset.json", tileset("content/gone.glb")]]],
      [
        "unsupportedContentFormat",
        "content Kiriko cannot read",
        [
          ["tileset.json", tileset("content/model.b3dm")],
          ["content/model.b3dm", new TextEncoder().encode("b3dm")],
        ],
      ],
      [
        "undecodableContent",
        "content that does not decode",
        [
          ["tileset.json", tileset("content/model.glb")],
          ["content/model.glb", new TextEncoder().encode("not a glb")],
        ],
      ],
      [
        "malformedTileset",
        "unreadable tileset",
        [["tileset.json", new TextEncoder().encode("{ not json")]],
      ],
      ["missingRootTileset", "no tileset at all", [["content/model.glb", glb(6)]]],
    ];

    for (const [code, label, entries] of cases) {
      const zip = await packageZip(entries);
      const { statusCode, body } = await ingest(app, cookie, venueId, zip);
      expect(statusCode, `${label}: ${JSON.stringify(body)}`).toBe(400);
      expect(body["code"], label).toBe(code);
    }

    // Nothing was stored for any refused package.
    const packages = app.db
      .prepare("SELECT COUNT(*) AS count FROM tile_packages WHERE venue_id = ?")
      .get(venueId);
    expect(packages).toMatchObject({ count: 0 });
  });

  it("requires a producer session", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await venue(app, cookie, "Tiles Guarded");
    const zip = await packageZip([
      ["tileset.json", tileset("content/model.glb")],
      ["content/model.glb", glb(7)],
    ]);

    const upload = multipart(zip);
    const anonymous = await app.inject({
      method: "POST",
      url: `/api/venues/${venueId}/tiles/inspect`,
      headers: upload.headers,
      payload: upload.payload,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("changes no published state", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await venue(app, cookie, "Tiles No Publish");

    const zip = await packageZip([
      ["tileset.json", tileset("content/model.glb")],
      ["content/model.glb", glb(8)],
    ]);
    const { statusCode } = await ingest(app, cookie, venueId, zip);
    expect(statusCode).toBe(201);

    // Ingestion attaches a record to the venue and nothing else: no version is
    // created, and none changes status.
    const versions = app.db
      .prepare("SELECT COUNT(*) AS count FROM versions WHERE venue_id = ?")
      .get(venueId);
    expect(versions).toMatchObject({ count: 0 });
  });
});
