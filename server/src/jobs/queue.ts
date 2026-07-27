import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type JobRunner = (payloadJson: string, signal: AbortSignal) => Promise<unknown>;

export interface PublicationVersionDraft {
  venueId: number;
  seq: number;
  publicId: string;
  sourceBlobHash: string;
  sourceKind: "imdf" | "gdb";
  gdbSourceBlobHash?: string | null;
  gdbPlanJson?: string | null;
  networkJunctionsBlobHash?: string | null;
  networkPathsBlobHash?: string | null;
  facilitiesBlobHash?: string | null;
  synthesized?: boolean;
}

export interface JobQueueOptions {
  ownerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  closeGraceMs?: number;
}

interface JobRow {
  id: string;
  kind: string;
  payloadJson: string;
  versionId: number | null;
}

interface ActiveJob {
  controller: AbortController;
  heartbeat: NodeJS.Timeout;
}

interface StructuredError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

const LIVE_JOB_STATUSES = "'queued','running'";
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_CLOSE_GRACE_MS = 5_000;

function structured(code: string, message: string, details?: Record<string, unknown>): StructuredError {
  return details === undefined ? { code, message } : { code, message, details };
}

function tryParseStructured(message: string): StructuredError | null {
  try {
    const parsed: unknown = JSON.parse(message);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "code" in parsed &&
      "message" in parsed &&
      typeof parsed.code === "string" &&
      typeof parsed.message === "string"
    ) {
      const details = "details" in parsed && parsed.details !== null && typeof parsed.details === "object"
        ? (parsed.details as Record<string, unknown>)
        : undefined;
      return structured(parsed.code, parsed.message, details);
    }
  } catch {
    // Plain Error.message; normalize below.
  }
  return null;
}

function toStructuredError(error: unknown): StructuredError {
  if (error instanceof Error) {
    return tryParseStructured(error.message) ?? structured("internal_error", error.message);
  }
  return structured("internal_error", String(error));
}

function isoFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export class JobQueue {
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly closeGraceMs: number;
  private readonly active = new Map<string, ActiveJob>();
  private readonly abandoned = new Set<string>();

  constructor(
    private readonly db: Database.Database,
    private readonly runners: Record<string, JobRunner>,
    options: JobQueueOptions = {},
  ) {
    this.ownerId = options.ownerId ?? randomUUID();
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.recover();
  }

  enqueue(kind: string, payload: unknown): string {
    if (kind === "publish_imdf") {
      throw new Error("publication jobs must be enqueued with enqueuePublication");
    }
    this.assertOpen();
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO jobs (id, kind, payload_json) VALUES (?, ?, ?)")
      .run(id, kind, JSON.stringify(payload));
    this.schedule(id);
    return id;
  }

  enqueuePublication(
    kind: "publish_imdf",
    version: PublicationVersionDraft,
    payload: Record<string, unknown> = {},
  ): { jobId: string; versionId: number } {
    this.assertOpen();
    const jobId = randomUUID();
    const versionId = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO versions (
             venue_id, seq, public_id, source_blob_hash, source_kind,
             gdb_source_blob_hash, gdb_plan_json,
             net_junctions_blob_hash, net_paths_blob_hash, facilities_blob_hash, synthesized
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          version.venueId,
          version.seq,
          version.publicId,
          version.sourceBlobHash,
          version.sourceKind,
          version.gdbSourceBlobHash ?? null,
          version.gdbPlanJson ?? null,
          version.networkJunctionsBlobHash ?? null,
          version.networkPathsBlobHash ?? null,
          version.facilitiesBlobHash ?? null,
          version.synthesized === true ? 1 : 0,
        );
      const insertedVersionId = Number(info.lastInsertRowid);
      this.db
        .prepare("INSERT INTO jobs (id, kind, version_id, payload_json) VALUES (?, ?, ?, ?)")
        .run(jobId, kind, insertedVersionId, JSON.stringify({ ...payload, versionId: insertedVersionId }));
      return insertedVersionId;
    })();
    this.schedule(jobId);
    return { jobId, versionId };
  }

  /** Resolves when every runnable job in this process has finished (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  async close(graceMs = this.closeGraceMs): Promise<void> {
    this.closed = true;
    const drained = this.chain.then(
      () => "drained" as const,
      () => "drained" as const,
    );
    const timeout = Promise.withResolvers<"timeout">();
    const timer = setTimeout(() => timeout.resolve("timeout"), graceMs);
    timer.unref?.();
    const closeOutcome = await Promise.race([drained, timeout.promise]);
    clearTimeout(timer);
    if (closeOutcome === "drained") {
      return;
    }
    this.forceShutdownActiveJobs();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("job queue is closed");
    }
  }

  private recover(): void {
    const interrupted = structured("interrupted_by_restart", "Job was interrupted by server restart");
    // Leases are stored as ISO-8601 UTC (see `isoFromNow`); compare against an
    // ISO "now" so the ordering is lexicographically valid. SQLite's own
    // `datetime('now')` uses a space separator and would never order correctly
    // against the `T`/`Z` ISO strings.
    const now = new Date().toISOString();
    const running = this.db
      .prepare(
        `SELECT id, version_id AS versionId FROM jobs
         WHERE status = 'running'
           AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
      )
      .all(now) as Array<{ id: string; versionId: number | null }>;
    const markInterrupted = this.db.transaction((jobId: string, versionId: number | null) => {
      const result = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'error', owner_id = NULL, lease_expires_at = NULL,
               result_json = NULL, error = ?, updated_at = datetime('now')
           WHERE id = ? AND status = 'running'
             AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
        )
        .run(JSON.stringify(interrupted), jobId, new Date().toISOString());
      if (result.changes === 1) {
        this.failDraftVersion(versionId, interrupted);
      }
    });
    for (const job of running) {
      markInterrupted(job.id, job.versionId);
    }

    const orphaned = structured("orphaned_job", "Draft version has no live publication job");
    this.db
      .prepare(
        `UPDATE versions
         SET status = 'failed', bundle_hash = NULL, error = ?
         WHERE status = 'draft'
           AND NOT EXISTS (
             SELECT 1 FROM jobs
             WHERE jobs.version_id = versions.id
               AND jobs.status IN (${LIVE_JOB_STATUSES})
           )`,
      )
      .run(JSON.stringify(orphaned));

    const queued = this.db
      .prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at, id")
      .all() as Array<{ id: string }>;
    for (const job of queued) {
      this.schedule(job.id);
    }
  }

  private schedule(id: string): void {
    this.chain = this.chain.then(() => this.run(id));
  }

  private async run(id: string): Promise<void> {
    if (this.closed) {
      return;
    }
    const claimed = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'running', owner_id = ?, lease_expires_at = ?,
             result_json = NULL, error = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'queued'`,
      )
      .run(this.ownerId, isoFromNow(this.leaseMs), id);
    if (claimed.changes !== 1) {
      return;
    }

    const row = this.db
      .prepare("SELECT id, kind, payload_json AS payloadJson, version_id AS versionId FROM jobs WHERE id = ? AND owner_id = ?")
      .get(id, this.ownerId) as JobRow | undefined;
    if (row === undefined) {
      return;
    }

    const runner = this.runners[row.kind];
    if (!runner) {
      this.failJob(row, structured("missing_runner", `No runner registered for job kind ${row.kind}`));
      return;
    }

    const controller = new AbortController();
    const heartbeat = setInterval(() => this.extendLease(row.id), this.heartbeatMs);
    heartbeat.unref?.();
    this.active.set(row.id, { controller, heartbeat });
    try {
      const result = await runner(row.payloadJson, controller.signal);
      if (this.abandoned.has(row.id)) {
        return;
      }
      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'done', owner_id = NULL, lease_expires_at = NULL,
               result_json = ?, error = NULL, updated_at = datetime('now')
           WHERE id = ? AND status = 'running' AND owner_id = ?`,
        )
        .run(JSON.stringify(result ?? null), row.id, this.ownerId);
    } catch (error) {
      if (!this.abandoned.has(row.id)) {
        this.failJob(row, toStructuredError(error));
      }
    } finally {
      clearInterval(heartbeat);
      this.active.delete(row.id);
      this.abandoned.delete(row.id);
    }
  }

  private extendLease(id: string): void {
    if (this.abandoned.has(id)) {
      return;
    }
    this.db
      .prepare(
        `UPDATE jobs
         SET lease_expires_at = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'running' AND owner_id = ?`,
      )
      .run(isoFromNow(this.leaseMs), id, this.ownerId);
  }

  private forceShutdownActiveJobs(): void {
    const error = structured("interrupted_by_shutdown", "Job was interrupted by server shutdown");
    for (const [id, active] of this.active) {
      this.abandoned.add(id);
      clearInterval(active.heartbeat);
      active.controller.abort();
      const row = this.db
        .prepare("SELECT id, kind, payload_json AS payloadJson, version_id AS versionId FROM jobs WHERE id = ?")
        .get(id) as JobRow | undefined;
      if (row !== undefined) {
        this.failJob(row, error);
      }
    }
  }

  private failJob(row: JobRow, error: StructuredError): void {
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'error', owner_id = NULL, lease_expires_at = NULL,
               result_json = NULL, error = ?, updated_at = datetime('now')
           WHERE id = ? AND status = 'running' AND owner_id = ?`,
        )
        .run(JSON.stringify(error), row.id, this.ownerId);
      if (result.changes === 1) {
        this.failDraftVersion(row.versionId, error);
      }
    })();
  }

  private failDraftVersion(versionId: number | null, error: StructuredError): void {
    if (versionId === null) {
      return;
    }
    this.db
      .prepare("UPDATE versions SET status = 'failed', bundle_hash = NULL, error = ? WHERE id = ? AND status = 'draft'")
      .run(JSON.stringify(error), versionId);
  }
}
