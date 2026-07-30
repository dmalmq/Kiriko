import { useEffect, useRef, useState } from "react";
import type { LocaleCode } from "../imdf/types";
import { IssueMarkdownEditor, attachmentIdsForSubmit } from "./IssueMarkdownEditor";
import { formatIssueInstant } from "./issueDates";
import { dueDateText, issueStatusLabel, issueSummary } from "./IssueQueue";
import {
  checkIssueBody,
  MarkdownBody,
  normalizeIssueMarkdown,
} from "./MarkdownBody";
import type {
  CreateReplyInput,
  IssueAttachmentMetadata,
  IssuePatch,
  IssueReply,
  IssueStatus,
  ReplyBodyPatch,
  ReviewerSummary,
  ReviewIssue,
} from "./types";
import type { IssueActor } from "./useIssueSync";

/**
 * Issue detail: root body, metadata, role-gated controls, and the one-level
 * reply thread. Controls are convenience visibility only — the server
 * remains authoritative for every permission.
 */

const ui = {
  back: { ja: "課題一覧に戻る", en: "Back to issues" },
  author: { ja: "作成者", en: "Author" },
  created: { ja: "作成日", en: "Created" },
  updated: { ja: "更新日", en: "Updated" },
  status: { ja: "ステータス", en: "Status" },
  assignee: { ja: "担当者", en: "Assignee" },
  dueDate: { ja: "期限", en: "Due date" },
  unassigned: { ja: "未割り当て", en: "Unassigned" },
  noDueDate: { ja: "なし", en: "None" },
  floor: { ja: "フロア", en: "Floor" },
  pin: { ja: "ピン", en: "Pin" },
  feature: { ja: "地物", en: "Feature" },
  editIssue: { ja: "課題を編集", en: "Edit issue" },
  deleteIssue: { ja: "課題を削除", en: "Delete issue" },
  editIssueBody: { ja: "課題の本文を編集", en: "Edit issue body" },
  editReply: { ja: "返信を編集", en: "Edit reply" },
  deleteReply: { ja: "返信を削除", en: "Delete reply" },
  editReplyBody: { ja: "返信の本文を編集", en: "Edit reply body" },
  save: { ja: "保存", en: "Save" },
  cancel: { ja: "キャンセル", en: "Cancel" },
  assignToMe: { ja: "自分に割り当て", en: "Assign to me" },
  unassignMe: { ja: "割り当てを解除", en: "Unassign me" },
  clearDueDate: { ja: "期限をクリア", en: "Clear due date" },
  replies: { ja: "返信", en: "Replies" },
  reply: { ja: "返信", en: "Reply" },
  postAsNewReply: { ja: "新しい返信として投稿", en: "Post as new reply" },
  replyPlaceholder: { ja: "返信を入力…", en: "Write a reply…" },
  signInToReply: { ja: "返信するにはサインイン", en: "Sign in to reply" },
  edited: { ja: "編集済み", en: "Edited" },
} as const;

export interface IssueDetailProps {
  locale: LocaleCode;
  issue: ReviewIssue;
  currentUser: IssueActor | null;
  reviewers: ReviewerSummary[];
  /** Published version identity for staged attachment uploads. */
  publicVersionId: string | null;
  /** True while any mutation is in flight; submit controls disable. */
  pending: boolean;
  /**
   * True when the latest mutation outcome failed (mutation-scope error,
   * conflict, or expired session). Mutations are UI-serialized, so with
   * `pending` this identifies the submitted command's own outcome.
   */
  mutationFailed: boolean;
  /** True when the latest conflict is an idempotency-key collision. */
  idempotencyConflict: boolean;
  onBack: () => void;
  onRequestSignIn: () => void;
  onPatchIssue: (patch: IssuePatch) => void;
  onDeleteIssue: (expectedVersion: number) => void;
  onCreateReply: (input: CreateReplyInput) => void;
  onPatchReply: (replyId: string, patch: ReplyBodyPatch) => void;
  onDeleteReply: (replyId: string, expectedVersion: number) => void;
}

type Editing = { kind: "root" } | { kind: "reply"; replyId: string } | null;

interface SubmittedEdit {
  bodyMarkdown: string;
  expectedVersion: number;
}

interface BodyEditorProps {
  locale: LocaleCode;
  label: string;
  initial: string;
  /** Canonical attachments of the body being edited (for preview). */
  attachments: IssueAttachmentMetadata[];
  publicVersionId: string | null;
  /**
   * The current actor is the live resource's author. Save is shown only while
   * true; losing authorship (session lost or a different account) hides Save
   * but keeps the text and Cancel, and regaining it refocuses the textarea.
   */
  authorized: boolean;
  /** Locked from save through canonical admission; unlocked on failure. */
  locked: boolean;
  pending: boolean;
  onSave: (normalized: string) => void;
  onCancel: () => void;
}

/**
 * Inline body editor. Saving never closes the editor by itself — the owner
 * closes it only when the canonical projection admits the exact edit, and
 * keeps it locked meanwhile so an in-flight edit is never discarded. On
 * failure the owner unlocks it with the submitted text intact. It stays
 * mounted (text preserved) across auth changes; Save is gated on `authorized`.
 */
function BodyEditor({
  locale,
  label,
  initial,
  attachments,
  publicVersionId,
  authorized,
  locked,
  pending,
  onSave,
  onCancel,
}: BodyEditorProps) {
  const [text, setText] = useState(initial);
  const [uploadsBlocked, setUploadsBlocked] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wasUnauthorizedRef = useRef(!authorized);
  useEffect(() => {
    if (wasUnauthorizedRef.current && authorized) {
      textareaRef.current?.focus();
    }
    wasUnauthorizedRef.current = !authorized;
  }, [authorized]);
  const normalized = normalizeIssueMarkdown(text);
  const check = checkIssueBody(normalized);
  return (
    <div className="issue-editor">
      <IssueMarkdownEditor
        locale={locale}
        value={text}
        onChange={setText}
        disabled={locked}
        ariaLabel={label}
        rows={4}
        textareaClassName="issue-editor__input"
        publicVersionId={publicVersionId}
        existingAttachments={attachments}
        onSubmitBlockedChange={setUploadsBlocked}
        textareaRef={textareaRef}
      />
      <div className="issue-editor__actions">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          {ui.cancel[locale]}
        </button>
        {authorized ? (
          <button
            type="button"
            className="btn-primary"
            disabled={locked || pending || check.problem !== null || uploadsBlocked}
            onClick={() => {
              onSave(normalized);
            }}
          >
            {ui.save[locale]}
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface ReplyComposerProps {
  locale: LocaleCode;
  signedIn: boolean;
  pending: boolean;
  mutationFailed: boolean;
  idempotencyConflict: boolean;
  publicVersionId: string | null;
  /** False while a body editor is open, so it keeps auth-return focus. */
  focusOnReturn: boolean;
  onSubmit: (input: CreateReplyInput) => void;
  onRequestSignIn: () => void;
}

/**
 * Reply box. Kept mounted across a signed-out gap so its text and request ID
 * survive a mid-reply session loss; focus returns to it when the account
 * comes back (the App clears currentUser to null before the sign-in modal, so
 * recovery is a null→actor transition). The request ID is allocated once and
 * reused across failed retries; mutations are UI-serialized, so this box's own
 * outcome clears and rotates it only on success. An idempotency collision
 * offers an explicit "Post as new reply" that rotates the ID and resends the
 * retained text — never a silent rotation.
 */
function ReplyComposer({
  locale,
  signedIn,
  pending,
  mutationFailed,
  idempotencyConflict,
  publicVersionId,
  focusOnReturn,
  onSubmit,
  onRequestSignIn,
}: ReplyComposerProps) {
  const [text, setText] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [inFlight, setInFlight] = useState(false);
  const [restart, setRestart] = useState(false);
  const [uploadsBlocked, setUploadsBlocked] = useState(false);
  const phaseRef = useRef<"idle" | "submitted" | "inflight">("idle");
  const submittedBodyRef = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (phaseRef.current === "submitted" && pending) {
      phaseRef.current = "inflight";
      return;
    }
    if (phaseRef.current === "inflight" && !pending) {
      phaseRef.current = "idle";
      setInFlight(false);
      if (!mutationFailed) {
        setText("");
        setRequestId(crypto.randomUUID());
        setRestart(false);
      } else {
        setText(submittedBodyRef.current);
        if (idempotencyConflict) {
          setRestart(true);
        }
      }
    }
  }, [pending, mutationFailed, idempotencyConflict]);

  const wasSignedOutRef = useRef(!signedIn);
  useEffect(() => {
    if (wasSignedOutRef.current && signedIn && focusOnReturn) {
      textareaRef.current?.focus();
    }
    wasSignedOutRef.current = !signedIn;
  }, [signedIn, focusOnReturn]);

  const normalized = normalizeIssueMarkdown(text);
  const check = checkIssueBody(normalized);
  const showTextarea = signedIn || text !== "";

  const submit = (id: string) => {
    submittedBodyRef.current = normalized;
    phaseRef.current = "submitted";
    setInFlight(true);
    setRestart(false);
    onSubmit({ requestId: id, bodyMarkdown: normalized, attachmentIds: attachmentIdsForSubmit(normalized) });
  };

  return (
    <div className="issue-reply-composer">
      {showTextarea ? (
        <IssueMarkdownEditor
          locale={locale}
          value={text}
          onChange={setText}
          disabled={inFlight}
          ariaLabel={ui.reply[locale]}
          placeholder={ui.replyPlaceholder[locale]}
          rows={3}
          textareaClassName="issue-reply-composer__input"
          publicVersionId={publicVersionId}
          onSubmitBlockedChange={setUploadsBlocked}
          textareaRef={textareaRef}
        />
      ) : null}
      <div className="issue-reply-composer__actions">
        {!signedIn ? (
          <button type="button" className="btn-ghost" onClick={onRequestSignIn}>
            {ui.signInToReply[locale]}
          </button>
        ) : restart ? (
          <button
            type="button"
            className="btn-primary"
            disabled={pending || check.problem !== null || uploadsBlocked}
            onClick={() => {
              const id = crypto.randomUUID();
              setRequestId(id);
              submit(id);
            }}
          >
            {ui.postAsNewReply[locale]}
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary"
            disabled={inFlight || pending || check.problem !== null || uploadsBlocked}
            onClick={() => {
              submit(requestId);
            }}
          >
            {ui.reply[locale]}
          </button>
        )}
      </div>
    </div>
  );
}

interface ReplyRowProps {
  locale: LocaleCode;
  reply: IssueReply;
  currentUser: IssueActor | null;
  pending: boolean;
  editing: boolean;
  locked: boolean;
  publicVersionId: string | null;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (normalized: string) => void;
  onDeleteReply: (replyId: string, expectedVersion: number) => void;
}

function ReplyRow({
  locale,
  reply,
  currentUser,
  pending,
  editing,
  locked,
  publicVersionId,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDeleteReply,
}: ReplyRowProps) {
  const isAuthor = currentUser !== null && currentUser.id === reply.author.id;
  const live = reply.deletedAt === null;
  const canEdit = live && isAuthor;
  const canDelete = live && (isAuthor || currentUser?.role === "admin");
  const wasEdited = live && reply.updatedAt !== reply.createdAt;
  return (
    <li className="issue-reply">
      <p className="issue-reply__meta">
        <span className="issue-reply__author">{reply.author.username}</span>
        {" · "}
        {formatIssueInstant(reply.createdAt, locale)}
        {wasEdited ? ` · ${ui.edited[locale]}` : ""}
      </p>
      {editing ? (
        <BodyEditor
          locale={locale}
          label={ui.editReplyBody[locale]}
          initial={reply.bodyMarkdown ?? ""}
          attachments={reply.attachments}
          publicVersionId={publicVersionId}
          authorized={canEdit}
          locked={locked}
          pending={pending}
          onSave={onSaveEdit}
          onCancel={onCancelEdit}
        />
      ) : live ? (
        <div className="issue-reply__body">
          <MarkdownBody body={reply.bodyMarkdown ?? ""} attachments={reply.attachments} locale={locale} />
        </div>
      ) : (
        <p className="issue-reply__tombstone">{issueSummary(null, locale)}</p>
      )}
      {!editing && (canEdit || canDelete) ? (
        <div className="issue-reply__actions">
          {canEdit ? (
            <button type="button" className="btn-ghost" onClick={onStartEdit}>
              {ui.editReply[locale]}
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              className="btn-ghost"
              disabled={pending}
              onClick={() => {
                onDeleteReply(reply.id, reply.rowVersion);
              }}
            >
              {ui.deleteReply[locale]}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Kiriko issue detail body: root text, metadata rows, role-gated controls,
 * and the chronological reply thread. Hosted inside the Issues panel.
 */
export function IssueDetail({
  locale,
  issue,
  currentUser,
  reviewers,
  publicVersionId,
  pending,
  mutationFailed,
  idempotencyConflict,
  onBack,
  onRequestSignIn,
  onPatchIssue,
  onDeleteIssue,
  onCreateReply,
  onPatchReply,
  onDeleteReply,
}: IssueDetailProps) {
  const [editing, setEditing] = useState<Editing>(null);
  // The body edit submitted from the open editor. Together with `editFailed`
  // it drives the editor lock: locked from save until the canonical
  // projection carries this exact body at a newer row version (admission), or
  // until this submission fails (unlock, text intact).
  const [submittedEdit, setSubmittedEdit] = useState<SubmittedEdit | null>(null);
  const [editFailed, setEditFailed] = useState(false);
  const editPhaseRef = useRef<"idle" | "submitted" | "inflight">("idle");

  const closeEditor = () => {
    setEditing(null);
    setSubmittedEdit(null);
    setEditFailed(false);
    editPhaseRef.current = "idle";
  };

  const openEditor = (target: Exclude<Editing, null>) => {
    setEditing(target);
    setSubmittedEdit(null);
    setEditFailed(false);
    editPhaseRef.current = "idle";
  };

  const beginSubmit = (edit: SubmittedEdit) => {
    setSubmittedEdit(edit);
    setEditFailed(false);
    editPhaseRef.current = "submitted";
  };

  // Admission: close the editor once the canonical projection carries the
  // submitted body at a newer row version.
  useEffect(() => {
    if (submittedEdit === null || editing === null) {
      return;
    }
    let canonicalBody: string | null;
    let canonicalVersion: number;
    if (editing.kind === "root") {
      canonicalBody = issue.bodyMarkdown;
      canonicalVersion = issue.rowVersion;
    } else {
      const reply = issue.replies.find(({ id }) => id === editing.replyId);
      if (reply === undefined) {
        return;
      }
      canonicalBody = reply.bodyMarkdown;
      canonicalVersion = reply.rowVersion;
    }
    if (canonicalVersion > submittedEdit.expectedVersion && canonicalBody === submittedEdit.bodyMarkdown) {
      closeEditor();
    }
  }, [issue, editing, submittedEdit]);

  // Outcome: this submission's failure unlocks the editor (text intact);
  // success keeps it locked until admission closes it.
  useEffect(() => {
    if (editPhaseRef.current === "submitted" && pending) {
      editPhaseRef.current = "inflight";
      return;
    }
    if (editPhaseRef.current === "inflight" && !pending) {
      editPhaseRef.current = "idle";
      if (mutationFailed) {
        setEditFailed(true);
      }
    }
  }, [pending, mutationFailed]);

  const editorLocked = submittedEdit !== null && !editFailed;

  const live = issue.deletedAt === null;
  const isAuthor = currentUser !== null && currentUser.id === issue.author.id;
  const canModerate =
    currentUser !== null && (currentUser.role === "member" || currentUser.role === "admin");
  const canEditRoot = live && isAuthor;
  const canDeleteRoot = live && (isAuthor || currentUser?.role === "admin");

  const assigneeOptions: ReviewerSummary[] = [];
  {
    const seen = new Set<number>();
    for (const reviewer of reviewers) {
      if (!seen.has(reviewer.id)) {
        seen.add(reviewer.id);
        assigneeOptions.push(reviewer);
      }
    }
    if (currentUser !== null && !seen.has(currentUser.id)) {
      assigneeOptions.push({ id: currentUser.id, username: currentUser.username });
    }
    if (issue.assignee !== null && !seen.has(issue.assignee.id)) {
      assigneeOptions.push(issue.assignee);
    }
  }

  return (
    <div className="issue-detail issue-detail--two-pane">
      <div className="issue-detail__main">
      <button type="button" className="btn-ghost issue-detail__back" onClick={onBack}>
        {ui.back[locale]}
      </button>

      <p className="issue-detail__kind">#{issue.pinNumber}</p>

      {editing?.kind === "root" ? (
        <BodyEditor
          locale={locale}
          label={ui.editIssueBody[locale]}
          initial={issue.bodyMarkdown ?? ""}
          attachments={issue.attachments}
          publicVersionId={publicVersionId}
          authorized={canEditRoot}
          locked={editorLocked}
          pending={pending}
          onSave={(normalized) => {
            beginSubmit({ bodyMarkdown: normalized, expectedVersion: issue.rowVersion });
            onPatchIssue({
              type: "body",
              bodyMarkdown: normalized,
              expectedVersion: issue.rowVersion,
            });
          }}
          onCancel={closeEditor}
        />
      ) : live ? (
        <div className="issue-detail__body">
          <MarkdownBody body={issue.bodyMarkdown ?? ""} attachments={issue.attachments} locale={locale} />
        </div>
      ) : (
        <p className="issue-detail__tombstone">{issueSummary(null, locale)}</p>
      )}

      {editing?.kind !== "root" && (canEditRoot || canDeleteRoot) ? (
        <div className="issue-detail__actions">
          {canEditRoot ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                openEditor({ kind: "root" });
              }}
            >
              {ui.editIssue[locale]}
            </button>
          ) : null}
          {canDeleteRoot ? (
            <button
              type="button"
              className="btn-ghost"
              disabled={pending}
              onClick={() => {
                onDeleteIssue(issue.rowVersion);
              }}
            >
              {ui.deleteIssue[locale]}
            </button>
          ) : null}
        </div>
      ) : null}

      <dl className="issue-detail__meta">
        <div className="issue-detail__row">
          <dt>{ui.author[locale]}</dt>
          <dd>{issue.author.username}</dd>
        </div>
        <div className="issue-detail__row">
          <dt>{ui.created[locale]}</dt>
          <dd>{formatIssueInstant(issue.createdAt, locale)}</dd>
        </div>
        <div className="issue-detail__row">
          <dt>{ui.updated[locale]}</dt>
          <dd>{formatIssueInstant(issue.updatedAt, locale)}</dd>
        </div>
        <div className="issue-detail__row">
          <dt>{ui.status[locale]}</dt>
          <dd>
            {live && canModerate ? (
              <select
                aria-label={ui.status[locale]}
                value={issue.status}
                disabled={pending}
                onChange={(event) => {
                  onPatchIssue({
                    type: "status",
                    status: event.target.value as IssueStatus,
                    expectedVersion: issue.rowVersion,
                  });
                }}
              >
                <option value="open">{issueStatusLabel("open", locale)}</option>
                <option value="in_review">{issueStatusLabel("in_review", locale)}</option>
                <option value="closed">{issueStatusLabel("closed", locale)}</option>
              </select>
            ) : (
              issueStatusLabel(issue.status, locale)
            )}
          </dd>
        </div>
        <div className="issue-detail__row">
          <dt>{ui.assignee[locale]}</dt>
          <dd>
            {live && canModerate ? (
              <select
                aria-label={ui.assignee[locale]}
                value={issue.assignee?.id ?? ""}
                disabled={pending}
                onChange={(event) => {
                  onPatchIssue({
                    type: "assignment",
                    assigneeId: event.target.value === "" ? null : Number(event.target.value),
                    expectedVersion: issue.rowVersion,
                  });
                }}
              >
                <option value="">{ui.unassigned[locale]}</option>
                {assigneeOptions.map((reviewer) => (
                  <option key={reviewer.id} value={reviewer.id}>
                    {reviewer.username}
                  </option>
                ))}
              </select>
            ) : (
              <>
                {issue.assignee?.username ?? ui.unassigned[locale]}
                {live && currentUser !== null && !canModerate && issue.assignee === null ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={pending}
                    onClick={() => {
                      onPatchIssue({
                        type: "assignment",
                        assigneeId: currentUser.id,
                        expectedVersion: issue.rowVersion,
                      });
                    }}
                  >
                    {ui.assignToMe[locale]}
                  </button>
                ) : null}
                {live
                && currentUser !== null
                && !canModerate
                && issue.assignee?.id === currentUser.id ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={pending}
                    onClick={() => {
                      onPatchIssue({
                        type: "assignment",
                        assigneeId: null,
                        expectedVersion: issue.rowVersion,
                      });
                    }}
                  >
                    {ui.unassignMe[locale]}
                  </button>
                ) : null}
              </>
            )}
          </dd>
        </div>
        <div className="issue-detail__row">
          <dt>{ui.dueDate[locale]}</dt>
          <dd>
            {live && canModerate ? (
              <>
                <input
                  type="date"
                  aria-label={ui.dueDate[locale]}
                  value={issue.dueDate ?? ""}
                  disabled={pending}
                  onChange={(event) => {
                    onPatchIssue({
                      type: "due_date",
                      dueDate: event.target.value === "" ? null : event.target.value,
                      expectedVersion: issue.rowVersion,
                    });
                  }}
                />
                {issue.dueDate !== null ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={pending}
                    onClick={() => {
                      onPatchIssue({
                        type: "due_date",
                        dueDate: null,
                        expectedVersion: issue.rowVersion,
                      });
                    }}
                  >
                    {ui.clearDueDate[locale]}
                  </button>
                ) : null}
              </>
            ) : issue.dueDate !== null ? (
              dueDateText(issue.dueDate, locale)
            ) : (
              ui.noDueDate[locale]
            )}
          </dd>
        </div>
        <div className="issue-detail__row">
          <dt>{ui.floor[locale]}</dt>
          <dd className="issue-detail__mono">{issue.anchor.levelId}</dd>
        </div>
        <div className="issue-detail__row">
          <dt>{ui.pin[locale]}</dt>
          <dd className="issue-detail__mono">
            {issue.anchor.longitude}, {issue.anchor.latitude}
          </dd>
        </div>
        {issue.anchor.featureId !== undefined ? (
          <div className="issue-detail__row">
            <dt>{ui.feature[locale]}</dt>
            <dd className="issue-detail__mono">{issue.anchor.featureId}</dd>
          </div>
        ) : null}
      </dl>

      </div>
      <div className="issue-detail__thread-pane">
      <section className="issue-detail__thread" aria-label={ui.replies[locale]}>
        <h3 className="panel-caption">
          {ui.replies[locale]} ({issue.replies.length})
        </h3>
        {issue.replies.length > 0 ? (
          <ul className="issue-detail__replies">
            {issue.replies.map((reply) => (
              <ReplyRow
                key={reply.id}
                locale={locale}
                reply={reply}
                currentUser={currentUser}
                pending={pending}
                editing={editing?.kind === "reply" && editing.replyId === reply.id}
                locked={editorLocked}
                publicVersionId={publicVersionId}
                onStartEdit={() => {
                  openEditor({ kind: "reply", replyId: reply.id });
                }}
                onCancelEdit={closeEditor}
                onSaveEdit={(normalized) => {
                  beginSubmit({ bodyMarkdown: normalized, expectedVersion: reply.rowVersion });
                  onPatchReply(reply.id, {
                    type: "body",
                    bodyMarkdown: normalized,
                    expectedVersion: reply.rowVersion,
                  });
                }}
                onDeleteReply={onDeleteReply}
              />
            ))}
          </ul>
        ) : null}
        {live ? (
          <ReplyComposer
            locale={locale}
            signedIn={currentUser !== null}
            pending={pending}
            mutationFailed={mutationFailed}
            idempotencyConflict={idempotencyConflict}
            publicVersionId={publicVersionId}
            focusOnReturn={editing === null}
            onSubmit={onCreateReply}
            onRequestSignIn={onRequestSignIn}
          />
        ) : null}
      </section>
      </div>
    </div>
  );
}
