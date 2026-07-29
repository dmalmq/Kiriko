import { describe, expect, it } from "vitest";
import {
  initialIssueState,
  issueReducer,
  type IssueAction,
} from "./issueReducer";
import type { IssueCollection, IssueDraft, IssueState, ReviewIssue } from "./types";

const PUBLIC_A = "a".repeat(64);
const PUBLIC_B = "b".repeat(64);
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function reduce(publicId: string | null, actions: IssueAction[]) {
  return actions.reduce(issueReducer, initialIssueState(publicId));
}

function issue(id: string, deletedAt: string | null = null): ReviewIssue {
  const base = {
    id,
    pinNumber: 1,
    rowVersion: deletedAt === null ? 1 : 2,
    anchor: { levelId: "level-1", longitude: 1, latitude: 2 },
    status: deletedAt === null ? "open" as const : "closed" as const,
    author: { id: 1, username: "author" },
    assignee: null,
    dueDate: null,
    createdAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T10:01:00.000Z",
    replies: [],
  };
  return deletedAt === null
    ? { ...base, bodyMarkdown: "Body", attachments: [], deletedAt: null }
    : { ...base, bodyMarkdown: null, attachments: [], deletedAt };
}

function collection(revision: number, issues: ReviewIssue[] = []): IssueCollection {
  return { revision, issues };
}

function draft(): IssueDraft {
  return {
    requestId: REQUEST_ID,
    anchor: {
      levelId: "level-1",
      longitude: 1,
      latitude: 2,
      featureId: "feature-old",
    },
    bodyMarkdown: "Unsaved",
    assigneeId: 3,
    dueDate: "2026-08-01",
  };
}

describe("issueReducer", () => {
  it("initializes null identity as disabled and a public identity as fetchable", () => {
    expect(initialIssueState(null)).toMatchObject({
      publicVersionId: null,
      collection: null,
      appliedRevision: 0,
      highestObservedRevision: 0,
      refetchInFlight: false,
      refetchRequested: false,
    });
    expect(initialIssueState(PUBLIC_A).refetchRequested).toBe(true);
  });

  it("owns filter, selection, draft, and placement transitions", () => {
    const anchor = { levelId: "level-1", longitude: 1, latitude: 2, featureId: "feature-1" };
    const state = reduce(PUBLIC_A, [
      { type: "filter_set", filter: "assigned_to_me" },
      { type: "issue_selected", issueId: "issue-1" },
      { type: "placement_set", active: true },
      { type: "draft_started", anchor, requestId: REQUEST_ID },
      { type: "draft_updated", patch: { bodyMarkdown: "Hello", assigneeId: 2 } },
      { type: "placement_set", active: false },
    ]);

    expect(state.filter).toBe("assigned_to_me");
    expect(state.selectedIssueId).toBe("issue-1");
    expect(state.placementActive).toBe(false);
    expect(state.draft).toEqual({
      requestId: REQUEST_ID,
      anchor,
      bodyMarkdown: "Hello",
      assigneeId: 2,
      dueDate: null,
    });
    expect(issueReducer(state, {
      type: "draft_started",
      anchor: { ...anchor, longitude: 5 },
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }).draft?.requestId).toBe(REQUEST_ID);
    expect(issueReducer(state, { type: "draft_cancelled" }).draft).toBeNull();
  });

  it("clears only a rejected feature attachment and preserves the resubmittable draft", () => {
    const state = { ...initialIssueState(PUBLIC_A), draft: draft(), pendingMutations: 1 };
    const next = issueReducer(state, {
      type: "mutation_failed",
      draftRequestId: REQUEST_ID,
      failure: {
        kind: "api",
        status: 400,
        error: "invalid_anchor",
        message: "Invalid anchor",
        details: [{ field: "anchor.featureId", reason: "feature does not exist" }],
      },
    });

    expect(next.draft).toEqual({
      ...draft(),
      anchor: { levelId: "level-1", longitude: 1, latitude: 2 },
    });
    expect(next.notice).toBe("feature_attachment_removed");
    expect(next.pendingMutations).toBe(0);
  });

  it("ignores duplicate and out-of-order observations while requesting one refetch", () => {
    const state: IssueState = {
      ...initialIssueState(PUBLIC_A),
      collection: collection(5),
      appliedRevision: 5,
      highestObservedRevision: 5,
      refetchRequested: false,
    };
    let next = state;
    for (const revision of [7, 6, 7]) {
      next = issueReducer(next, { type: "revision_observed", revision });
    }

    expect(next.highestObservedRevision).toBe(7);
    expect(next.appliedRevision).toBe(5);
    expect(next.refetchRequested).toBe(true);
    const fetching = issueReducer(next, { type: "collection_fetch_started" });
    expect(issueReducer(fetching, { type: "collection_fetch_started" })).toBe(fetching);
  });

  it("suppresses a stale GET and requests an immediate follow-up when still behind", () => {
    const before = {
      ...initialIssueState(PUBLIC_A),
      collection: collection(5),
      appliedRevision: 5,
      highestObservedRevision: 7,
      refetchInFlight: true,
      refetchRequested: false,
    };
    const stale = issueReducer(before, {
      type: "collection_fetch_succeeded",
      collection: collection(4, [issue("old")]),
    });
    expect(stale.collection).toEqual(collection(5));
    expect(stale.appliedRevision).toBe(5);
    expect(stale.refetchInFlight).toBe(false);
    expect(stale.refetchRequested).toBe(true);

    const behind = issueReducer({ ...before, highestObservedRevision: 8 }, {
      type: "collection_fetch_succeeded",
      collection: collection(7, [issue("seven")]),
    });
    expect(behind.appliedRevision).toBe(7);
    expect(behind.collection).toEqual(collection(7, [issue("seven")]));
    expect(behind.refetchRequested).toBe(true);
  });

  it("observes mutation revision without patching canonical data or advancing applied revision", () => {
    const before = {
      ...initialIssueState(PUBLIC_A),
      collection: collection(5, [issue("canonical")]),
      appliedRevision: 5,
      highestObservedRevision: 6,
      refetchRequested: false,
      pendingMutations: 1,
    };
    const next = issueReducer(before, {
      type: "mutation_succeeded",
      response: { revision: 7, resourceId: "new-resource" },
      draftRequestId: REQUEST_ID,
    });

    expect(next.collection).toBe(before.collection);
    expect(next.appliedRevision).toBe(5);
    expect(next.highestObservedRevision).toBe(7);
    expect(next.refetchRequested).toBe(true);
    expect(next.pendingMutations).toBe(0);
  });

  it("clears a submitted draft when its resource is already canonical", () => {
    const admitted = issue("new-resource");
    const before = {
      ...initialIssueState(PUBLIC_A),
      collection: collection(7, [admitted]),
      appliedRevision: 7,
      highestObservedRevision: 7,
      refetchRequested: false,
      draft: draft(),
      pendingMutations: 1,
    };
    const next = issueReducer(before, {
      type: "mutation_succeeded",
      response: { revision: 7, resourceId: admitted.id },
      draftRequestId: REQUEST_ID,
    });

    expect(next.draft).toBeNull();
    expect(next.draftAdmissionResourceId).toBeNull();
    expect(next.refetchRequested).toBe(false);
  });

  it("does not let an unrelated collection success dismiss mutation auth or conflict state", () => {
    const auth = issueReducer({
      ...initialIssueState(PUBLIC_A),
      refetchInFlight: true,
      pendingMutations: 1,
      draft: draft(),
    }, {
      type: "mutation_failed",
      failure: { kind: "api", status: 401, error: "unauthorized", message: "Sign in" },
    });
    const afterAuthGet = issueReducer(auth, {
      type: "collection_fetch_succeeded",
      collection: collection(1),
    });
    expect(afterAuthGet.authRequired).toBe(true);
    expect(afterAuthGet.error?.kind).toBe("api");

    const conflict = issueReducer({
      ...initialIssueState(PUBLIC_A),
      refetchInFlight: true,
      pendingMutations: 1,
      draft: draft(),
    }, {
      type: "mutation_failed",
      failure: {
        kind: "api",
        status: 409,
        error: "stale_issue",
        message: "Changed",
        revision: 2,
      },
    });
    const afterConflictGet = issueReducer(conflict, {
      type: "collection_fetch_succeeded",
      collection: collection(1),
    });
    expect(afterConflictGet.conflict?.error).toBe("stale_issue");
    expect(afterConflictGet.error?.kind).toBe("api");
    expect(afterConflictGet.refetchRequested).toBe(true);
  });

  it("preserves a mutation failure when a concurrent collection GET also fails", () => {
    const denied = issueReducer({
      ...initialIssueState(PUBLIC_A),
      refetchInFlight: true,
      pendingMutations: 1,
      draft: draft(),
    }, {
      type: "mutation_failed",
      failure: { kind: "api", status: 403, error: "forbidden", message: "Denied" },
    });
    const next = issueReducer(denied, {
      type: "collection_fetch_failed",
      failure: { kind: "network", message: "Collection offline" },
    });

    expect(next.error).toEqual({
      kind: "api",
      status: 403,
      error: "forbidden",
      message: "Denied",
    });
    expect(next.errorScope).toBe("mutation");
    expect(next.refetchInFlight).toBe(false);
  });

  it("preserves one overlapping mutation failure when another mutation succeeds", () => {
    let state = initialIssueState(PUBLIC_A);
    state = issueReducer(state, { type: "mutation_started" });
    state = issueReducer(state, { type: "mutation_started" });
    state = issueReducer(state, {
      type: "mutation_failed",
      failure: { kind: "api", status: 401, error: "unauthorized", message: "Sign in" },
    });
    state = issueReducer(state, {
      type: "mutation_succeeded",
      response: { revision: 1, resourceId: "other-resource" },
    });

    expect(state.pendingMutations).toBe(0);
    expect(state.error?.kind).toBe("api");
    expect(state.authRequired).toBe(true);
    expect(state.highestObservedRevision).toBe(1);
    expect(state.appliedRevision).toBe(0);
  });

  it("dismisses an older notice without erasing a newer mutation failure", () => {
    const failed = issueReducer({
      ...initialIssueState(PUBLIC_A),
      notice: "selected_issue_deleted",
      pendingMutations: 1,
    }, {
      type: "mutation_failed",
      failure: { kind: "api", status: 401, error: "unauthorized", message: "Sign in" },
    });
    const next = issueReducer(failed, { type: "notice_reset" });

    expect(next.notice).toBeNull();
    expect(next.error?.kind).toBe("api");
    expect(next.errorScope).toBe("mutation");
    expect(next.authRequired).toBe(true);
  });

  it("does not apply a late invalid-anchor failure to a replacement draft", () => {
    const replacement = {
      ...draft(),
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      anchor: { ...draft().anchor, featureId: "feature-new" },
    };
    const next = issueReducer({
      ...initialIssueState(PUBLIC_A),
      draft: replacement,
      pendingMutations: 1,
    }, {
      type: "mutation_failed",
      draftRequestId: REQUEST_ID,
      failure: {
        kind: "api",
        status: 400,
        error: "invalid_anchor",
        message: "Invalid anchor",
        details: [{ field: "anchor.featureId", reason: "feature does not exist" }],
      },
    });

    expect(next.draft).toEqual(replacement);
    expect(next.notice).toBeNull();
  });

  it("resets all version-owned state and makes old-key actions suppressible by the hook", () => {
    const dirty = {
      ...initialIssueState(PUBLIC_A),
      collection: collection(3, [issue("issue-a")]),
      appliedRevision: 3,
      selectedIssueId: "issue-a",
      draft: draft(),
      reconnecting: true,
    };
    const reset = issueReducer(dirty, { type: "version_reset", publicVersionId: PUBLIC_B });
    expect(reset).toEqual(initialIssueState(PUBLIC_B));
  });

  it.each([
    { kind: "api", status: 401, error: "unauthorized", message: "Sign in" } as const,
    { kind: "network", message: "Offline" } as const,
    {
      kind: "api",
      status: 409,
      error: "stale_issue",
      message: "Changed",
      revision: 8,
    } as const,
  ])("preserves drafts after $kind mutation failure", (failure) => {
    const before = { ...initialIssueState(PUBLIC_A), draft: draft(), pendingMutations: 1 };
    const next = issueReducer(before, { type: "mutation_failed", failure });
    expect(next.draft).toEqual(draft());
    expect(next.pendingMutations).toBe(0);
    if (failure.kind === "api" && failure.status === 401) {
      expect(next.authRequired).toBe(true);
    }
    if (failure.kind === "api" && failure.status === 409) {
      expect(next.conflict?.error).toBe("stale_issue");
      expect(next.highestObservedRevision).toBe(8);
      expect(next.refetchRequested).toBe(true);
    }
  });

  it("returns a remotely deleted selection to the queue with a tombstone notice", () => {
    const live = issue("issue-1");
    const before = {
      ...initialIssueState(PUBLIC_A),
      collection: collection(1, [live]),
      appliedRevision: 1,
      highestObservedRevision: 2,
      selectedIssueId: live.id,
      refetchInFlight: true,
      refetchRequested: false,
    };
    const next = issueReducer(before, {
      type: "collection_fetch_succeeded",
      collection: collection(2, [issue(live.id, "2026-07-19T10:02:00.000Z")]),
    });
    expect(next.selectedIssueId).toBeNull();
    expect(next.notice).toBe("selected_issue_deleted");
  });
});
