import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { migrate } from "../src/db/migrate";

const MIGRATION_NAMES = ["001_init.sql", "002_review_issues.sql", "003_gdb_reprocess.sql", "004_network_synthesis.sql"];
const MIGRATIONS = MIGRATION_NAMES.map((name) => ({
  name,
  sql: readFileSync(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"),
}));

interface JobLinkRow {
  id: string;
  versionId: number | null;
}

interface MigratedJobRow extends JobLinkRow {
  status: string;
  resultJson: string | null;
  error: string | null;
  ownerId?: string | null;
  leaseExpiresAt?: string | null;
}

function open004SchemaDatabase() {
  const dataDir = mkdtempSync(join(tmpdir(), "kiriko-jobs-migration-"));
  const db = openDb(dataDir);
  db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(migration.name);
  }
  return { dataDir, db };
}

function open004Database() {
  const { dataDir, db } = open004SchemaDatabase();
  db.prepare("INSERT INTO venues (id, tenant_id, slug, name) VALUES (11, 1, 'station', 'Station')").run();
  db.prepare(
    `INSERT INTO versions (id, venue_id, seq, public_id, source_blob_hash, status)
     VALUES (41, 11, 1, ?, 'source-a', 'draft'),
            (42, 11, 2, ?, 'source-b', 'published')`,
  ).run("a".repeat(64), "b".repeat(64));
  db.prepare("INSERT INTO jobs (id, kind, status, payload_json) VALUES (?, ?, ?, ?)").run(
    "queued-publication",
    "publish_imdf",
    "queued",
    JSON.stringify({ versionId: 41 }),
  );
  db.prepare("INSERT INTO jobs (id, kind, status, payload_json) VALUES (?, ?, ?, ?)").run(
    "running-publication",
    "publish_imdf",
    "running",
    JSON.stringify({ versionId: 41 }),
  );
  db.prepare("INSERT INTO jobs (id, kind, status, payload_json) VALUES (?, ?, ?, ?)").run(
    "other-job",
    "maintenance",
    "queued",
    "{}",
  );
  return { dataDir, db };
}

describe("005 durable publication job migration", () => {
  it("backfills queryable version links and enforces required FKs for publication jobs only", () => {
    const { dataDir, db } = open004Database();
    try {
      migrate(db);

      const columns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
      const columnNames = columns.map((column) => column.name);
      expect(columnNames).toEqual(expect.arrayContaining(["version_id", "owner_id", "lease_expires_at"]));
      const links = db
        .prepare("SELECT id, version_id AS versionId FROM jobs ORDER BY id")
        .all() as JobLinkRow[];
      expect(links).toEqual([
        { id: "other-job", versionId: null },
        { id: "queued-publication", versionId: 41 },
        { id: "running-publication", versionId: 41 },
      ]);
      expect(
        db.prepare("SELECT owner_id AS ownerId, lease_expires_at AS leaseExpiresAt FROM jobs WHERE id = 'running-publication'").get(),
      ).toEqual({ ownerId: null, leaseExpiresAt: null });

      expect(() =>
        db.prepare("INSERT INTO jobs (id, kind, payload_json) VALUES ('publish-null', 'publish_imdf', '{}')").run(),
      ).toThrow();
      expect(() =>
        db
          .prepare("INSERT INTO jobs (id, kind, version_id, payload_json) VALUES ('publish-bad-fk', 'publish_imdf', 404, ?)")
          .run(JSON.stringify({ versionId: 404 })),
      ).toThrow();
      expect(() =>
        db.prepare("INSERT INTO jobs (id, kind, payload_json) VALUES ('maintenance-null', 'maintenance', '{}')").run(),
      ).not.toThrow();
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps terminal publication jobs pollable when their version was deleted before migration", () => {
    const { dataDir, db } = open004SchemaDatabase();
    try {
      db.prepare("INSERT INTO venues (id, tenant_id, slug, name) VALUES (21, 1, 'deleted', 'Deleted')").run();
      db.prepare(
        "INSERT INTO versions (id, venue_id, seq, public_id, source_blob_hash, status) VALUES (51, 21, 1, ?, 'source', 'published')",
      ).run("c".repeat(64));
      db.prepare(
        `INSERT INTO jobs (id, kind, status, payload_json, result_json, error, created_at, updated_at)
         VALUES ('terminal-done', 'publish_imdf', 'done', ?, ?, NULL, '2026-01-01 00:00:00', '2026-01-01 00:01:00'),
                ('terminal-error', 'publish_imdf', 'error', ?, NULL, ?, '2026-01-02 00:00:00', '2026-01-02 00:01:00')`,
      ).run(
        JSON.stringify({ versionId: 51 }),
        JSON.stringify({ versionId: 51 }),
        JSON.stringify({ versionId: 51 }),
        JSON.stringify({ code: "unsupported_file", message: "bad source" }),
      );
      db.prepare("DELETE FROM venues WHERE id = 21").run();

      migrate(db);

      const rows = db
        .prepare(
          "SELECT id, status, version_id AS versionId, result_json AS resultJson, error FROM jobs ORDER BY id",
        )
        .all() as MigratedJobRow[];
      expect(rows).toEqual([
        {
          id: "terminal-done",
          status: "done",
          versionId: null,
          resultJson: JSON.stringify({ versionId: 51 }),
          error: null,
        },
        {
          id: "terminal-error",
          status: "error",
          versionId: null,
          resultJson: null,
          error: JSON.stringify({ code: "unsupported_file", message: "bad source" }),
        },
      ]);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("converts queued and running publication jobs whose version is missing into terminal structured errors", () => {
    const { dataDir, db } = open004SchemaDatabase();
    try {
      db.prepare(
        `INSERT INTO jobs (id, kind, status, payload_json, created_at, updated_at)
         VALUES ('missing-queued', 'publish_imdf', 'queued', ?, '2026-02-01 00:00:00', '2026-02-01 00:00:00'),
                ('missing-running', 'publish_imdf', 'running', ?, '2026-02-02 00:00:00', '2026-02-02 00:00:00')`,
      ).run(JSON.stringify({ versionId: 404 }), JSON.stringify({ versionId: 405 }));

      migrate(db);

      const rows = db
        .prepare(
          "SELECT id, status, version_id AS versionId, result_json AS resultJson, error FROM jobs ORDER BY id",
        )
        .all() as MigratedJobRow[];
      expect(rows.map((row) => ({ id: row.id, status: row.status, versionId: row.versionId, resultJson: row.resultJson }))).toEqual([
        { id: "missing-queued", status: "error", versionId: null, resultJson: null },
        { id: "missing-running", status: "error", versionId: null, resultJson: null },
      ]);
      for (const row of rows) {
        const parsed = JSON.parse(row.error ?? "null") as { code: string; message: string };
        expect(parsed.code).toBe("orphaned_job");
        expect(parsed.message).toContain("version");
      }
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
