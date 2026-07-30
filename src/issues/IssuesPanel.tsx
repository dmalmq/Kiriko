import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { LocaleCode } from "../imdf/types";
import { IssueComposer } from "./IssueComposer";
import { IssueDetail } from "./IssueDetail";
import { countActiveIssues, IssueQueue } from "./IssueQueue";
import type { ReviewerSummary } from "./types";
import type { IssueActor, IssueController } from "./useIssueSync";

/**
 * Issues panel body: queue, detail, and composer views over the Task 9
 * controller. All canonical state and drafts live in the controller; this
 * component only projects state and routes interactions through
 * `controller.commands` / `controller.ui`. Hosted inside a FloatingPanel.
 */

const ui = {
  unavailable: {
    ja: "このデータセットでは課題を利用できません",
    en: "Issues aren't available for this dataset.",
  },
  loading: { ja: "課題を読み込み中…", en: "Loading issues…" },
  loadFailed: { ja: "課題を読み込めませんでした", en: "Issues couldn't be loaded." },
  retry: { ja: "再試行", en: "Retry" },
  reconnecting: { ja: "接続が切れました。再接続中…", en: "Connection lost. Reconnecting…" },
  staleData: { ja: "更新が遅れている可能性があります", en: "Updates may be delayed." },
  authError: {
    ja: "アカウントを確認できませんでした",
    en: "We couldn't verify your account.",
  },
  sessionExpired: {
    ja: "セッションの有効期限が切れました。続行するにはサインインしてください。",
    en: "Your session expired. Sign in to continue.",
  },
  signIn: { ja: "サインイン", en: "Sign in" },
  conflict: {
    ja: "この課題は他の場所で更新されました。入力内容は保持されています。確認してからもう一度お試しください。",
    en: "This issue changed while you were working. Your input is safe — review it and try again.",
  },
  idempotencyConflict: {
    ja: "このリクエストは別の内容で送信済みです。入力内容は保持されています。キャンセルして新しく作成し直してください。",
    en: "This request was already submitted with different content. Your input is kept — cancel and start again to post it.",
  },
  deletedTerminal: {
    ja: "この課題は完全に削除されました。",
    en: "This issue was permanently deleted.",
  },
  forbidden: {
    ja: "この操作を行う権限がありません。",
    en: "You don't have permission to do that.",
  },
  mutationFailed: {
    ja: "変更を保存できませんでした。入力内容は保持されています。もう一度お試しください。",
    en: "The change couldn't be saved. Your input is safe — try again.",
  },
  selectedDeleted: { ja: "この課題は削除されました", en: "This issue was deleted." },
  featureRemoved: {
    ja: "その地物はこのバージョンに存在しません。ピンの位置は保持されます。内容を確認して再投稿してください。",
    en: "That feature is no longer in this version. The pin keeps its location — review and post again.",
  },
  dismiss: { ja: "閉じる", en: "Dismiss" },
  newIssue: { ja: "新しい課題", en: "New issue" },
  signInToCreate: { ja: "課題を作成するにはサインイン", en: "Sign in to create issues" },
  placementHint: { ja: "地図をクリックしてピンを配置", en: "Click the map to place the pin" },
  cancelPlacement: { ja: "配置をキャンセル", en: "Cancel placement" },
} as const;

export interface IssuesPanelProps {
  locale: LocaleCode;
  controller: IssueController;
  currentUser: IssueActor | null;
  reviewers: ReviewerSummary[];
  /** The loaded bundle carried no valid review identity; issues are off. */
  identityError: boolean;
  /** The auth/reviewer lookup failed; public reading continues. */
  authError: boolean;
  onRetryAuth: () => void;
  onRequestSignIn: () => void;
  onBeginPlacement: () => void;
  onCancelPlacement: () => void;
}

export function IssuesPanel({
  locale,
  controller,
  currentUser,
  reviewers,
  identityError,
  authError,
  onRetryAuth,
  onRequestSignIn,
  onBeginPlacement,
  onCancelPlacement,
}: IssuesPanelProps) {
  const state = controller.state;

  // Focus returns to the initiating control when the draft goes away
  // (cancel or admission); the composer handles its own entry focus.
  const newIssueRef = useRef<HTMLButtonElement>(null);
  const hadDraftRef = useRef(state.draft !== null);
  useEffect(() => {
    if (hadDraftRef.current && state.draft === null) {
      newIssueRef.current?.focus();
    }
    hadDraftRef.current = state.draft !== null;
  }, [state.draft]);

  // An expired session opens sign-in automatically, once per authRequired
  // episode; the inline button stays as the explicit path.
  const authPromptedRef = useRef(false);
  useEffect(() => {
    if (!state.authRequired) {
      authPromptedRef.current = false;
      return;
    }
    if (!authPromptedRef.current) {
      authPromptedRef.current = true;
      onRequestSignIn();
    }
  }, [state.authRequired, onRequestSignIn]);

  if (identityError) {
    return (
      <div className="issues-panel">
        <p className="issues-panel__empty">{ui.unavailable[locale]}</p>
      </div>
    );
  }

  const issues = state.collection?.issues ?? [];
  const selected =
    state.selectedIssueId === null
      ? undefined
      : issues.find((issue) => issue.id === state.selectedIssueId);
  const collectionFailed = state.errorScope === "collection" && state.error !== null;
  const mutationFailed = state.errorScope === "mutation" && state.error !== null;
  const pending = state.pendingMutations > 0;
  const composerPending = pending || state.draftAdmissionResourceId !== null;
  const forbidden =
    state.error !== null && state.error.kind === "api" && state.error.error === "forbidden";
  // A loaded collection is stuck stale when a GET failed (directly, or after a
  // 409/403 whose error masks the collection error) and cleared refetch demand
  // while no SSE reconnection is recovering it. Only a manual Retry can refresh
  // it, so surface one whenever it is stale with nothing in flight to recover.
  const needsCollectionRetry =
    state.collection !== null
    && state.stale
    && !state.reconnecting
    && !state.refetchInFlight
    && !state.refetchRequested;

  const showingDetail = state.draft === null && selected !== undefined;
  let body: ReactNode;
  if (state.draft !== null) {
    body = (
      <IssueComposer
        locale={locale}
        draft={state.draft}
        currentUser={currentUser}
        reviewers={reviewers}
        publicVersionId={state.publicVersionId}
        pending={composerPending}
        onUpdateDraft={controller.ui.updateDraft}
        onSubmit={(input) => {
          void controller.commands.createIssue(input);
        }}
        onCancel={controller.ui.cancelDraft}
        onRequestSignIn={onRequestSignIn}
      />
    );
  } else if (selected !== undefined) {
    body = (
      <IssueDetail
        key={selected.id}
        locale={locale}
        issue={selected}
        currentUser={currentUser}
        reviewers={reviewers}
        publicVersionId={state.publicVersionId}
        pending={pending}
        mutationFailed={mutationFailed || state.conflict !== null || state.authRequired}
        idempotencyConflict={state.conflict?.error === "idempotency_conflict"}
        onBack={() => {
          controller.ui.selectIssue(null);
        }}
        onRequestSignIn={onRequestSignIn}
        onPatchIssue={(patch) => {
          void controller.commands.patchIssue(selected.id, patch);
        }}
        onDeleteIssue={(expectedVersion) => {
          void controller.commands.deleteIssue(selected.id, expectedVersion);
        }}
        onCreateReply={(input) => {
          void controller.commands.createReply(selected.id, input);
        }}
        onPatchReply={(replyId, patch) => {
          void controller.commands.patchReply(replyId, patch);
        }}
        onDeleteReply={(replyId, expectedVersion) => {
          void controller.commands.deleteReply(replyId, expectedVersion);
        }}
      />
    );
  } else if (state.collection === null) {
    body = collectionFailed ? (
      <div className="issues-panel__failed">
        <p className="issues-panel__empty">{ui.loadFailed[locale]}</p>
        <button type="button" className="btn-ghost" onClick={controller.retryCollection}>
          {ui.retry[locale]}
        </button>
      </div>
    ) : (
      <p className="issues-panel__empty">{ui.loading[locale]}</p>
    );
  } else {
    body = (
      <>
        <p className="issues-panel__count panel-caption">
          {locale === "ja"
            ? `${countActiveIssues(issues)} 件の進行中`
            : `${countActiveIssues(issues)} active`}
        </p>
        <IssueQueue
          locale={locale}
          issues={issues}
          filter={state.filter}
          currentUserId={currentUser?.id ?? null}
          selectedIssueId={state.selectedIssueId}
          onSelectFilter={controller.ui.setFilter}
          onSelectIssue={controller.ui.selectIssue}
        />
      </>
    );
  }

  let footer: ReactNode = null;
  if (state.draft === null) {
    if (state.placementActive) {
      footer = (
        <div className="issues-panel__footer">
          <p className="issues-panel__hint" role="status">
            {ui.placementHint[locale]}
          </p>
          <button type="button" className="btn-ghost" onClick={onCancelPlacement}>
            {ui.cancelPlacement[locale]}
          </button>
        </div>
      );
    } else if (selected === undefined) {
      // Detail keeps a single primary action (Reply); Back leads to the
      // queue where New issue lives.
      footer = currentUser !== null ? (
        <div className="issues-panel__footer">
          <button
            type="button"
            ref={newIssueRef}
            className="btn-primary"
            onClick={onBeginPlacement}
          >
            {ui.newIssue[locale]}
          </button>
        </div>
      ) : (
        <div className="issues-panel__footer">
          <button type="button" className="btn-primary" onClick={onRequestSignIn}>
            {ui.signInToCreate[locale]}
          </button>
        </div>
      );
    }
  }

  return (
    <div className={showingDetail ? "issues-panel issues-panel--detail" : "issues-panel"}>
      {state.reconnecting ? (
        <p className="issues-panel__line" role="status">
          {ui.reconnecting[locale]}
        </p>
      ) : state.stale && !needsCollectionRetry ? (
        <p className="issues-panel__line" role="status">
          {ui.staleData[locale]}
        </p>
      ) : null}

      {needsCollectionRetry ? (
        <p className="issues-panel__line" role="alert">
          {ui.loadFailed[locale]}{" "}
          <button type="button" className="btn-ghost" onClick={controller.retryCollection}>
            {ui.retry[locale]}
          </button>
        </p>
      ) : null}

      {authError ? (
        <p className="issues-panel__line" role="alert">
          {ui.authError[locale]}{" "}
          <button type="button" className="btn-ghost" onClick={onRetryAuth}>
            {ui.retry[locale]}
          </button>
        </p>
      ) : null}

      {state.authRequired ? (
        <p className="issues-panel__line" role="alert">
          {ui.sessionExpired[locale]}{" "}
          <button type="button" className="btn-ghost" onClick={onRequestSignIn}>
            {ui.signIn[locale]}
          </button>
        </p>
      ) : null}

      {state.conflict !== null ? (
        <p className="issues-panel__line" role="alert">
          {state.conflict.error === "issue_deleted"
            ? ui.deletedTerminal[locale]
            : state.conflict.error === "idempotency_conflict"
              ? ui.idempotencyConflict[locale]
              : ui.conflict[locale]}
        </p>
      ) : mutationFailed && !state.authRequired ? (
        <p className="issues-panel__line" role="alert">
          {forbidden ? ui.forbidden[locale] : ui.mutationFailed[locale]}
        </p>
      ) : null}

      {state.notice === "selected_issue_deleted" ? (
        <p className="issues-panel__line" role="status">
          {ui.selectedDeleted[locale]}{" "}
          <button type="button" className="btn-ghost" onClick={controller.resetNotice}>
            {ui.dismiss[locale]}
          </button>
        </p>
      ) : null}

      {state.notice === "feature_attachment_removed" && state.draft !== null ? (
        <p className="issues-panel__line" role="status">
          {ui.featureRemoved[locale]}{" "}
          <button type="button" className="btn-ghost" onClick={controller.resetNotice}>
            {ui.dismiss[locale]}
          </button>
        </p>
      ) : null}

      {body}
      {footer}
    </div>
  );
}
