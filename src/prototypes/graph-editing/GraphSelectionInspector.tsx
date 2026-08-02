import type { ReactElement } from "react";
import type {
  FloorId,
  GraphEditorPrototypeState,
  GraphFinding,
  ScenePoint,
} from "./graphEditingModel";
import type { GraphEditorPrototypeActions } from "./useGraphEditingPrototype";

interface LocalizedText {
  ja: string;
  en: string;
}

export interface GraphSelectionInspectorProps {
  state: GraphEditorPrototypeState;
  actions: GraphEditorPrototypeActions;
}

const findingTitles: Record<GraphFinding["id"], LocalizedText> = {
  "endpoint-off-stair": { ja: "階段から外れた端点", en: "Endpoint off stair" },
  "floor-drift": { ja: "フロア割り当てのずれ", en: "Floor assignment drift" },
  "unassociated-lift": { ja: "未関連付けのエレベーター", en: "Unassociated lift" },
};

const copy = {
  inspector: { ja: "選択インスペクター", en: "Selection inspector" },
  noSelection: { ja: "シーンまたは検出事項から対象を選択してください", en: "Select an object in the scene or findings queue" },
  node: { ja: "ジャンクション", en: "Junction" },
  edge: { ja: "接続", en: "Connection" },
  connector: { ja: "垂直接続", en: "Connector" },
  controlPoint: { ja: "制御点", en: "Control point" },
  venue: { ja: "会場エビデンス", en: "Venue evidence" },
  assignedFloor: { ja: "割り当てフロア", en: "Assigned floor" },
  sceneZ: { ja: "フロア面 Z", en: "Floor-plane Z" },
  sourceAltitude: { ja: "ソース標高", en: "Source altitude" },
  altitudeDelta: { ja: "ソースとの差", en: "Source-to-plane delta" },
  provenance: { ja: "来歴", en: "Provenance" },
  endpoints: { ja: "端点", en: "Endpoints" },
  association: { ja: "関連付け", en: "Association" },
  findingEvidence: { ja: "検出エビデンス", en: "Finding evidence" },
  source: { ja: "ソース", en: "Source" },
  manual: { ja: "手動", en: "Manual" },
  none: { ja: "なし", en: "None" },
  notApplicable: { ja: "対象外", en: "Not applicable" },
  notEvaluated: { ja: "未評価", en: "Not evaluated" },
  pendingFix: { ja: "保留中の修復", en: "Pending fix" },
  before: { ja: "変更前", en: "Before" },
  candidate: { ja: "候補", en: "Candidate" },
  candidateIdentity: { ja: "候補 ID", en: "Candidate identity" },
  candidateFloor: { ja: "候補フロア", en: "Candidate floor" },
  confidence: { ja: "信頼度", en: "Confidence" },
  affectedAssociation: { ja: "影響する関連付け", en: "Affected association" },
  associationUnchanged: { ja: "XY スナップでは変更なし", en: "Unchanged by XY snap" },
  candidateRelation: { ja: "フロア適格性", en: "Floor eligibility" },
  sameFloorEvidence: { ja: "同一フロア候補", en: "Same-floor candidate" },
  crossFloorEvidence: { ja: "異なるフロアのエビデンス · スナップ禁止", en: "Cross-floor evidence · snapping prohibited" },
  distance: { ja: "距離", en: "Distance" },
  snapBand: { ja: "判定帯", en: "Snap band" },
  floorInvariant: { ja: "フロアを維持", en: "Floor remains" },
  auto: { ja: "自動", en: "Auto" },
  review: { ja: "要確認", en: "Review" },
  ambiguous: { ja: "候補が曖昧", en: "Ambiguous" },
  outside: { ja: "範囲外", en: "None" },
  provisional: { ja: "暫定", en: "Provisional" },
  provisionalDisclosure: { ja: "自動帯と要確認帯は暫定です。", en: "Auto and Review bands are provisional." },
  provisionalThresholds: { ja: "現在の暫定値", en: "Current provisional values" },
  issue33: { ja: "検証 Issue #33 · JR 付属データセットで 3D グラフスナップを検証", en: "Validation issue #33 · Validate 3D graph snapping against the companion JR datasets" },
  applySnap: { ja: "スナップを適用", en: "Apply snap" },
  acceptCandidate: { ja: "候補を採用", en: "Accept candidate" },
  keepRaw: { ja: "未スナップ位置を確定", en: "Commit raw position" },
  ambiguousHelp: { ja: "候補を一意に決められないため、自動適用できません。", en: "Evidence is ambiguous, so only raw placement can commit." },
  cancel: { ja: "キャンセル", en: "Cancel" },
  connectorDraft: { ja: "接続ドラフト", en: "Connection draft" },
  from: { ja: "開始", en: "From" },
  to: { ja: "終了", en: "To" },
  chooseEndpoint: { ja: "シーンで終了端点を選択してください", en: "Choose the second endpoint in the scene" },
  stairCandidate: { ja: "中央階段 · GDB 形状 · 信頼度 96%", en: "Main stair · GDB footprint · 96% confidence" },
  liftCandidate: { ja: "東エレベーター · GDB 形状 · 信頼度 88%", en: "East lift · GDB footprint · 88% confidence" },
  leaveUnassociated: { ja: "関連付けない", en: "Leave unassociated" },
  addLanding: { ja: "踊り場ハンドルを追加", en: "Add landing handle" },
  commitConnector: { ja: "垂直接続を確定", en: "Commit connector" },
  commitConnection: { ja: "接続を確定", en: "Commit connection" },
  associationRequired: { ja: "関連付けを選択してください（未関連付けも明示選択）", en: "Choose an association, including explicitly unassociated" },
  controlPoints: { ja: "内部制御点", en: "Interior control points" },
  straightPath: { ja: "内部制御点なし · 直線端点パス", en: "No interior control points · straight endpoint path" },
  landingSource: { ja: "「踊り場を追加」操作", en: "Add landing action" },
  pathEvidence: { ja: "パス数値エビデンス", en: "Path numeric evidence" },
  sceneZContext: { ja: "シーン Z", en: "Scene Z" },
  rise: { ja: "高低差", en: "Rise" },
  run: { ja: "水平ラン", en: "Horizontal run" },
  monotonicZ: { ja: "Z 単調性", en: "Monotonic Z" },
  monotonicUp: { ja: "単調増加", en: "Monotonic ascending" },
  monotonicDown: { ja: "単調減少", en: "Monotonic descending" },
  monotonicFlat: { ja: "一定", en: "Flat" },
  nonMonotonic: { ja: "非単調", en: "Non-monotonic" },
  footprintEvidence: { ja: "形状 / 関連付けエビデンス", en: "Footprint / association evidence" },
  stairFootprint: { ja: "中央階段 · GDB / GeoJSON 候補形状 · 信頼度 96%", en: "Main stair · GDB / GeoJSON candidate footprint · 96% confidence" },
  liftFootprint: { ja: "東エレベーター · GDB / GeoJSON 候補形状 · 信頼度 88%", en: "East lift · GDB / GeoJSON candidate footprint · 88% confidence" },
  unassociatedEvidence: { ja: "明示的に未関連付け · 候補形状なし", en: "Explicitly unassociated · no candidate footprint" },
  directionSemantics: { ja: "方向セマンティクス", en: "Direction semantics" },
  directionUnresolved: { ja: "未解決 · ドラフトに方向フィールドなし", en: "Unresolved · no direction field in this draft" },
  accessibilitySemantics: { ja: "アクセシビリティ", en: "Accessibility semantics" },
  accessibilityUnresolved: { ja: "未解決 · 関連付け候補はエビデンスのみ", en: "Unresolved · candidate association is evidence only" },
  draftStructure: { ja: "コミット準備", en: "Commit readiness" },
  draftReady: { ja: "構造エビデンス確認可能", en: "Structural evidence inspectable" },
  endpointEvidenceMissing: { ja: "異なる解決済み端点が必要です", en: "Two distinct resolved endpoints are required" },
  associationEvidenceMissing: { ja: "関連付けの明示選択が必要です", en: "An explicit association choice is required" },
  geometryEvidenceInvalid: { ja: "端点または制御点に有限でない座標があります", en: "An endpoint or control point has non-finite coordinates" },
  duplicateDraft: { ja: "同じ端点の接続が既にあります", en: "A connection already exists between these endpoints" },
  dataHonesty: { ja: "データ制約", en: "Data limitation" },
  dataHonestyText: { ja: "このローカル合成ドラフトは候補形状との完全な 3D 包含、方向、アクセシビリティを計算・永続化しません。関連付けの選択でそれらを暗黙変更しません。", en: "This local synthetic draft does not calculate or persist full 3D footprint containment, direction, or accessibility. Choosing an association does not silently change those semantics." },
  floorAssignment: { ja: "フロア割り当て", en: "Floor assignment" },
  reviewFloorChange: { ja: "フロア変更を確認", en: "Review floor change" },
  preserveAltitude: { ja: "ソース標高は保持されます", en: "Source altitude will be preserved" },
  confirmFloor: { ja: "フロア変更を確定", en: "Confirm floor change" },
  previewFloorConsequences: { ja: "接続への影響をプレビュー", en: "Preview connection consequences" },
  floorChangeConsequences: { ja: "フロア変更の影響", en: "Floor-change consequences" },
  finishPendingFirst: { ja: "先に保留中の操作を確定またはキャンセルしてください", en: "Commit or cancel the pending operation first" },
  exception: { ja: "例外", en: "Exception" },
  acceptException: { ja: "例外として承認", en: "Accept exception" },
  exceptionReason: { ja: "承認理由", en: "Acceptance reason" },
  reasonRequired: { ja: "理由を入力してください", en: "A reason is required" },
  acceptedReason: { ja: "承認済み理由", en: "Accepted reason" },
  exceptionDraftElsewhere: { ja: "別の検出事項の例外ドラフトを編集中です", en: "An exception draft for another finding is active" },
  profile: { ja: "検証プロファイル", en: "Validation profile" },
  editProfile: { ja: "しきい値を上書き", en: "Override thresholds" },
  autoThreshold: { ja: "自動スナップ (m)", en: "Auto snap (m)" },
  reviewThreshold: { ja: "レビュー上限 (m)", en: "Review limit (m)" },
  overrideReason: { ja: "上書き理由", en: "Override reason" },
  newValues: { ja: "新しい値", en: "New values" },
  overrideScope: { ja: "上書き範囲", en: "Override scope" },
  chooseScope: { ja: "範囲を選択", en: "Choose scope" },
  graphScope: { ja: "現在の合成グラフ全体", en: "Current synthetic graph" },
  noOverride: { ja: "上書きなし", en: "No override" },
  scopeRequired: { ja: "上書き範囲を選択してください", en: "An override scope is required" },
  invalidProfile: { ja: "0 < 自動スナップ < レビュー上限 が必要です", en: "Requires 0 < auto snap < review limit" },
  commitProfile: { ja: "プロファイルを確定", en: "Commit profile override" },
  deletePreview: { ja: "削除の影響", en: "Delete consequences" },
  confirmDelete: { ja: "削除を確定", en: "Confirm delete" },
  checks: { ja: "チェックと保存", en: "Check and save" },
  structural: { ja: "構造", en: "Structural" },
  structuralValid: { ja: "有効", en: "Valid" },
  structuralInvalid: { ja: "無効", en: "Invalid" },
  semantic: { ja: "意味的検出", en: "Semantic findings" },
  broadRule: { ja: "広域ルール", en: "Broad rule" },
  checking: { ja: "チェック中", en: "Checking" },
  checked: { ja: "チェック完了", en: "Check complete" },
  runCheck: { ja: "フルチェックを実行", en: "Run full Check" },
  stagedChanges: { ja: "ステージ済み変更", en: "Staged changes" },
  noChanges: { ja: "変更なし", en: "No staged changes" },
  requestSave: { ja: "新しいバージョンとして保存", en: "Save as new version" },
  saveConfirmation: { ja: "本番では新しい不変バージョンを作成します。既存版は変更しません。", en: "Production would create a new immutable version. The existing version remains unchanged." },
  confirmSave: { ja: "保存を確認", en: "Confirm Save" },
  saved: { ja: "プロトタイプの新バージョンを準備しました", en: "Prototype new version prepared" },
  status: { ja: "状態", en: "Status" },
  noticeDuplicate: { ja: "同じ端点の接続がすでに存在します。変更は適用されません。", en: "A connection between these endpoints already exists. No change was applied." },
  noticeUnusable: { ja: "利用可能なグラフを壊す削除は拒否されました。", en: "Deletion was rejected because it would leave an unusable graph." },
  noticeGeometry: { ja: "無効な形状操作は拒否されました。", en: "The invalid geometry operation was rejected." },
  nudgeControl: { ja: "制御点を調整", en: "Adjust control point" },
  decrease: { ja: "減らす", en: "Decrease" },
  increase: { ja: "増やす", en: "Increase" },
} satisfies Record<string, LocalizedText>;

const findingStateCopy = {
  open: { ja: "未解決", en: "Open" },
  resolved: { ja: "解決済み", en: "Resolved" },
  accepted: { ja: "例外を承認", en: "Exception accepted" },
  "not-evaluated": copy.notEvaluated,
} satisfies Record<GraphFinding["state"], LocalizedText>;

function t(value: LocalizedText, locale: GraphEditorPrototypeState["locale"]): string {
  return value[locale];
}

function pointText(point: ScenePoint): string {
  return `X ${point.x.toFixed(2)} · Y ${point.y.toFixed(2)} · Z ${point.z.toFixed(2)}`;
}


function horizontalRun(points: readonly ScenePoint[]): number {
  let run = 0;
  let previous: ScenePoint | null = null;
  for (const point of points) {
    if (previous !== null) run += Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
  }
  return run;
}

function monotonicZLabel(points: readonly ScenePoint[]): LocalizedText {
  const first = points[0];
  if (first === undefined || points.length < 2 || points.every((point) => Math.abs(point.z - first.z) < 0.000001)) {
    return copy.monotonicFlat;
  }
  const ascending = points.every((point, index) => {
    const previous = points[index - 1];
    return previous === undefined || point.z >= previous.z;
  });
  if (ascending) return copy.monotonicUp;
  const descending = points.every((point, index) => {
    const previous = points[index - 1];
    return previous === undefined || point.z <= previous.z;
  });
  return descending ? copy.monotonicDown : copy.nonMonotonic;
}

function findingEvidence(finding: GraphFinding, locale: GraphEditorPrototypeState["locale"]): string {
  const state = t(findingStateCopy[finding.state], locale);
  if (finding.measuredM === null) return `${t(findingTitles[finding.id], locale)} · ${state}`;
  return `${t(findingTitles[finding.id], locale)} · ${state} · ${finding.measuredM.toFixed(2)} m`;
}

function consequenceText(token: string, locale: GraphEditorPrototypeState["locale"]): string {
  const [kind, first, second, third] = token.split(":");
  switch (kind) {
    case "reassign-node-floor":
      return locale === "ja"
        ? `${first} のフロアを ${second} から ${third} に変更`
        : `Reassign ${first} from ${second} to ${third}`;
    case "edge-kind": {
      const before = second === "same-floor"
        ? locale === "ja" ? "同一フロア接続" : "same-floor edge"
        : locale === "ja" ? "垂直接続" : "connector";
      const after = third === "same-floor"
        ? locale === "ja" ? "同一フロア接続" : "same-floor edge"
        : locale === "ja" ? "未関連付けの垂直接続" : "unassociated connector";
      return locale === "ja"
        ? `${first}: ${before} から ${after} に変更`
        : `${first}: change ${before} to ${after}`;
    }
    case "edge-association":
      return locale === "ja"
        ? `${first}: 関連付け ${second} を解除`
        : `${first}: remove association ${second}`;
    case "edge-control-points":
      return locale === "ja"
        ? `${first}: 制御点 ${second} を削除`
        : `${first}: remove control point(s) ${second}`;
    case "incident-edges":
      return locale === "ja" ? `接続 ${first} 件を削除` : `Remove ${first} incident connection(s)`;
    case "affected-findings":
      return locale === "ja" ? `検出事項 ${first} 件に影響` : `Affect ${first} finding(s)`;
    case "disconnect":
      return locale === "ja" ? `${first} と ${second} を切断` : `Disconnect ${first} from ${second}`;
    case "remove-association":
      return locale === "ja" ? `関連付け ${first} を解除` : `Remove association ${first}`;
    case "remove-control-point":
      return locale === "ja" ? `制御点 ${second} を削除` : `Remove control point ${second}`;
    case "structural-unusable":
      return locale === "ja"
        ? "構造違反: 利用可能な接続がなくなるため、削除を確定できません"
        : "Structural violation: deletion would leave no usable connection, so commit is blocked";
    case "venue-read-only":
      return locale === "ja" ? `会場形状 ${first} は読み取り専用` : `Venue evidence ${first} is read-only`;
    default:
      return locale === "ja" ? "削除の影響を再確認してください" : "Review the deletion impact";
  }
}

function stagedChangeText(token: string, locale: GraphEditorPrototypeState["locale"]): string {
  const [kind, first, second, third] = token.split(":");
  switch (kind) {
    case "add":
      return locale === "ja" ? `${first} を ${second} に追加` : `Added ${first} on ${second}`;
    case "move": {
      const mode = second === "snap"
        ? locale === "ja" ? "スナップ" : "snapped"
        : locale === "ja" ? "未スナップ" : "raw";
      return locale === "ja" ? `${first} を移動 (${mode})` : `Moved ${first} (${mode})`;
    }
    case "connect":
      return locale === "ja" ? `${second} と ${third} を接続` : `Connected ${second} to ${third}`;
    case "reassign-floor":
      return locale === "ja" ? `${first}: ${second} から ${third} へ変更` : `${first}: reassigned ${second} to ${third}`;
    case "delete": {
      const objectKind = first === "node"
        ? locale === "ja" ? "ジャンクション" : "junction"
        : first === "edge"
          ? locale === "ja" ? "接続" : "connection"
          : locale === "ja" ? "制御点" : "control point";
      return locale === "ja" ? `${objectKind} ${second} を削除` : `Deleted ${objectKind} ${second}`;
    }
    case "accept-exception":
      return locale === "ja" ? `${first} の例外を承認` : `Accepted exception for ${first}`;
    case "override-profile": {
      const scope = third === "graph"
        ? locale === "ja" ? "現在の合成グラフ全体" : "current synthetic graph"
        : locale === "ja" ? "未指定範囲" : "unspecified scope";
      return locale === "ja"
        ? `${scope} のスナップしきい値を ${first} / ${second} m に変更`
        : `Changed snap thresholds to ${first} / ${second} m for the ${scope}`;
    }
    case "nudge-control-point":
      return locale === "ja" ? `制御点 ${second} の ${third} 軸を調整` : `Adjusted ${third} axis of control point ${second}`;
    default:
      return locale === "ja" ? "グラフ変更をステージ" : "Staged graph change";
  }
}

function findingDeltaText(token: string, locale: GraphEditorPrototypeState["locale"]): string | null {
  if (token === "finding:none:unchanged") return null;
  const [findingId, transition] = token.split(":") as [GraphFinding["id"], string];
  const title = findingTitles[findingId];
  if (title === undefined) return null;
  const transitions: Record<string, LocalizedText> = {
    resolved: { ja: "解決", en: "resolved" },
    reopened: { ja: "再発", en: "reopened" },
    accepted: { ja: "例外を承認", en: "accepted" },
    "newly-exposed": { ja: "新たに検出", en: "newly exposed" },
  };
  const label = transitions[transition];
  return label === undefined ? null : `${t(title, locale)} · ${t(label, locale)}`;
}

function otherFloor(floorId: FloorId): FloorId {
  return floorId === "B1" ? "1F" : "B1";
}

export function GraphSelectionInspector({ state, actions }: GraphSelectionInspectorProps): ReactElement {
  const { locale, selection, pending } = state;
  const selectedFinding = state.findings.find((finding) => finding.id === state.selectedFindingId) ?? null;
  const selectedNode = selection?.kind === "node" ? state.nodes.find((node) => node.id === selection.id) ?? null : null;
  const selectedEdge = selection?.kind === "edge" ? state.edges.find((edge) => edge.id === selection.id) ?? null : null;
  const selectedControlEdge = selection?.kind === "control-point" ? state.edges.find((edge) => edge.id === selection.edgeId) ?? null : null;
  const selectedControlPoint = selection?.kind === "control-point"
    ? selectedControlEdge?.controlPoints.find((point) => point.id === selection.id) ?? null
    : null;

  const fields: Array<{ label: LocalizedText; value: string; machine?: boolean }> = [];
  let selectionTitle = t(copy.noSelection, locale);
  let selectionKind = "";

  if (selectedNode !== null) {
    selectionKind = t(copy.node, locale);
    selectionTitle = selectedNode.id;
    fields.push(
      { label: copy.assignedFloor, value: selectedNode.floorId, machine: true },
      { label: copy.sceneZ, value: `${selectedNode.point.z.toFixed(2)} m`, machine: true },
      {
        label: copy.sourceAltitude,
        value: selectedNode.sourceAltitude === null ? t(copy.none, locale) : `${selectedNode.sourceAltitude.toFixed(2)} m`,
        machine: true,
      },
      {
        label: copy.altitudeDelta,
        value: selectedNode.sourceAltitude === null
          ? t(copy.notApplicable, locale)
          : `${(selectedNode.sourceAltitude - selectedNode.point.z).toFixed(2)} m`,
        machine: true,
      },
      { label: copy.provenance, value: t(copy[selectedNode.provenance], locale) },
      { label: copy.endpoints, value: t(copy.notApplicable, locale) },
      { label: copy.association, value: t(copy.none, locale) },
    );
  } else if (selectedEdge !== null) {
    const from = state.nodes.find((node) => node.id === selectedEdge.fromNodeId);
    const to = state.nodes.find((node) => node.id === selectedEdge.toNodeId);
    selectionKind = t(selectedEdge.kind === "connector" ? copy.connector : copy.edge, locale);
    selectionTitle = selectedEdge.id;
    fields.push(
      {
        label: copy.assignedFloor,
        value: from === undefined || to === undefined
          ? t(copy.notApplicable, locale)
          : from.floorId === to.floorId
            ? from.floorId
            : `${from.floorId} ↔ ${to.floorId}`,
        machine: true,
      },
      { label: copy.sceneZ, value: t(copy.notApplicable, locale) },
      { label: copy.sourceAltitude, value: t(copy.none, locale) },
      { label: copy.altitudeDelta, value: t(copy.notApplicable, locale) },
      { label: copy.provenance, value: t(copy.notApplicable, locale) },
      { label: copy.endpoints, value: `${selectedEdge.fromNodeId} → ${selectedEdge.toNodeId}`, machine: true },
      { label: copy.association, value: selectedEdge.associationId ?? t(copy.none, locale), machine: true },
    );
  } else if (selectedControlPoint !== null && selectedControlEdge !== null) {
    selectionKind = t(copy.controlPoint, locale);
    selectionTitle = selectedControlPoint.id;
    fields.push(
      { label: copy.assignedFloor, value: "B1 ↔ 1F", machine: true },
      { label: copy.sceneZ, value: `${selectedControlPoint.z.toFixed(2)} m`, machine: true },
      { label: copy.sourceAltitude, value: t(copy.none, locale) },
      { label: copy.altitudeDelta, value: t(copy.notApplicable, locale) },
      { label: copy.provenance, value: t(copy.manual, locale) },
      { label: copy.endpoints, value: `${selectedControlEdge.fromNodeId} → ${selectedControlEdge.toNodeId}`, machine: true },
      { label: copy.association, value: selectedControlEdge.associationId ?? t(copy.none, locale), machine: true },
    );
  } else if (selection?.kind === "venue") {
    selectionKind = t(copy.venue, locale);
    selectionTitle = selection.id;
    fields.push(
      { label: copy.assignedFloor, value: "B1 ↔ 1F", machine: true },
      { label: copy.sceneZ, value: t(copy.notApplicable, locale) },
      { label: copy.sourceAltitude, value: t(copy.none, locale) },
      { label: copy.altitudeDelta, value: t(copy.notApplicable, locale) },
      { label: copy.provenance, value: "GDB / GeoJSON", machine: true },
      { label: copy.endpoints, value: t(copy.notApplicable, locale) },
      { label: copy.association, value: selection.id, machine: true },
    );
  }

  fields.push({
    label: copy.findingEvidence,
    value: selectedFinding === null ? t(copy.none, locale) : findingEvidence(selectedFinding, locale),
  });

  const placement = pending?.kind === "add" || pending?.kind === "move" ? pending : null;
  const placementNode = placement?.kind === "move"
    ? state.nodes.find((node) => node.id === placement.nodeId) ?? null
    : null;
  const placementFloor = placement?.kind === "add" ? placement.floorId : placementNode?.floorId ?? null;
  const snapBand = placement?.snap?.band ?? "none";
  const snapBandLabel = snapBand === "none" ? copy.outside : copy[snapBand];
  const displayedSnapBand = snapBand === "auto" || snapBand === "review"
    ? `${t(copy.provisional, locale)} · ${t(snapBandLabel, locale)}`
    : t(snapBandLabel, locale);
  const snapCandidateRelation = placement?.snap === undefined || placement.snap === null
    ? copy.none
    : placement.snap.sameFloor
      ? copy.sameFloorEvidence
      : copy.crossFloorEvidence;
  const profileDraft = pending?.kind === "profile" ? pending : null;
  const selectedExceptionDraft = pending?.kind === "exception"
    && pending.findingId === selectedFinding?.id
    ? pending
    : null;
  const otherExceptionDraft = pending?.kind === "exception"
    && pending.findingId !== selectedFinding?.id
    ? pending
    : null;
  const profileThresholdsValid = profileDraft !== null
    && Number.isFinite(profileDraft.autoSnapM)
    && Number.isFinite(profileDraft.reviewSnapM)
    && profileDraft.autoSnapM > 0
    && profileDraft.autoSnapM < profileDraft.reviewSnapM;
  const profileScopeValid = profileDraft?.scope === "graph";
  const profileReasonValid = profileDraft !== null && profileDraft.reason.trim() !== "";
  const profileValid = profileThresholdsValid && profileScopeValid && profileReasonValid;
  const connectorDraft = pending?.kind === "connect" ? pending : null;
  const connectorFrom = connectorDraft === null ? null : state.nodes.find((node) => node.id === connectorDraft.fromNodeId) ?? null;
  const connectorTo = connectorDraft?.toNodeId === null || connectorDraft === null
    ? null
    : state.nodes.find((node) => node.id === connectorDraft.toNodeId) ?? null;
  const connectorCrossFloor = connectorFrom !== null && connectorTo !== null && connectorFrom.floorId !== connectorTo.floorId;
  const connectorEndpointReady = connectorFrom !== null
    && connectorTo !== null
    && connectorFrom.id !== connectorTo.id;
  const connectorPathPoints: ScenePoint[] = connectorFrom !== null
    && connectorTo !== null
    && connectorDraft !== null
    && connectorFrom.id !== connectorTo.id
    ? [connectorFrom.point, ...connectorDraft.controlPoints, connectorTo.point]
    : [];
  const connectorGeometryReady = connectorEndpointReady
    && connectorPathPoints.every((point) =>
      Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z));
  const connectorAssociationReady = !connectorCrossFloor || connectorDraft?.associationConfirmed === true;
  const connectorDuplicate = connectorFrom !== null
    && connectorTo !== null
    && connectorFrom.id !== connectorTo.id
    && state.edges.some((edge) =>
      (edge.fromNodeId === connectorFrom.id && edge.toNodeId === connectorTo.id)
      || (edge.fromNodeId === connectorTo.id && edge.toNodeId === connectorFrom.id));
  const connectorReady = connectorEndpointReady
    && connectorGeometryReady
    && connectorAssociationReady
    && !connectorDuplicate;
  const connectorReadiness = !connectorEndpointReady
    ? copy.endpointEvidenceMissing
    : !connectorGeometryReady
      ? copy.geometryEvidenceInvalid
      : connectorDuplicate
        ? copy.duplicateDraft
        : !connectorAssociationReady
          ? copy.associationEvidenceMissing
          : copy.draftReady;
  const connectorFootprintEvidence = connectorDraft?.associationConfirmed !== true
    ? copy.associationRequired
    : connectorDraft.associationId === "stair-main"
      ? copy.stairFootprint
      : connectorDraft.associationId === "lift-east"
        ? copy.liftFootprint
        : copy.unassociatedEvidence;
  const connectorRise = connectorFrom !== null
    && connectorTo !== null
    && connectorFrom.id !== connectorTo.id
    ? Math.abs(connectorTo.point.z - connectorFrom.point.z)
    : 0;
  const connectorRun = connectorEndpointReady ? horizontalRun(connectorPathPoints) : 0;
  const floorDraft = pending?.kind === "reassign-floor" ? pending : null;
  const selectedFloorDraft = floorDraft?.nodeId === selectedNode?.id ? floorDraft : null;
  const deleteBlocked = pending?.kind === "delete"
    && pending.consequences.includes("structural-unusable:no-edges");
  const structuralValid = state.edges.length > 0 && state.nodes.length > 1 && state.notice !== "unusable-graph";
  const openCounts = {
    defect: state.findings.filter((finding) => finding.severity === "defect" && finding.state === "open").length,
    review: state.findings.filter((finding) => finding.severity === "review" && finding.state === "open").length,
    advisory: state.findings.filter((finding) => finding.severity === "advisory" && (finding.state === "open" || finding.state === "not-evaluated")).length,
  };
  const broadFinding = state.findings.find((finding) => finding.id === "unassociated-lift");
  const notice = state.notice === null
    ? null
    : state.notice === "duplicate-connection"
      ? copy.noticeDuplicate
      : state.notice === "unusable-graph"
        ? copy.noticeUnusable
        : copy.noticeGeometry;
  const delta = state.findingDelta === null ? null : findingDeltaText(state.findingDelta, locale);

  const commitPlacement = (mode: "snap" | "raw"): void => {
    if (placement?.kind === "add") actions.commitAdd(mode);
    else if (placement?.kind === "move") actions.commitMove(mode);
  };

  return (
    <aside className="graph-inspector" aria-labelledby="graph-inspector-title">
      <div className="graph-inspector__scroll">
      <header className="graph-inspector__header">
        <p>{selectionKind || t(copy.inspector, locale)}</p>
        <h2 id="graph-inspector-title">{selectionTitle}</h2>
      </header>

      {notice !== null || delta !== null ? (
        <div className="graph-inspector__status" role="status" aria-live="polite">
          {notice !== null ? <p>{t(notice, locale)}</p> : null}
          {delta !== null ? <p>{delta}</p> : null}
        </div>
      ) : null}

      {selection !== null ? (
        <dl className="graph-inspector__facts">
          {fields.map((field) => (
            <div key={field.label.en} className="graph-inspector__fact">
              <dt>{t(field.label, locale)}</dt>
              <dd className={field.machine ? "graph-inspector__machine" : undefined}>{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : <p className="graph-inspector__empty">{t(copy.noSelection, locale)}</p>}

      {selectedControlPoint !== null && selection?.kind === "control-point" ? (
        <section className="graph-inspector__section">
          <h3>{t(copy.nudgeControl, locale)}</h3>
          <div className="graph-inspector__axis-grid">
            {(["x", "y", "z"] as const).map((axis) => (
              <div key={axis}>
                <span className="graph-inspector__machine">{axis.toUpperCase()}</span>
                <button type="button" aria-label={`${t(copy.decrease, locale)} ${axis.toUpperCase()}`} onClick={() => actions.nudgeControlPoint(selection.edgeId, selectedControlPoint.id, axis, -0.25)}>−</button>
                <button type="button" aria-label={`${t(copy.increase, locale)} ${axis.toUpperCase()}`} onClick={() => actions.nudgeControlPoint(selection.edgeId, selectedControlPoint.id, axis, 0.25)}>+</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {placement !== null ? (
        <section className="graph-inspector__section graph-inspector__pending">
          <h3>{t(copy.pendingFix, locale)}</h3>
          <dl className="graph-inspector__facts">
            <div className="graph-inspector__fact"><dt>{t(copy.before, locale)}</dt><dd className="graph-inspector__machine">{placementNode === null ? t(copy.none, locale) : pointText(placementNode.point)}</dd></div>
            <div className="graph-inspector__fact"><dt>{t(copy.candidate, locale)}</dt><dd className="graph-inspector__machine">{pointText(placement.candidate)}</dd></div>
            <div className="graph-inspector__fact"><dt>{t(copy.candidateIdentity, locale)}</dt><dd className="graph-inspector__machine">{placement.snap?.candidateId ?? t(copy.none, locale)}</dd></div>
            <div className="graph-inspector__fact"><dt>{t(copy.candidateFloor, locale)}</dt><dd className="graph-inspector__machine">{placement.snap?.candidateFloorId ?? t(copy.none, locale)}</dd></div>
            <div className="graph-inspector__fact"><dt>{t(copy.distance, locale)}</dt><dd className="graph-inspector__machine">{placement.snap === null ? t(copy.none, locale) : `${placement.snap.distanceM.toFixed(2)} m`}</dd></div>
            <div className="graph-inspector__fact"><dt>{t(copy.confidence, locale)}</dt><dd className="graph-inspector__machine">{placement.snap === null ? t(copy.none, locale) : `${Math.round(placement.snap.confidence * 100)}%`}</dd></div>
            <div className="graph-inspector__fact"><dt>{t(copy.affectedAssociation, locale)}</dt><dd>{placement.snap === null ? t(copy.none, locale) : `${placement.snap.affectedAssociationId ?? t(copy.none, locale)} · ${t(copy.associationUnchanged, locale)}`}</dd></div>
            <div className="graph-inspector__fact"><dt>{t(copy.snapBand, locale)}</dt><dd>{displayedSnapBand}</dd></div>
            <div className="graph-inspector__fact"><dt>{t(copy.candidateRelation, locale)}</dt><dd>{t(snapCandidateRelation, locale)}</dd></div>
            <div className="graph-inspector__fact"><dt>{t(copy.floorInvariant, locale)}</dt><dd className="graph-inspector__machine">{placementFloor ?? t(copy.none, locale)}</dd></div>
          </dl>
          <p className="graph-inspector__snap-disclosure">
            <strong>{t(copy.provisionalDisclosure, locale)}</strong>{" "}
            {t(copy.provisionalThresholds, locale)}: {t(copy.auto, locale)} ≤ {state.profile.autoSnapM.toFixed(2)} m / {t(copy.review, locale)} ≤ {state.profile.reviewSnapM.toFixed(2)} m.{" "}
            <a href="https://github.com/dmalmq/imdf-map-application/issues/33" target="_blank" rel="noreferrer">{t(copy.issue33, locale)}</a>
          </p>
          {snapBand === "ambiguous" ? <p>{t(copy.ambiguousHelp, locale)}</p> : null}
        </section>
      ) : null}

      {connectorDraft !== null ? (
        <section className="graph-inspector__section graph-inspector__pending">
          <h3>{t(copy.connectorDraft, locale)}</h3>
          <div className="graph-inspector__endpoint-pair">
            <span>
              <small>{t(copy.from, locale)}</small>
              <strong className="graph-inspector__machine">{connectorFrom?.floorId ?? "—"} · {t(copy.sceneZContext, locale)} {connectorFrom?.point.z.toFixed(2) ?? "—"}</strong>
              <span className="graph-inspector__machine">{connectorDraft.fromNodeId}</span>
              {connectorFrom !== null ? <span className="graph-inspector__machine">{pointText(connectorFrom.point)}</span> : null}
            </span>
            <span>
              <small>{t(copy.to, locale)}</small>
              <strong className="graph-inspector__machine">{connectorTo?.floorId ?? "—"} · {t(copy.sceneZContext, locale)} {connectorTo?.point.z.toFixed(2) ?? "—"}</strong>
              <span className="graph-inspector__machine">{connectorDraft.toNodeId ?? "—"}</span>
              {connectorTo !== null ? <span className="graph-inspector__machine">{pointText(connectorTo.point)}</span> : null}
            </span>
          </div>
          {connectorTo === null ? <p>{t(copy.chooseEndpoint, locale)}</p> : null}

          {connectorEndpointReady ? (
            <>
              <h4>{t(copy.pathEvidence, locale)}</h4>
              <dl className="graph-inspector__facts">
                <div className="graph-inspector__fact"><dt>{t(copy.rise, locale)}</dt><dd className="graph-inspector__machine">{connectorRise.toFixed(2)} m</dd></div>
                <div className="graph-inspector__fact"><dt>{t(copy.run, locale)}</dt><dd className="graph-inspector__machine">{connectorRun.toFixed(2)} m</dd></div>
                <div className="graph-inspector__fact"><dt>{t(copy.monotonicZ, locale)}</dt><dd>{t(monotonicZLabel(connectorPathPoints), locale)}</dd></div>
              </dl>

              <h4>{t(copy.controlPoints, locale)} · {connectorDraft.controlPoints.length}</h4>
              {connectorDraft.controlPoints.length === 0 ? (
                <p>{t(copy.straightPath, locale)}</p>
              ) : (
                <ol className="graph-inspector__control-points">
                  {connectorDraft.controlPoints.map((point) => (
                    <li key={point.id}>
                      <strong className="graph-inspector__machine">{point.id}</strong>
                      <span className="graph-inspector__machine">{pointText(point)}</span>
                      <span>{t(copy.source, locale)}: {t(copy.landingSource, locale)}</span>
                      <span>{t(copy.provenance, locale)}: {t(copy.manual, locale)}</span>
                      <span className="graph-inspector__machine">{connectorFrom?.floorId} ↔ {connectorTo?.floorId} · {t(copy.sceneZContext, locale)} {point.z.toFixed(2)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          ) : null}

          {connectorCrossFloor ? (
            <>
              <fieldset className="graph-inspector__associations">
                <legend>{t(copy.association, locale)}</legend>
                <label><input type="radio" name="draft-association" checked={connectorDraft.associationConfirmed && connectorDraft.associationId === "stair-main"} onChange={() => actions.setDraftAssociation("stair-main")} />{t(copy.stairCandidate, locale)}</label>
                <label><input type="radio" name="draft-association" checked={connectorDraft.associationConfirmed && connectorDraft.associationId === "lift-east"} onChange={() => actions.setDraftAssociation("lift-east")} />{t(copy.liftCandidate, locale)}</label>
                <label><input type="radio" name="draft-association" checked={connectorDraft.associationConfirmed && connectorDraft.associationId === null} onChange={() => actions.setDraftAssociation(null)} />{t(copy.leaveUnassociated, locale)}</label>
              </fieldset>
              {!connectorDraft.associationConfirmed ? <p>{t(copy.associationRequired, locale)}</p> : null}
              <dl className="graph-inspector__facts graph-inspector__draft-evidence">
                <div className="graph-inspector__fact"><dt>{t(copy.footprintEvidence, locale)}</dt><dd>{t(connectorFootprintEvidence, locale)}</dd></div>
                <div className="graph-inspector__fact"><dt>{t(copy.directionSemantics, locale)}</dt><dd>{t(copy.directionUnresolved, locale)}</dd></div>
                <div className="graph-inspector__fact"><dt>{t(copy.accessibilitySemantics, locale)}</dt><dd>{t(copy.accessibilityUnresolved, locale)}</dd></div>
              </dl>
              <p className="graph-inspector__limitation"><strong>{t(copy.dataHonesty, locale)}:</strong> {t(copy.dataHonestyText, locale)}</p>
            </>
          ) : null}

          <p
            id="connector-readiness"
            className="graph-inspector__readiness"
            data-ready={connectorReady}
            role="status"
          >
            <strong>{t(copy.draftStructure, locale)}:</strong> {t(connectorReadiness, locale)}
          </p>
        </section>
      ) : null}

      {selectedNode !== null ? (
        <section className="graph-inspector__section">
          <h3>{t(copy.floorAssignment, locale)}</h3>
          {selectedFloorDraft !== null ? (
            <div className="graph-inspector__pending">
              <dl className="graph-inspector__facts">
                <div className="graph-inspector__fact"><dt>{t(copy.before, locale)}</dt><dd className="graph-inspector__machine">{selectedFloorDraft.fromFloorId} · Z {selectedNode.point.z.toFixed(2)}</dd></div>
                <div className="graph-inspector__fact"><dt>{t(copy.candidate, locale)}</dt><dd className="graph-inspector__machine">{selectedFloorDraft.toFloorId} · Z {selectedFloorDraft.toFloorId === "B1" ? "0.00" : "4.86"}</dd></div>
              </dl>
              <p>{t(copy.preserveAltitude, locale)}: <span className="graph-inspector__machine">{selectedNode.sourceAltitude?.toFixed(2) ?? "—"}</span></p>
              <h4>{t(copy.floorChangeConsequences, locale)}</h4>
              <ul>{selectedFloorDraft.consequences.map((item) => <li key={item}>{consequenceText(item, locale)}</li>)}</ul>
              <div className="graph-inspector__actions">
                <button type="button" className="graph-inspector__primary" onClick={actions.confirmNodeFloorReassignment}>{t(copy.confirmFloor, locale)}</button>
                <button type="button" onClick={actions.cancel}>{t(copy.cancel, locale)}</button>
              </div>
            </div>
          ) : (
            <details>
              <summary>{t(copy.reviewFloorChange, locale)} · <span className="graph-inspector__machine">{selectedNode.floorId} → {otherFloor(selectedNode.floorId)}</span></summary>
              <dl className="graph-inspector__facts">
                <div className="graph-inspector__fact"><dt>{t(copy.before, locale)}</dt><dd className="graph-inspector__machine">{selectedNode.floorId} · Z {selectedNode.point.z.toFixed(2)}</dd></div>
                <div className="graph-inspector__fact"><dt>{t(copy.candidate, locale)}</dt><dd className="graph-inspector__machine">{otherFloor(selectedNode.floorId)} · Z {otherFloor(selectedNode.floorId) === "B1" ? "0.00" : "4.86"}</dd></div>
              </dl>
              <p>{t(copy.preserveAltitude, locale)}: <span className="graph-inspector__machine">{selectedNode.sourceAltitude?.toFixed(2) ?? "—"}</span></p>
              {pending !== null ? <p>{t(copy.finishPendingFirst, locale)}</p> : null}
              <button type="button" disabled={pending !== null} onClick={() => actions.reassignNodeFloor(selectedNode.id, otherFloor(selectedNode.floorId))}>{t(copy.previewFloorConsequences, locale)}</button>
            </details>
          )}
        </section>
      ) : null}

      {selectedFinding !== null ? (
        <section className="graph-inspector__section">
          <h3>{t(copy.exception, locale)}</h3>
          {selectedExceptionDraft !== null ? (
            <>
              <label className="graph-inspector__field">
                <span>{t(copy.exceptionReason, locale)}</span>
                <textarea value={selectedExceptionDraft.reason} onChange={(event) => actions.updateExceptionReason(event.currentTarget.value)} />
              </label>
              {selectedExceptionDraft.reason.trim() === "" ? <p>{t(copy.reasonRequired, locale)}</p> : null}
              <div className="graph-inspector__actions">
                <button type="button" className="graph-inspector__primary" disabled={selectedExceptionDraft.reason.trim() === ""} onClick={actions.acceptException}>{t(copy.acceptException, locale)}</button>
                <button type="button" onClick={actions.cancel}>{t(copy.cancel, locale)}</button>
              </div>
            </>
          ) : otherExceptionDraft !== null ? (
            <>
              <p>{t(copy.exceptionDraftElsewhere, locale)}: {t(findingTitles[otherExceptionDraft.findingId], locale)}</p>
              <button type="button" onClick={actions.cancel}>{t(copy.cancel, locale)}</button>
            </>
          ) : selectedFinding.state === "accepted" && selectedFinding.exceptionReason !== null ? (
            <p><strong>{t(copy.acceptedReason, locale)}:</strong> {selectedFinding.exceptionReason}</p>
          ) : selectedFinding.state === "open" || selectedFinding.state === "not-evaluated" ? (
            <button type="button" disabled={pending !== null} onClick={() => actions.beginException(selectedFinding.id)}>{t(copy.acceptException, locale)}</button>
          ) : (
            <p>{t(findingStateCopy[selectedFinding.state], locale)}</p>
          )}
        </section>
      ) : null}

      <section className="graph-inspector__section">
        <h3>{t(copy.profile, locale)}</h3>
        {profileDraft === null ? (
          <>
            <dl className="graph-inspector__facts">
              <div className="graph-inspector__fact"><dt>{t(copy.autoThreshold, locale)}</dt><dd className="graph-inspector__machine">{state.profile.autoSnapM.toFixed(2)} m</dd></div>
              <div className="graph-inspector__fact"><dt>{t(copy.reviewThreshold, locale)}</dt><dd className="graph-inspector__machine">{state.profile.reviewSnapM.toFixed(2)} m</dd></div>
              <div className="graph-inspector__fact"><dt>{t(copy.overrideScope, locale)}</dt><dd>{t(state.profile.overrideScope === "graph" ? copy.graphScope : copy.noOverride, locale)}</dd></div>
              <div className="graph-inspector__fact"><dt>{t(copy.overrideReason, locale)}</dt><dd>{state.profile.overrideReason ?? t(copy.none, locale)}</dd></div>
            </dl>
            <button type="button" disabled={pending !== null} onClick={() => actions.updateProfileDraft(state.profile.autoSnapM, state.profile.reviewSnapM, state.profile.overrideScope, "")}>{t(copy.editProfile, locale)}</button>
          </>
        ) : (
          <>
            <dl className="graph-inspector__profile-comparison">
              <div>
                <dt>{t(copy.before, locale)}</dt>
                <dd className="graph-inspector__machine">
                  <span>{t(copy.autoThreshold, locale)}: {state.profile.autoSnapM.toFixed(2)} m</span>
                  <span>{t(copy.reviewThreshold, locale)}: {state.profile.reviewSnapM.toFixed(2)} m</span>
                </dd>
              </div>
              <div>
                <dt>{t(copy.newValues, locale)}</dt>
                <dd className="graph-inspector__machine">
                  <span>{t(copy.autoThreshold, locale)}: {Number.isFinite(profileDraft.autoSnapM) ? profileDraft.autoSnapM.toFixed(2) : "—"} m</span>
                  <span>{t(copy.reviewThreshold, locale)}: {Number.isFinite(profileDraft.reviewSnapM) ? profileDraft.reviewSnapM.toFixed(2) : "—"} m</span>
                </dd>
              </div>
            </dl>
            <label className="graph-inspector__field"><span>{t(copy.autoThreshold, locale)}</span><input type="number" min="0.01" step="0.01" value={profileDraft.autoSnapM} onChange={(event) => actions.updateProfileDraft(Number(event.currentTarget.value), profileDraft.reviewSnapM, profileDraft.scope, profileDraft.reason)} /></label>
            <label className="graph-inspector__field"><span>{t(copy.reviewThreshold, locale)}</span><input type="number" min="0.02" step="0.01" value={profileDraft.reviewSnapM} onChange={(event) => actions.updateProfileDraft(profileDraft.autoSnapM, Number(event.currentTarget.value), profileDraft.scope, profileDraft.reason)} /></label>
            <label className="graph-inspector__field">
              <span>{t(copy.overrideScope, locale)}</span>
              <select value={profileDraft.scope ?? ""} required aria-invalid={!profileScopeValid} onChange={(event) => actions.updateProfileDraft(profileDraft.autoSnapM, profileDraft.reviewSnapM, event.currentTarget.value === "graph" ? "graph" : null, profileDraft.reason)}>
                <option value="" disabled>{t(copy.chooseScope, locale)}</option>
                <option value="graph">{t(copy.graphScope, locale)}</option>
              </select>
            </label>
            <label className="graph-inspector__field"><span>{t(copy.overrideReason, locale)}</span><textarea required aria-invalid={!profileReasonValid} value={profileDraft.reason} onChange={(event) => actions.updateProfileDraft(profileDraft.autoSnapM, profileDraft.reviewSnapM, profileDraft.scope, event.currentTarget.value)} /></label>
            {!profileThresholdsValid ? <p>{t(copy.invalidProfile, locale)}</p> : null}
            {!profileScopeValid ? <p>{t(copy.scopeRequired, locale)}</p> : null}
            {!profileReasonValid ? <p>{t(copy.reasonRequired, locale)}</p> : null}
            <div className="graph-inspector__actions">
              <button type="button" className="graph-inspector__primary" disabled={!profileValid} onClick={actions.commitProfileOverride}>{t(copy.commitProfile, locale)}</button>
              <button type="button" onClick={actions.cancel}>{t(copy.cancel, locale)}</button>
            </div>
          </>
        )}
      </section>

      {pending?.kind === "delete" ? (
        <section className="graph-inspector__section graph-inspector__pending">
          <h3>{t(copy.deletePreview, locale)}</h3>
          <ul>{pending.consequences.map((item) => <li key={item}>{consequenceText(item, locale)}</li>)}</ul>
        </section>
      ) : null}

      <section className="graph-inspector__section graph-inspector__check">
        <h3>{t(copy.checks, locale)}</h3>
        <dl className="graph-inspector__facts">
          <div className="graph-inspector__fact"><dt>{t(copy.structural, locale)}</dt><dd>{t(structuralValid ? copy.structuralValid : copy.structuralInvalid, locale)}</dd></div>
          <div className="graph-inspector__fact"><dt>{t(copy.semantic, locale)}</dt><dd className="graph-inspector__machine">{locale === "ja" ? `欠陥 ${openCounts.defect} · レビュー ${openCounts.review} · 助言 ${openCounts.advisory}` : `Defect ${openCounts.defect} · Review ${openCounts.review} · Advisory ${openCounts.advisory}`}</dd></div>
          <div className="graph-inspector__fact"><dt>{t(copy.broadRule, locale)}</dt><dd>{state.checkState === "checking" ? t(copy.checking, locale) : broadFinding === undefined ? t(copy.notEvaluated, locale) : t(findingStateCopy[broadFinding.state], locale)}</dd></div>
        </dl>
        <button type="button" disabled={state.checkState === "checking"} onClick={actions.runCheck}>{state.checkState === "checking" ? t(copy.checking, locale) : state.checkState === "complete" ? t(copy.checked, locale) : t(copy.runCheck, locale)}</button>

        <h4>{t(copy.stagedChanges, locale)}</h4>
        {state.stagedChanges.length === 0 ? <p>{t(copy.noChanges, locale)}</p> : <ol className="graph-inspector__changes">{state.stagedChanges.map((change, index) => <li key={`${change}-${index}`}>{stagedChangeText(change, locale)}</li>)}</ol>}

        {state.saveState === "idle" ? (
          <button type="button" className="graph-inspector__primary" disabled={!structuralValid || state.checkState !== "complete" || state.stagedChanges.length === 0} onClick={actions.requestSave}>{t(copy.requestSave, locale)}</button>
        ) : state.saveState === "confirming" ? (
          <div className="graph-inspector__save-confirmation">
            <p>{t(copy.saveConfirmation, locale)}</p>
            <button type="button" className="graph-inspector__primary" onClick={actions.confirmSave}>{t(copy.confirmSave, locale)}</button>
          </div>
        ) : <p className="graph-inspector__saved" role="status">{t(copy.saved, locale)}</p>}
      </section>
      </div>
      {placement !== null || connectorDraft !== null || pending?.kind === "delete" ? (
        <div className="graph-inspector__action-dock">
          {placement !== null ? (
            <>
              {snapBand === "auto" ? <button type="button" className="graph-inspector__primary" onClick={() => commitPlacement("snap")}>{t(copy.applySnap, locale)}</button> : null}
              {snapBand === "review" ? <button type="button" className="graph-inspector__primary" onClick={() => commitPlacement("snap")}>{t(copy.acceptCandidate, locale)}</button> : null}
              {snapBand === "review" || snapBand === "ambiguous" || snapBand === "none" ? <button type="button" onClick={() => commitPlacement("raw")}>{t(copy.keepRaw, locale)}</button> : null}
              <button type="button" onClick={actions.cancel}>{t(copy.cancel, locale)}</button>
            </>
          ) : connectorDraft !== null ? (
            <>
              {connectorCrossFloor && connectorFrom !== null && connectorTo !== null ? (
                <button
                  type="button"
                  disabled={connectorDraft.controlPoints.length > 0}
                  onClick={() => actions.addConnectorControlPoint({
                    x: (connectorFrom.point.x + connectorTo.point.x) / 2,
                    y: (connectorFrom.point.y + connectorTo.point.y) / 2,
                    z: (connectorFrom.point.z + connectorTo.point.z) / 2,
                  })}
                >
                  {t(copy.addLanding, locale)}
                </button>
              ) : null}
              <button type="button" className="graph-inspector__primary" disabled={!connectorReady} aria-describedby="connector-readiness" onClick={actions.commitConnection}>{t(connectorCrossFloor ? copy.commitConnector : copy.commitConnection, locale)}</button>
              <button type="button" onClick={actions.cancel}>{t(copy.cancel, locale)}</button>
            </>
          ) : pending?.kind === "delete" ? (
            <>
              <button type="button" className="graph-inspector__danger" disabled={deleteBlocked} onClick={actions.confirmDelete}>{t(copy.confirmDelete, locale)}</button>
              <button type="button" onClick={actions.cancel}>{t(copy.cancel, locale)}</button>
            </>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
