import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { AppConfig } from "../src/config";
import { seedDevUsers, DEV_USERS, SEED_USERS_FILE } from "../src/auth/devSeed";
import { hashPassword, verifyPassword } from "../src/auth/passwords";
import { cleanupTestApps, makeTestDb } from "./helpers";

const PASSWORD = "seed-test-password";

const dataDirs: string[] = [];

/** A throwaway data directory, optionally holding a seed file. */
function dataDir(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kiriko-seed-"));
  dataDirs.push(dir);
  if (contents !== undefined) {
    writeFileSync(join(dir, SEED_USERS_FILE), contents, "utf8");
  }
  return dir;
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: dataDir(),
    sessionTtlDays: 30,
    secureCookies: false,
    issueSseMaxConnections: 512,
    issueSseMaxPerVersion: 128,
    seedDevUsers: true,
    seedPassword: PASSWORD,
    ...overrides,
  };
}

interface UserRow {
  username: string;
  role: string;
  password_hash: string;
}

function users(db: Database.Database): UserRow[] {
  return db
    .prepare("SELECT username, role, password_hash FROM users ORDER BY username")
    .all() as UserRow[];
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  await cleanupTestApps();
});

describe("seedDevUsers", () => {
  it("seeds one account per role from the built-in set when no file exists", () => {
    const db = makeTestDb();

    seedDevUsers(db, config());

    const rows = users(db);
    expect(rows.map((r) => [r.username, r.role])).toEqual([
      ["admin", "admin"],
      ["member", "member"],
      ["viewer", "viewer"],
    ]);
    for (const row of rows) {
      expect(verifyPassword(PASSWORD, row.password_hash)).toBe(true);
    }
    expect(DEV_USERS.map((u) => u.username)).toEqual(["admin", "member", "viewer"]);
  });

  it("seeds exactly the accounts the file lists, with their roles", () => {
    const db = makeTestDb();
    const dir = dataDir(
      JSON.stringify({
        users: [
          { username: "daniel@example.test", role: "admin" },
          { username: "reviewer@example.test", role: "viewer" },
        ],
      }),
    );

    seedDevUsers(db, config({ dataDir: dir }));

    expect(users(db).map((r) => [r.username, r.role])).toEqual([
      ["daniel@example.test", "admin"],
      ["reviewer@example.test", "viewer"],
    ]);
    // The built-in set is a fallback, not an addition: a file that lists
    // accounts is the whole answer, so the user list matches what was asked for.
    expect(users(db).some((r) => r.username === "admin")).toBe(false);
  });

  it("accepts an email address as a username", () => {
    const db = makeTestDb();
    const dir = dataDir(
      JSON.stringify({ users: [{ username: "nagasawayouko@jrc.jregroup.ne.jp", role: "admin" }] }),
    );

    seedDevUsers(db, config({ dataDir: dir }));

    const row = users(db)[0];
    expect(row?.username).toBe("nagasawayouko@jrc.jregroup.ne.jp");
    expect(verifyPassword(PASSWORD, row?.password_hash ?? "")).toBe(true);
  });

  it("seeds nothing and says why when no password is configured", () => {
    // Named accounts for real people must never fall back to a guessable
    // default, so the absence of a password is a refusal rather than a warning.
    const db = makeTestDb();
    const warnings: string[] = [];

    const unconfigured = config();
    delete unconfigured.seedPassword;

    seedDevUsers(db, unconfigured, (m) => warnings.push(m));

    expect(users(db)).toHaveLength(0);
    expect(warnings.join(" ")).toContain("KIRIKO_SEED_PASSWORD");
  });

  it("does nothing when the flag is off", () => {
    const db = makeTestDb();
    seedDevUsers(db, config({ seedDevUsers: false }));
    expect(users(db)).toHaveLength(0);
  });

  it("refuses to seed under NODE_ENV=production even when opted in", () => {
    vi.stubEnv("NODE_ENV", "production");
    const db = makeTestDb();
    const warnings: string[] = [];

    seedDevUsers(db, config(), (m) => warnings.push(m));

    expect(users(db)).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("rejects the whole file when it cannot be read", () => {
    // Half a seeded set is worse than none: the missing account is the one
    // whose owner cannot sign in, and nothing says which.
    const db = makeTestDb();
    const warnings: string[] = [];
    const dir = dataDir("{ not json");

    seedDevUsers(db, config({ dataDir: dir }), (m) => warnings.push(m));

    expect(users(db)).toHaveLength(0);
    expect(warnings.join(" ")).toContain(SEED_USERS_FILE);
  });

  it("rejects the whole file when an entry names an unknown role", () => {
    const db = makeTestDb();
    const warnings: string[] = [];
    const dir = dataDir(
      JSON.stringify({
        users: [
          { username: "ok@example.test", role: "admin" },
          { username: "bad@example.test", role: "superuser" },
        ],
      }),
    );

    seedDevUsers(db, config({ dataDir: dir }), (m) => warnings.push(m));

    expect(users(db)).toHaveLength(0);
    expect(warnings.join(" ")).toContain("superuser");
  });

  it("resets a listed account's password and role on every run", () => {
    const db = makeTestDb();
    const dir = dataDir(
      JSON.stringify({ users: [{ username: "daniel@example.test", role: "admin" }] }),
    );
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES ('daniel@example.test', ?, 'viewer')",
    ).run(hashPassword("stale"));

    seedDevUsers(db, config({ dataDir: dir }));
    seedDevUsers(db, config({ dataDir: dir }));

    const rows = users(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("admin");
    expect(verifyPassword(PASSWORD, rows[0]?.password_hash ?? "")).toBe(true);
    expect(verifyPassword("stale", rows[0]?.password_hash ?? "")).toBe(false);
  });

  it("leaves accounts the file does not list alone", () => {
    const db = makeTestDb();
    const dir = dataDir(
      JSON.stringify({ users: [{ username: "daniel@example.test", role: "admin" }] }),
    );
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('someone', ?, 'member')").run(
      hashPassword("their-own-password"),
    );

    seedDevUsers(db, config({ dataDir: dir }));

    const someone = users(db).find((r) => r.username === "someone");
    expect(verifyPassword("their-own-password", someone?.password_hash ?? "")).toBe(true);
  });
});
