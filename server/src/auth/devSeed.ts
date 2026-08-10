import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config";
import { hashPassword } from "./passwords";

export interface DevUser {
  username: string;
  role: "admin" | "member" | "viewer";
}

/**
 * The account list, read from the data directory rather than compiled in.
 *
 * Kept out of the repository on purpose: the accounts a team tests with are
 * real people's addresses, and adding a colleague should not be a commit.
 */
export const SEED_USERS_FILE = "seed-users.json";

/**
 * The fallback set when no file exists — one account per role, so role-gated
 * behaviour can be exercised on a fresh clone and in CI without any setup.
 */
export const DEV_USERS: DevUser[] = [
  { username: "admin", role: "admin" },
  { username: "member", role: "member" },
  { username: "viewer", role: "viewer" },
];

const ROLES: Record<string, DevUser["role"]> = {
  admin: "admin",
  member: "member",
  viewer: "viewer",
};

/**
 * Read the account list from `<dataDir>/seed-users.json`.
 *
 * Returns `null` when the file is unusable, having explained why. Rejecting the
 * whole file rather than the bad entry is deliberate: a half-seeded set leaves
 * one person unable to sign in with nothing saying which, and a list this small
 * is quicker to fix than to diagnose.
 */
function readSeedFile(dataDir: string, log?: (message: string) => void): DevUser[] | null {
  const path = join(dataDir, SEED_USERS_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Absent is the ordinary case: the built-in set applies.
    return DEV_USERS;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log?.(`${SEED_USERS_FILE} is not valid JSON, so no accounts were seeded: ${String(error)}`);
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !("users" in parsed)) {
    log?.(`${SEED_USERS_FILE} has no "users" array, so no accounts were seeded`);
    return null;
  }
  const { users } = parsed;
  if (!Array.isArray(users)) {
    log?.(`${SEED_USERS_FILE}'s "users" is not an array, so no accounts were seeded`);
    return null;
  }

  const seeded: DevUser[] = [];
  for (const entry of users) {
    if (entry === null || typeof entry !== "object") {
      log?.(`${SEED_USERS_FILE} has an entry that is not an object, so no accounts were seeded`);
      return null;
    }
    const username = "username" in entry ? entry.username : undefined;
    const role = "role" in entry ? entry.role : undefined;
    if (typeof username !== "string" || username === "") {
      log?.(`${SEED_USERS_FILE} has an entry with no username, so no accounts were seeded`);
      return null;
    }
    if (typeof role !== "string" || !Object.hasOwn(ROLES, role)) {
      log?.(
        `${SEED_USERS_FILE} gives ${username} the unknown role ${JSON.stringify(role)}, ` +
          "so no accounts were seeded (admin, member, viewer)",
      );
      return null;
    }
    seeded.push({ username, role: ROLES[role] as DevUser["role"] });
  }
  return seeded;
}

/**
 * Seed the testing accounts so role-gated behaviour can be exercised without a
 * user-management UI. Opt-in via `KIRIKO_SEED_DEV_USERS=1`; hard-skipped under
 * `NODE_ENV=production` so seeded credentials can never reach a real
 * deployment.
 *
 * The list comes from `<dataDir>/seed-users.json` when present, and from
 * {@link DEV_USERS} when it is not. Every run (re)sets each listed account's
 * password and role, so the credentials are always the known ones even if an
 * account of that name already existed. Accounts the list does not name are
 * left alone.
 *
 * The password comes from `KIRIKO_SEED_PASSWORD` and has no default. These are
 * named accounts for real people on a network-reachable instance; falling back
 * to something guessable would be worse than not seeding at all.
 */
export function seedDevUsers(
  db: Database.Database,
  config: AppConfig,
  log?: (message: string) => void,
): void {
  if (config.seedDevUsers !== true) {
    return;
  }
  if (process.env["NODE_ENV"] === "production") {
    log?.("KIRIKO_SEED_DEV_USERS is set but ignored under NODE_ENV=production");
    return;
  }
  const password = config.seedPassword;
  if (password === undefined || password === "") {
    log?.(
      "KIRIKO_SEED_DEV_USERS is set but KIRIKO_SEED_PASSWORD is not, so no accounts were seeded",
    );
    return;
  }
  const users = readSeedFile(config.dataDir, log);
  if (users === null) {
    return;
  }

  const upsert = db.prepare(
    `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role`,
  );
  const hash = hashPassword(password);
  const seed = db.transaction(() => {
    for (const user of users) {
      // One hash for every account: they share a password, and hashing per
      // account would only cost startup time for an identical result.
      upsert.run(user.username, hash, user.role);
    }
  });
  seed();
  log?.(`seeded ${users.length} testing account(s) from ${config.dataDir}`);
}
