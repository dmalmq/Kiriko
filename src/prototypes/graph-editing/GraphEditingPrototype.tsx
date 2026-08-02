import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  IconAlertTriangle,
  IconConnect,
  IconCursor,
  IconPointPlus,
  IconRedo,
  IconTrash,
  IconUndo,
  KirikoMark,
} from "../../components/icons";
import type {
  GraphEditorPrototypeState,
  GraphEditorTool,
  GraphFinding,
  ScenarioId,
} from "./graphEditingModel";
import { GraphEditingScene } from "./GraphEditingScene";
import { GraphFindingsQueue } from "./GraphFindingsQueue";
import { GraphSelectionInspector } from "./GraphSelectionInspector";
import { useGraphEditingPrototype } from "./useGraphEditingPrototype";
import "./graphEditingPrototype.css";

interface LocalizedText {
  ja: string;
  en: string;
}

const copy = {
  title: { ja: "3D ネットワーク修復", en: "3D network repair" },
  prototype: { ja: "操作モデル", en: "Interaction model" },
  synthetic: { ja: "合成 B1 ↔ 1F データ", en: "Synthetic B1 ↔ 1F data" },
  toolbarLabel: { ja: "グラフ編集ツールバー", en: "Graph editing toolbar" },
  prototypeState: { ja: "プロトタイプ状態", en: "Prototype state" },
  language: { ja: "言語", en: "Language" },
  reducedMotion: { ja: "動きを抑える", en: "Reduce motion" },
  scenario: { ja: "検証シナリオ", en: "Proof scenario" },
  reset: { ja: "リセット", en: "Reset" },
  select: { ja: "選択", en: "Select" },
  add: { ja: "点を追加", en: "Add point" },
  connect: { ja: "接続", en: "Connect" },
  delete: { ja: "削除", en: "Delete" },
  undo: { ja: "元に戻す", en: "Undo" },
  redo: { ja: "やり直す", en: "Redo" },
  activeFloor: { ja: "編集フロア", en: "Editing floor" },
  runCheck: { ja: "チェック", en: "Check" },
  checking: { ja: "チェック中", en: "Checking" },
  save: { ja: "新しいバージョンとして保存", en: "Save as new version" },
  staged: { ja: "ステージ済み", en: "staged" },
  scenarioField: { ja: "シナリオ", en: "Scenario" },
  toolField: { ja: "ツール", en: "Tool" },
  floorField: { ja: "フロア", en: "Floor" },
  selectionField: { ja: "選択対象", en: "Selection" },
  findingField: { ja: "検出事項", en: "Finding" },
  pendingField: { ja: "保留操作", en: "Pending" },
  snapField: { ja: "スナップ", en: "Snap" },
  historyField: { ja: "履歴", en: "History" },
  futureField: { ja: "やり直し履歴", en: "Future" },
  changesField: { ja: "変更数", en: "Changes" },
  deltaField: { ja: "検出差分", en: "Finding delta" },
  checkField: { ja: "チェック状態", en: "Check state" },
  saveField: { ja: "保存状態", en: "Save state" },
  localeField: { ja: "表示言語", en: "Locale" },
  motionField: { ja: "動き", en: "Motion" },
  cameraField: { ja: "カメラ", en: "Camera" },
  none: { ja: "なし", en: "None" },
  enabled: { ja: "抑制", en: "Reduced" },
  standard: { ja: "標準", en: "Standard" },
  perspective: { ja: "透視", en: "Perspective" },
  top: { ja: "上面", en: "Top" },
  idle: { ja: "待機", en: "Idle" },
  complete: { ja: "完了", en: "Complete" },
  confirming: { ja: "確認待ち", en: "Confirming" },
  saved: { ja: "保存済み", en: "Saved" },
  open: { ja: "未解決", en: "Open" },
  review: { ja: "要確認", en: "Review" },
  ambiguous: { ja: "曖昧", en: "Ambiguous" },
  auto: { ja: "自動", en: "Auto" },
  outside: { ja: "範囲外", en: "None" },
  commitAnnounce: { ja: "変更をステージしました", en: "Change staged" },
  rejectAnnounce: { ja: "無効な操作を拒否しました", en: "Invalid operation rejected" },
  undoAnnounce: { ja: "変更を元に戻しました", en: "Change undone" },
  redoAnnounce: { ja: "変更をやり直しました", en: "Change redone" },
  checkingAnnounce: { ja: "フルチェックを開始しました", en: "Full Check started" },
  checkedAnnounce: { ja: "フルチェックが完了しました", en: "Full Check complete" },
  saveReviewAnnounce: { ja: "新しい不変バージョンの確認を開きました", en: "New immutable version confirmation opened" },
  savedAnnounce: { ja: "新しいバージョンを準備しました", en: "New version prepared" },
  floorAnnounce: { ja: "現在の編集フロア", en: "Current editing floor" },
  resetAnnounce: { ja: "検証シナリオをリセットしました", en: "Proof scenario reset" },
} satisfies Record<string, LocalizedText>;

const scenarioCopy: Record<ScenarioId, LocalizedText> = {
  "repair-endpoint": { ja: "端点を修復", en: "Repair endpoint" },
  "create-connector": { ja: "垂直接続を作成", en: "Create connector" },
  "reject-duplicate": { ja: "重複接続を拒否", en: "Reject duplicate" },
  "resolve-uncertainty": { ja: "不確実性を解決", en: "Resolve uncertainty" },
  "delete-consequences": { ja: "削除の影響を確認", en: "Delete with consequences" },
  "check-save": { ja: "チェックして保存", en: "Check and save" },
};

const toolCopy: Record<GraphEditorTool, LocalizedText> = {
  select: copy.select,
  add: copy.add,
  connect: copy.connect,
  delete: copy.delete,
  move: { ja: "移動", en: "Move" },
};

const findingTitles: Record<GraphFinding["id"], LocalizedText> = {
  "endpoint-off-stair": { ja: "階段から外れた端点", en: "Endpoint off stair" },
  "floor-drift": { ja: "フロア割り当てのずれ", en: "Floor assignment drift" },
  "unassociated-lift": { ja: "未関連付けのエレベーター", en: "Unassociated lift" },
};

const toolButtons = [
  { id: "select", label: copy.select, icon: IconCursor },
  { id: "add", label: copy.add, icon: IconPointPlus },
  { id: "connect", label: copy.connect, icon: IconConnect },
  { id: "delete", label: copy.delete, icon: IconTrash },
] as const;

interface TransitionSnapshot {
  scenario: ScenarioId;
  activeFloor: GraphEditorPrototypeState["activeFloor"];
  noticeRevision: number;
  pastDepth: number;
  futureDepth: number;
  stagedCount: number;
  checkState: GraphEditorPrototypeState["checkState"];
  saveState: GraphEditorPrototypeState["saveState"];
}

function t(value: LocalizedText, locale: GraphEditorPrototypeState["locale"]): string {
  return value[locale];
}

function selectionLabel(state: GraphEditorPrototypeState): string {
  const { selection, locale } = state;
  if (selection === null) return t(copy.none, locale);
  const kind = selection.kind === "node"
    ? { ja: "ノード", en: "Node" }
    : selection.kind === "edge"
      ? { ja: "接続", en: "Connection" }
      : selection.kind === "control-point"
        ? { ja: "制御点", en: "Control point" }
        : { ja: "会場エビデンス", en: "Venue evidence" };
  return `${t(kind, locale)} · ${selection.id}`;
}

function pendingLabel(state: GraphEditorPrototypeState): string {
  const { pending, locale } = state;
  if (pending === null) return t(copy.none, locale);
  const labels = {
    add: { ja: "点の追加", en: "Add point" },
    move: { ja: "点の移動", en: "Move point" },
    connect: { ja: "接続ドラフト", en: "Connection draft" },
    delete: { ja: "削除確認", en: "Delete confirmation" },
    exception: { ja: "例外理由", en: "Exception reason" },
    profile: { ja: "プロファイル上書き", en: "Profile override" },
  } satisfies Record<NonNullable<GraphEditorPrototypeState["pending"]>["kind"], LocalizedText>;
  return t(labels[pending.kind], locale);
}

function findingDeltaLabel(state: GraphEditorPrototypeState): string {
  const { findingDelta, locale } = state;
  if (findingDelta === null || findingDelta === "finding:none:unchanged") return t(copy.none, locale);
  const [findingId, transition] = findingDelta.split(":") as [GraphFinding["id"], string];
  const transitionCopy: Record<string, LocalizedText> = {
    resolved: { ja: "解決", en: "resolved" },
    reopened: { ja: "再発", en: "reopened" },
    accepted: { ja: "例外を承認", en: "accepted" },
    "newly-exposed": { ja: "新たに検出", en: "newly exposed" },
  };
  const title = findingTitles[findingId];
  const transitionLabel = transitionCopy[transition];
  return title === undefined || transitionLabel === undefined
    ? t(copy.none, locale)
    : `${t(title, locale)} · ${t(transitionLabel, locale)}`;
}

export function GraphEditingPrototype(): ReactElement {
  const { state, actions } = useGraphEditingPrototype();
  const { locale } = state;
  const [announcement, setAnnouncement] = useState({
    revision: 0,
    text: `${t(copy.floorAnnounce, locale)} ${state.activeFloor}`,
  });
  const previous = useRef<TransitionSnapshot>({
    scenario: state.scenario,
    activeFloor: state.activeFloor,
    noticeRevision: state.noticeRevision,
    pastDepth: state.past.length,
    futureDepth: state.future.length,
    stagedCount: state.stagedChanges.length,
    checkState: state.checkState,
    saveState: state.saveState,
  });
  const historyAction = useRef<"undo" | "redo" | null>(null);
  const prototypeActions = {
    ...actions,
    undo: () => {
      if (state.past.length > 0) historyAction.current = "undo";
      actions.undo();
    },
    redo: () => {
      if (state.future.length > 0) historyAction.current = "redo";
      actions.redo();
    },
  };


  useEffect(() => {
    const before = previous.current;
    const messages: string[] = [];
    if (state.scenario !== before.scenario) messages.push(t(copy.resetAnnounce, locale));
    if (state.notice !== null && state.noticeRevision !== before.noticeRevision) messages.push(t(copy.rejectAnnounce, locale));
    if (historyAction.current === "undo") messages.push(t(copy.undoAnnounce, locale));
    else if (historyAction.current === "redo") messages.push(t(copy.redoAnnounce, locale));
    else if (state.stagedChanges.length > before.stagedCount) messages.push(t(copy.commitAnnounce, locale));
    historyAction.current = null;
    if (state.checkState !== before.checkState) {
      if (state.checkState === "checking") messages.push(t(copy.checkingAnnounce, locale));
      else if (state.checkState === "complete") messages.push(t(copy.checkedAnnounce, locale));
    }
    if (state.saveState !== before.saveState) {
      if (state.saveState === "confirming") messages.push(t(copy.saveReviewAnnounce, locale));
      else if (state.saveState === "saved") messages.push(t(copy.savedAnnounce, locale));
    }
    if (state.activeFloor !== before.activeFloor) messages.push(`${t(copy.floorAnnounce, locale)} ${state.activeFloor}`);
    if (messages.length > 0) {
      const floorContext = state.activeFloor === before.activeFloor
        ? `. ${t(copy.floorAnnounce, locale)} ${state.activeFloor}`
        : "";
      setAnnouncement((current) => ({
        revision: current.revision + 1,
        text: `${messages.join(". ")}${floorContext}.`,
      }));
    }
    previous.current = {
      scenario: state.scenario,
      activeFloor: state.activeFloor,
      noticeRevision: state.noticeRevision,
      pastDepth: state.past.length,
      futureDepth: state.future.length,
      stagedCount: state.stagedChanges.length,
      checkState: state.checkState,
      saveState: state.saveState,
    };
  }, [
    locale,
    state.activeFloor,
    state.checkState,
    state.future.length,
    state.notice,
    state.noticeRevision,
    state.past.length,
    state.saveState,
    state.scenario,
    state.stagedChanges.length,
  ]);

  const pendingSnap = state.pending?.kind === "add" || state.pending?.kind === "move"
    ? state.pending.snap
    : null;
  const structuralValid = state.edges.length > 0 && state.nodes.length > 1 && state.notice !== "unusable-graph";
  const saveReady = structuralValid && state.checkState === "complete" && state.stagedChanges.length > 0;
  const checkLabel = state.checkState === "checking" ? copy.checking : copy.runCheck;
  const stateRows: Array<{ label: LocalizedText; value: string }> = [
    { label: copy.scenarioField, value: t(scenarioCopy[state.scenario], locale) },
    { label: copy.toolField, value: t(toolCopy[state.tool], locale) },
    { label: copy.floorField, value: state.activeFloor },
    { label: copy.selectionField, value: selectionLabel(state) },
    { label: copy.findingField, value: state.selectedFindingId === null ? t(copy.none, locale) : t(findingTitles[state.selectedFindingId], locale) },
    { label: copy.pendingField, value: pendingLabel(state) },
    {
      label: copy.snapField,
      value: pendingSnap === null
        ? t(copy.none, locale)
        : `${t(pendingSnap.band === "none" ? copy.outside : copy[pendingSnap.band], locale)} · ${pendingSnap.distanceM.toFixed(2)} m`,
    },
    { label: copy.historyField, value: `${state.past.length}` },
    { label: copy.futureField, value: `${state.future.length}` },
    { label: copy.changesField, value: `${state.stagedChanges.length}` },
    { label: copy.deltaField, value: findingDeltaLabel(state) },
    { label: copy.checkField, value: t(state.checkState === "complete" ? copy.complete : state.checkState === "checking" ? copy.checking : copy.idle, locale) },
    { label: copy.saveField, value: t(state.saveState === "confirming" ? copy.confirming : state.saveState === "saved" ? copy.saved : copy.idle, locale) },
    { label: copy.localeField, value: locale === "ja" ? "日本語" : "English" },
    { label: copy.motionField, value: t(state.reducedMotion ? copy.enabled : copy.standard, locale) },
    { label: copy.cameraField, value: t(state.cameraPreset === "top" ? copy.top : copy.perspective, locale) },
  ];

  return (
    <main
      className={`graph-editing-prototype${state.reducedMotion ? " graph-editing-prototype--reduced-motion" : ""}`}
      lang={locale}
    >
      <header className="graph-editing-prototype__header">
        <div className="graph-editing-prototype__brand">
          <span className="graph-editing-prototype__mark"><KirikoMark size={22} /></span>
          <div>
            <h1>{t(copy.title, locale)}</h1>
            <p>{t(copy.synthetic, locale)} · <span>{t(copy.prototype, locale)}</span></p>
          </div>
        </div>
        <div className="graph-editing-prototype__header-controls">
          <div className="graph-editing-prototype__language" role="group" aria-label={t(copy.language, locale)}>
            <button type="button" aria-pressed={locale === "ja"} onClick={() => actions.setLocale("ja")}>日本語</button>
            <button type="button" aria-pressed={locale === "en"} onClick={() => actions.setLocale("en")}>English</button>
          </div>
          <button
            type="button"
            className="graph-editing-prototype__motion"
            aria-pressed={state.reducedMotion}
            onClick={actions.toggleReducedMotion}
          >
            {t(copy.reducedMotion, locale)}
          </button>
          <label className="graph-editing-prototype__scenario">
            <span>{t(copy.scenario, locale)}</span>
            <select value={state.scenario} onChange={(event) => actions.resetScenario(event.currentTarget.value as ScenarioId)}>
              {(Object.keys(scenarioCopy) as ScenarioId[]).map((scenario) => <option key={scenario} value={scenario}>{t(scenarioCopy[scenario], locale)}</option>)}
            </select>
          </label>
          <button type="button" className="graph-editing-prototype__reset" onClick={() => actions.resetScenario(state.scenario)}>{t(copy.reset, locale)}</button>
        </div>
      </header>

      <section className="graph-editing-prototype__toolbar" aria-label={t(copy.toolbarLabel, locale)}>
        <div className="graph-editing-prototype__toolset">
          {toolButtons.map((tool) => {
            const Icon = tool.icon;
            return (
              <button key={tool.id} type="button" aria-pressed={state.tool === tool.id} onClick={() => actions.setTool(tool.id)}>
                <Icon size={17} />
                <span>{t(tool.label, locale)}</span>
              </button>
            );
          })}
        </div>
        <span className="graph-editing-prototype__toolbar-divider" />
        <div className="graph-editing-prototype__history-controls">
          <button type="button" disabled={state.past.length === 0} onClick={prototypeActions.undo}><IconUndo size={17} /><span>{t(copy.undo, locale)}</span></button>
          <button type="button" disabled={state.future.length === 0} onClick={prototypeActions.redo}><IconRedo size={17} /><span>{t(copy.redo, locale)}</span></button>
        </div>
        <span className="graph-editing-prototype__toolbar-divider" />
        <div className="graph-editing-prototype__floors" role="group" aria-label={t(copy.activeFloor, locale)}>
          <span>{t(copy.activeFloor, locale)}</span>
          {(["B1", "1F"] as const).map((floor) => <button key={floor} type="button" aria-pressed={state.activeFloor === floor} onClick={() => actions.setActiveFloor(floor)}>{floor}</button>)}
        </div>
        <div className="graph-editing-prototype__commit-controls">
          <button type="button" disabled={state.checkState === "checking"} onClick={actions.runCheck}><IconAlertTriangle size={17} /><span>{t(checkLabel, locale)}</span></button>
          <button type="button" className="graph-editing-prototype__save" disabled={!saveReady || state.saveState !== "idle"} onClick={actions.requestSave}>{t(copy.save, locale)}</button>
        </div>
      </section>

      <GraphFindingsQueue state={state} actions={prototypeActions} />
      <GraphEditingScene state={state} actions={prototypeActions} />
      <GraphSelectionInspector state={state} actions={prototypeActions} />

      <aside className="graph-editing-prototype__state" aria-label={t(copy.prototypeState, locale)}>
        <header>
          <h2>{t(copy.prototypeState, locale)}</h2>
          <span><strong>{state.stagedChanges.length}</strong> {t(copy.staged, locale)}</span>
        </header>
        <dl>
          {stateRows.map((row) => <div key={row.label.en}><dt>{t(row.label, locale)}</dt><dd>{row.value}</dd></div>)}
        </dl>
      </aside>

      <div className="sr-only" aria-live="polite" aria-atomic="true"><span key={announcement.revision}>{announcement.text}</span></div>
    </main>
  );
}
