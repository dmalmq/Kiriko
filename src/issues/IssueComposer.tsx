import { useEffect, useRef, useState } from "react";
import type { LocaleCode } from "../imdf/types";
import { IssueMarkdownEditor, attachmentIdsForSubmit } from "./IssueMarkdownEditor";
import {
  checkIssueBody,
  normalizeIssueMarkdown,
} from "./MarkdownBody";
import type {
  CreateIssueInput,
  IssueDraft,
  IssueDraftPatch,
  ReviewerSummary,
} from "./types";
import type { IssueActor } from "./useIssueSync";

/**
 * New-issue composer over the controller-owned draft. It mounts after a
 * successful placement started the draft, routes every field change through
 * `updateDraft`, and never generates or replaces the controller-owned
 * request ID. Assignment and due date never block creation.
 */

const ui = {
  heading: { ja: "新しい課題", en: "New issue" },
  bodyLabel: { ja: "課題の本文", en: "Issue body" },
  bodyPlaceholder: { ja: "課題の内容を入力…", en: "Describe the issue…" },
  assignee: { ja: "担当者", en: "Assignee" },
  dueDate: { ja: "期限", en: "Due date" },
  optional: { ja: "（任意）", en: "(optional)" },
  unassigned: { ja: "未割り当て", en: "Unassigned" },
  floor: { ja: "フロア", en: "Floor" },
  pin: { ja: "ピン", en: "Pin" },
  feature: { ja: "地物", en: "Feature" },
  removeFeature: { ja: "地物を解除", en: "Remove feature" },
  cancel: { ja: "キャンセル", en: "Cancel" },
  post: { ja: "課題を投稿", en: "Post issue" },
  signInToPost: { ja: "投稿するにはサインイン", en: "Sign in to post" },
} as const;

export interface IssueComposerProps {
  locale: LocaleCode;
  draft: IssueDraft;
  currentUser: IssueActor | null;
  reviewers: ReviewerSummary[];
  /** Published version identity for staged attachment uploads. */
  publicVersionId: string | null;
  /** True while any mutation is in flight; posting disables. */
  pending: boolean;
  onUpdateDraft: (patch: IssueDraftPatch) => void;
  onSubmit: (input: CreateIssueInput) => void;
  onCancel: () => void;
  onRequestSignIn: () => void;
}

/**
 * Kiriko issue composer body: Markdown textarea with a formatting hint,
 * scalar character count, accessible limit error, optional assignee/due
 * metadata, and the captured anchor context. Hosted inside the Issues panel.
 */
export function IssueComposer({
  locale,
  draft,
  currentUser,
  reviewers,
  publicVersionId,
  pending,
  onUpdateDraft,
  onSubmit,
  onCancel,
  onRequestSignIn,
}: IssueComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [uploadsBlocked, setUploadsBlocked] = useState(false);
  useEffect(() => {
    // Placement just completed — move focus into the composer.
    textareaRef.current?.focus();
  }, []);

  // A draft can outlive a sign-in flow; when the account becomes known
  // again, return focus to the retained text.
  const wasSignedOutRef = useRef(currentUser === null);
  useEffect(() => {
    if (wasSignedOutRef.current && currentUser !== null) {
      textareaRef.current?.focus();
    }
    wasSignedOutRef.current = currentUser === null;
  }, [currentUser]);

  // A known viewer cannot set a due date or assign another account. Strip
  // now-forbidden metadata through the controller so the submitted payload
  // matches the visible form, preserving body, anchor, request ID, and any
  // allowed self-assignment. An unknown (signed-out) account changes nothing.
  useEffect(() => {
    if (currentUser === null || currentUser.role !== "viewer") {
      return;
    }
    const patch: IssueDraftPatch = {
      ...(draft.dueDate !== null ? { dueDate: null } : {}),
      ...(draft.assigneeId !== null && draft.assigneeId !== currentUser.id
        ? { assigneeId: null }
        : {}),
    };
    if (Object.keys(patch).length > 0) {
      onUpdateDraft(patch);
    }
  }, [currentUser, draft.assigneeId, draft.dueDate, onUpdateDraft]);

  const normalized = normalizeIssueMarkdown(draft.bodyMarkdown);
  const check = checkIssueBody(normalized);
  const signedIn = currentUser !== null;
  const canSetDueDate = currentUser !== null && currentUser.role !== "viewer";

  // A viewer may only leave the issue unassigned or assign themselves;
  // members and admins may pick any existing account.
  const assigneeOptions: ReviewerSummary[] = [];
  if (currentUser !== null) {
    if (currentUser.role === "viewer") {
      assigneeOptions.push({ id: currentUser.id, username: currentUser.username });
    } else {
      const seen = new Set<number>();
      for (const reviewer of reviewers) {
        if (!seen.has(reviewer.id)) {
          seen.add(reviewer.id);
          assigneeOptions.push(reviewer);
        }
      }
      if (!seen.has(currentUser.id)) {
        assigneeOptions.push({ id: currentUser.id, username: currentUser.username });
      }
    }
  }

  return (
    <div className="issue-composer">
      <h3 className="panel-caption">{ui.heading[locale]}</h3>

      <IssueMarkdownEditor
        locale={locale}
        value={draft.bodyMarkdown}
        onChange={(bodyMarkdown) => {
          onUpdateDraft({ bodyMarkdown });
        }}
        disabled={pending}
        ariaLabel={ui.bodyLabel[locale]}
        placeholder={ui.bodyPlaceholder[locale]}
        rows={5}
        textareaClassName="issue-composer__input"
        publicVersionId={publicVersionId}
        onSubmitBlockedChange={setUploadsBlocked}
        textareaRef={textareaRef}
      />

      {signedIn ? (
        <label className="issue-composer__field">
          <span>
            {ui.assignee[locale]} {ui.optional[locale]}
          </span>
          <select
            aria-label={ui.assignee[locale]}
            value={draft.assigneeId ?? ""}
            disabled={pending}
            onChange={(event) => {
              onUpdateDraft({
                assigneeId: event.target.value === "" ? null : Number(event.target.value),
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
        </label>
      ) : null}

      {canSetDueDate ? (
        <label className="issue-composer__field">
          <span>
            {ui.dueDate[locale]} {ui.optional[locale]}
          </span>
          <input
            type="date"
            aria-label={ui.dueDate[locale]}
            value={draft.dueDate ?? ""}
            disabled={pending}
            onChange={(event) => {
              onUpdateDraft({ dueDate: event.target.value === "" ? null : event.target.value });
            }}
          />
        </label>
      ) : null}

      <p className="issue-composer__anchor">
        {ui.floor[locale]}{" "}
        <span className="issue-composer__mono">{draft.anchor.levelId}</span>
      </p>
      <p className="issue-composer__anchor">
        {ui.pin[locale]}{" "}
        <span className="issue-composer__mono">
          {draft.anchor.longitude}, {draft.anchor.latitude}
        </span>
      </p>
      {draft.anchor.featureId !== undefined ? (
        <p className="issue-composer__anchor">
          {ui.feature[locale]}{" "}
          <span className="issue-composer__mono">{draft.anchor.featureId}</span>{" "}
          <button
            type="button"
            className="btn-ghost"
            disabled={pending}
            onClick={() => {
              const { featureId: _featureId, ...anchor } = draft.anchor;
              onUpdateDraft({ anchor });
            }}
          >
            {ui.removeFeature[locale]}
          </button>
        </p>
      ) : null}

      <div className="issue-composer__footer">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          {ui.cancel[locale]}
        </button>
        {signedIn ? (
          <button
            type="button"
            className="btn-primary"
            disabled={pending || check.problem !== null || uploadsBlocked}
            onClick={() => {
              onSubmit({
                requestId: draft.requestId,
                bodyMarkdown: normalized,
                attachmentIds: attachmentIdsForSubmit(normalized),
                anchor: {
                  levelId: draft.anchor.levelId,
                  longitude: draft.anchor.longitude,
                  latitude: draft.anchor.latitude,
                  featureId: draft.anchor.featureId ?? null,
                },
                assigneeId: draft.assigneeId,
                dueDate: draft.dueDate,
              });
            }}
          >
            {ui.post[locale]}
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={onRequestSignIn}>
            {ui.signInToPost[locale]}
          </button>
        )}
      </div>
    </div>
  );
}
