import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { openDb } from "../src/db/db";
import { migrate } from "../src/db/migrate";
import {
  setSpawnWorkerForTests,
  type GdalRequest,
  type GdalWorkerHandle,
  type GdalWorkerMessage,
  type SerializedError,
} from "../src/gdb/gdalProcess";
import { runGdalRequest } from "../src/gdb/gdalWorker.mjs";

const cleanups: Array<() => Promise<void>> = [];

export const TEST_USER = "test";
export const TEST_PASSWORD = "test-password";

export function newTestPublicVersionId(): string {
  return randomBytes(32).toString("hex");
}

/** Opens a fresh migrated SQLite database without booting the Fastify app. */
export function makeTestDb(): Database.Database {
  const dataDir = mkdtempSync(join(tmpdir(), "kiriko-db-test-"));
  const db = openDb(dataDir);
  migrate(db);
  cleanups.push(async () => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return db;
}

export async function makeTestApp(): Promise<{ app: FastifyInstance; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "kiriko-test-"));
  const app = await buildApp({
    dataDir,
    sessionTtlDays: 30,
    secureCookies: false,
    issueSseMaxConnections: 512,
    issueSseMaxPerVersion: 128,
    bootstrapUser: TEST_USER,
    bootstrapPassword: TEST_PASSWORD,
  });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, dataDir };
}

export async function cleanupTestApps(): Promise<void> {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
}

/** Logs in as the bootstrap user; returns the session cookie header value. */
export async function loginCookie(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: TEST_USER, password: TEST_PASSWORD },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  }
  const cookie = res.cookies.find((c) => c.name === "kiriko_session");
  if (!cookie) {
    throw new Error("no session cookie set");
  }
  return `kiriko_session=${cookie.value}`;
}

/**
 * Route the serial GDAL process queue through an in-process fake worker that
 * runs the real shared `runGdalRequest` body against `fakeGdal`. This keeps the
 * parse / missing-layer logic (and structured `GdbSourceError` reconstruction)
 * that the route tests assert, without spawning the real gdal3.js worker
 * thread. Mirrors the real worker: post one message, then fire `exit`.
 */
export function useInProcessGdal(fakeGdal: unknown): void {
  setSpawnWorkerForTests((request: GdalRequest): GdalWorkerHandle => {
    const messageCbs: Array<(m: GdalWorkerMessage) => void> = [];
    const exitCbs: Array<(code: number) => void> = [];
    let terminated = false;
    void (async () => {
      let message: GdalWorkerMessage;
      try {
        message = { ok: true, result: await runGdalRequest(request, fakeGdal) };
      } catch (error) {
        message = { ok: false, error: serializeGdalError(error) };
      }
      if (terminated) return;
      for (const cb of [...messageCbs]) cb(message);
      for (const cb of [...exitCbs]) cb(0);
    })();
    return {
      onMessage: (cb) => {
        messageCbs.push(cb);
      },
      onError: () => {},
      onExit: (cb) => {
        exitCbs.push(cb);
      },
      terminate: () => {
        terminated = true;
        for (const cb of [...exitCbs]) cb(1);
      },
    };
  });
}

/** Serialize a thrown error the way the real worker does, for the queue to rebuild. */
function serializeGdalError(error: unknown): SerializedError {
  if (error && typeof error === "object") {
    const e = error as { name?: unknown; code?: unknown; message?: unknown; details?: unknown };
    const serialized: SerializedError = {
      name: typeof e.name === "string" ? e.name : "Error",
      message: typeof e.message === "string" ? e.message : String(error),
    };
    if (typeof e.code === "string") serialized.code = e.code;
    if (e.details && typeof e.details === "object") {
      serialized.details = e.details as Record<string, unknown>;
    }
    return serialized;
  }
  return { name: "Error", message: String(error) };
}
