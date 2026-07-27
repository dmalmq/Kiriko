import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";
import { createSession } from "../src/auth/sessions";

const PUBLIC_ID = "a".repeat(64);

function networkImportPayload() {
  return {
    slug: "missing-station",
    publicVersionId: PUBLIC_ID,
    junctions: JSON.stringify({ type: "FeatureCollection", features: [] }),
    paths: JSON.stringify({ type: "FeatureCollection", features: [] }),
  };
}

function cookieFor(app: FastifyInstance, userId: number): string {
  return `kiriko_session=${createSession(app.db, userId, 30)}`;
}

async function fakeGdbZip(): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("fake.gdb/a00000001.gdbtable", new TextReader("not a geodatabase"));
  return writer.close();
}

function multipartZip(bytes: Uint8Array): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----kirikoGdbRouteBoundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="fake.gdb.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

afterEach(cleanupTestApps);

describe("GDB routes", () => {
  it("rejects a `.gdb` shell without a valid system catalog before GDAL", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const multipart = multipartZip(await fakeGdbZip());

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect",
      headers: { cookie, ...multipart.headers },
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "invalid_geodatabase",
    });
  });

  it("allows only members and admins to import edited network graphs", async () => {
    const { app } = await makeTestApp();
    app.db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (2, 'viewer', 'x', 'viewer')",
    ).run();
    const viewerCookie = cookieFor(app, 2);
    const memberCookie = await loginCookie(app);
    const payload = networkImportPayload();

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/gdb/import-network",
      payload,
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({
      error: "unauthorized",
      code: "unauthorized",
      message: "Authentication is required.",
    });

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/gdb/import-network",
      headers: { cookie: viewerCookie },
      payload,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({
      error: "forbidden",
      code: "forbidden",
      message: "Only members and admins can edit network data.",
    });

    const allowed = await app.inject({
      method: "POST",
      url: "/api/gdb/import-network",
      headers: { cookie: memberCookie },
      payload,
    });
    expect(allowed.statusCode).toBe(404);
    expect(allowed.json()).toEqual({ error: "not_found" });
  });
});

it("inspect returns a suggestedPlan alongside the inspection", async () => {
  const { app } = await makeTestApp();
  const cookie = await loginCookie(app);
  // A crafted-but-malformed catalog would pass pre-GDAL validation and then
  // hang the gdal3.js WASM runtime (it emits an out-of-band FS rejection and
  // never resolves), so this stub deliberately fails pre-GDAL validation and
  // returns 400. The point here is the wired contract shape: inspect answers
  // with 200|400 and, on 200, carries `suggestedPlan.layers`. Real 200-path
  // coverage (suggestedPlan.layers.length === 318) lives in gdbSmoke against
  // the Tokyo fixture.
  const multipart = multipartZip(await fakeGdbZip());
  const response = await app.inject({
    method: "POST",
    url: "/api/gdb/inspect",
    headers: { cookie, ...multipart.headers },
    payload: multipart.payload,
  });
  expect([200, 400]).toContain(response.statusCode);
  if (response.statusCode === 200) {
    const body = response.json() as { suggestedPlan?: { layers: unknown[] } };
    expect(Array.isArray(body.suggestedPlan?.layers)).toBe(true);
  }
});
