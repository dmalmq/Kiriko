import { act, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueApiError, type IssueApiClient } from "./api";
import type {
  CreateIssueInput,
  IssueCollection,
  IssueMutationResponse,
  IssueState,
  ReviewIssue,
} from "./types";
import {
  useIssueSync,
  type IssueController,
  type IssueEventSource,
  type IssueSyncOptions,
} from "./useIssueSync";

const PUBLIC_A = "a".repeat(64);
const PUBLIC_B = "b".repeat(64);
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

type Listener = (event: Event) => void;

class FakeEventSource implements IssueEventSource {
  readonly listeners = new Map<string, Set<Listener>>();
  closed = false;

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    const event = type === "revision"
      ? new MessageEvent(type, { data: JSON.stringify(data) })
      : new Event(type);
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function issue(id: string, deletedAt: string | null = null): ReviewIssue {
  const shared = {
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
    ? { ...shared, bodyMarkdown: "Body", attachments: [], deletedAt: null }
    : { ...shared, bodyMarkdown: null, attachments: [], deletedAt };
}

function collection(revision: number, issues: ReviewIssue[] = []): IssueCollection {
  return { revision, issues };
}

function api(overrides: Partial<IssueApiClient> = {}): IssueApiClient {
  const mutation = vi.fn().mockResolvedValue({ revision: 1, resourceId: "resource" });
  return {
    getIssues: vi.fn().mockResolvedValue(collection(0)),
    createIssue: mutation,
    createReply: mutation,
    patchIssue: mutation,
    patchReply: mutation,
    deleteIssue: mutation,
    deleteReply: mutation,
    listReviewers: vi.fn().mockResolvedValue([]),
    issueEventUrl: (publicId) => `/events/${publicId}`,
    ...overrides,
  } as IssueApiClient;
}

function harness(client: IssueApiClient, randomUUID = () => REQUEST_ID) {
  const sources: FakeEventSource[] = [];
  const options: IssueSyncOptions = {
    api: client,
    randomUUID,
    createEventSource: () => {
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    },
  };
  return { options, sources };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useIssueSync", () => {
  it("calls the hook normally with null while creating no GET or EventSource", async () => {
    const client = api();
    const { options, sources } = harness(client);
    const { result } = renderHook(() => useIssueSync(null, options));
    await flush();
    await act(async () => {
      await result.current.commands.createIssue({
        requestId: REQUEST_ID,
        bodyMarkdown: "Hidden",
        anchor: { levelId: "level-1", longitude: 1, latitude: 2 },
      });
      await result.current.commands.createReply("issue-1", {
        requestId: REQUEST_ID,
        bodyMarkdown: "Hidden",
      });
      await result.current.commands.patchIssue("issue-1", {
        type: "status",
        status: "closed",
        expectedVersion: 1,
      });
      await result.current.commands.patchReply("reply-1", {
        type: "body",
        bodyMarkdown: "Hidden",
        expectedVersion: 1,
      });
      await result.current.commands.deleteIssue("issue-1", 1);
      await result.current.commands.deleteReply("reply-1", 1);
    });

    expect(result.current.state.publicVersionId).toBeNull();
    expect(client.getIssues).not.toHaveBeenCalled();
    expect(sources).toHaveLength(0);
    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.createReply).not.toHaveBeenCalled();
    expect(client.patchIssue).not.toHaveBeenCalled();
    expect(client.patchReply).not.toHaveBeenCalled();
    expect(client.deleteIssue).not.toHaveBeenCalled();
    expect(client.deleteReply).not.toHaveBeenCalled();
    expect(Object.keys(result.current).sort()).toEqual([
      "commands",
      "retryCollection",
      "state",
      "ui",
      "resetNotice",
    ].sort());
  });

  it("starts one initial GET and the exact native event stream", async () => {
    const first = deferred<IssueCollection>();
    const issueEventUrl = vi.fn().mockReturnValue(`/events/${PUBLIC_A}`);
    const client = api({
      getIssues: vi.fn().mockReturnValue(first.promise),
      issueEventUrl,
    });
    const { options, sources } = harness(client);
    const { result } = renderHook(() => useIssueSync(PUBLIC_A, options));

    expect(client.getIssues).toHaveBeenCalledTimes(1);
    expect(client.getIssues).toHaveBeenCalledWith(PUBLIC_A, expect.any(AbortSignal));
    expect(sources).toHaveLength(1);
    expect(issueEventUrl).toHaveBeenCalledWith(PUBLIC_A);
    first.resolve(collection(2, [issue("issue-1")]));
    await flush();
    expect(result.current.state.appliedRevision).toBe(2);
    expect(result.current.state.collection).toEqual(collection(2, [issue("issue-1")]));
  });

  it("does not restart a public-ID generation when dependency option identities change", () => {
    const pending = deferred<IssueCollection>();
    const client = api({ getIssues: vi.fn().mockReturnValue(pending.promise) });
    const sources: FakeEventSource[] = [];
    const firstFactory = () => {
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    };
    const secondFactory = () => {
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    };
    const { rerender } = renderHook(
      ({ factory }) => useIssueSync(PUBLIC_A, {
        api: client,
        createEventSource: factory,
      }),
      { initialProps: { factory: firstFactory } },
    );
    const signal = vi.mocked(client.getIssues).mock.calls[0]![1];

    rerender({ factory: secondFactory });

    expect(signal.aborted).toBe(false);
    expect(sources).toHaveLength(1);
    expect(client.getIssues).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst during one GET and immediately follows up when still behind", async () => {
    const first = deferred<IssueCollection>();
    const second = deferred<IssueCollection>();
    const getIssues = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { options, sources } = harness(api({ getIssues }));
    const { result } = renderHook(() => useIssueSync(PUBLIC_A, options));

    act(() => {
      sources[0]!.emit("revision", { revision: 1 });
      sources[0]!.emit("revision", { revision: 3 });
      sources[0]!.emit("revision", { revision: 2 });
    });
    expect(getIssues).toHaveBeenCalledTimes(1);

    first.resolve(collection(2));
    await flush();
    expect(getIssues).toHaveBeenCalledTimes(2);
    expect(result.current.state.appliedRevision).toBe(2);

    second.resolve(collection(3));
    await flush();
    expect(getIssues).toHaveBeenCalledTimes(2);
    expect(result.current.state.appliedRevision).toBe(3);
    expect(result.current.state.highestObservedRevision).toBe(3);
  });

  it("shows reconnecting state and uses the reconnect revision to repair a mismatch", async () => {
    const next = deferred<IssueCollection>();
    const getIssues = vi.fn()
      .mockResolvedValueOnce(collection(1))
      .mockReturnValueOnce(next.promise);
    const { options, sources } = harness(api({ getIssues }));
    const { result } = renderHook(() => useIssueSync(PUBLIC_A, options));
    await flush();

    act(() => sources[0]!.emit("error"));
    expect(result.current.state.reconnecting).toBe(true);
    expect(result.current.state.stale).toBe(true);
    act(() => {
      sources[0]!.emit("open");
      sources[0]!.emit("revision", { revision: 4 });
    });
    expect(result.current.state.reconnecting).toBe(false);
    expect(getIssues).toHaveBeenCalledTimes(2);
    next.resolve(collection(4));
    await flush();
    expect(result.current.state.appliedRevision).toBe(4);
    expect(result.current.state.stale).toBe(false);
  });

  it("aborts and ignores a controlled old-version response after a key change", async () => {
    const oldGet = deferred<IssueCollection>();
    const newGet = deferred<IssueCollection>();
    const signals: AbortSignal[] = [];
    const getIssues = vi.fn((_publicId: string, signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? oldGet.promise : newGet.promise;
    });
    const { options, sources } = harness(api({ getIssues }));
    const { result, rerender } = renderHook(
      ({ publicId }) => useIssueSync(publicId, options),
      { initialProps: { publicId: PUBLIC_A as string | null } },
    );

    rerender({ publicId: PUBLIC_B });
    expect(signals[0]!.aborted).toBe(true);
    expect(sources[0]!.closed).toBe(true);
    expect(getIssues).toHaveBeenCalledTimes(2);

    oldGet.resolve(collection(9, [issue("old")]));
    await flush();
    expect(result.current.state.publicVersionId).toBe(PUBLIC_B);
    expect(result.current.state.collection).toBeNull();

    newGet.resolve(collection(1, [issue("new")]));
    await flush();
    expect(result.current.state.collection).toEqual(collection(1, [issue("new")]));
  });

  it("suppresses a late mutation response from an old public version", async () => {
    const mutation = deferred<IssueMutationResponse>();
    const newGet = deferred<IssueCollection>();
    const client = api({
      getIssues: vi.fn()
        .mockResolvedValueOnce(collection(0))
        .mockReturnValueOnce(newGet.promise),
      patchIssue: vi.fn().mockReturnValue(mutation.promise),
    });
    const { options } = harness(client);
    const { result, rerender } = renderHook(
      ({ publicId }) => useIssueSync(publicId, options),
      { initialProps: { publicId: PUBLIC_A as string | null } },
    );
    await flush();
    let command!: Promise<void>;
    act(() => {
      command = result.current.commands.patchIssue("issue-a", {
        type: "status",
        status: "closed",
        expectedVersion: 1,
      });
    });

    rerender({ publicId: PUBLIC_B });
    mutation.resolve({ revision: 9, resourceId: "issue-a" });
    await act(async () => command);

    expect(result.current.state.publicVersionId).toBe(PUBLIC_B);
    expect(result.current.state.highestObservedRevision).toBe(0);
    expect(result.current.state.pendingMutations).toBe(0);
    newGet.resolve(collection(1));
    await flush();
  });

  it("keeps canonical data and exposes stale network failure until controller retry", async () => {
    const retry = deferred<IssueCollection>();
    const getIssues = vi.fn()
      .mockResolvedValueOnce(collection(1, [issue("existing")]))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockReturnValueOnce(retry.promise);
    const { options, sources } = harness(api({ getIssues }));
    const { result } = renderHook(() => useIssueSync(PUBLIC_A, options));
    await flush();

    act(() => sources[0]!.emit("revision", { revision: 2 }));
    await flush();
    expect(result.current.state.collection).toEqual(collection(1, [issue("existing")]));
    expect(result.current.state.error).toEqual({ kind: "network", message: "offline" });
    expect(result.current.state.stale).toBe(true);

    act(() => result.current.retryCollection());
    expect(getIssues).toHaveBeenCalledTimes(3);
    retry.resolve(collection(2, [issue("existing")]));
    await flush();
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.stale).toBe(false);
  });

  it("does not let local revision 7 hide unseen revision 6 while a GET is in flight", async () => {
    const six = deferred<IssueCollection>();
    const seven = deferred<IssueCollection>();
    const mutation = deferred<IssueMutationResponse>();
    const getIssues = vi.fn()
      .mockResolvedValueOnce(collection(5, [issue("canonical")]))
      .mockReturnValueOnce(six.promise)
      .mockReturnValueOnce(seven.promise);
    const patchIssue = vi.fn().mockReturnValue(mutation.promise);
    const { options, sources } = harness(api({ getIssues, patchIssue }));
    const { result } = renderHook(() => useIssueSync(PUBLIC_A, options));
    await flush();

    act(() => sources[0]!.emit("revision", { revision: 6 }));
    let command!: Promise<void>;
    act(() => {
      command = result.current.commands.patchIssue("canonical", {
        type: "status",
        status: "in_review",
        expectedVersion: 1,
      });
    });
    mutation.resolve({ revision: 7, resourceId: "canonical" });
    await act(async () => command);
    expect(result.current.state.appliedRevision).toBe(5);
    expect(result.current.state.highestObservedRevision).toBe(7);
    expect(getIssues).toHaveBeenCalledTimes(2);

    six.resolve(collection(6, [issue("canonical")]));
    await flush();
    expect(result.current.state.appliedRevision).toBe(6);
    expect(getIssues).toHaveBeenCalledTimes(3);
    seven.resolve(collection(7, [issue("canonical")]));
    await flush();
    expect(result.current.state.appliedRevision).toBe(7);
  });

  it("retains a create draft until a canonical GET admits the returned resource", async () => {
    const admitted = deferred<IssueCollection>();
    const createIssue = vi.fn().mockResolvedValue({
      revision: 1,
      resourceId: "created",
    });
    const getIssues = vi.fn()
      .mockResolvedValueOnce(collection(0))
      .mockReturnValueOnce(admitted.promise);
    const { options } = harness(api({ createIssue, getIssues }));
    const { result } = renderHook(() => useIssueSync(PUBLIC_A, options));
    await flush();
    act(() => {
      result.current.ui.startDraft({ levelId: "level-1", longitude: 1, latitude: 2 });
      result.current.ui.updateDraft({ bodyMarkdown: "Canonical only" });
    });

    await act(async () => result.current.commands.createIssue({
      requestId: "00000000-0000-4000-8000-000000000000",
      bodyMarkdown: "Canonical only",
      anchor: { levelId: "level-1", longitude: 1, latitude: 2 },
    }));
    expect(result.current.state.draft?.requestId).toBe(REQUEST_ID);
    expect(result.current.state.appliedRevision).toBe(0);
    expect(result.current.state.draftAdmissionResourceId).toBe("created");

    admitted.resolve(collection(1, [issue("created")]));
    await flush();
    expect(result.current.state.draft).toBeNull();
    expect(result.current.state.draftAdmissionResourceId).toBeNull();
    expect(result.current.state.appliedRevision).toBe(1);
  });

  it("retains one draft UUID and recovers only a stale feature attachment", async () => {
    const randomUUID = vi.fn().mockReturnValue(REQUEST_ID);
    const createIssue = vi.fn().mockRejectedValue(new IssueApiError(400, {
      error: "invalid_anchor",
      message: "Invalid anchor",
      details: [{ field: "anchor.featureId", reason: "feature does not exist" }],
    }));
    const { options } = harness(api({ createIssue }), randomUUID);
    const { result } = renderHook(() => useIssueSync(PUBLIC_A, options));
    await flush();

    const anchor = {
      levelId: "level-1",
      longitude: 1,
      latitude: 2,
      featureId: "stale-feature",
    };
    act(() => {
      result.current.ui.startDraft(anchor);
      result.current.ui.startDraft({ ...anchor, longitude: 8 });
      result.current.ui.updateDraft({
        bodyMarkdown: "Preserve me",
        assigneeId: 2,
        dueDate: "2026-08-01",
      });
    });
    expect(randomUUID).toHaveBeenCalledTimes(1);

    const input: CreateIssueInput = {
      requestId: "00000000-0000-4000-8000-000000000000",
      bodyMarkdown: "Preserve me",
      anchor,
      assigneeId: 2,
      dueDate: "2026-08-01",
    };
    await act(async () => result.current.commands.createIssue(input));

    expect(createIssue).toHaveBeenCalledWith(PUBLIC_A, { ...input, requestId: REQUEST_ID });
    expect(result.current.state.draft).toEqual({
      requestId: REQUEST_ID,
      anchor: { levelId: "level-1", longitude: 1, latitude: 2 },
      bodyMarkdown: "Preserve me",
      assigneeId: 2,
      dueDate: "2026-08-01",
    });
    expect(result.current.state.notice).toBe("feature_attachment_removed");
    act(() => result.current.resetNotice());
    expect(result.current.state.notice).toBeNull();
  });

  it("falls back through controller selection when a canonical tombstone arrives", async () => {
    const tombstone = deferred<IssueCollection>();
    const getIssues = vi.fn()
      .mockResolvedValueOnce(collection(1, [issue("selected")]))
      .mockReturnValueOnce(tombstone.promise);
    const { options, sources } = harness(api({ getIssues }));
    const { result } = renderHook(() => useIssueSync(PUBLIC_A, options));
    await flush();
    act(() => result.current.ui.selectIssue("selected"));
    act(() => sources[0]!.emit("revision", { revision: 2 }));
    tombstone.resolve(collection(2, [
      issue("selected", "2026-07-19T10:02:00.000Z"),
    ]));
    await flush();
    expect(result.current.state.selectedIssueId).toBeNull();
    expect(result.current.state.notice).toBe("selected_issue_deleted");
  });

  it("preserves drafts on auth and stale failures and cleans up stream and GET", async () => {
    const pending = deferred<IssueCollection>();
    const createIssue = vi.fn()
      .mockRejectedValueOnce(new IssueApiError(401, {
        error: "unauthorized",
        message: "Sign in",
      }))
      .mockRejectedValueOnce(new IssueApiError(409, {
        error: "stale_issue",
        message: "Changed",
        revision: 3,
      }));
    const client = api({ getIssues: vi.fn().mockReturnValue(pending.promise), createIssue });
    const { options, sources } = harness(client);
    const { result, unmount } = renderHook(() => useIssueSync(PUBLIC_A, options));
    act(() => result.current.ui.startDraft({ levelId: "level-1", longitude: 1, latitude: 2 }));
    const input = {
      requestId: REQUEST_ID,
      bodyMarkdown: "Unsaved",
      anchor: { levelId: "level-1", longitude: 1, latitude: 2 },
    };

    await act(async () => result.current.commands.createIssue(input));
    expect(result.current.state.authRequired).toBe(true);
    expect(result.current.state.draft?.requestId).toBe(REQUEST_ID);
    await act(async () => result.current.commands.createIssue(input));
    expect(result.current.state.conflict?.error).toBe("stale_issue");
    expect(result.current.state.draft?.requestId).toBe(REQUEST_ID);

    const signal = vi.mocked(client.getIssues).mock.calls[0]![1];
    unmount();
    expect(signal.aborted).toBe(true);
    expect(sources[0]!.closed).toBe(true);
  });

  it("never exposes previous-version state to consumers during an identity change render", async () => {
    const first = deferred<IssueCollection>();
    const getIssues = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(new Promise<IssueCollection>(() => {}));
    const { options } = harness(api({ getIssues }));
    const snapshots: Array<{ prop: string | null; state: IssueState }> = [];
    let controller!: IssueController;

    function Consumer({ prop, value }: { prop: string | null; value: IssueController }) {
      snapshots.push({ prop, state: value.state });
      controller = value;
      return null;
    }
    function Probe({ prop }: { prop: string | null }) {
      return <Consumer prop={prop} value={useIssueSync(prop, options)} />;
    }

    const view = render(<Probe prop={PUBLIC_A} />);
    await act(async () => {
      first.resolve(collection(3, [issue("issue-a")]));
    });
    act(() => {
      controller.ui.selectIssue("issue-a");
      controller.ui.startDraft({ levelId: "level-1", longitude: 1, latitude: 2 });
    });
    expect(controller.state.collection).toEqual(collection(3, [issue("issue-a")]));
    expect(controller.state.draft?.requestId).toBe(REQUEST_ID);

    view.rerender(<Probe prop={PUBLIC_B} />);
    view.rerender(<Probe prop={null} />);

    for (const { prop, state } of snapshots) {
      expect(state.publicVersionId).toBe(prop);
      if (prop !== PUBLIC_A) {
        expect(state.collection).toBeNull();
        expect(state.selectedIssueId).toBeNull();
        expect(state.draft).toBeNull();
        expect(state.highestObservedRevision).toBe(0);
        expect(state.appliedRevision).toBe(0);
      }
    }
  });

  it("synchronously releases the draft UUID guard when the identity changes", async () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce(REQUEST_ID)
      .mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const { options } = harness(api(), randomUUID);
    const { result, rerender } = renderHook(
      ({ publicId }) => useIssueSync(publicId, options),
      { initialProps: { publicId: PUBLIC_A as string | null } },
    );
    await flush();
    act(() => result.current.ui.startDraft({ levelId: "level-1", longitude: 1, latitude: 2 }));
    expect(result.current.state.draft?.requestId).toBe(REQUEST_ID);

    rerender({ publicId: PUBLIC_B });
    expect(result.current.state.draft).toBeNull();
    act(() => result.current.ui.startDraft({ levelId: "level-2", longitude: 3, latitude: 4 }));
    expect(result.current.state.draft?.requestId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });
});
