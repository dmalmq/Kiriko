import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../src/auth/sessions";
import type { BlobStore } from "../src/blobs/store";
import type { BundleAnchorIndex } from "../src/core/native";
import { IssueServiceError } from "../src/issues/errors";
import {
  AnchorIndexCache,
} from "../src/issues/anchorIndex";
import type {
  CreateReplyCommand,
  CreateRootCommand,
  DeleteIssueCommand,
  DeleteReplyCommand,
  IssueMutationContext,
  PatchIssueCommand,
  PatchReplyCommand,
  PublishedReviewVersion,
  ReplyMutationContext,
  RepositoryMutationResult,
} from "../src/issues/repository";
import {
  IssueService,
  type IssueRepositoryPort,
  type IssueRevisionPublisher,
} from "../src/issues/service";
import type {
  IssueCollection,
  IssuePatch,
  ReviewerSummary,
  RootCreateBody,
} from "../src/issues/types";
import { hashReplyCreate, hashRootCreate } from "../src/issues/validation";

const PUBLIC_ID = "a".repeat(64);
const BUNDLE_HASH = "b".repeat(64);
const NOW = "2026-07-19T10:11:12.000Z";
const VERSION: PublishedReviewVersion = {
  versionId: 41,
  publicVersionId: PUBLIC_ID,
  bundleHash: BUNDLE_HASH,
};
const VIEWER: SessionUser = { id: 1, username: "viewer", role: "viewer" };
const MEMBER: SessionUser = { id: 2, username: "member", role: "member" };
const ADMIN: SessionUser = { id: 3, username: "admin", role: "admin" };
const OTHER: SessionUser = { id: 4, username: "other", role: "viewer" };
const REVIEWERS: ReviewerSummary[] = [VIEWER, MEMBER, ADMIN, OTHER].map(({ id, username }) => ({
  id,
  username,
}));

let requestSequence = 0;
function nextRequestId(): string {
  requestSequence += 1;
  return `00000000-0000-4000-8000-${requestSequence.toString(16).padStart(12, "0")}`;
}

function rootInput(overrides: Partial<RootCreateBody> = {}): RootCreateBody {
  return {
    requestId: nextRequestId(),
    bodyMarkdown: "Broken escalator",
    anchor: { levelId: "level-1", longitude: -73.9, latitude: 40.7, featureId: "unit-1" },
    ...overrides,
  };
}

function issueContext(overrides: Partial<IssueMutationContext> = {}): IssueMutationContext {
  return {
    kind: "issue",
    issueId: "issue-1",
    versionId: VERSION.versionId,
    publicVersionId: VERSION.publicVersionId,
    authorId: VIEWER.id,
    status: "open",
    assigneeId: null,
    rowVersion: 1,
    deletedAt: null,
    ...overrides,
  };
}

function replyContext(overrides: Partial<ReplyMutationContext> = {}): ReplyMutationContext {
  return {
    kind: "reply",
    replyId: "reply-1",
    parentIssueId: "issue-1",
    versionId: VERSION.versionId,
    publicVersionId: VERSION.publicVersionId,
    authorId: VIEWER.id,
    rowVersion: 1,
    deletedAt: null,
    parentDeletedAt: null,
    ...overrides,
  };
}

function ok(overrides: Partial<Extract<RepositoryMutationResult, { type: "ok" }>> = {}): RepositoryMutationResult {
  return {
    type: "ok",
    revision: 7,
    versionId: VERSION.versionId,
    publicVersionId: VERSION.publicVersionId,
    resourceId: "resource-1",
    replayed: false,
    ...overrides,
  };
}

class FakeRepository implements IssueRepositoryPort {
  version: PublishedReviewVersion | null = VERSION;
  issue: IssueMutationContext | null = issueContext();
  reply: ReplyMutationContext | null = replyContext();
  reviewers = REVIEWERS;
  collection: IssueCollection = { revision: 0, issues: [] };
  replay: RepositoryMutationResult | null = null;
  mutationResult: RepositoryMutationResult = ok();
  calls: string[] = [];
  rootCommands: CreateRootCommand[] = [];
  replyCommands: CreateReplyCommand[] = [];
  patchIssueCommands: PatchIssueCommand[] = [];
  patchReplyCommands: PatchReplyCommand[] = [];
  deleteIssueCommands: DeleteIssueCommand[] = [];
  deleteReplyCommands: DeleteReplyCommand[] = [];
  onCreateRoot?: (command: CreateRootCommand) => RepositoryMutationResult;
  onCreateReply?: (command: CreateReplyCommand) => RepositoryMutationResult;
  onProbe?: (authorId: number, requestId: string, requestHash: string) => RepositoryMutationResult | null;

  resolvePublishedVersion(publicVersionId: string): PublishedReviewVersion | null {
    this.calls.push("resolve-version");
    return this.version?.publicVersionId === publicVersionId ? this.version : null;
  }

  getCollection(versionId: number): IssueCollection {
    this.calls.push(`collection:${versionId}`);
    return this.collection;
  }

  listReviewers(): ReviewerSummary[] {
    this.calls.push("reviewers");
    return this.reviewers;
  }

  getIssueContext(issueId: string): IssueMutationContext | null {
    this.calls.push("issue-context");
    return this.issue?.issueId === issueId ? this.issue : null;
  }

  getReplyContext(replyId: string): ReplyMutationContext | null {
    this.calls.push("reply-context");
    return this.reply?.replyId === replyId ? this.reply : null;
  }

  probeCreateReplay(authorId: number, requestId: string, requestHash: string): RepositoryMutationResult | null {
    this.calls.push("probe");
    return this.onProbe?.(authorId, requestId, requestHash) ?? this.replay;
  }

  createRoot(command: CreateRootCommand): RepositoryMutationResult {
    this.calls.push("create-root");
    this.rootCommands.push(command);
    return this.onCreateRoot?.(command) ?? this.mutationResult;
  }

  createReply(command: CreateReplyCommand): RepositoryMutationResult {
    this.calls.push("create-reply");
    this.replyCommands.push(command);
    return this.onCreateReply?.(command) ?? this.mutationResult;
  }

  patchIssue(command: PatchIssueCommand): RepositoryMutationResult {
    this.calls.push("patch-issue");
    this.patchIssueCommands.push(command);
    return this.mutationResult;
  }

  patchReply(command: PatchReplyCommand): RepositoryMutationResult {
    this.calls.push("patch-reply");
    this.patchReplyCommands.push(command);
    return this.mutationResult;
  }

  deleteIssue(command: DeleteIssueCommand): RepositoryMutationResult {
    this.calls.push("delete-issue");
    this.deleteIssueCommands.push(command);
    return this.mutationResult;
  }

  deleteReply(command: DeleteReplyCommand): RepositoryMutationResult {
    this.calls.push("delete-reply");
    this.deleteReplyCommands.push(command);
    return this.mutationResult;
  }
}

function anchorIndex(
  bundleHash = BUNDLE_HASH,
  featureLevels: ReadonlyMap<string, string | null> = new Map([
    ["unit-1", "level-1"],
    ["venue-1", null],
  ]),
): BundleAnchorIndex {
  return {
    bundleHash,
    levelIds: new Set(["level-1", "level-2"]),
    featureLevels,
  };
}

function serviceFixture(index: BundleAnchorIndex = anchorIndex()) {
  const repository = new FakeRepository();
  const anchors = { get: vi.fn(async () => index), clear: vi.fn() };
  const publications: Array<{ publicVersionId: string; revision: number }> = [];
  const publisher: IssueRevisionPublisher = {
    publishRevision(publicVersionId, revision) {
      publications.push({ publicVersionId, revision });
    },
  };
  const service = new IssueService(repository, anchors, publisher, () => NOW);
  return { repository, anchors, publications, service };
}

async function expectCode(action: () => unknown | Promise<unknown>, code: string): Promise<IssueServiceError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(IssueServiceError);
    expect((error as IssueServiceError).code).toBe(code);
    return error as IssueServiceError;
  }
  throw new Error(`expected IssueServiceError ${code}`);
}

describe("AnchorIndexCache", () => {
  it("coalesces concurrent misses and uses only asynchronous blob reads", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readAsync = vi.fn(async () => Buffer.from("bundle"));
    const read = vi.fn(() => {
      throw new Error("synchronous read must not run");
    });
    const inspect = vi.fn(async () => {
      await gate;
      return anchorIndex();
    });
    const cache = new AnchorIndexCache({ readAsync, read } as unknown as BlobStore, inspect);

    const first = cache.get(BUNDLE_HASH);
    const second = cache.get(BUNDLE_HASH);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(readAsync).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it("keys by hash, verifies the returned hash, and never caches failures", async () => {
    const readAsync = vi.fn(async () => Buffer.from("bundle"));
    const inspect = vi
      .fn<(_: Buffer, hash: string) => Promise<BundleAnchorIndex>>()
      .mockResolvedValueOnce(anchorIndex("c".repeat(64)))
      .mockRejectedValueOnce(new Error("corrupt"))
      .mockResolvedValueOnce(anchorIndex());
    const cache = new AnchorIndexCache({ readAsync } as unknown as BlobStore, inspect);

    await expect(cache.get(BUNDLE_HASH)).rejects.toThrow(/hash/i);
    await expect(cache.get(BUNDLE_HASH)).rejects.toThrow("corrupt");
    await expect(cache.get(BUNDLE_HASH)).resolves.toMatchObject({ bundleHash: BUNDLE_HASH });
    await expect(cache.get(BUNDLE_HASH)).resolves.toMatchObject({ bundleHash: BUNDLE_HASH });
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(readAsync).toHaveBeenCalledTimes(3);
  });

  it("keeps exactly eight resolved indexes in the default LRU", async () => {
    const inspect = vi.fn(async (_: Buffer, hash: string) => anchorIndex(hash));
    const cache = new AnchorIndexCache(
      { readAsync: vi.fn(async () => Buffer.from("bundle")) } as unknown as BlobStore,
      inspect,
    );
    const hashes = Array.from({ length: 9 }, (_, index) => (index + 1).toString(16).repeat(64));

    for (const hash of hashes.slice(0, 8)) {
      await cache.get(hash);
    }
    await cache.get(hashes[0]!);
    await cache.get(hashes[8]!);
    await cache.get(hashes[0]!);
    await cache.get(hashes[1]!);

    expect(inspect.mock.calls.map((call) => call[1])).toEqual([...hashes, hashes[1]]);
  });

  it("evicts the least-recent resolved entry and clear drops resolved and in-flight state", async () => {
    const readAsync = vi.fn(async () => Buffer.from("bundle"));
    const inspect = vi.fn(async (_: Buffer, hash: string) => anchorIndex(hash));
    const cache = new AnchorIndexCache({ readAsync } as unknown as BlobStore, inspect, 2);
    const a = "1".repeat(64);
    const b = "2".repeat(64);
    const c = "3".repeat(64);

    await cache.get(a);
    await cache.get(b);
    await cache.get(a);
    await cache.get(c);
    await cache.get(b);
    expect(inspect.mock.calls.map((call) => call[1])).toEqual([a, b, c, b]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    inspect.mockImplementationOnce(async (_bytes, hash) => {
      await gate;
      return anchorIndex(hash);
    });
    const pendingHash = "4".repeat(64);
    const pending = cache.get(pendingHash);
    cache.clear();
    const afterClear = cache.get(pendingHash);
    release();
    await Promise.all([pending, afterClear]);
    expect(inspect.mock.calls.filter((call) => call[1] === pendingHash)).toHaveLength(2);
    await cache.get(a);
    expect(inspect.mock.calls.filter((call) => call[1] === a)).toHaveLength(2);
  });
});

describe("IssueService create orchestration", () => {
  it("normalizes and validates before resolving, then hashes the numeric target before probing", async () => {
    const { repository, service, publications } = serviceFixture();
    const input = rootInput({
      requestId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
      bodyMarkdown: "line one\r\nline two\rline three",
      assigneeId: OTHER.id,
      dueDate: "2026-08-01",
    });

    const result = await service.createIssue(MEMBER, PUBLIC_ID, input);
    const command = repository.rootCommands[0]!;
    expect(command.requestId).toBe(input.requestId.toLowerCase());
    expect(command.input.bodyMarkdown).toBe("line one\nline two\nline three");
    expect(command.requestHash).toBe(hashRootCreate(command.input, VERSION.versionId));
    expect(repository.calls.indexOf("probe")).toBeLessThan(repository.calls.indexOf("reviewers"));
    expect(repository.calls.indexOf("probe")).toBeLessThan(repository.calls.indexOf("create-root"));
    expect(result).toMatchObject({ resourceId: "resource-1", replayed: false });
    expect(publications).toEqual([{ publicVersionId: PUBLIC_ID, revision: 7 }]);
  });

  it("returns an exact replay before mutable role, account, and anchor checks without publication", async () => {
    const { repository, anchors, service, publications } = serviceFixture();
    repository.replay = ok({ resourceId: "already-created", replayed: true, revision: 11 });
    repository.reviewers = [];
    const downgraded = { ...VIEWER };
    const input = rootInput({ assigneeId: OTHER.id, anchor: { levelId: "gone", longitude: 0, latitude: 0 } });

    await expect(service.createIssue(downgraded, PUBLIC_ID, input)).resolves.toEqual({
      revision: 11,
      versionId: VERSION.versionId,
      publicVersionId: PUBLIC_ID,
      resourceId: "already-created",
      replayed: true,
    });
    expect(anchors.get).not.toHaveBeenCalled();
    expect(repository.calls).not.toContain("reviewers");
    expect(repository.calls).not.toContain("create-root");
    expect(publications).toEqual([]);
  });

  it("probes reply replay after parent identity resolution but before tombstone checks", async () => {
    const { repository, service, publications } = serviceFixture();
    repository.issue = issueContext({ deletedAt: NOW, status: "closed" });
    repository.replay = ok({ resourceId: "reply-existing", replayed: true });
    const input = { requestId: nextRequestId(), bodyMarkdown: "Already saved" };

    const result = await service.createReply(VIEWER, "issue-1", input);
    const expected = hashReplyCreate({ bodyMarkdown: input.bodyMarkdown, attachmentIds: [] }, VERSION.versionId, "issue-1");
    expect(repository.calls.slice(0, 2)).toEqual(["issue-context", "probe"]);
    expect(repository.onProbe).toBeUndefined();
    expect(result.resourceId).toBe("reply-existing");
    expect(repository.calls).not.toContain("create-reply");
    expect(publications).toEqual([]);
    repository.replay = null;
    repository.onProbe = (_author, _request, requestHash) => {
      expect(requestHash).toBe(expected);
      throw new IssueServiceError("idempotency_conflict", "conflict");
    };
    await expectCode(() => service.createReply(VIEWER, "issue-1", input), "idempotency_conflict");
    expect(repository.calls.filter((call) => call === "create-reply")).toHaveLength(0);
  });

  it("rejects non-replayed replies to deleted roots but permits closed roots", async () => {
    const { repository, service } = serviceFixture();
    repository.issue = issueContext({ deletedAt: NOW, status: "closed" });
    await expectCode(
      () => service.createReply(VIEWER, "issue-1", { requestId: nextRequestId(), bodyMarkdown: "Too late" }),
      "issue_deleted",
    );
    repository.issue = issueContext({ status: "closed" });
    await expect(
      service.createReply(VIEWER, "issue-1", { requestId: nextRequestId(), bodyMarkdown: "Still discussing" }),
    ).resolves.toMatchObject({ replayed: false });
  });

  it("rejects unknown/cross-floor features while accepting level-independent features", async () => {
    const fixture = serviceFixture();
    await expectCode(
      () => fixture.service.createIssue(VIEWER, PUBLIC_ID, rootInput({ anchor: { levelId: "unknown", longitude: 0, latitude: 0 } })),
      "invalid_anchor",
    );
    await expectCode(
      () => fixture.service.createIssue(VIEWER, PUBLIC_ID, rootInput({ anchor: { levelId: "level-1", longitude: 0, latitude: 0, featureId: "unknown" } })),
      "invalid_anchor",
    );
    await expectCode(
      () => fixture.service.createIssue(VIEWER, PUBLIC_ID, rootInput({ anchor: { levelId: "level-2", longitude: 0, latitude: 0, featureId: "unit-1" } })),
      "invalid_anchor",
    );
    await expect(
      fixture.service.createIssue(VIEWER, PUBLIC_ID, rootInput({ anchor: { levelId: "level-2", longitude: 0, latitude: 0, featureId: "venue-1" } })),
    ).resolves.toMatchObject({ replayed: false });
  });

  it("keeps native/blob/cache failures internal and rejects final version or bundle races without publication", async () => {
    const internal = serviceFixture();
    internal.anchors.get.mockRejectedValueOnce(new Error("native frame details"));
    const error = await expectCode(() => internal.service.createIssue(VIEWER, PUBLIC_ID, rootInput()), "internal_error");
    expect(error.message).not.toContain("native frame details");
    expect(internal.publications).toEqual([]);

    const raced = serviceFixture();
    let releaseInspection!: () => void;
    const inspectionGate = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    raced.anchors.get.mockImplementationOnce(async () => {
      await inspectionGate;
      return anchorIndex();
    });
    raced.repository.onCreateRoot = (command) => {
      if (command.version.bundleHash !== raced.repository.version?.bundleHash) {
        throw new IssueServiceError("not_found", "not found");
      }
      return ok();
    };
    const pending = raced.service.createIssue(VIEWER, PUBLIC_ID, rootInput());
    await vi.waitFor(() => expect(raced.anchors.get).toHaveBeenCalledOnce());
    raced.repository.version = { ...VERSION, bundleHash: "e".repeat(64) };
    releaseInspection();
    await expectCode(() => pending, "not_found");
    expect(raced.repository.rootCommands[0]?.version.bundleHash).toBe(BUNDLE_HASH);
    expect(raced.publications).toEqual([]);
  });

  it("publishes only the final committed result identity and not transaction replays", async () => {
    const committed = serviceFixture();
    committed.repository.mutationResult = ok({ publicVersionId: "d".repeat(64), revision: 19 });
    await committed.service.createIssue(VIEWER, PUBLIC_ID, rootInput());
    expect(committed.publications).toEqual([{ publicVersionId: "d".repeat(64), revision: 19 }]);

    const racedReplay = serviceFixture();
    racedReplay.repository.mutationResult = ok({ replayed: true, resourceId: "winner" });
    await expect(racedReplay.service.createIssue(VIEWER, PUBLIC_ID, rootInput())).resolves.toMatchObject({
      replayed: true,
      resourceId: "winner",
    });
    expect(racedReplay.publications).toEqual([]);
  });
});

describe("IssueService permissions and mutations", () => {
  it.each([
    ["viewer author", VIEWER, VIEWER.id, true],
    ["member author", MEMBER, MEMBER.id, true],
    ["admin author", ADMIN, ADMIN.id, true],
    ["member non-author", MEMBER, VIEWER.id, false],
    ["admin non-author", ADMIN, VIEWER.id, false],
  ])("allows body edits only by the author: %s", async (_name, user, authorId, allowed) => {
    const { repository, service } = serviceFixture();
    repository.issue = issueContext({ authorId });
    const action = () => service.patchIssue(user, "issue-1", { type: "body", bodyMarkdown: "edited", expectedVersion: 1 });
    if (allowed) {
      await expect(action()).resolves.toMatchObject({ replayed: false });
    } else {
      await expectCode(action, "forbidden");
    }
  });

  it.each([
    ["viewer author", VIEWER, VIEWER.id, true],
    ["member author", MEMBER, MEMBER.id, true],
    ["admin author", ADMIN, ADMIN.id, true],
    ["viewer non-author", OTHER, VIEWER.id, false],
    ["member non-author", MEMBER, VIEWER.id, false],
    ["admin non-author", ADMIN, VIEWER.id, true],
  ])("enforces exact issue delete permissions: %s", async (_name, user, authorId, allowed) => {
    const { repository, service } = serviceFixture();
    repository.issue = issueContext({ authorId });
    const action = () => service.deleteIssue(user, "issue-1", 1);
    if (allowed) {
      await expect(action()).resolves.toMatchObject({ replayed: false });
    } else {
      await expectCode(action, "forbidden");
    }
  });

  it("applies the same author/admin delete and author-only body rules to replies from repository context", async () => {
    const { repository, service } = serviceFixture();
    repository.reply = replyContext({ authorId: VIEWER.id });
    await expectCode(
      () => service.patchReply(ADMIN, "reply-1", { type: "body", bodyMarkdown: "rewrite", expectedVersion: 1 }),
      "forbidden",
    );
    await expectCode(() => service.deleteReply(MEMBER, "reply-1", 1), "forbidden");
    await expect(service.deleteReply(ADMIN, "reply-1", 1)).resolves.toMatchObject({ replayed: false });
  });

  it.each([
    [null, VIEWER.id, true],
    [VIEWER.id, null, true],
    [OTHER.id, VIEWER.id, false],
    [OTHER.id, null, false],
    [null, OTHER.id, false],
  ])("enforces viewer assignment transition %s -> %s", async (current, next, allowed) => {
    const { repository, service } = serviceFixture();
    repository.issue = issueContext({ assigneeId: current });
    const action = () => service.patchIssue(VIEWER, "issue-1", { type: "assignment", assigneeId: next, expectedVersion: 1 });
    if (allowed) {
      await expect(action()).resolves.toMatchObject({ replayed: false });
    } else {
      await expectCode(action, "forbidden");
    }
  });

  it("lets members/admins assign or clear existing accounts and rejects vanished reviewers", async () => {
    const { repository, service } = serviceFixture();
    repository.issue = issueContext({ assigneeId: OTHER.id });
    await expect(service.patchIssue(MEMBER, "issue-1", { type: "assignment", assigneeId: ADMIN.id, expectedVersion: 1 })).resolves.toBeDefined();
    await expect(service.patchIssue(ADMIN, "issue-1", { type: "assignment", assigneeId: null, expectedVersion: 1 })).resolves.toBeDefined();
    repository.reviewers = repository.reviewers.filter(({ id }) => id !== OTHER.id);
    await expectCode(
      () => service.patchIssue(MEMBER, "issue-1", { type: "assignment", assigneeId: OTHER.id, expectedVersion: 1 }),
      "invalid_request",
    );
  });

  it("limits create assignment and due dates by role", async () => {
    const viewer = serviceFixture();
    await expect(viewer.service.createIssue(VIEWER, PUBLIC_ID, rootInput({ assigneeId: VIEWER.id }))).resolves.toBeDefined();
    await expectCode(() => viewer.service.createIssue(VIEWER, PUBLIC_ID, rootInput({ assigneeId: OTHER.id })), "forbidden");
    await expectCode(() => viewer.service.createIssue(VIEWER, PUBLIC_ID, rootInput({ dueDate: "2026-08-01" })), "forbidden");
    const member = serviceFixture();
    await expect(member.service.createIssue(MEMBER, PUBLIC_ID, rootInput({ assigneeId: OTHER.id, dueDate: "2026-08-01" }))).resolves.toBeDefined();
    member.repository.reviewers = member.repository.reviewers.filter(({ id }) => id !== OTHER.id);
    await expectCode(
      () => member.service.createIssue(MEMBER, PUBLIC_ID, rootInput({ assigneeId: OTHER.id })),
      "invalid_request",
    );
  });

  it("allows only members/admins to change due date or status", async () => {
    for (const patch of [
      { type: "due_date", dueDate: "2026-08-01", expectedVersion: 1 },
      { type: "status", status: "closed", expectedVersion: 1 },
    ] satisfies IssuePatch[]) {
      const viewer = serviceFixture();
      await expectCode(() => viewer.service.patchIssue(VIEWER, "issue-1", patch), "forbidden");
      const member = serviceFixture();
      await expect(member.service.patchIssue(MEMBER, "issue-1", patch)).resolves.toBeDefined();
    }
  });

  it("rejects every mutation of a deleted target, including root reopen", async () => {
    const root = serviceFixture();
    root.repository.issue = issueContext({ deletedAt: NOW, status: "closed" });
    await expectCode(
      () => root.service.patchIssue(ADMIN, "issue-1", { type: "status", status: "open", expectedVersion: 2 }),
      "issue_deleted",
    );
    await expectCode(() => root.service.deleteIssue(ADMIN, "issue-1", 2), "issue_deleted");

    const reply = serviceFixture();
    reply.repository.reply = replyContext({ deletedAt: NOW });
    await expectCode(
      () => reply.service.patchReply(VIEWER, "reply-1", { type: "body", bodyMarkdown: "again", expectedVersion: 2 }),
      "issue_deleted",
    );
  });

  it("turns repository stale results into stale_issue and never publishes", async () => {
    const { repository, service, publications } = serviceFixture();
    repository.mutationResult = {
      type: "stale",
      revision: 8,
      versionId: VERSION.versionId,
      publicVersionId: VERSION.publicVersionId,
      resourceId: "issue-1",
      replayed: false,
      current: {
        kind: "issue",
        value: {
          id: "issue-1",
          pinNumber: 1,
          rowVersion: 2,
          anchor: { levelId: "level-1", longitude: 0, latitude: 0 },
          bodyMarkdown: "current",
          attachments: [],
          status: "open",
          author: { id: VIEWER.id, username: VIEWER.username },
          assignee: null,
          dueDate: null,
          createdAt: NOW,
          updatedAt: NOW,
          deletedAt: null,
          replies: [],
        },
      },
    };
    const error = await expectCode(
      () => service.patchIssue(VIEWER, "issue-1", { type: "body", bodyMarkdown: "stale", expectedVersion: 1 }),
      "stale_issue",
    );
    expect(error.revision).toBe(8);
    expect(error.current?.kind).toBe("issue");
    expect(publications).toEqual([]);
  });

  it("derives opaque-target authorization and publication identity solely from repository context/result", async () => {
    const { repository, service, publications } = serviceFixture();
    repository.issue = issueContext({ authorId: OTHER.id, publicVersionId: "c".repeat(64), versionId: 99 });
    repository.mutationResult = ok({ publicVersionId: "c".repeat(64), versionId: 99, revision: 23 });
    await service.patchIssue(OTHER, "issue-1", { type: "body", bodyMarkdown: "mine", expectedVersion: 1 });
    expect(publications).toEqual([{ publicVersionId: "c".repeat(64), revision: 23 }]);
    expect(repository.patchIssueCommands[0]?.issueId).toBe("issue-1");
  });

  it("resolves collections by permanent public ID and exposes reviewers to authenticated users", () => {
    const { repository, service } = serviceFixture();
    expect(service.getCollection(PUBLIC_ID)).toBe(repository.collection);
    expect(service.listReviewers(VIEWER)).toEqual(REVIEWERS);
    repository.version = null;
    expect(() => service.getCollection(PUBLIC_ID)).toThrowError(IssueServiceError);
  });
});
