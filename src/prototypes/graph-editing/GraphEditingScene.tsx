import { useRef, useState } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from "react";
import type {
  FloorId,
  GraphEdge,
  GraphEditorPrototypeState,
  GraphFinding,
  GraphSelection,
  ScenePoint,
  SnapBand,
} from "./graphEditingModel";
import type { GraphEditorPrototypeActions } from "./useGraphEditingPrototype";

/**
 * GraphEditingScene is a renderer-neutral, self-contained exploded view over
 * the Task 1 graph-editor contract. It owns projection, SVG markup,
 * pointer-to-floor coordinate conversion, and the semantic scene controls
 * (tools, camera presets, object list, control-point nudging). It never
 * classifies snap bands or mutates findings — it only calls the supplied
 * actions and reflects `state`.
 */

export interface GraphEditingSceneProps {
  state: GraphEditorPrototypeState;
  actions: GraphEditorPrototypeActions;
}

type CameraPreset = "perspective" | "top";

const COLOR = {
  selected: "#4f46e5", // indigo-600
  defect: "#dc2626", // red-600
  review: "#d97706", // amber-600
  advisory: "#6b7280", // muted gray-500
  node: "#0f172a",
  edge: "#334155",
  connector: "#0ea5e9",
  controlPoint: "#0f172a",
  venueStair: "#a16207",
  venueLift: "#475569",
  floorStroke: "#cbd5e1",
  floorFill: "#ffffff",
  floorLabel: "#475569",
} as const;

const SNAP_COLOR: Record<SnapBand, string> = {
  auto: "#16a34a",
  review: COLOR.review,
  ambiguous: "#9ca3af",
  none: COLOR.defect,
};

/** Floor base scene Z used to project floor planes and invert pointer hits. */
const FLOOR_Z: Record<FloorId, number> = { B1: 0, "1F": 4.86 };

const FLOOR_RECT = { x: 90, y: 150, w: 540, h: 300 } as const;

const NUDGE_STEP: Record<"x" | "y" | "z", number> = { x: 4, y: 4, z: 0.5 };

interface VenueFootprint {
  id: string;
  kind: "stair" | "lift";
  floorId: FloorId;
  polygon: Array<[number, number]>;
  label: { ja: string; en: string };
}

/** Static venue evidence footprints referenced by findings / associations. */
const VENUES: readonly VenueFootprint[] = [
  {
    id: "stair-main",
    kind: "stair",
    floorId: "B1",
    polygon: [
      [284, 284],
      [316, 284],
      [316, 316],
      [284, 316],
    ],
    label: { ja: "階段（主）", en: "Stair (main)" },
  },
  {
    id: "lift-east",
    kind: "lift",
    floorId: "1F",
    polygon: [
      [434, 286],
      [470, 286],
      [470, 322],
      [434, 322],
    ],
    label: { ja: "エレベーター（東）", en: "Lift (east)" },
  },
];

const labels = {
  sceneTitle: { ja: "グラフ編集シーン", en: "Graph editing scene" },
  sceneHint: { ja: "シーンを選択後 S/P/C/D・Esc・Ctrl+Z", en: "Focus scene: S/P/C/D · Esc · Ctrl+Z" },
  toolGroup: { ja: "ツール", en: "Tools" },
  cameraGroup: { ja: "カメラ", en: "Camera" },
  select: { ja: "選択 (S)", en: "Select (S)" },
  add: { ja: "追加 (P)", en: "Add (P)" },
  connect: { ja: "接続 (C)", en: "Connect (C)" },
  delete: { ja: "削除 (D)", en: "Delete (D)" },
  perspective: { ja: "パース", en: "Perspective" },
  top: { ja: "上面", en: "Top" },
  objectList: { ja: "オブジェクト一覧", en: "Objects" },
  node: { ja: "ノード", en: "Node" },
  edge: { ja: "辺", en: "Edge" },
  connector: { ja: "コネクタ", en: "Connector" },
  controlPoint: { ja: "制御点", en: "Control point" },
  connectorDraft: { ja: "接続ドラフト", en: "Connector draft" },
  draftFrom: { ja: "開始", en: "From" },
  draftTo: { ja: "終了", en: "To" },
  landing: { ja: "踊り場", en: "Landing" },
  venue: { ja: "施設", en: "Venue" },
  stair: { ja: "階段", en: "Stair" },
  lift: { ja: "エレベーター", en: "Lift" },
  sceneZ: { ja: "シーン Z", en: "Scene Z" },
  defect: { ja: "不具合", en: "Defect" },
  review: { ja: "確認", en: "Review" },
  advisory: { ja: "助言", en: "Advisory" },
  legend: { ja: "凡例", en: "Legend" },
  selected: { ja: "選択中", en: "Selected" },
  moveHandle: { ja: "移動ハンドル（XY）", en: "Move handle (XY)" },
  nudgeTitle: { ja: "制御点を軸移動", en: "Nudge control point" },
  nudgeHint: { ja: "軸ボタンで 1 ステップ移動", en: "Axis buttons move one step" },
  empty: { ja: "選択可能なオブジェクトがありません", en: "No selectable objects" },
  snapAuto: { ja: "自動スナップ", en: "Auto snap" },
  snapReview: { ja: "確認スナップ", en: "Review snap" },
  snapAmbiguous: { ja: "曖昧", en: "Ambiguous" },
  snapNone: { ja: "スナップなし", en: "No snap" },
} as const;

type Locale = GraphEditorPrototypeState["locale"];

function t(entry: { ja: string; en: string }, locale: Locale): string {
  return entry[locale];
}

const SNAP_BAND_LABEL: Record<SnapBand, { ja: string; en: string }> = {
  auto: labels.snapAuto,
  review: labels.snapReview,
  ambiguous: labels.snapAmbiguous,
  none: labels.snapNone,
};

function snapBandLabel(band: SnapBand, locale: Locale): string {
  return t(SNAP_BAND_LABEL[band], locale);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function floorOffsetFor(floorId: FloorId): number {
  return floorId === "1F" ? -150 : 90;
}

/** Core projection: maps a scene point to SVG user-space using an explicit floor offset. */
function projectWithOffset(point: ScenePoint, offset: number, preset: CameraPreset): [number, number] {
  if (preset === "top") return [point.x, point.y + offset];
  return [point.x + point.y * 0.34, point.y * 0.62 + offset - point.z * 4];
}

/** Stable projection shared by all scene geometry (Task 2 Step 1). */
function project(point: ScenePoint, floorId: FloorId, preset: CameraPreset): [number, number] {
  return projectWithOffset(point, floorOffsetFor(floorId), preset);
}

/** Inverse of `projectWithOffset` for a fixed Z, shared by floor and connector controls. */
function invertProjectWithOffset(
  local: { x: number; y: number },
  offset: number,
  preset: CameraPreset,
  z: number,
): { x: number; y: number } {
  let x: number;
  let y: number;
  if (preset === "top") {
    x = local.x;
    y = local.y - offset;
  } else {
    y = (local.y - offset + z * 4) / 0.62;
    x = local.x - y * 0.34;
  }
  return { x: clamp(x, 0, 760), y: clamp(y, 0, 620) };
}

/** Inverse of `project` for a fixed floor, used to convert pointer hits to bounded floor XY. */
function invertProject(
  local: { x: number; y: number },
  floorId: FloorId,
  preset: CameraPreset,
  z: number,
): { x: number; y: number } {
  return invertProjectWithOffset(local, floorOffsetFor(floorId), preset, z);
}

/** Pointer → SVG user-space coordinates via the inverse screen CTM (Task 2 Step 3). */
function localPointer(
  svg: SVGSVGElement,
  event: { clientX: number; clientY: number },
): { x: number; y: number } {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const ctm = svg.getScreenCTM();
  const local = ctm ? point.matrixTransform(ctm.inverse()) : { x: event.clientX, y: event.clientY };
  return { x: local.x, y: local.y };
}

function severityColor(severity: GraphFinding["severity"]): string {
  return severity === "defect" ? COLOR.defect : severity === "review" ? COLOR.review : COLOR.advisory;
}

function sameSelection(a: GraphSelection, b: GraphSelection): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "control-point" && b.kind === "control-point") {
    return a.edgeId === b.edgeId && a.id === b.id;
  }
  return a.id === b.id;
}

function diamondPoints(cx: number, cy: number, size: number): string {
  return `${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`;
}

const styles = {
  root: {
    fontFamily: "inherit",
    fontSize: 12,
    color: "var(--color-text)",
    outline: "none",
    background: "#fff",
    border: "1px solid var(--color-border)",
    borderRadius: 8,
    overflow: "hidden",
  } as CSSProperties,
  toolbar: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    alignItems: "center",
    padding: "8px 10px",
    borderBottom: "1px solid var(--color-border)",
  } as CSSProperties,
  group: { display: "flex", gap: 4, alignItems: "center" } as CSSProperties,
  groupLabel: { fontSize: 10, color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: 0.4 } as CSSProperties,
  hint: { fontSize: 10, color: "var(--color-muted)" } as CSSProperties,
  svg: {
    width: "100%",
    height: "auto",
    display: "block",
    background: "#f1f5f9",
    touchAction: "none",
  } as CSSProperties,
  list: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
    gap: 4,
    padding: "8px 10px",
    margin: 0,
    listStyle: "none",
    maxHeight: 168,
    overflow: "auto",
    borderTop: "1px solid var(--color-border)",
    background: "#f8fafc",
  } as CSSProperties,
  listBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    padding: "4px 6px",
    border: "1px solid var(--color-border)",
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
    textAlign: "left",
    width: "100%",
  } as CSSProperties,
  listBtnActive: {
    borderColor: COLOR.selected,
    background: "#eef2ff",
    color: COLOR.selected,
  } as CSSProperties,
  swatch: { width: 9, height: 9, borderRadius: 2, display: "inline-block", flex: "0 0 auto" } as CSSProperties,
  nudge: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
    padding: "8px 10px",
    borderTop: "1px solid var(--color-border)",
    background: "var(--color-warning-bg)",
  } as CSSProperties,
} as const;

function btnStyle(active: boolean): CSSProperties {
  return {
    fontSize: 11,
    padding: "3px 8px",
    border: `1px solid ${active ? COLOR.selected : "var(--color-border)"}`,
    borderRadius: 6,
    background: active ? COLOR.selected : "#fff",
    color: active ? "#fff" : "var(--color-text)",
    cursor: "pointer",
  };
}

const NUDGE_BTN_STYLE: CSSProperties = {
  fontSize: 11,
  padding: "2px 7px",
  border: "1px solid #fcd34d",
  borderRadius: 6,
  background: "#fff",
  color: "#92400e",
  cursor: "pointer",
  minWidth: 36,
};

const FLOOR_ORDER: readonly FloorId[] = ["B1", "1F"];

export function GraphEditingScene({ state, actions }: GraphEditingSceneProps): ReactElement {
  const { locale, cameraPreset: preset } = state;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const movedRef = useRef(false);
  const dragStartLocal = useRef<{ x: number; y: number } | null>(null);
  const releasingRef = useRef(false);

  const nodesById = new Map(state.nodes.map((node) => [node.id, node]));

  const findingTargets = state.findings.map((finding) => ({
    finding,
    target: resolveFindingTarget(finding, nodesById, state.edges, preset),
  }));
  // A finding drives fade only while its target still resolves in the current
  // graph/venue scene. Closed or stale selections keep their reducer-owned
  // selection state, but do not make every surviving object look inactive.
  const selectedFindingTarget =
    state.selectedFindingId === null
      ? null
      : (findingTargets.find(({ finding }) => finding.id === state.selectedFindingId) ?? null);
  const focusedFinding =
    selectedFindingTarget !== null &&
    selectedFindingTarget.target !== null &&
    (selectedFindingTarget.finding.state === "open" ||
      selectedFindingTarget.finding.state === "not-evaluated")
      ? selectedFindingTarget.finding
      : null;
  const findingFocus = (() => {
    if (focusedFinding === null) return null;

    const floorIds = new Set<FloorId>();
    const objectIds = new Set<string>([focusedFinding.objectId]);
    const addVenueEvidence = (venueId: string | null): void => {
      if (venueId === null) return;
      const venue = VENUES.find((candidate) => candidate.id === venueId);
      if (venue === undefined) return;
      objectIds.add(venue.id);
      floorIds.add(venue.floorId);
    };

    const node = nodesById.get(focusedFinding.objectId);
    if (node !== undefined) {
      floorIds.add(node.floorId);
      for (const edge of state.edges) {
        if (edge.fromNodeId === node.id || edge.toNodeId === node.id) {
          addVenueEvidence(edge.associationId);
        }
      }
      return { floorIds, objectIds };
    }

    const edge = state.edges.find((candidate) => candidate.id === focusedFinding.objectId);
    if (edge !== undefined) {
      const from = nodesById.get(edge.fromNodeId);
      const to = nodesById.get(edge.toNodeId);
      if (from === undefined || to === undefined) return null;
      floorIds.add(from.floorId);
      floorIds.add(to.floorId);
      addVenueEvidence(edge.associationId);
      return { floorIds, objectIds };
    }

    const venue = VENUES.find((candidate) => candidate.id === focusedFinding.objectId);
    if (venue === undefined) return null;
    floorIds.add(venue.floorId);
    return { floorIds, objectIds };
  })();

  function floorOpacity(floorId: FloorId): number {
    return findingFocus === null || findingFocus.floorIds.has(floorId) ? 1 : 0.35;
  }
  function objectOpacity(objectId: string): number {
    return findingFocus === null || findingFocus.objectIds.has(objectId) ? 1 : 0.35;
  }
  function effectiveOpacity(floorId: FloorId, objectId: string): number {
    if (findingFocus === null) return 1;
    return findingFocus.floorIds.has(floorId) && findingFocus.objectIds.has(objectId) ? 1 : 0.35;
  }

  function isSelected(selection: GraphSelection): boolean {
    return sameSelection(state.selection, selection);
  }

  /** Dispatch the gesture appropriate to the active tool for a graph/venue object. */
  function activateSelection(selection: Exclude<GraphSelection, null>): void {
    const current = stateRef.current;
    const connecting = current.tool === "connect" || current.pending?.kind === "connect";
    if (selection.kind === "node" && connecting) {
      if (current.pending?.kind === "connect") {
        actions.chooseConnectionEndpoint(selection.id);
      } else {
        actions.beginConnection(selection.id);
      }
      return;
    }
    if (current.tool === "delete" && selection.kind !== "venue") {
      actions.requestDelete(selection);
      return;
    }
    actions.selectObject(selection);
  }

  function onBackgroundClick(event: ReactMouseEvent<SVGElement>): void {
    const current = stateRef.current;
    const svg = svgRef.current;
    if (current.tool === "add") {
      if (svg === null) return;
      const floorId = current.activeFloor;
      const local = localPointer(svg, event);
      const point = invertProject(local, floorId, current.cameraPreset, FLOOR_Z[floorId]);
      actions.previewAdd(point);
      return;
    }
    if (current.tool === "select" || current.tool === "move") {
      actions.selectObject(null);
    }
  }

  function moveDraftControlPoint(
    event: ReactPointerEvent<SVGElement>,
    pointId: string,
  ): void {
    event.stopPropagation();
    const target = event.currentTarget as Element;
    if (!target.hasPointerCapture(event.pointerId)) return;
    const svg = svgRef.current;
    const pending = stateRef.current.pending;
    if (svg === null || pending?.kind !== "connect" || pending.toNodeId === null) return;
    const point = pending.controlPoints.find((candidate) => candidate.id === pointId);
    const from = stateRef.current.nodes.find((candidate) => candidate.id === pending.fromNodeId);
    const to = stateRef.current.nodes.find((candidate) => candidate.id === pending.toNodeId);
    if (point === undefined || from === undefined || to === undefined) return;
    const local = localPointer(svg, event);
    const next = invertProjectWithOffset(
      local,
      connectorControlOffset(point.z, from.floorId, to.floorId),
      stateRef.current.cameraPreset,
      point.z,
    );
    actions.updateDraftControlPoint(point.id, { ...point, ...next });
  }

  // --- Floor-constrained node movement (Task 2 Step 3) ---
  function applyMove(event: ReactPointerEvent<SVGElement>, nodeId: string): void {
    const svg = svgRef.current;
    if (svg === null) return;
    const node = stateRef.current.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) return;
    const local = localPointer(svg, event);
    const point = invertProject(local, node.floorId, stateRef.current.cameraPreset, node.point.z);
    actions.previewMove(nodeId, point);
  }

  function startMove(event: ReactPointerEvent<SVGElement>, nodeId: string): void {
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    setDragNodeId(nodeId);
    movedRef.current = false;
    const svg = svgRef.current;
    // Record the pointer origin; do NOT preview until real XY displacement so
    // a click on the handle preserves any existing pending draft.
    dragStartLocal.current = svg === null ? null : localPointer(svg, event);
  }
  function onHandlePointerMove(event: ReactPointerEvent<SVGElement>): void {
    if (dragNodeId === null) return;
    const svg = svgRef.current;
    if (svg === null || dragStartLocal.current === null) return;
    // The displacement threshold gates only the FIRST preview, preserving any
    // existing pending draft on a click. Once movement has begun, every
    // subsequent coordinate is forwarded so the candidate stays current —
    // including a return-to-origin, which commitOrCancelMove recognizes as
    // a no-op.
    if (!movedRef.current) {
      const current = localPointer(svg, event);
      const dx = current.x - dragStartLocal.current.x;
      const dy = current.y - dragStartLocal.current.y;
      if (Math.hypot(dx, dy) <= 0.5) return;
      movedRef.current = true;
    }
    applyMove(event, dragNodeId);
  }

  function commitOrCancelMove(): void {
    const pending = stateRef.current.pending;
    if (pending?.kind !== "move") return;
    const node = stateRef.current.nodes.find((candidate) => candidate.id === pending.nodeId);
    // Same-coordinate gesture (returned to origin): no net change, no history entry.
    const sameCoords =
      node !== undefined &&
      Math.abs(pending.candidate.x - node.point.x) < 0.01 &&
      Math.abs(pending.candidate.y - node.point.y) < 0.01;
    if (sameCoords) {
      actions.cancel();
      return;
    }
    const band = pending.snap?.band ?? "none";
    if (band === "auto") {
      actions.commitMove("snap");
    } else if (band === "review") {
      // Preserve the pending draft for the inspector to commit explicitly.
    } else {
      actions.commitMove("raw");
    }
  }

  function resetDragState(): void {
    setDragNodeId(null);
    movedRef.current = false;
    dragStartLocal.current = null;
  }

  function endMove(event: ReactPointerEvent<SVGElement>): void {
    if (dragNodeId === null) return;
    if (movedRef.current) {
      commitOrCancelMove();
    }
    // When movedRef is false (no real displacement) we leave any existing
    // Review draft untouched — no preview was issued, nothing to commit.
    // Mark this as an expected release so the synchronous lostpointercapture
    // callback (fired by releasePointerCapture) does not cancel the result.
    releasingRef.current = true;
    const el = event.currentTarget as Element;
    if (el.hasPointerCapture(event.pointerId)) {
      el.releasePointerCapture(event.pointerId);
    }
    releasingRef.current = false;
    resetDragState();
  }

  function cancelDrag(): void {
    // Expected release (endMove already handled commit + state reset).
    if (releasingRef.current) return;
    if (dragNodeId === null) return;
    // Unexpected capture loss / pointer cancel: discard any pending preview.
    if (movedRef.current) {
      actions.cancel();
    }
    resetDragState();
    // Do not call releasePointerCapture — the capture was already lost or
    // the browser auto-released on cancel.
  }


  function floorPolygonPoints(floorId: FloorId): string {
    const z = FLOOR_Z[floorId];
    const corners: Array<[number, number]> = [
      [FLOOR_RECT.x, FLOOR_RECT.y],
      [FLOOR_RECT.x + FLOOR_RECT.w, FLOOR_RECT.y],
      [FLOOR_RECT.x + FLOOR_RECT.w, FLOOR_RECT.y + FLOOR_RECT.h],
      [FLOOR_RECT.x, FLOOR_RECT.y + FLOOR_RECT.h],
    ];
    return corners
      .map(([x, y]) => {
        const projected = project({ x, y, z }, floorId, preset);
        return `${round(projected[0], 2)} ${round(projected[1], 2)}`;
      })
      .join(" ");
  }

  function venuePolygonPoints(venue: VenueFootprint): string {
    const z = FLOOR_Z[venue.floorId];
    return venue.polygon
      .map(([x, y]) => {
        const projected = project({ x, y, z }, venue.floorId, preset);
        return `${round(projected[0], 2)} ${round(projected[1], 2)}`;
      })
      .join(" ");
  }

  function connectorControlOffset(z: number, fromFloor: FloorId, toFloor: FloorId): number {
    const zFrom = FLOOR_Z[fromFloor];
    const zTo = FLOOR_Z[toFloor];
    if (zTo === zFrom) return floorOffsetFor(fromFloor);
    const ratio = clamp((z - zFrom) / (zTo - zFrom), 0, 1);
    return lerp(floorOffsetFor(fromFloor), floorOffsetFor(toFloor), ratio);
  }

  const selectedNode =
    state.selection !== null && state.selection.kind === "node"
      ? (nodesById.get(state.selection.id) ?? null)
      : null;

  const selectedControlPoint: {
    edge: GraphEditorPrototypeState["edges"][number];
    point: GraphEditorPrototypeState["edges"][number]["controlPoints"][number];
  } | null = (() => {
    const selection = state.selection;
    if (selection === null || selection.kind !== "control-point") return null;
    const edge = state.edges.find((candidate) => candidate.id === selection.edgeId);
    if (edge === undefined) return null;
    const point = edge.controlPoints.find((candidate) => candidate.id === selection.id);
    if (point === undefined) return null;
    return { edge, point };
  })();

  // Pending draft markers (move/add) visualize the uncommitted candidate so
  // Review-band drafts remain visible while they wait for the inspector.
  const pendingMarker = (() => {
    const pending = state.pending;
    if (pending === null) return null;
    if (pending.kind === "add") {
      const projected = project(pending.candidate, pending.floorId, preset);
      return { kind: "add" as const, x: projected[0], y: projected[1], band: pending.snap?.band ?? "none" };
    }
    if (pending.kind === "move") {
      const node = nodesById.get(pending.nodeId);
      if (node === undefined) return null;
      const projected = project(pending.candidate, node.floorId, preset);
      return { kind: "move" as const, x: projected[0], y: projected[1], band: pending.snap?.band ?? "none" };
    }
    return null;
  })();

  const pendingConnector = (() => {
    const pending = state.pending;
    if (pending?.kind !== "connect" || pending.toNodeId === null) return null;
    const from = nodesById.get(pending.fromNodeId);
    const to = nodesById.get(pending.toNodeId);
    if (from === undefined || to === undefined || from.id === to.id) return null;
    const fromXY = project(from.point, from.floorId, preset);
    const toXY = project(to.point, to.floorId, preset);
    const controlProjected = pending.controlPoints.map((control) => ({
      control,
      xy: projectWithOffset(
        control,
        connectorControlOffset(control.z, from.floorId, to.floorId),
        preset,
      ),
    }));
    const segments = [`M ${round(fromXY[0], 2)} ${round(fromXY[1], 2)}`];
    for (const entry of controlProjected) {
      segments.push(`L ${round(entry.xy[0], 2)} ${round(entry.xy[1], 2)}`);
    }
    segments.push(`L ${round(toXY[0], 2)} ${round(toXY[1], 2)}`);
    return {
      from,
      to,
      fromXY,
      toXY,
      controlProjected,
      path: segments.join(" "),
      color: from.floorId === to.floorId ? COLOR.edge : COLOR.connector,
    };
  })();


  const objectList = selectableObjectList(state, locale);

  return (
    <section
      className="graph-editing-scene"
      tabIndex={0}
      aria-label={t(labels.sceneTitle, locale)}
      style={styles.root}
    >
      <div className="graph-editing-scene__toolbar" style={styles.toolbar}>
        <div className="graph-editing-scene__tool-group" style={styles.group}>
          <span style={styles.groupLabel}>{t(labels.toolGroup, locale)}</span>
          {(["select", "add", "connect", "delete"] as const).map((tool) => (
            <button
              key={tool}
              type="button"
              aria-pressed={state.tool === tool}
              style={btnStyle(state.tool === tool)}
              onClick={() => actions.setTool(tool)}
            >
              {t(labels[tool], locale)}
            </button>
          ))}
        </div>
        <div className="graph-editing-scene__camera-group" style={styles.group}>
          <span style={styles.groupLabel}>{t(labels.cameraGroup, locale)}</span>
          {(["perspective", "top"] as const).map((camera) => (
            <button
              key={camera}
              type="button"
              aria-pressed={preset === camera}
              style={btnStyle(preset === camera)}
              onClick={() => actions.setCameraPreset(camera)}
            >
              {t(labels[camera], locale)}
            </button>
          ))}
        </div>
        <div className="graph-editing-scene__legend" style={{ ...styles.group, marginLeft: "auto" }}>
          <span style={styles.groupLabel}>{t(labels.legend, locale)}</span>
          <span style={styles.group}>
            <span style={{ ...styles.swatch, background: COLOR.selected }} />
            {t(labels.selected, locale)}
          </span>
          <span style={styles.group}>
            <span style={{ ...styles.swatch, background: COLOR.defect }} />
            {t(labels.defect, locale)}
          </span>
          <span style={styles.group}>
            <span style={{ ...styles.swatch, background: COLOR.review }} />
            {t(labels.review, locale)}
          </span>
          <span style={styles.group}>
            <span style={{ ...styles.swatch, background: COLOR.advisory }} />
            {t(labels.advisory, locale)}
          </span>
        </div>
        <span style={{ ...styles.hint, flexBasis: "100%" }}>{t(labels.sceneHint, locale)}</span>
      </div>

      <svg
        ref={svgRef}
        viewBox="0 0 760 620"
        role="img"
        aria-label={t(labels.sceneTitle, locale)}
        style={styles.svg}
      >
        {/* Background capture surface: floor-plane Add + Select gestures. */}
        <rect x={0} y={0} width={760} height={620} fill="transparent" onClick={onBackgroundClick} />

        {/* Floor groups with labels and resolved elevation badges. */}
        {FLOOR_ORDER.map((floorId) => {
          const opacity = floorOpacity(floorId);
          const labelXY = project(
            { x: FLOOR_RECT.x + 8, y: FLOOR_RECT.y + 22, z: FLOOR_Z[floorId] },
            floorId,
            preset,
          );
          return (
            <g key={`floor-${floorId}`}>
              <polygon
                points={floorPolygonPoints(floorId)}
                fill={COLOR.floorFill}
                fillOpacity={0.5}
                stroke={COLOR.floorStroke}
                strokeWidth={1}
                opacity={opacity}
                onClick={onBackgroundClick}
              />
              <text x={labelXY[0]} y={labelXY[1]} fontSize={13} fontWeight={700} fill={COLOR.floorLabel} opacity={opacity}>
                {floorId}
              </text>
              <text x={labelXY[0]} y={labelXY[1] + 14} fontSize={10} fill={COLOR.floorLabel} opacity={opacity}>
                {t(labels.sceneZ, locale)}: {FLOOR_Z[floorId].toFixed(2)} m
              </text>

              {/* Venue stair/lift footprints on this floor. */}
              {VENUES.filter((venue) => venue.floorId === floorId).map((venue) => {
                const venueSel: GraphSelection = { kind: "venue", id: venue.id };
                const selected = isSelected(venueSel);
                const venueColor = venue.kind === "stair" ? COLOR.venueStair : COLOR.venueLift;
                return (
                  <g key={`venue-${venue.id}`} opacity={effectiveOpacity(floorId, venue.id)}>
                    <polygon
                      points={venuePolygonPoints(venue)}
                      fill={selected ? COLOR.selected : venueColor}
                      fillOpacity={selected ? 0.25 : 0.12}
                      stroke={selected ? COLOR.selected : venueColor}
                      strokeWidth={selected ? 2 : 1}
                      role="button"
                      tabIndex={-1}
                      aria-label={`${t(venue.label, locale)}`}
                      style={{ cursor: "pointer" }}
                      onClick={(event) => {
                        event.stopPropagation();
                        activateSelection(venueSel);
                      }}
                    />
                  </g>
                );
              })}

              {/* Same-floor edges on this floor. */}
              {state.edges
                .filter((edge) => {
                  if (edge.kind !== "same-floor") return false;
                  const from = nodesById.get(edge.fromNodeId);
                  return from !== undefined && from.floorId === floorId;
                })
                .map((edge) => {
                  const from = nodesById.get(edge.fromNodeId);
                  const to = nodesById.get(edge.toNodeId);
                  if (from === undefined || to === undefined) return null;
                  const a = project(from.point, floorId, preset);
                  const b = project(to.point, floorId, preset);
                  const edgeSel: GraphSelection = { kind: "edge", id: edge.id };
                  const selected = isSelected(edgeSel);
                  return (
                    <line
                      key={`edge-${edge.id}`}
                      opacity={effectiveOpacity(floorId, edge.id)}
                      x1={a[0]}
                      y1={a[1]}
                      x2={b[0]}
                      y2={b[1]}
                      stroke={selected ? COLOR.selected : COLOR.edge}
                      strokeWidth={selected ? 3 : 2}
                      strokeLinecap="round"
                      role="button"
                      tabIndex={-1}
                      aria-label={`${t(labels.edge, locale)} ${edge.id}`}
                      style={{ cursor: "pointer" }}
                      onClick={(event) => {
                        event.stopPropagation();
                        activateSelection(edgeSel);
                      }}
                    />
                  );
                })}

              {/* Nodes on this floor. */}
              {state.nodes
                .filter((node) => node.floorId === floorId)
                .map((node) => {
                  const projected = project(node.point, floorId, preset);
                  const nodeSel: GraphSelection = { kind: "node", id: node.id };
                  const selected = isSelected(nodeSel);
                  const elevation = node.sourceAltitude ?? node.point.z;
                  return (
                    <g key={`node-${node.id}`} opacity={effectiveOpacity(floorId, node.id)}>
                      <circle
                        cx={projected[0]}
                        cy={projected[1]}
                        r={selected ? 7 : 5}
                        fill={selected ? COLOR.selected : COLOR.node}
                        stroke="#fff"
                        strokeWidth={1.5}
                        role="button"
                        tabIndex={-1}
                        aria-label={`${t(labels.node, locale)} ${node.id}`}
                        style={{ cursor: "pointer" }}
                        onClick={(event) => {
                          event.stopPropagation();
                          activateSelection(nodeSel);
                        }}
                      />
                      <text x={projected[0] + 9} y={projected[1] - 6} fontSize={9} fill={COLOR.floorLabel}>
                        {round(elevation, 2)}m
                      </text>
                    </g>
                  );
                })}
            </g>
          );
        })}

        {/* Connector layer: cross-floor paths + interior control-point diamonds. */}
        {state.edges
          .filter((edge) => edge.kind === "connector")
          .map((edge) => {
            const from = nodesById.get(edge.fromNodeId);
            const to = nodesById.get(edge.toNodeId);
            if (from === undefined || to === undefined) return null;
            const fromXY = project(from.point, from.floorId, preset);
            const toXY = project(to.point, to.floorId, preset);
            const controlProjected = edge.controlPoints.map((control) => ({
              control,
              xy: projectWithOffset(
                control,
                connectorControlOffset(control.z, from.floorId, to.floorId),
                preset,
              ),
            }));
            const segments = [`M ${round(fromXY[0], 2)} ${round(fromXY[1], 2)}`];
            for (const entry of controlProjected) {
              segments.push(`L ${round(entry.xy[0], 2)} ${round(entry.xy[1], 2)}`);
            }
            segments.push(`L ${round(toXY[0], 2)} ${round(toXY[1], 2)}`);
            const edgeSel: GraphSelection = { kind: "edge", id: edge.id };
            const edgeSelected = isSelected(edgeSel);
            const edgeOpacity = objectOpacity(edge.id);
            return (
              <g key={`connector-${edge.id}`} opacity={edgeOpacity}>
                <path
                  d={segments.join(" ")}
                  fill="none"
                  stroke={edgeSelected ? COLOR.selected : COLOR.connector}
                  strokeWidth={edgeSelected ? 3 : 2}
                  strokeDasharray="6 3"
                  strokeLinecap="round"
                  role="button"
                  tabIndex={-1}
                  aria-label={`${t(labels.connector, locale)} ${edge.id}`}
                  style={{ cursor: "pointer" }}
                  onClick={(event) => {
                    event.stopPropagation();
                    activateSelection(edgeSel);
                  }}
                />
                {controlProjected.map(({ control, xy }) => {
                  const cpSel: GraphSelection = { kind: "control-point", edgeId: edge.id, id: control.id };
                  const cpSelected = isSelected(cpSel);
                  return (
                    <g key={`cp-${edge.id}-${control.id}`}>
                      <polygon
                        points={diamondPoints(xy[0], xy[1], 6)}
                        fill={cpSelected ? COLOR.selected : "#fff"}
                        stroke={cpSelected ? COLOR.selected : COLOR.controlPoint}
                        strokeWidth={2}
                        role="button"
                        tabIndex={-1}
                        aria-label={`${t(labels.controlPoint, locale)} ${control.id}`}
                        style={{ cursor: "pointer" }}
                        onClick={(event) => {
                          event.stopPropagation();
                          activateSelection(cpSel);
                        }}
                      />
                      <text x={xy[0]} y={xy[1] - 10} fontSize={8.5} fill={COLOR.controlPoint} textAnchor="middle">
                        X{round(control.x)} Y{round(control.y)} Z{round(control.z, 2)}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}

        {/* Provisional connector proof: same projection as committed connectors, no graph mutation. */}
        {pendingConnector !== null ? (
          <g
            className="graph-editing-scene__connector-draft"
            role="img"
            aria-label={`${t(labels.connectorDraft, locale)} ${pendingConnector.from.id} → ${pendingConnector.to.id}`}
          >
            <path
              d={pendingConnector.path}
              fill="none"
              stroke={COLOR.floorFill}
              strokeWidth={7}
              strokeLinecap="round"
              opacity={0.92}
            />
            <path
              d={pendingConnector.path}
              fill="none"
              stroke={pendingConnector.color}
              strokeWidth={3}
              strokeDasharray="7 3"
              strokeLinecap="round"
            />
            {([
              { kind: labels.draftFrom, node: pendingConnector.from, xy: pendingConnector.fromXY, yOffset: 17 },
              { kind: labels.draftTo, node: pendingConnector.to, xy: pendingConnector.toXY, yOffset: -12 },
            ] as const).map(({ kind, node, xy, yOffset }) => (
              <g key={`draft-endpoint-${node.id}`}>
                <circle cx={xy[0]} cy={xy[1]} r={8} fill={COLOR.floorFill} stroke={pendingConnector.color} strokeWidth={2.5} />
                <circle cx={xy[0]} cy={xy[1]} r={2.5} fill={pendingConnector.color} />
                <text x={xy[0] + 11} y={xy[1] + yOffset} fontSize={8.5} fontWeight={600} fill={pendingConnector.color}>
                  {t(kind, locale)} · {node.id} · {node.floorId} · {t(labels.sceneZ, locale)} {round(node.point.z, 2)} · X{round(node.point.x, 2)} Y{round(node.point.y, 2)}
                </text>
              </g>
            ))}
            {pendingConnector.controlProjected.map(({ control, xy }, index) => (
              <g key={`draft-control-${control.id}`}>
                <polygon
                  points={diamondPoints(xy[0], xy[1], 8)}
                  fill={COLOR.floorFill}
                  stroke={pendingConnector.color}
                  strokeWidth={2.5}
                  role="slider"
                  tabIndex={0}
                  aria-label={`${t(labels.landing, locale)} ${index + 1} · ${control.id}`}
                  aria-valuenow={control.z}
                  aria-valuetext={`X ${round(control.x, 2)} · Y ${round(control.y, 2)} · Z ${round(control.z, 2)}`}
                  style={{ cursor: "move" }}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    (event.currentTarget as Element).setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => moveDraftControlPoint(event, control.id)}
                  onPointerUp={(event) => {
                    event.stopPropagation();
                    const target = event.currentTarget as Element;
                    if (target.hasPointerCapture(event.pointerId)) {
                      target.releasePointerCapture(event.pointerId);
                    }
                  }}
                  onKeyDown={(event) => {
                    const step = 0.25;
                    const adjustment =
                      event.key === "ArrowLeft" ? { axis: "x" as const, delta: -step }
                      : event.key === "ArrowRight" ? { axis: "x" as const, delta: step }
                      : event.key === "ArrowUp" ? { axis: "y" as const, delta: -step }
                      : event.key === "ArrowDown" ? { axis: "y" as const, delta: step }
                      : event.key === "PageUp" ? { axis: "z" as const, delta: step }
                      : event.key === "PageDown" ? { axis: "z" as const, delta: -step }
                      : null;
                    if (adjustment === null) return;
                    event.preventDefault();
                    event.stopPropagation();
                    actions.updateDraftControlPoint(control.id, {
                      ...control,
                      [adjustment.axis]: control[adjustment.axis] + adjustment.delta,
                    });
                  }}
                />
                <circle cx={xy[0]} cy={xy[1]} r={2} fill={pendingConnector.color} pointerEvents="none" />
                <text x={xy[0]} y={xy[1] - 13} fontSize={8.5} fontWeight={600} fill={pendingConnector.color} textAnchor="middle" pointerEvents="none">
                  {t(labels.landing, locale)} {index + 1} · X{round(control.x, 2)} Y{round(control.y, 2)} Z{round(control.z, 2)}
                </text>
                <text x={xy[0]} y={xy[1] + 17} fontSize={8} fill={COLOR.floorLabel} textAnchor="middle" pointerEvents="none">
                  {pendingConnector.from.floorId} ↔ {pendingConnector.to.floorId} · {t(labels.sceneZ, locale)} {round(control.z, 2)}
                </text>
              </g>
            ))}
          </g>
        ) : null}

        {/* Evidence layer: point/segment/area finding overlays (pointer-transparent). */}
        <g pointerEvents="none">
        {findingTargets
          .filter((entry) => entry.target !== null)
          .map(({ finding, target }) => {
            const color = severityColor(finding.severity);
            if (target!.kind === "area") {
              return (
                <polygon
                  key={`finding-${finding.id}`}
                  points={target!.polygon}
                  fill={color}
                  fillOpacity={0.18}
                  stroke={color}
                  strokeWidth={2}
                  strokeDasharray="4 3"
                />
              );
            }
            if (target!.kind === "segment") {
              return (
                <line
                  key={`finding-${finding.id}`}
                  x1={target!.x1}
                  y1={target!.y1}
                  x2={target!.x2}
                  y2={target!.y2}
                  stroke={color}
                  strokeWidth={4}
                  strokeLinecap="round"
                  strokeDasharray="2 4"
                />
              );
            }
            return (
              <g key={`finding-${finding.id}`}>
                <circle
                  cx={target!.x}
                  cy={target!.y}
                  r={11}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeDasharray="3 3"
                />
                <circle cx={target!.x} cy={target!.y} r={2.5} fill={color} />
              </g>
            );
          })}
        </g>

        {/* Pending draft marker for add/move. */}
        {pendingMarker !== null ? (
          <g pointerEvents="none">
            {pendingMarker.kind === "add" ? (
              <circle
                cx={pendingMarker.x}
                cy={pendingMarker.y}
                r={8}
                fill="none"
                stroke={SNAP_COLOR[pendingMarker.band]}
                strokeWidth={2}
                strokeDasharray="2 2"
              />
            ) : null}
            <line
              x1={pendingMarker.x + 8}
              y1={pendingMarker.y - 8}
              x2={pendingMarker.x + 18}
              y2={pendingMarker.y - 20}
              stroke={SNAP_COLOR[pendingMarker.band]}
              strokeWidth={1.5}
            />
            <rect
              x={pendingMarker.x + 16}
              y={pendingMarker.y - 34}
              width={60}
              height={17}
              rx={3}
              fill={COLOR.floorFill}
              stroke={SNAP_COLOR[pendingMarker.band]}
            />
            <text
              x={pendingMarker.x + 21}
              y={pendingMarker.y - 22}
              fontSize={8.5}
              fill={SNAP_COLOR[pendingMarker.band]}
              textAnchor="start"
            >
              {snapBandLabel(pendingMarker.band, locale)}
            </text>
          </g>
        ) : null}

        {/* XY move handle for the selected node, floor-constrained. */}
        {selectedNode !== null ? (
          <circle
            cx={
              state.pending?.kind === "move" && state.pending.nodeId === selectedNode.id
                ? project(state.pending.candidate, selectedNode.floorId, preset)[0]
                : project(selectedNode.point, selectedNode.floorId, preset)[0]
            }
            cy={
              state.pending?.kind === "move" && state.pending.nodeId === selectedNode.id
                ? project(state.pending.candidate, selectedNode.floorId, preset)[1]
                : project(selectedNode.point, selectedNode.floorId, preset)[1]
            }
            r={15}
            fill={COLOR.selected}
            fillOpacity={dragNodeId === selectedNode.id ? 0.28 : 0.14}
            stroke={COLOR.selected}
            strokeWidth={1.5}
            strokeDasharray="3 3"
            role="slider"
            tabIndex={-1}
            aria-label={t(labels.moveHandle, locale)}
            style={{ cursor: dragNodeId === selectedNode.id ? "grabbing" : "grab" }}
            onPointerDown={(event) => startMove(event, selectedNode.id)}
            onPointerMove={onHandlePointerMove}
            onPointerUp={endMove}
            onPointerCancel={cancelDrag}
            onLostPointerCapture={cancelDrag}
          />
        ) : null}
      </svg>

      <ul className="graph-editing-scene__object-list" aria-label={t(labels.objectList, locale)} style={styles.list}>
        {objectList.map((entry) => {
          const selected = isSelected(entry.selection);
          return (
            <li key={entry.key} style={{ display: "flex" }}>
              <button
                type="button"
                aria-pressed={selected}
                {...(selected ? { "aria-current": "true" as const } : {})}
                style={{ ...styles.listBtn, ...(selected ? styles.listBtnActive : {}) }}
                onClick={() => activateSelection(entry.selection)}
              >
                <span style={{ ...styles.swatch, background: entry.color }} />
                <span>{entry.label}</span>
              </button>
            </li>
          );
        })}
        {objectList.length === 0 ? (
          <li style={{ fontSize: 11, color: "var(--color-muted)", gridColumn: "1 / -1" }}>
            {t(labels.empty, locale)}
          </li>
        ) : null}
      </ul>

      {selectedControlPoint !== null ? (
        <div className="graph-editing-scene__nudge" style={styles.nudge}>
          <strong style={{ fontSize: 11 }}>
            {t(labels.nudgeTitle, locale)}: {selectedControlPoint.point.id}
          </strong>
          <span style={styles.hint}>{t(labels.nudgeHint, locale)}</span>
          {(["x", "y", "z"] as const).map((axis) => (
            <span key={axis} style={styles.group}>
              <span style={styles.groupLabel}>{axis.toUpperCase()}</span>
              <button
                type="button"
                style={NUDGE_BTN_STYLE}
                onClick={() =>
                  actions.nudgeControlPoint(
                    selectedControlPoint.edge.id,
                    selectedControlPoint.point.id,
                    axis,
                    -NUDGE_STEP[axis],
                  )
                }
              >
                {axis.toUpperCase()}−
              </button>
              <button
                type="button"
                style={NUDGE_BTN_STYLE}
                onClick={() =>
                  actions.nudgeControlPoint(
                    selectedControlPoint.edge.id,
                    selectedControlPoint.point.id,
                    axis,
                    NUDGE_STEP[axis],
                  )
                }
              >
                {axis.toUpperCase()}+
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

interface FindingPointTarget {
  kind: "point";
  x: number;
  y: number;
}
interface FindingAreaTarget {
  kind: "area";
  polygon: string;
}
interface FindingSegmentTarget {
  kind: "segment";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
type FindingTarget = FindingPointTarget | FindingAreaTarget | FindingSegmentTarget | null;

/** Resolve a finding to its scene overlay geometry, projected for the active preset. */
function resolveFindingTarget(
  finding: GraphFinding,
  nodesById: Map<string, GraphEditorPrototypeState["nodes"][number]>,
  edges: readonly GraphEdge[],
  preset: CameraPreset,
): FindingTarget {
  const node = nodesById.get(finding.objectId);
  if (node !== undefined) {
    const projected = project(node.point, node.floorId, preset);
    return { kind: "point", x: projected[0], y: projected[1] };
  }
  const venue = VENUES.find((candidate) => candidate.id === finding.objectId);
  if (venue !== undefined) {
    const z = FLOOR_Z[venue.floorId];
    const polygon = venue.polygon
      .map(([x, y]) => {
        const projected = project({ x, y, z }, venue.floorId, preset);
        return `${round(projected[0], 2)} ${round(projected[1], 2)}`;
      })
      .join(" ");
    return { kind: "area", polygon };
  }
  const edge = edges.find((candidate) => candidate.id === finding.objectId);
  if (edge !== undefined) {
    const from = nodesById.get(edge.fromNodeId);
    const to = nodesById.get(edge.toNodeId);
    if (from !== undefined && to !== undefined) {
      const a = project(from.point, from.floorId, preset);
      const b = project(to.point, to.floorId, preset);
      return { kind: "segment", x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
    }
  }
  return null;
}

interface ObjectListEntry {
  key: string;
  selection: Exclude<GraphSelection, null>;
  label: string;
  color: string;
}

/** Build the keyboard/occlusion-fallback object list from current graph state. */
function selectableObjectList(
  state: GraphEditorPrototypeState,
  locale: Locale,
): ObjectListEntry[] {
  const entries: ObjectListEntry[] = [];
  for (const node of state.nodes) {
    entries.push({
      key: `node:${node.id}`,
      selection: { kind: "node", id: node.id },
      label: `${t(labels.node, locale)} ${node.id} · ${node.floorId}`,
      color: COLOR.node,
    });
  }
  for (const edge of state.edges) {
    const isConnector = edge.kind === "connector";
    entries.push({
      key: `edge:${edge.id}`,
      selection: { kind: "edge", id: edge.id },
      label: `${t(isConnector ? labels.connector : labels.edge, locale)} ${edge.id}`,
      color: isConnector ? COLOR.connector : COLOR.edge,
    });
    for (const control of edge.controlPoints) {
      entries.push({
        key: `cp:${edge.id}:${control.id}`,
        selection: { kind: "control-point", edgeId: edge.id, id: control.id },
        label: `${t(labels.controlPoint, locale)} ${control.id} · ${edge.id}`,
        color: COLOR.controlPoint,
      });
    }
  }
  for (const venue of VENUES) {
    entries.push({
      key: `venue:${venue.id}`,
      selection: { kind: "venue", id: venue.id },
      label: `${t(venue.kind === "stair" ? labels.stair : labels.lift, locale)} ${venue.id} · ${venue.floorId}`,
      color: venue.kind === "stair" ? COLOR.venueStair : COLOR.venueLift,
    });
  }
  return entries;
}
