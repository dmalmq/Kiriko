import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IssueServiceError } from "../src/issues/errors";
import type {
  CreateReplyCommand,
  CreateRootCommand,
  PublishedReviewVersion,
  RepositoryMutationResult,
} from "../src/issues/repository";
import { IssueRepository } from "../src/issues/repository";
import type { IssueErrorCode, NormalizedRootCreate, ReviewIssue } from "../src/issues/types";
import { hashReplyCreate, hashRootCreate } from "../src/issues/validation";
import { cleanupTestApps, makeTestDb } from "./helpers";

const PUBLIC_A = "a".repeat(64);
const PUBLIC_B = "b".repeat(64);
const PUBLIC_C = "c".repeat(64);
const PUBLIC_DRAFT = "d".repeat(64);

const T1 = new Date("2026-07-18T00:00:01.111Z").toISOString();
const T2 = new Date("2026-07-18T00:00:02.222Z").toISOString();
const T3 = new Date("2026-07-18T00:00:03.333Z").toISOString();

let db: Database.Database;
let repo: IssueRepository;

function seed(database: Database.Database): void {
  const insertUser = database.prepare(
    "INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'hash', ?)",
  );
  insertUser.run(1, "alice", "admin");
  insertUser.run(2, "bob", "member");
  insertUser.run(3, "cara", "member");
  insertUser.run(4, "dave", "viewer");
  const insertVenue = database.prepare(
    "INSERT INTO venues (id, tenant_id, slug, name, created_by) VALUES (?, 1, ?, ?, 1)",
  );
  insertVenue.run(10, "station", "Station");
  insertVenue.run(11, "annex", "Annex");
  const insertVersion = database.prepare(
    `INSERT INTO versions (id, venue_id, seq, public_id, source_blob_hash, bundle_hash, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertVersion.run(100, 10, 1, PUBLIC_A, "src-a", "bundle-a", "published");
  insertVersion.run(101, 10, 2, PUBLIC_DRAFT, "src-d", null, "draft");
  insertVersion.run(102, 10, 3, PUBLIC_B, "src-b", "bundle-b", "published");
  insertVersion.run(103, 11, 1, PUBLIC_C, "src-c", "bundle-c", "published");
}

beforeEach(() => {
  db = makeTestDb();
  seed(db);
  repo = new IssueRepository(db);
});

afterEach(async () => {
  await cleanupTestApps();
});

function published(publicId: string): PublishedReviewVersion {
  const version = repo.resolvePublishedVersion(publicId);
  if (!version) {
    throw new Error(`seed version ${publicId} is not published`);
  }
  return version;
}

interface RootOverrides {
  version?: PublishedReviewVersion;
  authorId?: number;
  requestId?: string;
  now?: string;
  input?: Partial<NormalizedRootCreate>;
}

function rootCommand(overrides: RootOverrides = {}): CreateRootCommand {
  const version = overrides.version ?? published(PUBLIC_A);
  const input: NormalizedRootCreate = {
    bodyMarkdown: "Broken escalator",
    attachmentIds: [],
    levelId: "level-1",
    longitude: 139.7,
    latitude: 35.68,
    featureId: null,
    assigneeId: null,
    dueDate: null,
    ...overrides.input,
  };
  return {
    version,
    authorId: overrides.authorId ?? 1,
    requestId: overrides.requestId ?? randomUUID(),
    requestHash: hashRootCreate(input, version.versionId),
    input,
    now: overrides.now ?? T1,
  };
}

interface ReplyOverrides {
  version?: PublishedReviewVersion;
  authorId?: number;
  requestId?: string;
  now?: string;
  bodyMarkdown?: string;
}

function replyCommand(parentIssueId: string, overrides: ReplyOverrides = {}): CreateReplyCommand {
  const version = overrides.version ?? published(PUBLIC_A);
  const input = { bodyMarkdown: overrides.bodyMarkdown ?? "Acknowledged", attachmentIds: [] };
  return {
    version,
    parentIssueId,
    authorId: overrides.authorId ?? 2,
    requestId: overrides.requestId ?? randomUUID(),
    requestHash: hashReplyCreate(input, version.versionId, parentIssueId),
    input,
    now: overrides.now ?? T1,
  };
}

function ok(result: RepositoryMutationResult) {
  if (result.type !== "ok") {
    throw new Error(`expected ok result, got ${result.type}`);
  }
  return result;
}

function stale(result: RepositoryMutationResult) {
  if (result.type !== "stale") {
    throw new Error(`expected stale result, got ${result.type}`);
  }
  return result;
}

function expectIssueError(fn: () => unknown, code: IssueErrorCode): IssueServiceError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(IssueServiceError);
    const serviceError = error as IssueServiceError;
    expect(serviceError.code).toBe(code);
    return serviceError;
  }
  throw new Error(`expected IssueServiceError ${code}`);
}

function stateRow(versionId: number): { revision: number; nextPinNumber: number } | undefined {
  return db
    .prepare("SELECT revision, next_pin_number AS nextPinNumber FROM comment_state WHERE version_id = ?")
    .get(versionId) as { revision: number; nextPinNumber: number } | undefined;
}

function commentCount(versionId: number): number {
  return (
    db.prepare("SELECT count(*) AS c FROM comments WHERE version_id = ?").get(versionId) as { c: number }
  ).c;
}

function findIssue(collection: { issues: ReviewIssue[] }, id: string): ReviewIssue {
  const issue = collection.issues.find((candidate) => candidate.id === id);
  if (!issue) {
    throw new Error(`issue ${id} missing from collection`);
  }
  return issue;
}

describe("IssueRepository.resolvePublishedVersion", () => {
  it("resolves only currently published versions with bundles", () => {
    expect(repo.resolvePublishedVersion(PUBLIC_A)).toEqual({
      versionId: 100,
      publicVersionId: PUBLIC_A,
      bundleHash: "bundle-a",
    });
    expect(repo.resolvePublishedVersion(PUBLIC_DRAFT)).toBeNull();
    expect(repo.resolvePublishedVersion("f".repeat(64))).toBeNull();
    db.prepare("UPDATE versions SET status = 'archived' WHERE id = 102").run();
    expect(repo.resolvePublishedVersion(PUBLIC_B)).toBeNull();
  });
});

describe("IssueRepository lazy state (contract 1)", () => {
  it("starts at revision 0 and next pin 1 without prior writes", () => {
    expect(stateRow(100)).toBeUndefined();
    expect(repo.getCurrentRevision(100)).toBe(0);
    expect(stateRow(100)).toEqual({ revision: 0, nextPinNumber: 1 });
    expect(repo.getCollection(102)).toEqual({ revision: 0, issues: [] });
    expect(stateRow(102)).toEqual({ revision: 0, nextPinNumber: 1 });
  });
});

describe("IssueRepository pin allocation (contract 2)", () => {
  it("allocates 1,2,3 and never reuses a deleted pin", () => {
    const first = ok(repo.createRoot(rootCommand()));
    const second = ok(repo.createRoot(rootCommand({ input: { bodyMarkdown: "Second" } })));
    const third = ok(repo.createRoot(rootCommand({ input: { bodyMarkdown: "Third" } })));
    let collection = repo.getCollection(100);
    expect(collection.issues.map((issue) => issue.pinNumber)).toEqual([1, 2, 3]);

    repo.deleteIssue({ issueId: second.resourceId, expectedVersion: 1, now: T2 });
    db.prepare("DELETE FROM comments WHERE id = ?").run(second.resourceId);
    const fourth = ok(repo.createRoot(rootCommand({ input: { bodyMarkdown: "Fourth" } })));
    collection = repo.getCollection(100);
    expect(collection.issues.map((issue) => issue.id)).toEqual([
      first.resourceId,
      third.resourceId,
      fourth.resourceId,
    ]);
    expect(collection.issues.map((issue) => issue.pinNumber)).toEqual([1, 3, 4]);
  });
});

describe("IssueRepository snapshot reads (contract 3)", () => {
  it("returns a consistent snapshot with deterministic ordering", () => {
    const root = ok(
      repo.createRoot(
        rootCommand({
          input: {
            bodyMarkdown: "Check signage",
            featureId: "feature-9",
            assigneeId: 2,
            dueDate: "2026-08-01",
          },
        }),
      ),
    );
    const replyIds = [
      ok(repo.createReply(replyCommand(root.resourceId, { bodyMarkdown: "r-one", now: T2 }))).resourceId,
      ok(repo.createReply(replyCommand(root.resourceId, { bodyMarkdown: "r-two", now: T2 }))).resourceId,
      ok(repo.createReply(replyCommand(root.resourceId, { bodyMarkdown: "r-three", now: T2 }))).resourceId,
    ];
    const collection = repo.getCollection(100);
    expect(collection.revision).toBe(4);
    expect(collection.revision).toBe(repo.getCurrentRevision(100));

    const issue = findIssue(collection, root.resourceId);
    expect(issue.pinNumber).toBe(1);
    expect(issue.rowVersion).toBe(1);
    expect(issue.anchor).toEqual({
      levelId: "level-1",
      longitude: 139.7,
      latitude: 35.68,
      featureId: "feature-9",
    });
    expect(issue.bodyMarkdown).toBe("Check signage");
    expect(issue.status).toBe("open");
    expect(issue.author).toEqual({ id: 1, username: "alice" });
    expect(issue.assignee).toEqual({ id: 2, username: "bob" });
    expect(issue.dueDate).toBe("2026-08-01");
    expect(issue.createdAt).toBe(T1);
    expect(issue.updatedAt).toBe(T1);
    expect(issue.deletedAt).toBeNull();
    // Identical created_at values fall back to the id tie-breaker.
    expect(issue.replies.map((reply) => reply.id)).toEqual([...replyIds].sort());
    expect(issue.replies.every((reply) => reply.createdAt === T2)).toBe(true);
    expect(issue.replies[0]?.author).toEqual({ id: 2, username: "bob" });
  });

  it("omits featureId from the anchor when the root has none", () => {
    const root = ok(repo.createRoot(rootCommand()));
    const issue = findIssue(repo.getCollection(100), root.resourceId);
    expect(issue.anchor).toEqual({ levelId: "level-1", longitude: 139.7, latitude: 35.68 });
  });
});

describe("IssueRepository reviewer lookup", () => {
  it("lists every account deterministically", () => {
    expect(repo.listReviewers()).toEqual([
      { id: 1, username: "alice" },
      { id: 2, username: "bob" },
      { id: 3, username: "cara" },
      { id: 4, username: "dave" },
    ]);
  });
});

describe("IssueRepository replay probe (contract 4)", () => {
  it("returns null for an absent request key without touching state", () => {
    expect(repo.probeCreateReplay(1, randomUUID(), "0".repeat(64))).toBeNull();
    expect(stateRow(100)).toBeUndefined();
  });

  it("replays an existing create without row, pin, or revision changes", () => {
    const command = rootCommand();
    const created = ok(repo.createRoot(command));
    const before = stateRow(100);
    const count = commentCount(100);

    const probe = repo.probeCreateReplay(command.authorId, command.requestId, command.requestHash);
    expect(probe).not.toBeNull();

    const replay = ok(probe!);
    expect(replay.replayed).toBe(true);
    expect(replay.resourceId).toBe(created.resourceId);
    expect(replay.revision).toBe(created.revision);
    expect(replay.versionId).toBe(100);
    expect(replay.publicVersionId).toBe(PUBLIC_A);
    expect(stateRow(100)).toEqual(before);
    expect(commentCount(100)).toBe(count);
  });

  it("serializes concurrent final creates into one commit and one replay", async () => {
    const command = rootCommand();
    const repositoryUrl = new URL("../src/issues/repository.ts", import.meta.url).href;
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      const { createRequire } = require("node:module");
      const requireFromServer = createRequire(workerData.packagePath);
      const { register } = requireFromServer("tsx/esm/api");
      register();
      const Database = requireFromServer("better-sqlite3");
      import(workerData.repositoryUrl).then(({ IssueRepository }) => {
        const database = new Database(workerData.databasePath);
        database.pragma("journal_mode = WAL");
        database.pragma("foreign_keys = ON");
        parentPort.once("message", (createCommand) => {
          try {
            parentPort.postMessage({
              result: new IssueRepository(database).createRoot(createCommand),
            });
          } catch (error) {
            parentPort.postMessage({
              error: {
                code: error && typeof error === "object" && "code" in error ? error.code : undefined,
                message: error instanceof Error ? error.message : String(error),
              },
            });
          } finally {
            database.close();
          }
        });
        parentPort.postMessage({ ready: true });
      });
    `;
    const workerData = {
      packagePath: new URL("../package.json", import.meta.url).pathname,
      repositoryUrl,
      databasePath: db.name,
    };
    const workers = [
      new Worker(workerSource, { eval: true, workerData }),
      new Worker(workerSource, { eval: true, workerData }),
    ];
    try {
      const ready = await Promise.all(workers.map((worker) => once(worker, "message")));
      expect(ready.map(([message]) => message)).toEqual([{ ready: true }, { ready: true }]);
      for (const worker of workers) {
        worker.postMessage(command);
      }
      const replies = await Promise.all(workers.map((worker) => once(worker, "message")));
      expect(replies.map(([message]) => message.error)).toEqual([undefined, undefined]);
      expect(replies.map(([message]) => message.result.replayed).sort()).toEqual([false, true]);
      expect(new Set(replies.map(([message]) => message.result.resourceId)).size).toBe(1);
      expect(replies.map(([message]) => message.result.revision)).toEqual([1, 1]);
      expect(commentCount(100)).toBe(1);
      expect(stateRow(100)).toEqual({ revision: 1, nextPinNumber: 2 });
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  });

  it("throws idempotency_conflict when the stored hash differs", () => {
    const command = rootCommand();
    ok(repo.createRoot(command));
    expectIssueError(
      () => repo.probeCreateReplay(command.authorId, command.requestId, "0".repeat(64)),
      "idempotency_conflict",
    );
  });

  it("repeats the replay decision inside the final create transaction", () => {
    const command = rootCommand();
    const created = ok(repo.createRoot(command));
    const before = stateRow(100);

    const replayed = ok(repo.createRoot(command));
    expect(replayed.replayed).toBe(true);
    expect(replayed.resourceId).toBe(created.resourceId);
    expect(replayed.revision).toBe(created.revision);
    expect(stateRow(100)).toEqual(before);
    expect(commentCount(100)).toBe(1);

    const reply = replyCommand(created.resourceId);
    const createdReply = ok(repo.createReply(reply));
    const replayedReply = ok(repo.createReply(reply));
    expect(replayedReply.replayed).toBe(true);
    expect(replayedReply.resourceId).toBe(createdReply.resourceId);
    expect(commentCount(100)).toBe(2);
  });
});

describe("IssueRepository idempotency across mutable state (contract 5)", () => {
  it("replays a root create after the assignee account is deleted", () => {
    const command = rootCommand({ input: { assigneeId: 2 } });
    const created = ok(repo.createRoot(command));
    db.prepare("DELETE FROM users WHERE id = 2").run();
    expect(
      db.prepare("SELECT assignee_id AS a FROM comments WHERE id = ?").get(created.resourceId),
    ).toEqual({ a: null });

    const replay = ok(repo.createRoot(command));
    expect(replay.replayed).toBe(true);
    expect(replay.resourceId).toBe(created.resourceId);
  });

  it("replays after an author role change and after parent tombstoning", () => {
    const root = ok(repo.createRoot(rootCommand()));
    const reply = replyCommand(root.resourceId, { authorId: 4 });
    const createdReply = ok(repo.createReply(reply));

    db.prepare("UPDATE users SET role = 'viewer' WHERE id = 4").run();
    repo.deleteIssue({ issueId: root.resourceId, expectedVersion: 1, now: T2 });

    const replay = ok(repo.createReply(reply));
    expect(replay.replayed).toBe(true);
    expect(replay.resourceId).toBe(createdReply.resourceId);
  });

  it("rejects the same request ID across kind, version, parent, and payload conflicts", () => {
    const requestId = randomUUID();
    const root = ok(repo.createRoot(rootCommand({ requestId })));

    // Same key, different payload.
    expectIssueError(
      () => repo.createRoot(rootCommand({ requestId, input: { bodyMarkdown: "Different" } })),
      "idempotency_conflict",
    );
    // Same key, different kind.
    expectIssueError(() => repo.createReply(replyCommand(root.resourceId, { authorId: 1, requestId })), "idempotency_conflict");
    // Same key, different version.
    expectIssueError(
      () => repo.createRoot(rootCommand({ requestId, version: published(PUBLIC_B) })),
      "idempotency_conflict",
    );

    const parentRequestId = randomUUID();
    ok(repo.createReply(replyCommand(root.resourceId, { requestId: parentRequestId })));
    const secondRoot = ok(repo.createRoot(rootCommand()));
    expectIssueError(
      () => repo.createReply(replyCommand(secondRoot.resourceId, { requestId: parentRequestId })),
      "idempotency_conflict",
    );
  });
});

describe("IssueRepository revision accounting (contract 6)", () => {
  it("increments the collection revision exactly once per non-replay commit", () => {
    expect(repo.getCurrentRevision(100)).toBe(0);
    const root = ok(repo.createRoot(rootCommand()));
    expect(root.revision).toBe(1);
    const reply = ok(repo.createReply(replyCommand(root.resourceId)));
    expect(reply.revision).toBe(2);
    expect(ok(repo.patchIssue({
      issueId: root.resourceId,
      patch: { type: "body", bodyMarkdown: "Edited", expectedVersion: 1, attachmentIds: [] },
      now: T2,
    })).revision).toBe(3);
    expect(ok(repo.patchIssue({
      issueId: root.resourceId,
      patch: { type: "status", status: "in_review", expectedVersion: 2 },
      now: T2,
    })).revision).toBe(4);
    expect(ok(repo.patchIssue({
      issueId: root.resourceId,
      patch: { type: "assignment", assigneeId: 3, expectedVersion: 3 },
      now: T2,
    })).revision).toBe(5);
    expect(ok(repo.patchIssue({
      issueId: root.resourceId,
      patch: { type: "due_date", dueDate: "2026-09-01", expectedVersion: 4 },
      now: T2,
    })).revision).toBe(6);
    expect(ok(repo.patchReply({
      replyId: reply.resourceId,
      patch: { type: "body", bodyMarkdown: "Edited reply", expectedVersion: 1, attachmentIds: [] },
      now: T2,
    })).revision).toBe(7);
    expect(ok(repo.deleteReply({ replyId: reply.resourceId, expectedVersion: 2, now: T3 })).revision).toBe(8);
    expect(ok(repo.deleteIssue({ issueId: root.resourceId, expectedVersion: 5, now: T3 })).revision).toBe(9);
    expect(repo.getCurrentRevision(100)).toBe(9);
  });
});

describe("IssueRepository stale mutations (contract 7)", () => {
  it("returns the current issue and revision without incrementing", () => {
    const root = ok(repo.createRoot(rootCommand()));
    ok(repo.patchIssue({
      issueId: root.resourceId,
      patch: { type: "body", bodyMarkdown: "Edited", expectedVersion: 1, attachmentIds: [] },
      now: T2,
    }));
    const result = stale(repo.patchIssue({
      issueId: root.resourceId,
      patch: { type: "body", bodyMarkdown: "Lost update", expectedVersion: 1, attachmentIds: [] },
      now: T3,
    }));
    expect(result.revision).toBe(2);
    expect(result.versionId).toBe(100);
    expect(result.publicVersionId).toBe(PUBLIC_A);
    expect(result.current.kind).toBe("issue");
    const current = result.current.value as ReviewIssue;
    expect(current.id).toBe(root.resourceId);
    expect(current.rowVersion).toBe(2);
    expect(current.bodyMarkdown).toBe("Edited");
    expect(repo.getCurrentRevision(100)).toBe(2);
    expect(db.prepare("SELECT body_markdown AS b FROM comments WHERE id = ?").get(root.resourceId)).toEqual({
      b: "Edited",
    });
  });

  it("returns the current reply for stale reply patches and deletes", () => {
    const root = ok(repo.createRoot(rootCommand()));
    const reply = ok(repo.createReply(replyCommand(root.resourceId)));
    ok(repo.patchReply({
      replyId: reply.resourceId,
      patch: { type: "body", bodyMarkdown: "Edited reply", expectedVersion: 1, attachmentIds: [] },
      now: T2,
    }));

    const stalePatch = stale(repo.patchReply({
      replyId: reply.resourceId,
      patch: { type: "body", bodyMarkdown: "Old edit", expectedVersion: 1, attachmentIds: [] },
      now: T3,
    }));
    expect(stalePatch.current.kind).toBe("reply");
    expect(stalePatch.current.value.rowVersion).toBe(2);
    expect(stalePatch.revision).toBe(3);

    const staleDelete = stale(repo.deleteReply({ replyId: reply.resourceId, expectedVersion: 1, now: T3 }));
    expect(staleDelete.current.value.rowVersion).toBe(2);
    expect(repo.getCurrentRevision(100)).toBe(3);

    const staleIssueDelete = stale(repo.deleteIssue({ issueId: root.resourceId, expectedVersion: 9, now: T3 }));
    expect(staleIssueDelete.current.kind).toBe("issue");
    expect(repo.getCurrentRevision(100)).toBe(3);
  });
  it("returns stale or tombstone state before validating a vanished assignee", () => {
    const root = ok(repo.createRoot(rootCommand()));
    ok(repo.patchIssue({
      issueId: root.resourceId,
      patch: { type: "body", bodyMarkdown: "Edited", expectedVersion: 1, attachmentIds: [] },
      now: T2,
    }));
    db.prepare("DELETE FROM users WHERE id = 2").run();

    const staleAssignment = stale(repo.patchIssue({
      issueId: root.resourceId,
      patch: { type: "assignment", assigneeId: 2, expectedVersion: 1 },
      now: T3,
    }));
    expect(staleAssignment.current.value.rowVersion).toBe(2);
    expect(staleAssignment.revision).toBe(2);

    ok(repo.deleteIssue({ issueId: root.resourceId, expectedVersion: 2, now: T3 }));
    expectIssueError(() => repo.patchIssue({
      issueId: root.resourceId,
      patch: { type: "assignment", assigneeId: 2, expectedVersion: 3 },
      now: T3,
    }), "issue_deleted");
    expectIssueError(() => repo.patchIssue({
      issueId: "missing",
      patch: { type: "assignment", assigneeId: 2, expectedVersion: 1 },
      now: T3,
    }), "not_found");
  });

});

describe("IssueRepository context lookups (contract 8)", () => {
  it("exposes identity and current mutable state for roots and replies", () => {
    const root = ok(repo.createRoot(rootCommand({ input: { assigneeId: 2 } })));
    const reply = ok(repo.createReply(replyCommand(root.resourceId, { authorId: 3 })));

    expect(repo.getIssueContext(root.resourceId)).toEqual({
      kind: "issue",
      issueId: root.resourceId,
      versionId: 100,
      publicVersionId: PUBLIC_A,
      authorId: 1,
      status: "open",
      assigneeId: 2,
      rowVersion: 1,
      deletedAt: null,
    });
    expect(repo.getReplyContext(reply.resourceId)).toEqual({
      kind: "reply",
      replyId: reply.resourceId,
      parentIssueId: root.resourceId,
      versionId: 100,
      publicVersionId: PUBLIC_A,
      authorId: 3,
      rowVersion: 1,
      deletedAt: null,
      parentDeletedAt: null,
    });

    repo.deleteIssue({ issueId: root.resourceId, expectedVersion: 1, now: T2 });
    expect(repo.getIssueContext(root.resourceId)).toMatchObject({
      deletedAt: T2,
      status: "closed",
      rowVersion: 2,
    });
    expect(repo.getReplyContext(reply.resourceId)).toMatchObject({ parentDeletedAt: T2 });
  });

  it("rejects wrong-kind, unknown, deleted-version, and unpublished resources", () => {
    const root = ok(repo.createRoot(rootCommand()));
    const reply = ok(repo.createReply(replyCommand(root.resourceId)));
    const otherRoot = ok(repo.createRoot(rootCommand({ version: published(PUBLIC_B) })));

    expect(repo.getIssueContext(reply.resourceId)).toBeNull();
    expect(repo.getReplyContext(root.resourceId)).toBeNull();
    expect(repo.getIssueContext("missing")).toBeNull();
    expect(repo.getReplyContext("missing")).toBeNull();

    db.prepare("DELETE FROM versions WHERE id = 102").run();
    expect(repo.getIssueContext(otherRoot.resourceId)).toBeNull();

    db.prepare("UPDATE versions SET status = 'archived' WHERE id = 100").run();
    expect(repo.getIssueContext(root.resourceId)).toBeNull();
    expect(repo.getReplyContext(reply.resourceId)).toBeNull();
  });
});

describe("IssueRepository create rechecks and races (contracts 5, 9)", () => {
  it("rejects a non-replay root create after the version is unpublished", () => {
    const version = published(PUBLIC_A);
    db.prepare("UPDATE versions SET status = 'archived' WHERE id = 100").run();
    expectIssueError(() => repo.createRoot(rootCommand({ version })), "not_found");
    expect(commentCount(100)).toBe(0);
    expect(stateRow(100)?.revision ?? 0).toBe(0);
  });

  it("rejects a non-replay root create after the resolved bundle identity changes", () => {
    const version = published(PUBLIC_A);
    db.prepare("UPDATE versions SET bundle_hash = 'bundle-recompiled' WHERE id = 100").run();
    expectIssueError(() => repo.createRoot(rootCommand({ version })), "not_found");
    expect(commentCount(100)).toBe(0);
  });

  it("rejects a non-replay root create when the assignee account vanished", () => {
    const command = rootCommand({ input: { assigneeId: 2 } });
    db.prepare("DELETE FROM users WHERE id = 2").run();
    expectIssueError(() => repo.createRoot(command), "invalid_request");
    expect(commentCount(100)).toBe(0);
  });

  it("accepts replies to closed roots and rejects replies to deleted roots", () => {
    const root = ok(repo.createRoot(rootCommand()));
    ok(repo.patchIssue({
      issueId: root.resourceId,
      patch: { type: "status", status: "closed", expectedVersion: 1 },
      now: T2,
    }));
    const onClosed = ok(repo.createReply(replyCommand(root.resourceId)));
    expect(onClosed.replayed).toBe(false);

    // Simulates the probe/create race: the parent is tombstoned after the
    // caller resolved its context but before the create transaction runs.
    const pending = replyCommand(root.resourceId, { bodyMarkdown: "Too late" });
    repo.deleteIssue({ issueId: root.resourceId, expectedVersion: 2, now: T2 });
    expectIssueError(() => repo.createReply(pending), "issue_deleted");
    expectIssueError(
      () => repo.createReply(replyCommand(root.resourceId, { bodyMarkdown: "Still too late" })),
      "issue_deleted",
    );
    expectIssueError(() => repo.createReply(replyCommand("missing")), "not_found");
    expectIssueError(
      () => repo.createReply(replyCommand(root.resourceId, { version: published(PUBLIC_B) })),
      "not_found",
    );
  });
});

describe("IssueRepository tombstones (contract 10)", () => {
  it("nulls the root body, closes status, and preserves metadata and replies", () => {
    const root = ok(repo.createRoot(rootCommand({
      input: { featureId: "feature-9", assigneeId: 2, dueDate: "2026-08-01" },
    })));
    const reply = ok(repo.createReply(replyCommand(root.resourceId, { authorId: 3, now: T2 })));
    const other = ok(repo.createReply(replyCommand(root.resourceId, { authorId: 2, bodyMarkdown: "Keep me", now: T2 })));

    ok(repo.deleteIssue({ issueId: root.resourceId, expectedVersion: 1, now: T3 }));
    const issue = findIssue(repo.getCollection(100), root.resourceId);
    expect(issue.bodyMarkdown).toBeNull();
    expect(issue.deletedAt).toBe(T3);
    expect(issue.status).toBe("closed");
    expect(issue.pinNumber).toBe(1);
    expect(issue.anchor).toEqual({
      levelId: "level-1",
      longitude: 139.7,
      latitude: 35.68,
      featureId: "feature-9",
    });
    expect(issue.author).toEqual({ id: 1, username: "alice" });
    expect(issue.assignee).toEqual({ id: 2, username: "bob" });
    expect(issue.dueDate).toBe("2026-08-01");
    expect(issue.createdAt).toBe(T1);
    expect(issue.replies).toHaveLength(2);

    // Existing reply authors may still edit and delete after root deletion.
    ok(repo.patchReply({
      replyId: reply.resourceId,
      patch: { type: "body", bodyMarkdown: "Edited after root delete", expectedVersion: 1, attachmentIds: [] },
      now: T3,
    }));
    ok(repo.deleteReply({ replyId: other.resourceId, expectedVersion: 1, now: T3 }));

    const after = findIssue(repo.getCollection(100), root.resourceId);
    const edited = after.replies.find((candidate) => candidate.id === reply.resourceId);
    const deleted = after.replies.find((candidate) => candidate.id === other.resourceId);
    expect(edited?.bodyMarkdown).toBe("Edited after root delete");
    expect(edited?.deletedAt).toBeNull();
    expect(deleted?.bodyMarkdown).toBeNull();
    expect(deleted?.deletedAt).toBe(T3);
  });

  it("rejects mutating tombstoned resources with issue_deleted", () => {
    const root = ok(repo.createRoot(rootCommand()));
    const reply = ok(repo.createReply(replyCommand(root.resourceId)));
    ok(repo.deleteReply({ replyId: reply.resourceId, expectedVersion: 1, now: T2 }));
    ok(repo.deleteIssue({ issueId: root.resourceId, expectedVersion: 1, now: T2 }));

    expectIssueError(() => repo.patchIssue({
      issueId: root.resourceId,
      patch: { type: "body", bodyMarkdown: "Necromancy", expectedVersion: 2, attachmentIds: [] },
      now: T3,
    }), "issue_deleted");
    expectIssueError(() => repo.deleteIssue({ issueId: root.resourceId, expectedVersion: 2, now: T3 }), "issue_deleted");
    expectIssueError(() => repo.patchReply({
      replyId: reply.resourceId,
      patch: { type: "body", bodyMarkdown: "Necromancy", expectedVersion: 2, attachmentIds: [] },
      now: T3,
    }), "issue_deleted");
    expectIssueError(() => repo.deleteReply({ replyId: reply.resourceId, expectedVersion: 2, now: T3 }), "issue_deleted");
    expectIssueError(() => repo.patchIssue({
      issueId: "missing",
      patch: { type: "body", bodyMarkdown: "x", expectedVersion: 1, attachmentIds: [] },
      now: T3,
    }), "not_found");
  });
});

describe("IssueRepository cascades (contract 11)", () => {
  it("deletes state and comments when the venue or version is deleted", () => {
    const annexRoot = ok(repo.createRoot(rootCommand({ version: published(PUBLIC_C) })));
    ok(repo.createReply(replyCommand(annexRoot.resourceId, { version: published(PUBLIC_C) })));
    expect(commentCount(103)).toBe(2);

    db.prepare("DELETE FROM venues WHERE id = 11").run();
    expect(commentCount(103)).toBe(0);
    expect(stateRow(103)).toBeUndefined();

    const stationRoot = ok(repo.createRoot(rootCommand({ version: published(PUBLIC_B) })));
    ok(repo.createReply(replyCommand(stationRoot.resourceId, { version: published(PUBLIC_B) })));
    db.prepare("DELETE FROM versions WHERE id = 102").run();
    expect(commentCount(102)).toBe(0);
    expect(stateRow(102)).toBeUndefined();
  });
});

describe("IssueRepository timestamps (contract 12)", () => {
  it("stores exact application toISOString values under TZ=Asia/Tokyo", () => {
    const previousTimeZone = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      expect(process.env.TZ).toBe("Asia/Tokyo");
      const createdAt = new Date().toISOString();
      const updatedAt = new Date("2026-07-18T00:00:02.222Z").toISOString();
      const deletedAt = new Date("2026-07-18T00:00:03.333Z").toISOString();
      const root = ok(repo.createRoot(rootCommand({ now: createdAt })));
      expect(
        db
          .prepare("SELECT created_at AS c, updated_at AS u, deleted_at AS d FROM comments WHERE id = ?")
          .get(root.resourceId),
      ).toEqual({ c: createdAt, u: createdAt, d: null });

      ok(repo.patchIssue({
        issueId: root.resourceId,
        patch: { type: "body", bodyMarkdown: "Edited", expectedVersion: 1, attachmentIds: [] },
        now: updatedAt,
      }));
      ok(repo.deleteIssue({ issueId: root.resourceId, expectedVersion: 2, now: deletedAt }));
      expect(
        db
          .prepare("SELECT created_at AS c, updated_at AS u, deleted_at AS d FROM comments WHERE id = ?")
          .get(root.resourceId),
      ).toEqual({ c: createdAt, u: deletedAt, d: deletedAt });
    } finally {
      if (previousTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimeZone;
      }
    }
  });
});
