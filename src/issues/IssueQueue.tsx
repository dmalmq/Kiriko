import type { LocaleCode } from "../imdf/types";
import { classifyDueDate, formatDueDate, localToday, parseDueDate } from "./issueDates";
import { normalizeIssueMarkdown } from "./MarkdownBody";
import type { IssueFilter, IssueStatus, ReviewIssue } from "./types";

/**
 * Issue queue: filter chips over the canonical collection and one row per
 * root issue. Filtering never mutates or reorders the canonical list — the
 * server's pin-number ordering is preserved.
 */

const SUMMARY_MAX_SCALARS = 80;

const FILTERS: readonly IssueFilter[] = ["active", "assigned_to_me", "unassigned", "closed"];

const ui = {
  filterGroup: { ja: "絞り込み", en: "Filter" },
  listLabel: { ja: "課題", en: "Issues" },
  filters: {
    active: { ja: "進行中", en: "Active" },
    assigned_to_me: { ja: "自分に割り当て", en: "Assigned to me" },
    unassigned: { ja: "未割り当て", en: "Unassigned" },
    closed: { ja: "クローズ", en: "Closed" },
  },
  empty: {
    active: { ja: "進行中の課題はありません", en: "No active issues" },
    assigned_to_me: { ja: "あなたに割り当てられた課題はありません", en: "Nothing is assigned to you" },
    unassigned: { ja: "未割り当ての課題はありません", en: "No unassigned issues" },
    closed: { ja: "クローズした課題はありません", en: "No closed issues" },
  },
  status: {
    open: { ja: "オープン", en: "Open" },
    in_review: { ja: "レビュー中", en: "In review" },
    closed: { ja: "クローズ", en: "Closed" },
  },
  commentDeleted: { ja: "コメントは削除されました", en: "Comment deleted" },
  imageAttachment: { ja: "画像添付", en: "Image attachment" },
  duePrefix: { ja: "期限 ", en: "Due " },
  overdue: { ja: "期限切れ", en: "Overdue" },
  dueSoon: { ja: "期限が近い", en: "Due soon" },
  floor: { ja: "フロア", en: "Floor" },
  feature: { ja: "地物", en: "Feature" },
} as const;

/** Localized status text; shared by the queue, detail view, and map pins. */
export function issueStatusLabel(status: IssueStatus, locale: LocaleCode): string {
  return ui.status[status][locale];
}

/** Active means a live root that is open or in review, on any floor. */
export function countActiveIssues(issues: ReviewIssue[]): number {
  let count = 0;
  for (const issue of issues) {
    if (issue.deletedAt === null && issue.status !== "closed") {
      count += 1;
    }
  }
  return count;
}

/** Projects the canonical list for one filter without mutating it. */
export function filterIssues(
  issues: ReviewIssue[],
  filter: IssueFilter,
  currentUserId: number | null,
): ReviewIssue[] {
  switch (filter) {
    case "active":
      return issues.filter((issue) => issue.deletedAt === null && issue.status !== "closed");
    case "assigned_to_me":
      return issues.filter(
        (issue) =>
          issue.deletedAt === null
          && issue.status !== "closed"
          && currentUserId !== null
          && issue.assignee?.id === currentUserId,
      );
    case "unassigned":
      return issues.filter(
        (issue) =>
          issue.deletedAt === null && issue.status !== "closed" && issue.assignee === null,
      );
    case "closed":
      return issues.filter((issue) => issue.status === "closed" || issue.deletedAt !== null);
  }
}

/**
 * Deterministic row summary: the first non-empty line of the normalized
 * Markdown source with whitespace collapsed, cut to the first 80 Unicode
 * scalar values with `…` appended iff the line is longer. Deleted roots use
 * the localized tombstone.
 */
export function issueSummary(bodyMarkdown: string | null, locale: LocaleCode): string {
  if (bodyMarkdown === null) {
    return ui.commentDeleted[locale];
  }
  const normalized = normalizeIssueMarkdown(bodyMarkdown);
  // Image syntax never contributes summary text; an image-only body falls
  // back to the localized placeholder instead of exposing token syntax.
  const hadAttachment = /!\[[^\]]*\]\(attachment:[0-9a-f-]{36}\)/.test(normalized);
  const stripped = normalized.replace(/!\[[^\]]*\]\([^)\n]*\)/g, "");
  let firstLine = "";
  for (const line of stripped.split("\n")) {
    if (line.trim() !== "") {
      firstLine = line;
      break;
    }
  }
  const collapsed = firstLine.trim().replace(/\s+/g, " ");
  if (collapsed === "") {
    return hadAttachment ? ui.imageAttachment[locale] : "";
  }
  const scalars = [...collapsed];
  if (scalars.length <= SUMMARY_MAX_SCALARS) {
    return collapsed;
  }
  return `${scalars.slice(0, SUMMARY_MAX_SCALARS).join("")}…`;
}

/**
 * Localized due-date display with a textual overdue/due-soon marker — color
 * is never the only signal. Shared by the queue rows and the detail view.
 */
export function dueDateText(dueDate: string, locale: LocaleCode): string {
  const formatted = formatDueDate(dueDate, locale);
  const parsed = parseDueDate(dueDate);
  const classified = parsed === null ? "none" : classifyDueDate(parsed, localToday(new Date()));
  if (classified === "overdue") {
    return `${formatted} (${ui.overdue[locale]})`;
  }
  if (classified === "due_soon") {
    return `${formatted} (${ui.dueSoon[locale]})`;
  }
  return formatted;
}

function replyCountText(count: number, locale: LocaleCode): string {
  if (locale === "ja") {
    return `返信 ${count} 件`;
  }
  return count === 1 ? "1 reply" : `${count} replies`;
}

export interface IssueQueueProps {
  locale: LocaleCode;
  issues: ReviewIssue[];
  filter: IssueFilter;
  currentUserId: number | null;
  selectedIssueId: string | null;
  onSelectFilter: (filter: IssueFilter) => void;
  onSelectIssue: (issueId: string) => void;
}

/**
 * Kiriko Issues queue body: filter chips and issue rows. Hosted inside the
 * Issues panel.
 */
export function IssueQueue({
  locale,
  issues,
  filter,
  currentUserId,
  selectedIssueId,
  onSelectFilter,
  onSelectIssue,
}: IssueQueueProps) {
  const visible = filterIssues(issues, filter, currentUserId);
  return (
    <div className="issue-queue">
      <div className="chip-row" role="group" aria-label={ui.filterGroup[locale]}>
        {FILTERS.map((id) => {
          const selected = id === filter;
          return (
            <button
              key={id}
              type="button"
              className={selected ? "chip chip--selected" : "chip"}
              aria-pressed={selected}
              onClick={() => {
                onSelectFilter(id);
              }}
            >
              {ui.filters[id][locale]}
            </button>
          );
        })}
      </div>
      {visible.length === 0 ? (
        <p className="issue-queue__empty">{ui.empty[filter][locale]}</p>
      ) : (
        <ul className="list-rows" role="listbox" aria-label={ui.listLabel[locale]}>
          {visible.map((issue) => {
            const selected = issue.id === selectedIssueId;
            const meta: string[] = [ui.status[issue.status][locale]];
            if (issue.assignee !== null) {
              meta.push(issue.assignee.username);
            }
            if (issue.replies.length > 0) {
              meta.push(replyCountText(issue.replies.length, locale));
            }
            if (issue.dueDate !== null) {
              meta.push(`${ui.duePrefix[locale]}${dueDateText(issue.dueDate, locale)}`);
            }
            return (
              <li key={issue.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={selected ? "list-row list-row--selected" : "list-row"}
                  onClick={() => {
                    onSelectIssue(issue.id);
                  }}
                >
                  <span className="list-row__title">
                    <span className="issue-queue__pin">#{issue.pinNumber}</span>{" "}
                    {issueSummary(issue.bodyMarkdown, locale)}
                  </span>
                  <span className="list-row__meta">{meta.join(" · ")}</span>
                  <span className="list-row__meta issue-queue__anchor">
                    {ui.floor[locale]}{" "}
                    <span className="issue-queue__mono">{issue.anchor.levelId}</span>
                    {issue.anchor.featureId !== undefined ? (
                      <>
                        {" · "}
                        {ui.feature[locale]}{" "}
                        <span className="issue-queue__mono">{issue.anchor.featureId}</span>
                      </>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
