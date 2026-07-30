import type { ReactElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { LocaleCode } from "../imdf/types";
import { initialIssueState } from "./issueReducer";
import { countActiveIssues, issueSummary } from "./IssueQueue";
import { IssuesPanel, type IssuesPanelProps } from "./IssuesPanel";
import type {
  IssueCollection,
  IssueDraft,
  IssueReply,
  IssueState,
  IssueStatus,
  ReviewerSummary,
  ReviewIssue,
} from "./types";
import type { IssueActor, IssueCommands, IssueController, IssueUiActions } from "./useIssueSync";

const PUBLIC_ID = "a".repeat(64);

const VIEWER: IssueActor = { id: 1, username: "viewer1", role: "viewer" };
const MEMBER: IssueActor = { id: 2, username: "member1", role: "member" };
const ADMIN: IssueActor = { id: 3, username: "admin1", role: "admin" };
const REVIEWERS: ReviewerSummary[] = [
  { id: 1, username: "viewer1" },
  { id: 2, username: "member1" },
  { id: 3, username: "admin1" },
];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function localDueString(daysAhead: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const YESTERDAY = localDueString(-1);
const IN_TWO_DAYS = localDueString(2);
const IN_FOUR_DAYS = localDueString(4);

interface IssueOptions {
  id: string;
  pinNumber: number;
  levelId?: string;
  featureId?: string;
  status?: IssueStatus;
  authorId?: number;
  authorName?: string;
  assigneeId?: number | null;
  assigneeName?: string;
  dueDate?: string | null;
  body?: string;
  deletedAt?: string | null;
  replies?: IssueReply[];
  rowVersion?: number;
}

function makeIssue(options: IssueOptions): ReviewIssue {
  const deletedAt = options.deletedAt ?? null;
  const shared = {
    id: options.id,
    pinNumber: options.pinNumber,
    rowVersion: options.rowVersion ?? 1,
    anchor: {
      levelId: options.levelId ?? "level-1f",
      longitude: 139.7,
      latitude: 35.68,
      ...(options.featureId !== undefined ? { featureId: options.featureId } : {}),
    },
    status: options.status ?? ("open" as IssueStatus),
    author: { id: options.authorId ?? 2, username: options.authorName ?? "member1" },
    assignee:
      options.assigneeId != null
        ? { id: options.assigneeId, username: options.assigneeName ?? `user${options.assigneeId}` }
        : null,
    dueDate: options.dueDate ?? null,
    createdAt: "2026-07-18T09:00:00Z",
    updatedAt: "2026-07-18T10:00:00Z",
    replies: options.replies ?? [],
  };
  return deletedAt === null
    ? { ...shared, bodyMarkdown: options.body ?? "Body text", attachments: [], deletedAt: null }
    : { ...shared, bodyMarkdown: null, attachments: [], deletedAt };
}

interface ReplyOptions {
  id: string;
  authorId?: number;
  authorName?: string;
  body?: string;
  deletedAt?: string | null;
  rowVersion?: number;
}

function makeReply(options: ReplyOptions): IssueReply {
  const deletedAt = options.deletedAt ?? null;
  const shared = {
    id: options.id,
    rowVersion: options.rowVersion ?? 1,
    author: { id: options.authorId ?? 1, username: options.authorName ?? "viewer1" },
    createdAt: "2026-07-18T09:30:00Z",
    updatedAt: "2026-07-18T09:30:00Z",
  };
  return deletedAt === null
    ? { ...shared, bodyMarkdown: options.body ?? "Reply text", attachments: [], deletedAt: null }
    : { ...shared, bodyMarkdown: null, attachments: [], deletedAt };
}

function makeDraft(patch: Partial<IssueDraft> = {}): IssueDraft {
  return {
    requestId: "req-1",
    anchor: { levelId: "level-1f", longitude: 139.7, latitude: 35.68 },
    bodyMarkdown: "",
    assigneeId: null,
    dueDate: null,
    ...patch,
  };
}

function collection(revision: number, issues: ReviewIssue[]): IssueCollection {
  return { revision, issues };
}

interface PanelHarness {
  commands: { [K in keyof IssueCommands]: Mock };
  ui: { [K in keyof IssueUiActions]: Mock };
  retryCollection: Mock;
  resetNotice: Mock;
  callbacks: {
    onRetryAuth: Mock;
    onRequestSignIn: Mock;
    onBeginPlacement: Mock;
    onCancelPlacement: Mock;
  };
  update(patch: Partial<IssueState>): void;
  setUser(actor: IssueActor | null): void;
}

function renderPanel(
  options: {
    state?: Partial<IssueState>;
    currentUser?: IssueActor | null;
    reviewers?: ReviewerSummary[];
    identityError?: boolean;
    authError?: boolean;
    locale?: LocaleCode;
  } = {},
): PanelHarness {
  let state: IssueState = { ...initialIssueState(PUBLIC_ID), ...options.state };
  let currentUser: IssueActor | null = options.currentUser ?? null;
  const commands = {
    createIssue: vi.fn(),
    createReply: vi.fn(),
    patchIssue: vi.fn(),
    patchReply: vi.fn(),
    deleteIssue: vi.fn(),
    deleteReply: vi.fn(),
  };
  const ui = {
    setFilter: vi.fn(),
    selectIssue: vi.fn(),
    startDraft: vi.fn(),
    updateDraft: vi.fn(),
    cancelDraft: vi.fn(),
    setPlacement: vi.fn(),
  };
  const retryCollection = vi.fn();
  const resetNotice = vi.fn();
  const callbacks: PanelHarness["callbacks"] = {
    onRetryAuth: vi.fn(),
    onRequestSignIn: vi.fn(),
    onBeginPlacement: vi.fn(),
    onCancelPlacement: vi.fn(),
  };

  function controller(): IssueController {
    return { state, commands, ui, retryCollection, resetNotice };
  }
  function element(): ReactElement {
    const props: IssuesPanelProps = {
      locale: options.locale ?? "en",
      controller: controller(),
      currentUser,
      reviewers: options.reviewers ?? REVIEWERS,
      identityError: options.identityError ?? false,
      authError: options.authError ?? false,
      onRetryAuth: callbacks.onRetryAuth,
      onRequestSignIn: callbacks.onRequestSignIn,
      onBeginPlacement: callbacks.onBeginPlacement,
      onCancelPlacement: callbacks.onCancelPlacement,
    };
    return <IssuesPanel {...props} />;
  }

  const view = render(element());
  return {
    commands,
    ui,
    retryCollection,
    resetNotice,
    callbacks,
    update(patch: Partial<IssueState>) {
      state = { ...state, ...patch };
      view.rerender(element());
    },
    setUser(actor: IssueActor | null) {
      currentUser = actor;
      view.rerender(element());
    },
  };
}

function renderDetail(
  issue: ReviewIssue,
  actor: IssueActor | null,
  patch: Partial<IssueState> = {},
): PanelHarness {
  return renderPanel({
    currentUser: actor,
    state: {
      collection: collection(1, [issue]),
      appliedRevision: 1,
      highestObservedRevision: 1,
      selectedIssueId: issue.id,
      ...patch,
    },
  });
}

describe("IssueQueue filtering", () => {
  const issues = [
    makeIssue({ id: "i1", pinNumber: 1, levelId: "level-1f", body: "Gate is blocked" }),
    makeIssue({
      id: "i2",
      pinNumber: 2,
      levelId: "level-2f",
      status: "in_review",
      body: "Signage unclear",
      assigneeId: 1,
      assigneeName: "viewer1",
    }),
    makeIssue({ id: "i3", pinNumber: 3, levelId: "level-b1", status: "closed", body: "Fixed" }),
    makeIssue({ id: "i4", pinNumber: 4, levelId: "level-b1", deletedAt: "2026-07-18T11:00:00Z" }),
  ];

  it("shows active issues by default and reports filter changes", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: VIEWER,
      state: { collection: collection(1, issues), appliedRevision: 1 },
    });

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toContain("Gate is blocked");
    expect(options[1]?.textContent).toContain("Signage unclear");
    expect(screen.getByRole("button", { name: "Active" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Closed" }));
    expect(harness.ui.setFilter).toHaveBeenCalledWith("closed");

    harness.update({ filter: "closed" });
    const closedOptions = screen.getAllByRole("option");
    expect(closedOptions).toHaveLength(2);
    expect(closedOptions[0]?.textContent).toContain("Fixed");
    expect(closedOptions[1]?.textContent).toContain("Comment deleted");
  });

  it("filters assigned-to-me and unassigned against the signed-in user", () => {
    const harness = renderPanel({
      currentUser: VIEWER,
      state: { collection: collection(1, issues), appliedRevision: 1, filter: "assigned_to_me" },
    });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toContain("Signage unclear");

    harness.update({ filter: "unassigned" });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toContain("Gate is blocked");
  });

  it("shows a filter-specific empty state", () => {
    renderPanel({
      currentUser: VIEWER,
      state: { collection: collection(1, []), appliedRevision: 1, filter: "unassigned" },
    });
    expect(screen.getByText("No unassigned issues")).toBeTruthy();
  });

  it("selecting a row reports the issue id", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: VIEWER,
      state: { collection: collection(1, issues), appliedRevision: 1 },
    });
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    expect(harness.ui.selectIssue).toHaveBeenCalledWith("i1");
  });
});

describe("active issue badge derivation", () => {
  it("counts open and in_review issues across every floor", () => {
    const issues = [
      makeIssue({ id: "i1", pinNumber: 1, levelId: "level-1f" }),
      makeIssue({ id: "i2", pinNumber: 2, levelId: "level-2f", status: "in_review" }),
      makeIssue({ id: "i3", pinNumber: 3, levelId: "level-b1", status: "closed" }),
      makeIssue({ id: "i4", pinNumber: 4, levelId: "level-b1", deletedAt: "2026-07-18T11:00:00Z" }),
    ];
    expect(countActiveIssues(issues)).toBe(2);
  });

  it("shows the all-floor active count above the queue", () => {
    renderPanel({
      currentUser: VIEWER,
      state: {
        collection: collection(1, [
          makeIssue({ id: "i1", pinNumber: 1, levelId: "level-1f" }),
          makeIssue({ id: "i2", pinNumber: 2, levelId: "level-2f", status: "in_review" }),
        ]),
        appliedRevision: 1,
      },
    });
    expect(screen.getByText("2 active")).toBeTruthy();
  });
});

describe("issueSummary", () => {
  it("uses the first non-empty normalized source line", () => {
    expect(issueSummary("\n\n  First line\nsecond line", "en")).toBe("First line");
    expect(issueSummary("a\r\nb", "en")).toBe("a");
  });

  it("collapses whitespace runs", () => {
    expect(issueSummary("  many\t spaces   here  ", "en")).toBe("many spaces here");
  });

  it("keeps 80 Unicode scalar values without an ellipsis", () => {
    expect(issueSummary("x".repeat(80), "en")).toBe("x".repeat(80));
    expect(issueSummary("🙂".repeat(80), "en")).toBe("🙂".repeat(80));
  });

  it("truncates 81 scalar values to 80 plus an ellipsis", () => {
    expect(issueSummary("x".repeat(81), "en")).toBe(`${"x".repeat(80)}…`);
    expect(issueSummary("🙂".repeat(81), "en")).toBe(`${"🙂".repeat(80)}…`);
    expect(issueSummary(`${"x".repeat(81)} trailing`, "en")).toBe(`${"x".repeat(80)}…`);
  });

  it("localizes the deleted-root tombstone", () => {
    expect(issueSummary(null, "en")).toBe("Comment deleted");
    expect(issueSummary(null, "ja")).toBe("コメントは削除されました");
  });

  it("strips image syntax and falls back for image-only bodies", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(issueSummary(`![gate](attachment:${id})`, "en")).toBe("Image attachment");
    expect(issueSummary(`![gate](attachment:${id})`, "ja")).toBe("画像添付");
    expect(issueSummary(`Broken gate ![gate](attachment:${id})`, "en")).toBe("Broken gate");
    expect(issueSummary(`![x](https://example.com/x.png)`, "en")).toBe("");
  });
});

describe("queue row content", () => {
  it("shows pin number, status, assignee, reply count, and due classification text", () => {
    const issues = [
      makeIssue({
        id: "i1",
        pinNumber: 7,
        body: "Escalator stopped",
        assigneeId: 2,
        assigneeName: "member1",
        dueDate: YESTERDAY,
        replies: [makeReply({ id: "r1" }), makeReply({ id: "r2" })],
      }),
      makeIssue({ id: "i2", pinNumber: 8, body: "Loose tile", dueDate: IN_TWO_DAYS }),
      makeIssue({ id: "i3", pinNumber: 9, body: "Future work", dueDate: IN_FOUR_DAYS }),
    ];
    renderPanel({
      currentUser: MEMBER,
      state: { collection: collection(1, issues), appliedRevision: 1 },
    });

    const options = screen.getAllByRole("option");
    expect(options[0]?.textContent).toContain("#7");
    expect(options[0]?.textContent).toContain("Open");
    expect(options[0]?.textContent).toContain("member1");
    expect(options[0]?.textContent).toContain("2 replies");
    expect(options[0]?.textContent).toContain("Overdue");
    expect(options[1]?.textContent).toContain("Due soon");
    expect(options[2]?.textContent).not.toContain("Due soon");
    expect(options[2]?.textContent).not.toContain("Overdue");
  });
});

describe("IssueDetail role matrix", () => {
  const authoredByMember = makeIssue({
    id: "i1",
    pinNumber: 1,
    body: "Root markdown body",
    authorId: 2,
    authorName: "member1",
  });

  it("anonymous users read but get no mutation controls", () => {
    renderDetail(authoredByMember, null);
    expect(screen.queryByRole("button", { name: "Edit issue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete issue" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Status" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Assignee" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Assign to me" })).toBeNull();
    expect(screen.queryByText("Root markdown body")).toBeTruthy();
  });

  it("a viewer who is not the author can only self-assign or reply", () => {
    renderDetail(authoredByMember, VIEWER);
    expect(screen.queryByRole("button", { name: "Edit issue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete issue" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Status" })).toBeNull();
    expect(screen.queryByLabelText("Due date")).toBeNull();
    expect(screen.getByRole("button", { name: "Assign to me" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Reply" })).toBeTruthy();
  });

  it("the member author edits and moderates their own issue", () => {
    renderDetail(authoredByMember, MEMBER);
    expect(screen.getByRole("button", { name: "Edit issue" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete issue" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Status" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Assignee" })).toBeTruthy();
    expect(screen.getByLabelText("Due date")).toBeTruthy();
  });

  it("an admin can delete any issue but never edits another author's text", () => {
    renderDetail(authoredByMember, ADMIN);
    expect(screen.queryByRole("button", { name: "Edit issue" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete issue" })).toBeTruthy();
  });

  it("a viewer author edits and deletes their own issue", () => {
    renderDetail(makeIssue({ id: "i9", pinNumber: 9, authorId: 1, authorName: "viewer1" }), VIEWER);
    expect(screen.getByRole("button", { name: "Edit issue" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete issue" })).toBeTruthy();
  });
});

describe("self-assignment transitions", () => {
  it("a viewer assigns themselves on an unassigned issue", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1, rowVersion: 5 });
    const harness = renderDetail(issue, VIEWER);
    await user.click(screen.getByRole("button", { name: "Assign to me" }));
    expect(harness.commands.patchIssue).toHaveBeenCalledWith("i1", {
      type: "assignment",
      assigneeId: 1,
      expectedVersion: 5,
    });
  });

  it("a viewer clears only their own assignment", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({
      id: "i1",
      pinNumber: 1,
      rowVersion: 6,
      assigneeId: 1,
      assigneeName: "viewer1",
    });
    const harness = renderDetail(issue, VIEWER);
    await user.click(screen.getByRole("button", { name: "Unassign me" }));
    expect(harness.commands.patchIssue).toHaveBeenCalledWith("i1", {
      type: "assignment",
      assigneeId: null,
      expectedVersion: 6,
    });
  });

  it("a viewer cannot replace another account's assignment", () => {
    const issue = makeIssue({ id: "i1", pinNumber: 1, assigneeId: 3, assigneeName: "admin1" });
    renderDetail(issue, VIEWER);
    expect(screen.queryByRole("button", { name: "Assign to me" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unassign me" })).toBeNull();
    expect(screen.getByText("admin1")).toBeTruthy();
  });
});

describe("member assignment, due date, and status", () => {
  it("assigns and clears any account through the select", () => {
    const issue = makeIssue({ id: "i1", pinNumber: 1, rowVersion: 3 });
    const harness = renderDetail(issue, MEMBER);
    const select = screen.getByRole("combobox", { name: "Assignee" });
    fireEvent.change(select, { target: { value: "3" } });
    expect(harness.commands.patchIssue).toHaveBeenCalledWith("i1", {
      type: "assignment",
      assigneeId: 3,
      expectedVersion: 3,
    });
    fireEvent.change(select, { target: { value: "" } });
    expect(harness.commands.patchIssue).toHaveBeenCalledWith("i1", {
      type: "assignment",
      assigneeId: null,
      expectedVersion: 3,
    });
  });

  it("sets and clears the due date", () => {
    const issue = makeIssue({ id: "i1", pinNumber: 1, rowVersion: 4, dueDate: "2026-08-01" });
    const harness = renderDetail(issue, MEMBER);
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-09-15" } });
    expect(harness.commands.patchIssue).toHaveBeenCalledWith("i1", {
      type: "due_date",
      dueDate: "2026-09-15",
      expectedVersion: 4,
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear due date" }));
    expect(harness.commands.patchIssue).toHaveBeenCalledWith("i1", {
      type: "due_date",
      dueDate: null,
      expectedVersion: 4,
    });
  });

  it("changes the status of an open issue", () => {
    const open = makeIssue({ id: "i1", pinNumber: 1, rowVersion: 2 });
    const harness = renderDetail(open, MEMBER);
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "in_review" },
    });
    expect(harness.commands.patchIssue).toHaveBeenCalledWith("i1", {
      type: "status",
      status: "in_review",
      expectedVersion: 2,
    });
  });

  it("reopens a closed issue", () => {
    const closed = makeIssue({ id: "i2", pinNumber: 2, rowVersion: 7, status: "closed" });
    const harness = renderDetail(closed, MEMBER);
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "open" },
    });
    expect(harness.commands.patchIssue).toHaveBeenCalledWith("i2", {
      type: "status",
      status: "open",
      expectedVersion: 7,
    });
  });
});

describe("tombstones and reply controls", () => {
  it("renders a deleted root as a tombstone and hides status and reply creation", () => {
    const deleted = makeIssue({
      id: "i1",
      pinNumber: 1,
      status: "closed",
      deletedAt: "2026-07-18T11:00:00Z",
      replies: [makeReply({ id: "r1", body: "Still visible" })],
    });
    renderDetail(deleted, MEMBER);
    expect(screen.getByText("Comment deleted")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Status" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Assignee" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    expect(screen.getByText("Still visible")).toBeTruthy();
  });

  it("keeps reply edit/delete controls under the normal authorship rules", () => {
    const deleted = makeIssue({
      id: "i1",
      pinNumber: 1,
      status: "closed",
      deletedAt: "2026-07-18T11:00:00Z",
      replies: [
        makeReply({ id: "r1", authorId: 1, authorName: "viewer1", body: "Mine" }),
        makeReply({ id: "r2", authorId: 2, authorName: "member1", body: "Theirs" }),
        makeReply({ id: "r3", authorId: 2, deletedAt: "2026-07-18T12:00:00Z" }),
      ],
    });
    renderDetail(deleted, VIEWER);
    expect(screen.getByRole("button", { name: "Edit reply" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete reply" })).toBeTruthy();
    expect(screen.getAllByText("Comment deleted")).toHaveLength(2);
  });

  it("an admin deletes any reply but edits only their own", () => {
    const issue = makeIssue({
      id: "i1",
      pinNumber: 1,
      replies: [makeReply({ id: "r1", authorId: 1, authorName: "viewer1", body: "Mine" })],
    });
    renderDetail(issue, ADMIN);
    expect(screen.queryByRole("button", { name: "Edit reply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete reply" })).toBeTruthy();
  });

  it("edits a reply, keeps the editor open, and closes it on canonical admission", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({
      id: "i1",
      pinNumber: 1,
      replies: [makeReply({ id: "r1", authorId: 1, body: "Original", rowVersion: 4 })],
    });
    const harness = renderDetail(issue, VIEWER);

    await user.click(screen.getByRole("button", { name: "Edit reply" }));
    const editor = screen.getByRole("textbox", { name: "Edit reply body" });
    fireEvent.change(editor, { target: { value: "Updated" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(harness.commands.patchReply).toHaveBeenCalledWith("r1", {
      type: "body",
      bodyMarkdown: "Updated",
      expectedVersion: 4,
    });
    // The editor survives until the canonical projection shows the new body.
    expect(screen.getByRole("textbox", { name: "Edit reply body" })).toBeTruthy();

    harness.update({
      collection: collection(2, [
        makeIssue({
          id: "i1",
          pinNumber: 1,
          replies: [makeReply({ id: "r1", authorId: 1, body: "Updated", rowVersion: 5 })],
        }),
      ]),
      appliedRevision: 2,
    });
    expect(screen.queryByRole("textbox", { name: "Edit reply body" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Delete reply" }));
    expect(harness.commands.deleteReply).toHaveBeenCalledWith("r1", 5);
  });

  it("edits the root body through the controller with normalized Markdown", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1, authorId: 1, rowVersion: 8, body: "Before" });
    const harness = renderDetail(issue, VIEWER);
    await user.click(screen.getByRole("button", { name: "Edit issue" }));
    const editor = screen.getByRole("textbox", { name: "Edit issue body" });
    fireEvent.change(editor, { target: { value: "After\r\nline" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(harness.commands.patchIssue).toHaveBeenCalledWith("i1", {
      type: "body",
      bodyMarkdown: "After\nline",
      expectedVersion: 8,
    });
  });
});

describe("replies on closed issues", () => {
  it("a signed-in user replies to a closed issue with normalized Markdown", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1, status: "closed", authorId: 2 });
    const harness = renderDetail(issue, VIEWER);

    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "Sounds good\r\nShip it" },
    });
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(harness.commands.createReply).toHaveBeenCalledTimes(1);
    const [issueId, input] = harness.commands.createReply.mock.calls[0] as [
      string,
      { requestId: string; bodyMarkdown: string },
    ];
    expect(issueId).toBe("i1");
    expect(input.bodyMarkdown).toBe("Sounds good\nShip it");
    expect(UUID_V4.test(input.requestId)).toBe(true);
  });

  it("an anonymous user is invited to sign in to reply", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1 });
    const harness = renderDetail(issue, null);
    await user.click(screen.getByRole("button", { name: "Sign in to reply" }));
    expect(harness.callbacks.onRequestSignIn).toHaveBeenCalled();
  });
});

describe("retry, error, conflict, and stream states", () => {
  it("offers a retry when the collection fails to load", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: VIEWER,
      state: {
        collection: null,
        error: { kind: "network", message: "offline" },
        errorScope: "collection",
        refetchInFlight: false,
        refetchRequested: false,
      },
    });
    expect(screen.getByText("Issues couldn't be loaded.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.retryCollection).toHaveBeenCalled();
  });

  it("shows a mutation failure without blocking further input", () => {
    renderDetail(makeIssue({ id: "i1", pinNumber: 1, authorId: 1 }), VIEWER, {
      error: { kind: "network", message: "offline" },
      errorScope: "mutation",
    });
    expect(
      screen.getByText("The change couldn't be saved. Your input is safe — try again."),
    ).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Reply" })).toBeTruthy();
  });

  it("explains a conflict and preserves the draft", () => {
    renderDetail(makeIssue({ id: "i1", pinNumber: 1, authorId: 1 }), VIEWER, {
      conflict: {
        kind: "api",
        status: 409,
        error: "stale_issue",
        message: "stale",
      },
    });
    expect(
      screen.getByText(
        "This issue changed while you were working. Your input is safe — review it and try again.",
      ),
    ).toBeTruthy();
  });

  it("asks for sign-in when the session expired mid-mutation", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: null,
      state: {
        collection: collection(1, []),
        appliedRevision: 1,
        authRequired: true,
      },
    });
    expect(screen.getByText("Your session expired. Sign in to continue.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(harness.callbacks.onRequestSignIn).toHaveBeenCalled();
  });

  it("shows a reconnecting line while keeping loaded issues visible", () => {
    renderPanel({
      currentUser: VIEWER,
      state: {
        collection: collection(1, [makeIssue({ id: "i1", pinNumber: 1, body: "Still here" })]),
        appliedRevision: 1,
        reconnecting: true,
        stale: true,
      },
    });
    expect(screen.getByText("Connection lost. Reconnecting…")).toBeTruthy();
    expect(screen.getByText("Still here")).toBeTruthy();
  });

  it("announces a remotely deleted selection and dismisses the notice", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: VIEWER,
      state: {
        collection: collection(2, []),
        appliedRevision: 2,
        notice: "selected_issue_deleted",
      },
    });
    expect(screen.getByText("This issue was deleted.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(harness.resetNotice).toHaveBeenCalled();
  });
});

describe("identity and auth-lookup states", () => {
  it("explains when the bundle has no review identity", () => {
    renderPanel({ currentUser: VIEWER, identityError: true });
    expect(screen.getByText("Issues aren't available for this dataset.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Active" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New issue" })).toBeNull();
  });

  it("surfaces an auth lookup failure with a retry while keeping issues readable", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: null,
      authError: true,
      state: {
        collection: collection(1, [makeIssue({ id: "i1", pinNumber: 1, body: "Visible" })]),
        appliedRevision: 1,
      },
    });
    expect(screen.getByText("We couldn't verify your account.")).toBeTruthy();
    expect(screen.getByText("Visible")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.callbacks.onRetryAuth).toHaveBeenCalled();
  });
});

describe("placement capture", () => {
  it("starts placement from the new issue button", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: MEMBER,
      state: { collection: collection(1, []), appliedRevision: 1 },
    });
    await user.click(screen.getByRole("button", { name: "New issue" }));
    expect(harness.callbacks.onBeginPlacement).toHaveBeenCalled();
  });

  it("shows the placement hint and cancels placement", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: MEMBER,
      state: { collection: collection(1, []), appliedRevision: 1, placementActive: true },
    });
    expect(screen.getByText("Click the map to place the pin")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New issue" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel placement" }));
    expect(harness.callbacks.onCancelPlacement).toHaveBeenCalled();
  });

  it("invites a signed-out user to sign in instead of placing", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: null,
      state: { collection: collection(1, []), appliedRevision: 1 },
    });
    expect(screen.queryByRole("button", { name: "New issue" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Sign in to create issues" }));
    expect(harness.callbacks.onRequestSignIn).toHaveBeenCalled();
  });
});

describe("IssueComposer", () => {
  const composerState = (draft: IssueDraft, patch: Partial<IssueState> = {}): Partial<IssueState> => ({
    collection: collection(1, []),
    appliedRevision: 1,
    draft,
    ...patch,
  });

  it("routes field changes through updateDraft", () => {
    const harness = renderPanel({
      currentUser: MEMBER,
      state: composerState(makeDraft()),
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Issue body" }), {
      target: { value: "Hello" },
    });
    expect(harness.ui.updateDraft).toHaveBeenCalledWith({ bodyMarkdown: "Hello" });

    fireEvent.change(screen.getByRole("combobox", { name: "Assignee" }), {
      target: { value: "3" },
    });
    expect(harness.ui.updateDraft).toHaveBeenCalledWith({ assigneeId: 3 });

    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-08-01" } });
    expect(harness.ui.updateDraft).toHaveBeenCalledWith({ dueDate: "2026-08-01" });
  });

  it("limits a viewer to unassigned or self and hides the due date", () => {
    renderPanel({
      currentUser: VIEWER,
      state: composerState(makeDraft()),
    });
    const select = screen.getByRole("combobox", { name: "Assignee" });
    const labels = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toEqual(["Unassigned", "viewer1"]);
    expect(screen.queryByLabelText("Due date")).toBeNull();
  });

  it("posts the draft through the controller-owned request ID with normalized fields", async () => {
    const user = userEvent.setup();
    const draft = makeDraft({
      bodyMarkdown: "Needs work\r\nASAP",
      assigneeId: 3,
      dueDate: "2026-08-01",
      anchor: { levelId: "level-1f", longitude: 139.7, latitude: 35.68, featureId: "f1" },
    });
    const harness = renderPanel({
      currentUser: MEMBER,
      state: composerState(draft),
    });
    await user.click(screen.getByRole("button", { name: "Post issue" }));
    expect(harness.commands.createIssue).toHaveBeenCalledWith({
      requestId: "req-1",
      bodyMarkdown: "Needs work\nASAP",
      attachmentIds: [],
      anchor: { levelId: "level-1f", longitude: 139.7, latitude: 35.68, featureId: "f1" },
      assigneeId: 3,
      dueDate: "2026-08-01",
    });
  });

  it("removes the captured feature manually", async () => {
    const user = userEvent.setup();
    const draft = makeDraft({
      bodyMarkdown: "Body",
      anchor: { levelId: "level-1f", longitude: 139.7, latitude: 35.68, featureId: "f1" },
    });
    const harness = renderPanel({
      currentUser: MEMBER,
      state: composerState(draft),
    });
    expect(screen.getByText("f1")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove feature" }));
    expect(harness.ui.updateDraft).toHaveBeenCalledWith({
      anchor: { levelId: "level-1f", longitude: 139.7, latitude: 35.68 },
    });
  });

  it("announces a server-removed stale feature and resubmits with the same request ID", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: MEMBER,
      state: composerState(makeDraft({ bodyMarkdown: "Still valid" }), {
        notice: "feature_attachment_removed",
      }),
    });
    expect(
      screen.getByText(
        "That feature is no longer in this version. The pin keeps its location — review and post again.",
      ),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Post issue" }));
    expect(harness.commands.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        anchor: { levelId: "level-1f", longitude: 139.7, latitude: 35.68, featureId: null },
      }),
    );

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(harness.resetNotice).toHaveBeenCalled();
  });

  it("shows the scalar character count and disables posting over the limit", () => {
    const harness = renderPanel({
      currentUser: MEMBER,
      state: composerState(makeDraft({ bodyMarkdown: "Hello" })),
    });
    expect(screen.getByText("5/4000")).toBeTruthy();

    harness.update({ draft: makeDraft({ bodyMarkdown: "🙂".repeat(4001) }) });
    expect(screen.getByText("4001/4000")).toBeTruthy();
    expect(screen.getByText("Keep it under 4,000 characters.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Post issue" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("disables posting for an empty or whitespace-only body", () => {
    const harness = renderPanel({
      currentUser: MEMBER,
      state: composerState(makeDraft()),
    });
    expect(
      (screen.getByRole("button", { name: "Post issue" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    harness.update({ draft: makeDraft({ bodyMarkdown: "  \n\t " }) });
    expect(
      (screen.getByRole("button", { name: "Post issue" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("never blocks creation on the optional assignee or due date", () => {
    renderPanel({
      currentUser: MEMBER,
      state: composerState(makeDraft({ bodyMarkdown: "Body only" })),
    });
    expect(
      (screen.getByRole("button", { name: "Post issue" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("disables posting while a mutation is pending", () => {
    renderPanel({
      currentUser: MEMBER,
      state: composerState(makeDraft({ bodyMarkdown: "Body" }), { pendingMutations: 1 }),
    });
    expect(
      (screen.getByRole("button", { name: "Post issue" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps a signed-out draft and offers sign-in instead of posting", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: null,
      state: composerState(makeDraft({ bodyMarkdown: "Preserved" })),
    });
    expect(screen.getByRole("textbox", { name: "Issue body" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Post issue" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Sign in to post" }));
    expect(harness.callbacks.onRequestSignIn).toHaveBeenCalled();
  });

  it("cancels the draft through the controller", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: MEMBER,
      state: composerState(makeDraft({ bodyMarkdown: "Draft" })),
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(harness.ui.cancelDraft).toHaveBeenCalled();
  });
});

describe("focus behavior", () => {
  it("moves focus into the composer after placement and back to new issue on cancel", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: MEMBER,
      state: { collection: collection(1, []), appliedRevision: 1 },
    });

    const newIssue = screen.getByRole("button", { name: "New issue" });
    await user.click(newIssue);
    expect(harness.callbacks.onBeginPlacement).toHaveBeenCalled();

    // App marks placement active, then a successful capture starts the draft.
    harness.update({ placementActive: true });
    harness.update({ placementActive: false, draft: makeDraft() });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Issue body" }));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(harness.ui.cancelDraft).toHaveBeenCalled();
    harness.update({ draft: null });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New issue" }));
  });
});

describe("detail navigation", () => {
  it("returns to the queue from the detail view", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1 });
    const harness = renderDetail(issue, VIEWER);
    await user.click(screen.getByRole("button", { name: "Back to issues" }));
    expect(harness.ui.selectIssue).toHaveBeenCalledWith(null);
  });

  it("deletes the root issue with its row version", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1, authorId: 1, rowVersion: 9 });
    const harness = renderDetail(issue, VIEWER);
    await user.click(screen.getByRole("button", { name: "Delete issue" }));
    expect(harness.commands.deleteIssue).toHaveBeenCalledWith("i1", 9);
  });

  it("keeps Reply as the only primary action while a detail is open", () => {
    const issue = makeIssue({ id: "i1", pinNumber: 1 });
    renderDetail(issue, MEMBER);
    expect(screen.queryByRole("button", { name: "New issue" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reply" })).toBeTruthy();
  });

  it("renders the detail as two panes: main content and the reply thread", () => {
    const issue = makeIssue({ id: "i1", pinNumber: 1 });
    renderDetail(issue, VIEWER);
    const twoPane = document.querySelector(".issue-detail--two-pane");
    expect(twoPane).not.toBeNull();
    const main = twoPane!.querySelector(".issue-detail__main");
    const threadPane = twoPane!.querySelector(".issue-detail__thread-pane");
    expect(main).not.toBeNull();
    expect(threadPane).not.toBeNull();
    expect(main!.querySelector(".issue-detail__meta")).not.toBeNull();
    expect(threadPane!.querySelector(".issue-detail__thread")).not.toBeNull();
  });
});

describe("localized copy", () => {
  it("renders the queue in Japanese", () => {
    renderPanel({
      locale: "ja",
      currentUser: VIEWER,
      state: {
        collection: collection(1, [
          makeIssue({ id: "i1", pinNumber: 1, body: "改札が塞がれている" }),
        ]),
        appliedRevision: 1,
      },
    });
    expect(screen.getByRole("button", { name: "進行中" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "自分に割り当て" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "未割り当て" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "クローズ" })).toBeTruthy();
    expect(screen.getByText("1 件の進行中")).toBeTruthy();
    expect(screen.getByText("改札が塞がれている")).toBeTruthy();
  });
});

describe("body editor persistence", () => {
  it("keeps the root editor and its text through a failed mutation", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1, authorId: 1, rowVersion: 8, body: "Before" });
    const harness = renderDetail(issue, VIEWER);

    await user.click(screen.getByRole("button", { name: "Edit issue" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit issue body" }), {
      target: { value: "After" },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    harness.update({ pendingMutations: 1 });
    harness.update({
      pendingMutations: 0,
      error: { kind: "network", message: "offline" },
      errorScope: "mutation",
    });
    const editor = screen.getByRole("textbox", { name: "Edit issue body" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("After");

    // A stale-issue conflict also preserves the editor.
    harness.update({
      error: null,
      errorScope: null,
      conflict: { kind: "api", status: 409, error: "stale_issue", message: "stale" },
    });
    expect(
      (screen.getByRole("textbox", { name: "Edit issue body" }) as HTMLTextAreaElement).value,
    ).toBe("After");
  });

  it("closes the root editor only when the canonical body and version admit the edit", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1, authorId: 1, rowVersion: 8, body: "Before" });
    const harness = renderDetail(issue, VIEWER);

    await user.click(screen.getByRole("button", { name: "Edit issue" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit issue body" }), {
      target: { value: "After" },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    // A remote refetch with someone else's newer body must NOT close it.
    harness.update({
      collection: collection(2, [
        makeIssue({ id: "i1", pinNumber: 1, authorId: 1, rowVersion: 9, body: "Theirs" }),
      ]),
      appliedRevision: 2,
    });
    expect(screen.getByRole("textbox", { name: "Edit issue body" })).toBeTruthy();

    harness.update({
      collection: collection(3, [
        makeIssue({ id: "i1", pinNumber: 1, authorId: 1, rowVersion: 10, body: "After" }),
      ]),
      appliedRevision: 3,
    });
    expect(screen.queryByRole("textbox", { name: "Edit issue body" })).toBeNull();
    expect(screen.getByText("After")).toBeTruthy();
  });
});

describe("reply composer retention", () => {
  const liveIssue = () => makeIssue({ id: "i1", pinNumber: 1, authorId: 2 });

  it("keeps text and reuses the request ID after a failed submission", async () => {
    const user = userEvent.setup();
    const harness = renderDetail(liveIssue(), VIEWER);

    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "First try" },
    });
    await user.click(screen.getByRole("button", { name: "Reply" }));
    harness.update({ pendingMutations: 1 });
    harness.update({
      pendingMutations: 0,
      error: { kind: "network", message: "offline" },
      errorScope: "mutation",
    });

    const box = screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement;
    expect(box.value).toBe("First try");

    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(harness.commands.createReply).toHaveBeenCalledTimes(2);
    const first = harness.commands.createReply.mock.calls[0] as [string, { requestId: string }];
    const second = harness.commands.createReply.mock.calls[1] as [string, { requestId: string }];
    expect(second[1].requestId).toBe(first[1].requestId);
  });

  it("never clears on an arbitrary applied revision", async () => {
    const user = userEvent.setup();
    const harness = renderDetail(liveIssue(), VIEWER);

    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "Waiting" },
    });
    await user.click(screen.getByRole("button", { name: "Reply" }));
    harness.update({ appliedRevision: 42, highestObservedRevision: 42 });
    expect((screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement).value).toBe(
      "Waiting",
    );
  });

  it("clears and rotates the request ID only after this submission succeeds", async () => {
    const user = userEvent.setup();
    const harness = renderDetail(liveIssue(), VIEWER);

    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "Lands" },
    });
    await user.click(screen.getByRole("button", { name: "Reply" }));
    harness.update({ pendingMutations: 1 });
    harness.update({ pendingMutations: 0 });

    const box = screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement;
    expect(box.value).toBe("");

    fireEvent.change(box, { target: { value: "Next one" } });
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(harness.commands.createReply).toHaveBeenCalledTimes(2);
    const first = harness.commands.createReply.mock.calls[0] as [string, { requestId: string }];
    const second = harness.commands.createReply.mock.calls[1] as [string, { requestId: string }];
    expect(second[1].requestId).not.toBe(first[1].requestId);
    expect(UUID_V4.test(second[1].requestId)).toBe(true);
  });
});

describe("idempotency conflict", () => {
  it("explains that the request key admitted different content and offers restart, not retry", () => {
    renderPanel({
      currentUser: MEMBER,
      state: {
        collection: collection(1, []),
        appliedRevision: 1,
        draft: makeDraft({ bodyMarkdown: "Draft body" }),
        conflict: {
          kind: "api",
          status: 409,
          error: "idempotency_conflict",
          message: "conflict",
        },
      },
    });
    expect(
      screen.getByText(
        "This request was already submitted with different content. Your input is kept — cancel and start again to post it.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "This issue changed while you were working. Your input is safe — review it and try again.",
      ),
    ).toBeNull();
    // The restart affordance is the composer's own Cancel.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "Issue body" }) as HTMLTextAreaElement).value,
    ).toBe("Draft body");
  });
});

describe("viewer draft sanitation", () => {
  it("routes removal of now-forbidden metadata through updateDraft for a known viewer", () => {
    const harness = renderPanel({
      currentUser: VIEWER,
      state: {
        collection: collection(1, []),
        appliedRevision: 1,
        draft: makeDraft({ bodyMarkdown: "Keep me", dueDate: "2026-08-01", assigneeId: 3 }),
      },
    });
    expect(harness.ui.updateDraft).toHaveBeenCalledTimes(1);
    expect(harness.ui.updateDraft).toHaveBeenCalledWith({ dueDate: null, assigneeId: null });
  });

  it("keeps a viewer's self-assignment", () => {
    const harness = renderPanel({
      currentUser: VIEWER,
      state: {
        collection: collection(1, []),
        appliedRevision: 1,
        draft: makeDraft({ bodyMarkdown: "Keep me", assigneeId: VIEWER.id }),
      },
    });
    expect(harness.ui.updateDraft).not.toHaveBeenCalled();
  });

  it("preserves everything while the account is unknown", () => {
    const harness = renderPanel({
      currentUser: null,
      state: {
        collection: collection(1, []),
        appliedRevision: 1,
        draft: makeDraft({ bodyMarkdown: "Keep me", dueDate: "2026-08-01", assigneeId: 3 }),
      },
    });
    expect(harness.ui.updateDraft).not.toHaveBeenCalled();
  });
});

describe("anchor context", () => {
  it("shows the floor and optional feature as machine values on queue rows", () => {
    renderPanel({
      currentUser: VIEWER,
      state: {
        collection: collection(1, [
          makeIssue({ id: "i1", pinNumber: 1, levelId: "level-2f", featureId: "feat-9" }),
          makeIssue({ id: "i2", pinNumber: 2, levelId: "level-b1" }),
        ]),
        appliedRevision: 1,
      },
    });
    const rows = screen.getAllByRole("option");
    expect(rows[0]?.textContent).toContain("Floor");
    expect(rows[0]?.textContent).toContain("level-2f");
    expect(rows[0]?.textContent).toContain("Feature");
    expect(rows[0]?.textContent).toContain("feat-9");
    expect(rows[1]?.textContent).toContain("level-b1");
    expect(rows[1]?.textContent).not.toContain("Feature");
  });

  it("shows the floor row in the detail view", () => {
    renderDetail(makeIssue({ id: "i1", pinNumber: 1, levelId: "level-2f" }), VIEWER);
    expect(screen.getByText("Floor")).toBeTruthy();
    expect(screen.getByText("level-2f")).toBeTruthy();
  });

  it("shows the captured floor in the composer", () => {
    renderPanel({
      currentUser: MEMBER,
      state: {
        collection: collection(1, []),
        appliedRevision: 1,
        draft: makeDraft({ bodyMarkdown: "Body" }),
      },
    });
    expect(screen.getByText("Floor")).toBeTruthy();
    expect(screen.getByText("level-1f")).toBeTruthy();
  });

  it("localizes the floor label", () => {
    renderPanel({
      locale: "ja",
      currentUser: VIEWER,
      state: {
        collection: collection(1, [makeIssue({ id: "i1", pinNumber: 1, levelId: "level-2f" })]),
        appliedRevision: 1,
      },
    });
    expect(screen.getByRole("option").textContent).toContain("フロア");
  });
});

describe("editor feedback", () => {
  it("gives the root editor a count, hint, and empty explanation", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1, authorId: 1, body: "Before" });
    renderDetail(issue, VIEWER);

    await user.click(screen.getByRole("button", { name: "Edit issue" }));
    const editorBox = screen
      .getByRole("textbox", { name: "Edit issue body" })
      .closest(".issue-editor") as HTMLElement;
    expect(within(editorBox).getByText("6/4000")).toBeTruthy();
    expect(
      within(editorBox).getByText("Markdown: **bold**, *italic*, lists, links"),
    ).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Edit issue body" }), {
      target: { value: "" },
    });
    expect(within(editorBox).getByText("Enter some text.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("alerts on invalid reply input with the reason", () => {
    renderDetail(makeIssue({ id: "i1", pinNumber: 1, authorId: 2 }), VIEWER);
    const replyBox = screen
      .getByRole("textbox", { name: "Reply" })
      .closest(".issue-reply-composer") as HTMLElement;
    expect(within(replyBox).getByText("0/4000")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "bad\u0000char" },
    });
    expect(within(replyBox).getByRole("alert").textContent).toBe(
      "Remove unsupported control characters.",
    );
    expect((screen.getByRole("button", { name: "Reply" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("explains why an empty composer cannot post", () => {
    renderPanel({
      currentUser: MEMBER,
      state: {
        collection: collection(1, []),
        appliedRevision: 1,
        draft: makeDraft(),
      },
    });
    expect(screen.getByText("Enter some text.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Post issue" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("automatic sign-in flow", () => {
  it("opens sign-in once per authRequired episode while keeping the explicit button", () => {
    const harness = renderPanel({
      currentUser: MEMBER,
      state: {
        collection: collection(1, []),
        appliedRevision: 1,
        draft: makeDraft({ bodyMarkdown: "Draft" }),
      },
    });
    expect(harness.callbacks.onRequestSignIn).not.toHaveBeenCalled();

    harness.update({ authRequired: true });
    expect(harness.callbacks.onRequestSignIn).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();

    harness.update({ authRequired: true, pendingMutations: 0 });
    expect(harness.callbacks.onRequestSignIn).toHaveBeenCalledTimes(1);

    harness.update({ authRequired: false });
    harness.update({ authRequired: true });
    expect(harness.callbacks.onRequestSignIn).toHaveBeenCalledTimes(2);
  });

  it("restores focus to the retained draft after sign-in", () => {
    const harness = renderPanel({
      currentUser: null,
      state: {
        collection: collection(1, []),
        appliedRevision: 1,
        draft: makeDraft({ bodyMarkdown: "Preserved" }),
      },
    });
    screen.getByRole("button", { name: "Sign in to post" }).focus();

    harness.setUser(MEMBER);
    const textarea = screen.getByRole("textbox", { name: "Issue body" }) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe("Preserved");
  });
});

describe("in-flight submission locks", () => {
  it("locks the reply box while its own submission is in flight", async () => {
    const user = userEvent.setup();
    const harness = renderDetail(makeIssue({ id: "i1", pinNumber: 1, authorId: 2 }), VIEWER);
    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "In flight" },
    });
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect((screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Reply" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    void harness;
  });

  it("locks the root editor until admission and unlocks unchanged on failure", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1, authorId: 1, rowVersion: 8, body: "Before" });
    const harness = renderDetail(issue, VIEWER);

    await user.click(screen.getByRole("button", { name: "Edit issue" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit issue body" }), {
      target: { value: "After" },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    harness.update({ pendingMutations: 1 });
    expect(
      (screen.getByRole("textbox", { name: "Edit issue body" }) as HTMLTextAreaElement).disabled,
    ).toBe(true);

    harness.update({
      pendingMutations: 0,
      error: { kind: "network", message: "offline" },
      errorScope: "mutation",
    });
    const editor = screen.getByRole("textbox", { name: "Edit issue body" }) as HTMLTextAreaElement;
    expect(editor.disabled).toBe(false);
    expect(editor.value).toBe("After");
  });

  it("disables the composer inputs from post through canonical admission", () => {
    const harness = renderPanel({
      currentUser: MEMBER,
      state: {
        collection: collection(1, []),
        appliedRevision: 1,
        draft: makeDraft({ bodyMarkdown: "Body" }),
      },
    });
    harness.update({ pendingMutations: 0, draftAdmissionResourceId: "new-1" });
    expect(
      (screen.getByRole("textbox", { name: "Issue body" }) as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("combobox", { name: "Assignee" }) as HTMLSelectElement).disabled,
    ).toBe(true);
    expect((screen.getByLabelText("Due date") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Post issue" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    harness.update({
      pendingMutations: 0,
      draftAdmissionResourceId: null,
      error: { kind: "network", message: "offline" },
      errorScope: "mutation",
    });
    expect(
      (screen.getByRole("textbox", { name: "Issue body" }) as HTMLTextAreaElement).disabled,
    ).toBe(false);
  });
});

describe("reply idempotency restart", () => {
  it("offers Post as new reply after an idempotency conflict and rotates only then", async () => {
    const user = userEvent.setup();
    const harness = renderDetail(makeIssue({ id: "i1", pinNumber: 1, authorId: 2 }), VIEWER);

    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "Same text" },
    });
    await user.click(screen.getByRole("button", { name: "Reply" }));
    harness.update({ pendingMutations: 1 });
    harness.update({
      pendingMutations: 0,
      error: { kind: "api", status: 409, error: "idempotency_conflict", message: "conflict" },
      conflict: { kind: "api", status: 409, error: "idempotency_conflict", message: "conflict" },
    });

    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Post as new reply" }));
    expect(harness.commands.createReply).toHaveBeenCalledTimes(2);
    const first = harness.commands.createReply.mock.calls[0] as [string, { requestId: string; bodyMarkdown: string }];
    const second = harness.commands.createReply.mock.calls[1] as [string, { requestId: string; bodyMarkdown: string }];
    expect(second[1].requestId).not.toBe(first[1].requestId);
    expect(second[1].bodyMarkdown).toBe("Same text");
    expect(UUID_V4.test(second[1].requestId)).toBe(true);
  });
});

describe("reply survives a signed-out gap", () => {
  it("preserves reply text across null and refocuses on the account's return", () => {
    const harness = renderDetail(makeIssue({ id: "i1", pinNumber: 1, authorId: 2 }), VIEWER);
    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "Draft reply" },
    });

    harness.setUser(null);
    expect((screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement).value).toBe(
      "Draft reply",
    );
    expect(screen.getByRole("button", { name: "Sign in to reply" })).toBeTruthy();

    harness.setUser(VIEWER);
    const box = screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Draft reply");
    expect(document.activeElement).toBe(box);
  });
});

describe("terminal mutation copy", () => {
  it("marks a deleted issue permanently gone with no retry", () => {
    renderDetail(makeIssue({ id: "i1", pinNumber: 1, authorId: 1 }), VIEWER, {
      error: { kind: "api", status: 409, error: "issue_deleted", message: "gone" },
      conflict: { kind: "api", status: 409, error: "issue_deleted", message: "gone" },
    });
    expect(screen.getByText("This issue was permanently deleted.")).toBeTruthy();
    expect(
      screen.queryByText(
        "This issue changed while you were working. Your input is safe — review it and try again.",
      ),
    ).toBeNull();
  });

  it("explains a forbidden action with no retry", () => {
    renderDetail(makeIssue({ id: "i1", pinNumber: 1, authorId: 1 }), VIEWER, {
      error: { kind: "api", status: 403, error: "forbidden", message: "no" },
      errorScope: "mutation",
    });
    expect(screen.getByText("You don't have permission to do that.")).toBeTruthy();
    expect(
      screen.queryByText("The change couldn't be saved. Your input is safe — try again."),
    ).toBeNull();
  });

  it("keeps the review-and-retry copy for a stale conflict", () => {
    renderDetail(makeIssue({ id: "i1", pinNumber: 1, authorId: 1 }), VIEWER, {
      error: { kind: "api", status: 409, error: "stale_issue", message: "stale" },
      conflict: { kind: "api", status: 409, error: "stale_issue", message: "stale" },
    });
    expect(
      screen.getByText(
        "This issue changed while you were working. Your input is safe — review it and try again.",
      ),
    ).toBeTruthy();
  });
});

describe("loaded-collection refetch failure", () => {
  it("exposes Retry in the composer view and admits the draft after retry", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({
      currentUser: MEMBER,
      state: {
        collection: collection(1, []),
        appliedRevision: 1,
        draft: makeDraft({ bodyMarkdown: "New body" }),
      },
    });
    // Create succeeded (awaiting admission), then the canonical GET failed —
    // the draft stays locked with no way forward unless Retry is reachable.
    harness.update({
      pendingMutations: 0,
      draftAdmissionResourceId: "new-1",
      error: { kind: "network", message: "offline" },
      errorScope: "collection",
      stale: true,
      refetchInFlight: false,
      refetchRequested: false,
    });
    expect(
      (screen.getByRole("textbox", { name: "Issue body" }) as HTMLTextAreaElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.retryCollection).toHaveBeenCalled();

    harness.update({
      collection: collection(2, [makeIssue({ id: "new-1", pinNumber: 1, body: "New body" })]),
      appliedRevision: 2,
      draft: null,
      draftAdmissionResourceId: null,
      error: null,
      errorScope: null,
      stale: false,
    });
    expect(screen.queryByRole("textbox", { name: "Issue body" })).toBeNull();
  });

  it("exposes Retry in the detail view and admits the edit after retry", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1, authorId: 1, rowVersion: 8, body: "Before" });
    const harness = renderDetail(issue, VIEWER);

    await user.click(screen.getByRole("button", { name: "Edit issue" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit issue body" }), {
      target: { value: "After" },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    harness.update({ pendingMutations: 1 });
    harness.update({ pendingMutations: 0 });
    // The post-edit canonical GET fails; the editor is still locked awaiting
    // admission and must expose Retry from the detail view.
    harness.update({
      error: { kind: "network", message: "offline" },
      errorScope: "collection",
      stale: true,
      refetchInFlight: false,
      refetchRequested: false,
    });
    expect(
      (screen.getByRole("textbox", { name: "Edit issue body" }) as HTMLTextAreaElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.retryCollection).toHaveBeenCalled();

    harness.update({
      collection: collection(2, [
        makeIssue({ id: "i1", pinNumber: 1, authorId: 1, rowVersion: 9, body: "After" }),
      ]),
      appliedRevision: 2,
      error: null,
      errorScope: null,
      stale: false,
    });
    expect(screen.queryByRole("textbox", { name: "Edit issue body" })).toBeNull();
  });

  it("keeps a single Retry: the full error state when the collection never loaded", () => {
    renderPanel({
      currentUser: MEMBER,
      state: {
        collection: null,
        error: { kind: "network", message: "offline" },
        errorScope: "collection",
        refetchRequested: false,
      },
    });
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  });

  it("exposes Retry after a mutation conflict whose canonical refetch also failed", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1, authorId: 1, rowVersion: 3, body: "Before" });
    const harness = renderDetail(issue, VIEWER);
    // A stale-issue conflict on a patch, then a failed canonical refetch: the
    // reducer preserves the mutation error (errorScope "mutation"), sets stale,
    // and clears refetch demand, so `collectionFailed` stays false and only the
    // masked mutation copy would otherwise show — with no way to recover.
    harness.update({
      error: { kind: "api", status: 409, error: "stale_issue", message: "stale" },
      errorScope: "mutation",
      conflict: { kind: "api", status: 409, error: "stale_issue", message: "stale" },
      stale: true,
      refetchInFlight: false,
      refetchRequested: false,
    });
    expect(
      screen.getByText(
        "This issue changed while you were working. Your input is safe — review it and try again.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.retryCollection).toHaveBeenCalled();

    harness.update({
      collection: collection(2, [
        makeIssue({ id: "i1", pinNumber: 1, authorId: 1, rowVersion: 4, body: "Updated remotely" }),
      ]),
      appliedRevision: 2,
      error: null,
      errorScope: null,
      conflict: null,
      stale: false,
    });
    expect(screen.getByText("Updated remotely")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("editor authorship across auth changes", () => {
  it("hides root Save when the author signs out but keeps the text and Cancel", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1, authorId: 1, authorName: "viewer1", body: "Draft" });
    const harness = renderDetail(issue, VIEWER);

    await user.click(screen.getByRole("button", { name: "Edit issue" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit issue body" }), {
      target: { value: "Edited text" },
    });

    harness.setUser(null);
    const editor = screen.getByRole("textbox", { name: "Edit issue body" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("Edited text");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("hides root Save for a different account and keeps the text", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1, authorId: 1, authorName: "viewer1", body: "Draft" });
    const harness = renderDetail(issue, VIEWER);

    await user.click(screen.getByRole("button", { name: "Edit issue" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit issue body" }), {
      target: { value: "Edited text" },
    });

    harness.setUser(MEMBER);
    const editor = screen.getByRole("textbox", { name: "Edit issue body" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("Edited text");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("restores root Save and focus when the same author returns", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ id: "i1", pinNumber: 1, authorId: 1, authorName: "viewer1", body: "Draft" });
    const harness = renderDetail(issue, VIEWER);

    await user.click(screen.getByRole("button", { name: "Edit issue" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit issue body" }), {
      target: { value: "Edited text" },
    });

    harness.setUser(null);
    harness.setUser(VIEWER);
    const editor = screen.getByRole("textbox", { name: "Edit issue body" }) as HTMLTextAreaElement;
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(editor.value).toBe("Edited text");
    expect(document.activeElement).toBe(editor);
  });

  it("hides reply Save when the author signs out but keeps the text and Cancel", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({
      id: "i1",
      pinNumber: 1,
      authorId: 2,
      replies: [makeReply({ id: "r1", authorId: 1, authorName: "viewer1", body: "Reply draft" })],
    });
    const harness = renderDetail(issue, VIEWER);

    await user.click(screen.getByRole("button", { name: "Edit reply" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit reply body" }), {
      target: { value: "Edited reply" },
    });

    harness.setUser(null);
    const editor = screen.getByRole("textbox", { name: "Edit reply body" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("Edited reply");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("restores reply Save and focus when the same author returns", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({
      id: "i1",
      pinNumber: 1,
      authorId: 2,
      replies: [makeReply({ id: "r1", authorId: 1, authorName: "viewer1", body: "Reply draft" })],
    });
    const harness = renderDetail(issue, VIEWER);

    await user.click(screen.getByRole("button", { name: "Edit reply" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit reply body" }), {
      target: { value: "Edited reply" },
    });

    harness.setUser(null);
    harness.setUser(VIEWER);
    const editor = screen.getByRole("textbox", { name: "Edit reply body" }) as HTMLTextAreaElement;
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(editor.value).toBe("Edited reply");
    expect(document.activeElement).toBe(editor);
  });
});
