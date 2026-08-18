import type { ReactElement, ReactNode } from "react";
import type { LocaleCode } from "../imdf/types";
import type {
  NetworkChangeSummary,
  NetworkEditTool,
  NetworkPreviewStatus,
  PathCandidateKind,
  PathPreview,
} from "../map/networkEditor";
import type { NetworkMutationError } from "../map/networkFeatures";
import { IconConnect, IconCursor, IconPointPlus, IconRedo, IconTrash, IconUndo } from "./icons";

type ToolId = Exclude<NetworkEditTool, "move-junction">;

export interface NetworkEditorToolbarProps {
  locale: LocaleCode;
  tool: NetworkEditTool;
  summary: NetworkChangeSummary;
  /** Localized label of the floor new points land on. */
  activeFloorLabel: string;
  notice: NetworkMutationError | null;
  preview: PathPreview | null;
  previewStatus: NetworkPreviewStatus;
  saveProblem: "missing_junction" | "missing_connection" | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Save in flight or accepted: disables every control except Check status. */
  locked: boolean;
  canSave: boolean;
  /** The primary button retries an accepted job rather than starting a save. */
  checkStatus: boolean;
  saveMessage: string | null;
  saveError: string | null;
  /** Discard confirmation is armed (dirty first click). */
  discardArmed: boolean;
  onSetTool: (tool: ToolId) => void;
  onUndo: () => void;
  onRedo: () => void;
  onRequestDiscard: () => void;
  onCancelDiscard: () => void;
  onConfirmDiscard: () => void;
  onConfirmPreview: () => void;
  onSelectCandidate: (index: number) => void;
  onSelectCurrentRoute: () => void;
  onSave: () => void;
}

const ui = {
  toolbarLabel: { ja: "ネットワーク編集", en: "Network editing" },
  select: { ja: "選択", en: "Select" },
  addPoint: { ja: "点を追加", en: "Add point" },
  connect: { ja: "接続", en: "Connect" },
  delete: { ja: "削除", en: "Delete" },
  undo: { ja: "元に戻す", en: "Undo" },
  redo: { ja: "やり直す", en: "Redo" },
  discard: { ja: "変更を破棄", en: "Discard changes" },
  keepEditing: { ja: "編集を続ける", en: "Keep editing" },
  save: { ja: "新しいバージョンとして保存", en: "Save as new version" },
  checkStatus: { ja: "状況を確認", en: "Check status" },
  noChanges: { ja: "変更はありません", en: "No changes yet" },
  crossFloor: {
    ja: "このエディターではフロア間の接続を追加できません。",
    en: "Connections between floors are not supported in this editor.",
  },
  duplicate: {
    ja: "これらの点はすでに接続されています。",
    en: "Those points are already connected.",
  },
  rejected: { ja: "この変更を適用できませんでした。", en: "That edit could not be applied." },
  emptyGraph: {
    ja: "保存する前に、点と接続を1つ以上追加してください。",
    en: "Add at least one point and one connection before saving.",
  },
  instructSelect: { ja: "点または接続を選択してください。", en: "Select a point or connection." },
  instructConnect: { ja: "同じフロアの点を2つ選択してください。", en: "Select two points on the same floor." },
  instructPreview: {
    ja: "経路を選ぶか、Escapeで取り消します。",
    en: "Choose a route, or press Escape to cancel.",
  },
  instructDelete: { ja: "削除する点または接続を選択してください。", en: "Select a point or connection to remove it." },
  instructMove: { ja: "点の新しい位置をクリックしてください。", en: "Click the point’s new position." },
  addPath: { ja: "この経路を追加", en: "Add this path" },
  currentRoute: { ja: "現在の経路", en: "Current route" },
  alongNetwork: { ja: "ネットワークに沿う", en: "Along the network" },
  shorterPath: { ja: "より短い経路", en: "Shorter path" },
  selectRoute: { ja: "この経路を選択", en: "Select this route" },
  disconnected: {
    ja: "これらの点はつながっていません。",
    en: "These points are not connected.",
  },
  noWalkable: {
    ja: "これらの点の間に歩ける経路がありません。",
    en: "No walkable path between these points.",
  },
  proposeFailed: {
    ja: "経路を計算できませんでした。",
    en: "Could not calculate a path.",
  },
} as const;

const TOOL_SHORTCUT: Record<ToolId, string> = {
  select: "s",
  "add-junction": "p",
  connect: "c",
  delete: "d",
};

function noticeText(error: NetworkMutationError, locale: LocaleCode): string {
  if (error === "cross_floor_connection") return ui.crossFloor[locale];
  if (error === "existing_connection") return ui.duplicate[locale];
  return ui.rejected[locale];
}

function instructionText(
  tool: NetworkEditTool,
  activeFloorLabel: string,
  locale: LocaleCode,
  preview: PathPreview | null,
): string {
  if (preview !== null) {
    return ui.instructPreview[locale];
  }
  switch (tool) {
    case "add-junction":
      return locale === "ja"
        ? `地図をクリックして ${activeFloorLabel} に点を追加します。`
        : `Click the map to add a point on ${activeFloorLabel}.`;
    case "connect":
      return ui.instructConnect[locale];
    case "delete":
      return ui.instructDelete[locale];
    case "move-junction":
      return ui.instructMove[locale];
    case "select":
      return ui.instructSelect[locale];
  }
}

function candidateLabel(kind: PathCandidateKind, locale: LocaleCode): string {
  if (kind === "current") return ui.currentRoute[locale];
  if (kind === "along_network") return ui.alongNetwork[locale];
  return ui.shorterPath[locale];
}

function previewStatusText(status: NetworkPreviewStatus, locale: LocaleCode): string | null {
  if (status === "disconnected") return ui.disconnected[locale];
  if (status === "no_walkable") return ui.noWalkable[locale];
  if (status === "propose_failed") return ui.proposeFailed[locale];
  return null;
}

function changeSummaryText(summary: NetworkChangeSummary, locale: LocaleCode): string {
  const parts: string[] = [];
  const label = (
    n: number,
    ja: (count: number) => string,
    en: (count: number) => string,
  ): void => {
    if (n > 0) parts.push(locale === "ja" ? ja(n) : en(n));
  };
  label(summary.addedJunctions, (n) => `点を${n}件追加`, (n) => `${n} point${n === 1 ? "" : "s"} added`);
  label(summary.movedJunctions, (n) => `点を${n}件移動`, (n) => `${n} point${n === 1 ? "" : "s"} moved`);
  label(summary.deletedJunctions, (n) => `点を${n}件削除`, (n) => `${n} point${n === 1 ? "" : "s"} deleted`);
  label(
    summary.addedConnections,
    (n) => `接続を${n}件追加`,
    (n) => `${n} connection${n === 1 ? "" : "s"} added`,
  );
  label(
    summary.deletedConnections,
    (n) => `接続を${n}件削除`,
    (n) => `${n} connection${n === 1 ? "" : "s"} deleted`,
  );
  return parts.length === 0 ? ui.noChanges[locale] : parts.join(" · ");
}

/**
 * Floating control bar for the network geometry editor: four explicit tools,
 * undo/redo, a live instruction + change summary, an inline discard
 * confirmation, and the primary save. Rendered only while an editor session is
 * active; App owns all state and passes derived flags.
 */
export function NetworkEditorToolbar({
  locale,
  tool,
  summary,
  activeFloorLabel,
  notice,
  preview,
  previewStatus,
  saveProblem,
  canUndo,
  canRedo,
  locked,
  canSave,
  checkStatus,
  saveMessage,
  saveError,
  discardArmed,
  onSetTool,
  onUndo,
  onRedo,
  onRequestDiscard,
  onCancelDiscard,
  onConfirmDiscard,
  onConfirmPreview,
  onSelectCandidate,
  onSelectCurrentRoute,
  onSave,
}: NetworkEditorToolbarProps): ReactElement {
  const tools: { id: ToolId; label: string; icon: ReactNode }[] = [
    { id: "select", label: ui.select[locale], icon: <IconCursor /> },
    { id: "add-junction", label: ui.addPoint[locale], icon: <IconPointPlus /> },
    { id: "connect", label: ui.connect[locale], icon: <IconConnect /> },
    { id: "delete", label: ui.delete[locale], icon: <IconTrash /> },
  ];
  const totalChanges =
    summary.addedJunctions +
    summary.movedJunctions +
    summary.deletedJunctions +
    summary.addedConnections +
    summary.deletedConnections;
  const discardPrompt =
    locale === "ja" ? `${totalChanges}件の変更を破棄しますか？` : `Discard ${totalChanges} changes?`;
  const previewStatusCopy = previewStatusText(previewStatus, locale);

  return (
    <section className="network-editor-toolbar" aria-label={ui.toolbarLabel[locale]}>
      <div className="network-editor-toolbar__tools" role="group" aria-label={ui.toolbarLabel[locale]}>
        {tools.map(({ id, label, icon }) => {
          const active = tool === id || (tool === "move-junction" && id === "select");
          return (
            <button
              key={id}
              type="button"
              className={
                active
                  ? "network-editor-toolbar__tool network-editor-toolbar__tool--active"
                  : "network-editor-toolbar__tool"
              }
              aria-pressed={active}
              aria-keyshortcuts={TOOL_SHORTCUT[id]}
              disabled={locked}
              onClick={() => onSetTool(id)}
            >
              {icon}
              <span>{label}</span>
            </button>
          );
        })}
        <span className="network-editor-toolbar__divider" aria-hidden="true" />
        <button
          type="button"
          className="network-editor-toolbar__icon"
          aria-label={ui.undo[locale]}
          aria-keyshortcuts="Control+Z Meta+Z"
          disabled={locked || !canUndo}
          onClick={onUndo}
        >
          <IconUndo />
        </button>
        <button
          type="button"
          className="network-editor-toolbar__icon"
          aria-label={ui.redo[locale]}
          aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
          disabled={locked || !canRedo}
          onClick={onRedo}
        >
          <IconRedo />
        </button>
      </div>

      <div className="network-editor-toolbar__status">
        <p className="network-editor-toolbar__instruction" role="status">
          {instructionText(tool, activeFloorLabel, locale, preview)}
        </p>
        <p className="network-editor-toolbar__summary">{changeSummaryText(summary, locale)}</p>
        {previewStatusCopy !== null ? (
          <p className="network-editor-toolbar__note" role="status">
            {previewStatusCopy}
          </p>
        ) : null}
        {preview !== null ? (
          <div className="network-editor-toolbar__preview">
            <div className="network-editor-toolbar__candidates" role="group">
              {preview.candidates.map((candidate, index) => {
                const active = index === preview.selectedIndex;
                return (
                  <button
                    key={`${candidate.kind}-${index}`}
                    type="button"
                    className={
                      active
                        ? "network-editor-toolbar__tool network-editor-toolbar__tool--active"
                        : "network-editor-toolbar__tool"
                    }
                    aria-pressed={active}
                    disabled={locked}
                    onClick={() => onSelectCandidate(index)}
                  >
                    {candidateLabel(candidate.kind, locale)}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="btn-ghost"
              disabled={
                locked ||
                preview.candidates[preview.selectedIndex] === undefined ||
                preview.candidates[preview.selectedIndex]?.kind === "current"
              }
              onClick={onConfirmPreview}
            >
              {ui.addPath[locale]}
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={locked || !preview.candidates.some((candidate) => candidate.kind === "current")}
              onClick={onSelectCurrentRoute}
            >
              {ui.selectRoute[locale]}
            </button>
          </div>
        ) : null}
        {notice !== null ? (
          <p className="network-editor-toolbar__alert" role="alert">
            {noticeText(notice, locale)}
          </p>
        ) : null}
        {saveError !== null ? (
          <p className="network-editor-toolbar__alert" role="alert">
            {saveError}
          </p>
        ) : null}
        {saveMessage !== null ? (
          <p className="network-editor-toolbar__note" role="status">
            {saveMessage}
          </p>
        ) : null}
        {saveProblem !== null && !checkStatus ? (
          <p className="network-editor-toolbar__note">{ui.emptyGraph[locale]}</p>
        ) : null}
      </div>

      <div className="network-editor-toolbar__actions">
        {discardArmed ? (
          <>
            <span className="network-editor-toolbar__confirm">{discardPrompt}</span>
            <button type="button" className="btn-ghost" onClick={onCancelDiscard}>
              {ui.keepEditing[locale]}
            </button>
            <button type="button" className="btn-destructive" onClick={onConfirmDiscard}>
              {ui.discard[locale]}
            </button>
          </>
        ) : (
          <button type="button" className="btn-ghost" disabled={locked} onClick={onRequestDiscard}>
            {ui.discard[locale]}
          </button>
        )}
        <button type="button" className="btn-primary" disabled={!canSave} onClick={onSave}>
          {checkStatus ? ui.checkStatus[locale] : ui.save[locale]}
        </button>
      </div>
    </section>
  );
}
