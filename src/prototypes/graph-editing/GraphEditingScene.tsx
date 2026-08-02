import { useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from "react";
import type {
  FloorId,
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

/** Floor base elevation (metres) used only for elevation badges. */
const FLOOR_ELEVATION_M: Record<FloorId, number> = { B1: -4.86, "1F": 0 };
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
      [540, 340],
      [582, 340],
      [582, 382],
      [540, 382],
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
  venue: { ja: "施設", en: "Venue" },
  stair: { ja: "階段", en: "Stair" },
  lift: { ja: "エレベーター", en: "Lift" },
  elevation: { ja: "標高", en: "Elevation" },
  defect: { ja: "不具合", en: "Defect" },
  review: { ja: "確認", en: "Review" },
  advisory: { ja: "助言", en: "Advisory" },
  legend: { ja: "凡例", en: "Legend" },
  selected: { ja: "選択中", en: "Selected" },
  moveHandle: { ja: "移動ハンドル（XY）", en: "Move handle (XY)" },
  nudgeTitle: { ja: "制御点を軸移動", en: "Nudge control point" },
  nudgeHint: { ja: "軸ボタンで 1 ステップ移動", en: "Axis buttons move one step" },
  empty: { ja: "選択可能なオブジェクトがありません", en: "No selectable objects" },
} as const;

type Locale = GraphEditorPrototypeState["locale"];

function t(entry: { ja: string; en: string }, locale: Locale): string {
  return entry[locale];
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

/** Stable projection shared by all scene geometry (Task 2 Step 1). */
function project(point: ScenePoint, floorId: FloorId, preset: CameraPreset): [number, number] {
  const floorOffset = floorOffsetFor(floorId);
  if (preset === "top") return [point.x, point.y + floorOffset];
  return [point.x + point.y * 0.34, point.y * 0.62 + floorOffset - point.z * 4];
}

/** Projection with an explicit floor offset, for cross-floor connector points. */
function projectAt(point: ScenePoint, offset: number, preset: CameraPreset): [number, number] {
  if (preset === "top") return [point.x, point.y + offset];
  return [point.x + point.y * 0.34, point.y * 0.62 + offset - point.z * 4];
}

/** Inverse of `project` for a fixed floor, used to convert pointer hits to bounded floor XY. */
function invertProject(
  local: { x: number; y: number },
  floorId: FloorId,
  preset: CameraPreset,
  z: number,
): { x: number; y: number } {
  const offset = floorOffsetFor(floorId);
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
    color: "#0f172a",
    outline: "none",
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    overflow: "hidden",
  } as CSSProperties,
  toolbar: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    alignItems: "center",
    padding: "8px 10px",
    borderBottom: "1px solid #e2e8f0",
  } as CSSProperties,
  group: { display: "flex", gap: 4, alignItems: "center" } as CSSProperties,
  groupLabel: { fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.4 } as CSSProperties,
  hint: { fontSize: 10, color: "#94a3b8" } as CSSProperties,
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
    borderTop: "1px solid #e2e8f0",
    background: "#f8fafc",
  } as CSSProperties,
  listBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    padding: "4px 6px",
    border: "1px solid #e2e8f0",
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
    borderTop: "1px solid #e2e8f0",
    background: "#fffbeb",
  } as CSSProperties,
} as const;

function btnStyle(active: boolean): CSSProperties {
  return {
    fontSize: 11,
    padding: "3px 8px",
    border: `1px solid ${active ? COLOR.selected : "#cbd5e1"}`,
    borderRadius: 6,
    background: active ? COLOR.selected : "#fff",
    color: active ? "#fff" : "#0f172a",
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

  const nodesById = new Map(state.nodes.map((node) => [node.id, node]));

  // Evidence emphasis context (Task 2 Step 2): the active finding dims
  // unrelated floors and graph objects while keeping everything rendered.
  const activeFinding =
    state.selectedFindingId !== null
      ? (state.findings.find((finding) => finding.id === state.selectedFindingId) ?? null)
      : null;
  let relatedFloorId: FloorId | null = null;
  let relatedObjectId: string | null = null;
  if (activeFinding !== null) {
    relatedObjectId = activeFinding.objectId;
    const relatedNode = state.nodes.find((node) => node.id === activeFinding.objectId);
    if (relatedNode !== undefined) {
      relatedFloorId = relatedNode.floorId;
    } else {
      const relatedEdge = state.edges.find((edge) => edge.id === activeFinding.objectId);
      const endpoint =
        relatedEdge !== undefined ? nodesById.get(relatedEdge.fromNodeId) : undefined;
      relatedFloorId = endpoint !== undefined ? endpoint.floorId : null;
      if (relatedFloorId === null) {
        const venue = VENUES.find((candidate) => candidate.id === activeFinding.objectId);
        relatedFloorId = venue !== undefined ? venue.floorId : null;
      }
    }
  }

  function floorOpacity(floorId: FloorId): number {
    return activeFinding === null || floorId === relatedFloorId ? 1 : 0.35;
  }
  function objectOpacity(objectId: string): number {
    return activeFinding === null || objectId === relatedObjectId ? 1 : 0.35;
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

  function onBackgroundClick(event: ReactMouseEvent<SVGRectElement>): void {
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
    applyMove(event, nodeId);
  }

  function onHandlePointerMove(event: ReactPointerEvent<SVGElement>): void {
    if (dragNodeId === null) return;
    applyMove(event, dragNodeId);
  }

  function endMove(event: ReactPointerEvent<SVGElement>): void {
    if (dragNodeId === null) return;
    const pending = stateRef.current.pending;
    if (pending?.kind === "move") {
      const band = pending.snap?.band ?? "none";
      if (band === "auto") {
        actions.commitMove("snap");
      } else if (band === "review") {
        // Preserve the pending draft for the inspector to commit explicitly.
      } else {
        actions.commitMove("raw");
      }
    }
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
    setDragNodeId(null);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    const target = event.target as HTMLElement | null;
    if (target !== null) {
      const tag = target.tagName.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        tag === "button" ||
        target.isContentEditable
      ) {
        return;
      }
    }
    if (event.key === "Escape") {
      actions.cancel();
      return;
    }
    const meta = event.metaKey || event.ctrlKey;
    if (meta && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      if (event.shiftKey) actions.redo();
      else actions.undo();
      return;
    }
    if (meta || event.altKey) return;
    switch (event.key.toLowerCase()) {
      case "s":
        actions.setTool("select");
        break;
      case "p":
        actions.setTool("add");
        break;
      case "c":
        actions.setTool("connect");
        break;
      case "d":
        actions.setTool("delete");
        break;
      default:
        break;
    }
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

  const selectedControlPoint =
    state.selection !== null && state.selection.kind === "control-point"
      ? (() => {
          const edge = state.edges.find((candidate) => candidate.id === state.selection!.edgeId);
          if (edge === undefined) return null;
          const point = edge.controlPoints.find((candidate) => candidate.id === state.selection!.id);
          return point === undefined ? null : { edge, point };
        })()
      : null;

  // Pending draft markers (move/add) visualize the uncommitted candidate so
  // Review-band drafts remain visible while they wait for the inspector.
  const pendingMarker = (() => {
    const pending = state.pending;
    if (pending === null) return null;
    if (pending.kind === "add") {
      const projected = project(pending.candidate, pending.floorId, preset);
      return { x: projected[0], y: projected[1], band: pending.snap?.band ?? "none" };
    }
    if (pending.kind === "move") {
      const node = nodesById.get(pending.nodeId);
      if (node === undefined) return null;
      const projected = project(pending.candidate, node.floorId, preset);
      return { x: projected[0], y: projected[1], band: pending.snap?.band ?? "none" };
    }
    return null;
  })();


  const findingTargets = state.findings.map((finding) => ({
    finding,
    target: resolveFindingTarget(finding, nodesById, state.edges, preset),
  }));
  const objectList = selectableObjectList(state, locale);

  return (
    <section
      className="graph-editing-scene"
      tabIndex={0}
      onKeyDown={onKeyDown}
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
            <g key={`floor-${floorId}`} opacity={opacity}>
              <polygon
                points={floorPolygonPoints(floorId)}
                fill={COLOR.floorFill}
                fillOpacity={0.5}
                stroke={COLOR.floorStroke}
                strokeWidth={1}
              />
              <text x={labelXY[0]} y={labelXY[1]} fontSize={13} fontWeight={700} fill={COLOR.floorLabel}>
                {floorId}
              </text>
              <text x={labelXY[0]} y={labelXY[1] + 14} fontSize={10} fill={COLOR.floorLabel}>
                {t(labels.elevation, locale)}: {round(FLOOR_ELEVATION_M[floorId], 2)} m
              </text>

              {/* Venue stair/lift footprints on this floor. */}
              {VENUES.filter((venue) => venue.floorId === floorId).map((venue) => {
                const venueSel: GraphSelection = { kind: "venue", id: venue.id };
                const selected = isSelected(venueSel);
                const venueColor = venue.kind === "stair" ? COLOR.venueStair : COLOR.venueLift;
                return (
                  <g key={`venue-${venue.id}`}>
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
                    <g key={`node-${node.id}`}>
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
              xy: projectAt(
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

        {/* Evidence layer: point/segment/area finding overlays. */}
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

        {/* Pending draft marker for add/move. */}
        {pendingMarker !== null ? (
          <g>
            <circle
              cx={pendingMarker.x}
              cy={pendingMarker.y}
              r={8}
              fill="none"
              stroke={SNAP_COLOR[pendingMarker.band]}
              strokeWidth={2}
              strokeDasharray="2 2"
            />
            <text
              x={pendingMarker.x}
              y={pendingMarker.y - 12}
              fontSize={8.5}
              fill={SNAP_COLOR[pendingMarker.band]}
              textAnchor="middle"
            >
              {pendingMarker.band}
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
          <li style={{ fontSize: 11, color: "#94a3b8", gridColumn: "1 / -1" }}>
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
  edges: readonly GraphEditorPrototypeState["edges"],
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
