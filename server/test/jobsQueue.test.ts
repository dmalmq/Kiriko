import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobQueue, type JobRunner, type PublicationVersionDraft } from "../src/jobs/queue";
import { cleanupTestApps, makeTestDb, newTestPublicVersionId } from "./helpers";

afterEach(cleanupTestApps);

function seedVenue(db: Database.Database): number {
  const info = db.prepare("INSERT INTO venues (tenant_id, slug, name) VALUES (1, ?, ?)").run(
    `venue-${Date.now()}-${Math.random()}`,
    "Queue Venue",
  );
  return Number(info.lastInsertRowid);
}

function draftFor(venueId: number, seq = 1): PublicationVersionDraft {
  return {
    venueId,
    seq,
    publicId: newTestPublicVersionId(),
    sourceBlobHash: `${seq}`.repeat(64).slice(0, 64),
    sourceKind: "imdf",
  };
}

function seedDraftVersion(db: Database.Database, venueId = seedVenue(db), seq = 1): number {
  const version = draftFor(venueId, seq);
  const info = db
    .prepare(
      `INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, source_kind)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(version.venueId, version.seq, version.publicId, version.sourceBlobHash, version.sourceKind);
  return Number(info.lastInsertRowid);
}

function versionRow(db: Database.Database, id: number): { status: string; error: string | null } {
  return db.prepare("SELECT status, error FROM versions WHERE id = ?").get(id) as {
    status: string;
    error: string | null;
  };
}

function jobRow(db: Database.Database, id: string): { status: string; result: string | null; error: string | null } {
  return db.prepare("SELECT status, result_json AS result, error FROM jobs WHERE id = ?").get(id) as {
    status: string;
    result: string | null;
    error: string | null;
  };
}

function errorCode(value: string | null): string | undefined {
  return value === null ? undefined : (JSON.parse(value) as { code: string }).code;
}


function leaseRow(db: Database.Database, id: string): { status: string; error: string | null; ownerId: string | null; leaseExpiresAt: string | null } {
  return db
    .prepare("SELECT status, error, owner_id AS ownerId, lease_expires_at AS leaseExpiresAt FROM jobs WHERE id = ?")
    .get(id) as { status: string; error: string | null; ownerId: string | null; leaseExpiresAt: string | null };
}

function expiredLease(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

function futureLease(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

describe("jobs.version_id migration contract", () => {
  it("requires a queryable linked version for publication jobs while allowing unlinked non-publication jobs", () => {
    const db = makeTestDb();
    const versionId = seedDraftVersion(db);

    const versionIdColumn = (db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).find(
      (column) => column.name === "version_id",
    );
    expect(versionIdColumn).toBeDefined();

    expect(() =>
      db.prepare("INSERT INTO jobs (id, kind, payload_json) VALUES ('publish-without-version', 'publish_imdf', '{}')").run(),
    ).toThrow();
    expect(() =>
      db
        .prepare("INSERT INTO jobs (id, kind, version_id, payload_json) VALUES ('publish-missing-version', 'publish_imdf', 999999, '{}')")
        .run(),
    ).toThrow();

    db.prepare("INSERT INTO jobs (id, kind, version_id, payload_json) VALUES ('publish-linked', 'publish_imdf', ?, ?)").run(
      versionId,
      JSON.stringify({ versionId }),
    );
    db.prepare("INSERT INTO jobs (id, kind, payload_json) VALUES ('maintenance', 'maintenance', '{}')").run();

    expect(
      db.prepare("SELECT version_id AS versionId FROM jobs WHERE id = 'publish-linked'").get(),
    ).toEqual({ versionId });
    expect(db.prepare("SELECT version_id AS versionId FROM jobs WHERE id = 'maintenance'").get()).toEqual({
      versionId: null,
    });
  });
});

describe("JobQueue durable lifecycle", () => {
  it("replays a persisted queued job exactly once on construction", async () => {
    const db = makeTestDb();
    const versionId = seedDraftVersion(db);
    db.prepare("INSERT INTO jobs (id, kind, version_id, payload_json) VALUES ('queued-1', 'publish_imdf', ?, ?)").run(
      versionId,
      JSON.stringify({ versionId }),
    );

    let calls = 0;
    const queue = new JobQueue(db, {
      publish_imdf: async (payloadJson) => {
        calls += 1;
        expect(JSON.parse(payloadJson)).toEqual({ versionId });
        db.prepare("UPDATE versions SET status = 'published', bundle_hash = 'bundle', error = NULL WHERE id = ?").run(
          versionId,
        );
        return { versionId };
      },
    });

    await queue.idle();
    await queue.idle();

    expect(calls).toBe(1);
    expect(jobRow(db, "queued-1")).toEqual({ status: "done", result: JSON.stringify({ versionId }), error: null });
    expect(versionRow(db, versionId).status).toBe("published");
  });

  it("does not replay terminal persisted jobs", async () => {
    const db = makeTestDb();
    const versionId = seedDraftVersion(db);
    db.prepare("UPDATE versions SET status = 'published', bundle_hash = 'bundle' WHERE id = ?").run(versionId);
    db.prepare(
      "INSERT INTO jobs (id, kind, version_id, status, payload_json, result_json) VALUES ('done-1', 'publish_imdf', ?, 'done', ?, '{}')",
    ).run(versionId, JSON.stringify({ versionId }));

    let calls = 0;
    const queue = new JobQueue(db, {
      publish_imdf: async () => {
        calls += 1;
        return null;
      },
    });
    await queue.idle();

    expect(calls).toBe(0);
    expect(jobRow(db, "done-1").status).toBe("done");
  });

  it("marks an interrupted running publication job and its exact draft version failed on restart", async () => {
    const db = makeTestDb();
    const versionId = seedDraftVersion(db);
    db.prepare("INSERT INTO jobs (id, kind, version_id, status, payload_json) VALUES ('running-1', 'publish_imdf', ?, 'running', ?)").run(
      versionId,
      JSON.stringify({ versionId }),
    );

    const queue = new JobQueue(db, { publish_imdf: async () => null });
    await queue.idle();

    expect(errorCode(jobRow(db, "running-1").error)).toBe("interrupted_by_restart");
    const version = versionRow(db, versionId);
    expect(version.status).toBe("failed");
    expect(errorCode(version.error)).toBe("interrupted_by_restart");
  });

  it("leaves a live-leased running job from another owner untouched on restart", async () => {
    const db = makeTestDb();
    const venueId = seedVenue(db);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const queue1 = new JobQueue(
      db,
      {
        publish_imdf: async () => {
          started.resolve();
          await release.promise;
          return { ok: true };
        },
      },
      { leaseMs: 60_000, heartbeatMs: 60_000, closeGraceMs: 1_000 },
    );

    const accepted = queue1.enqueuePublication("publish_imdf", draftFor(venueId, 1), {});
    await started.promise;
    const liveLease = leaseRow(db, accepted.jobId);
    expect(liveLease.status).toBe("running");
    expect(liveLease.ownerId).toMatch(/[0-9a-f-]{36}/);
    expect(liveLease.leaseExpiresAt).toBeTruthy();
    const liveOwner = liveLease.ownerId;

    let queue2Calls = 0;
    const queue2 = new JobQueue(
      db,
      {
        publish_imdf: async () => {
          queue2Calls += 1;
          return null;
        },
      },
      { leaseMs: 60_000, heartbeatMs: 60_000, closeGraceMs: 1_000 },
    );
    await queue2.idle();

    // A second instance must not replay or interrupt a peer's live-leased job.
    expect(queue2Calls).toBe(0);
    const afterRecover = leaseRow(db, accepted.jobId);
    expect(afterRecover.status).toBe("running");
    expect(afterRecover.ownerId).toBe(liveOwner);
    expect(afterRecover.error).toBeNull();
    expect(versionRow(db, accepted.versionId).status).toBe("draft");

    release.resolve();
    await queue1.idle();
    expect(jobRow(db, accepted.jobId).status).toBe("done");
  });

  it("marks an expired running lease interrupted without replaying it", async () => {
    const db = makeTestDb();
    const versionId = seedDraftVersion(db);
    db.prepare(
      `INSERT INTO jobs (id, kind, version_id, status, payload_json, owner_id, lease_expires_at)
       VALUES ('expired-running', 'publish_imdf', ?, 'running', ?, 'dead-owner', ?)`,
    ).run(versionId, JSON.stringify({ versionId }), expiredLease());

    let calls = 0;
    const queue = new JobQueue(db, {
      publish_imdf: async () => {
        calls += 1;
        return null;
      },
    });
    await queue.idle();

    expect(calls).toBe(0);
    expect(errorCode(jobRow(db, "expired-running").error)).toBe("interrupted_by_restart");
    expect(errorCode(versionRow(db, versionId).error)).toBe("interrupted_by_restart");
  });

  it("marks draft versions with no live job failed as orphaned_job without touching terminal versions", async () => {
    const db = makeTestDb();
    const venueId = seedVenue(db);
    const orphanId = seedDraftVersion(db, venueId, 1);
    const failedId = seedDraftVersion(db, venueId, 2);
    db.prepare("UPDATE versions SET status = 'failed', error = ? WHERE id = ?").run(
      JSON.stringify({ code: "existing", message: "keep me" }),
      failedId,
    );

    const queue = new JobQueue(db, { publish_imdf: async () => null });
    await queue.idle();

    expect(versionRow(db, orphanId).status).toBe("failed");
    expect(errorCode(versionRow(db, orphanId).error)).toBe("orphaned_job");
    expect(errorCode(versionRow(db, failedId).error)).toBe("existing");
  });

  it("marks linked drafts failed when a queued job has no runner", async () => {
    const db = makeTestDb();
    const versionId = seedDraftVersion(db);
    db.prepare("INSERT INTO jobs (id, kind, version_id, payload_json) VALUES ('missing-runner', 'publish_imdf', ?, ?)").run(
      versionId,
      JSON.stringify({ versionId }),
    );

    const queue = new JobQueue(db, {});
    await queue.idle();

    expect(errorCode(jobRow(db, "missing-runner").error)).toBe("missing_runner");
    expect(errorCode(versionRow(db, versionId).error)).toBe("missing_runner");
    expect(versionRow(db, versionId).status).toBe("failed");
  });

  it("marks linked drafts failed when a runner throws before writing a domain failure", async () => {
    const db = makeTestDb();
    const versionId = seedDraftVersion(db);
    db.prepare("INSERT INTO jobs (id, kind, version_id, payload_json) VALUES ('throwing-runner', 'publish_imdf', ?, ?)").run(
      versionId,
      JSON.stringify({ versionId }),
    );

    const queue = new JobQueue(db, {
      publish_imdf: async () => {
        throw new Error("runner exploded before version write");
      },
    });
    await queue.idle();

    expect(errorCode(jobRow(db, "throwing-runner").error)).toBe("internal_error");
    expect(errorCode(versionRow(db, versionId).error)).toBe("internal_error");
    expect(versionRow(db, versionId).status).toBe("failed");
  });

  it("does not overwrite a runner's existing structured version failure", async () => {
    const db = makeTestDb();
    const versionId = seedDraftVersion(db);
    const runnerError = { code: "unsupported_file", message: "unsupported_file" };
    db.prepare("INSERT INTO jobs (id, kind, version_id, payload_json) VALUES ('domain-runner', 'publish_imdf', ?, ?)").run(
      versionId,
      JSON.stringify({ versionId }),
    );

    const queue = new JobQueue(db, {
      publish_imdf: async () => {
        db.prepare("UPDATE versions SET status = 'failed', error = ? WHERE id = ?").run(
          JSON.stringify(runnerError),
          versionId,
        );
        throw new Error(JSON.stringify(runnerError));
      },
    });
    await queue.idle();

    expect(errorCode(jobRow(db, "domain-runner").error)).toBe("unsupported_file");
    expect(versionRow(db, versionId).error).toBe(JSON.stringify(runnerError));
  });

  it("closes by rejecting new admission synchronously and waiting for the accepted runner chain", async () => {
    const db = makeTestDb();
    const venueId = seedVenue(db);
    const runnerDone = Promise.withResolvers<void>();
    let started = false;
    const runner: JobRunner = async (payloadJson) => {
      started = true;
      const { versionId } = JSON.parse(payloadJson) as { versionId: number };
      await runnerDone.promise;
      db.prepare("UPDATE versions SET status = 'published', bundle_hash = 'bundle' WHERE id = ?").run(versionId);
      return { versionId };
    };
    const queue = new JobQueue(db, { publish_imdf: runner });

    const accepted = queue.enqueuePublication("publish_imdf", draftFor(venueId, 1), {});
    expect(accepted.versionId).toBeGreaterThan(0);
    await Promise.resolve();
    expect(started).toBe(true);

    let closed = false;
    const closePromise = queue.close().then(() => {
      closed = true;
    });
    expect(() => queue.enqueuePublication("publish_imdf", draftFor(venueId, 2), {})).toThrow(/closed/i);
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM versions").get() as { n: number }).n).toBe(1);
    await Promise.resolve();
    expect(closed).toBe(false);

    runnerDone.resolve();
    await closePromise;
    expect(closed).toBe(true);
    expect(jobRow(db, accepted.jobId).status).toBe("done");
    expect(versionRow(db, accepted.versionId).status).toBe("published");
  });

  it("forces close by deadline, marks the owned running job failed, and leaves queued successors for restart", async () => {
    vi.useFakeTimers();
    try {
      const db = makeTestDb();
      const venueId = seedVenue(db);
      const started = Promise.withResolvers<void>();
      const lateReturn = Promise.withResolvers<{ versionId: number }>();
      const runner: JobRunner = async (payloadJson) => {
        const { versionId } = JSON.parse(payloadJson) as { versionId: number };
        started.resolve();
        await lateReturn.promise;
        return { versionId };
      };
      const queue = new JobQueue(db, { publish_imdf: runner }, { closeGraceMs: 25, leaseMs: 1_000, heartbeatMs: 100 });
      const first = queue.enqueuePublication("publish_imdf", draftFor(venueId, 1), {});
      const second = queue.enqueuePublication("publish_imdf", draftFor(venueId, 2), {});
      await started.promise;

      const closePromise = queue.close();
      await vi.advanceTimersByTimeAsync(25);
      await closePromise;

      expect(errorCode(jobRow(db, first.jobId).error)).toBe("interrupted_by_shutdown");
      expect(errorCode(versionRow(db, first.versionId).error)).toBe("interrupted_by_shutdown");
      expect(leaseRow(db, first.jobId).ownerId).toBeNull();
      expect(leaseRow(db, second.jobId).status).toBe("queued");
      const forced = jobRow(db, first.jobId);

      lateReturn.resolve({ versionId: first.versionId });
      await Promise.resolve();
      await Promise.resolve();

      expect(jobRow(db, first.jobId)).toEqual(forced);
      expect(leaseRow(db, second.jobId).status).toBe("queued");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the active runner when the close grace deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const db = makeTestDb();
      const venueId = seedVenue(db);
      const started = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      const runner: JobRunner = async (_payloadJson, signal) => {
        started.resolve();
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        await aborted.promise;
        throw new Error("runner observed abort");
      };
      const queue = new JobQueue(db, { publish_imdf: runner }, { closeGraceMs: 25, leaseMs: 1_000, heartbeatMs: 100 });
      const accepted = queue.enqueuePublication("publish_imdf", draftFor(venueId, 1), {});
      await started.promise;

      const closePromise = queue.close();
      await vi.advanceTimersByTimeAsync(25);
      await aborted.promise;
      await closePromise;

      expect(errorCode(jobRow(db, accepted.jobId).error)).toBe("interrupted_by_shutdown");
      expect(errorCode(versionRow(db, accepted.versionId).error)).toBe("interrupted_by_shutdown");
    } finally {
      vi.useRealTimers();
    }
  });
});
