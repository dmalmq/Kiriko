import { useEffect, useMemo, useReducer, useRef } from "react";

import {
  createGraphEditingPrototypeState,
  type FloorId,
  type GraphEdge,
  type GraphEditorPrototypeState,
  type GraphEditorTool,
  type GraphFinding,
  type GraphNode,
  type GraphSelection,
  type PendingOperation,
  type ScenarioId,
  type ScenePoint,
  type SnapBand,
  type SnapPreview,
  type StagedSnapshot,
  type ValidationProfile,
} from "./graphEditingModel";

export interface GraphEditorPrototypeActions {
  selectFinding(id: GraphFinding["id"]): void;
  selectObject(selection: GraphSelection): void;
  setTool(tool: GraphEditorTool): void;
  setActiveFloor(floorId: FloorId): void;
  previewAdd(point: Pick<ScenePoint, "x" | "y">): void;
  commitAdd(mode: "snap" | "raw"): void;
  previewMove(nodeId: string, point: Pick<ScenePoint, "x" | "y">): void;
  commitMove(mode: "snap" | "raw"): void;
  beginConnection(nodeId: string): void;
  chooseConnectionEndpoint(nodeId: string): void;
  setDraftAssociation(associationId: string | null): void;
  addConnectorControlPoint(point: ScenePoint): void;
  nudgeControlPoint(
    edgeId: string,
    pointId: string,
    axis: "x" | "y" | "z",
    delta: number,
  ): void;
  commitConnection(): void;
  reassignNodeFloor(nodeId: string, floorId: FloorId): void;
  requestDelete(selection: Exclude<GraphSelection, null>): void;
  confirmDelete(): void;
  beginException(findingId: GraphFinding["id"]): void;
  updateExceptionReason(reason: string): void;
  acceptException(): void;
  updateProfileDraft(autoSnapM: number, reviewSnapM: number, reason: string): void;
  commitProfileOverride(): void;
  undo(): void;
  redo(): void;
  cancel(): void;
  resetScenario(scenario: ScenarioId): void;
  runCheck(): void;
  requestSave(): void;
  confirmSave(): void;
  setLocale(locale: "ja" | "en"): void;
  toggleReducedMotion(): void;
  setCameraPreset(preset: "perspective" | "top"): void;
}

interface SnapAnchor {
  id: string;
  floorId: FloorId;
  point: ScenePoint;
}

const FLOOR_SCENE_Z: Record<FloorId, number> = { B1: 0, "1F": 4.86 };

const SNAP_ANCHORS: SnapAnchor[] = [
  { id: "stair-main", floorId: "B1", point: { x: 300, y: 300, z: 0 } },
  { id: "stair-main", floorId: "1F", point: { x: 300, y: 300, z: 4.86 } },
  { id: "lift-east", floorId: "B1", point: { x: 452, y: 304, z: 0 } },
  { id: "lift-east", floorId: "1F", point: { x: 452, y: 304, z: 4.86 } },
  { id: "snap-anchor-b1-entry", floorId: "B1", point: { x: 126, y: 406, z: 0 } },
  { id: "snap-anchor-f1-exit", floorId: "1F", point: { x: 516, y: 186, z: 4.86 } },
];

const MAX_HISTORY = 50;

type GraphEditorAction =
  | { type: "select-finding"; id: GraphFinding["id"] }
  | { type: "select-object"; selection: GraphSelection }
  | { type: "set-tool"; tool: GraphEditorTool }
  | { type: "set-active-floor"; floorId: FloorId }
  | { type: "preview-add"; point: Pick<ScenePoint, "x" | "y"> }
  | { type: "commit-add"; mode: "snap" | "raw" }
  | { type: "preview-move"; nodeId: string; point: Pick<ScenePoint, "x" | "y"> }
  | { type: "commit-move"; mode: "snap" | "raw" }
  | { type: "begin-connection"; nodeId: string }
  | { type: "choose-connection-endpoint"; nodeId: string }
  | { type: "set-draft-association"; associationId: string | null }
  | { type: "add-connector-control-point"; point: ScenePoint }
  | {
      type: "nudge-control-point";
      edgeId: string;
      pointId: string;
      axis: "x" | "y" | "z";
      delta: number;
    }
  | { type: "commit-connection" }
  | { type: "reassign-node-floor"; nodeId: string; floorId: FloorId }
  | { type: "request-delete"; selection: Exclude<GraphSelection, null> }
  | { type: "confirm-delete" }
  | { type: "begin-exception"; findingId: GraphFinding["id"] }
  | { type: "update-exception-reason"; reason: string }
  | { type: "accept-exception" }
  | {
      type: "update-profile-draft";
      autoSnapM: number;
      reviewSnapM: number;
      reason: string;
    }
  | { type: "commit-profile-override" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "cancel" }
  | { type: "reset-scenario"; scenario: ScenarioId }
  | { type: "run-check" }
  | { type: "complete-check" }
  | { type: "request-save" }
  | { type: "confirm-save" }
  | { type: "set-locale"; locale: "ja" | "en" }
  | { type: "toggle-reduced-motion" }
  | { type: "set-camera-preset"; preset: "perspective" | "top" };

function snapBand(
  distanceM: number,
  candidateCount: number,
  sameFloor: boolean,
  profile: ValidationProfile,
): SnapBand {
  if (!sameFloor || distanceM > profile.reviewSnapM) return "none";
  if (candidateCount !== 1) return "ambiguous";
  return distanceM <= profile.autoSnapM ? "auto" : "review";
}

function distance2d(a: Pick<ScenePoint, "x" | "y">, b: Pick<ScenePoint, "x" | "y">): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function nearestAnchor(
  candidate: ScenePoint,
  floorId: FloorId,
  profile: ValidationProfile,
): SnapPreview | null {
  const sameFloorCandidates = SNAP_ANCHORS.filter(
    (anchor) =>
      anchor.floorId === floorId && distance2d(candidate, anchor.point) <= profile.reviewSnapM,
  );
  const candidates = sameFloorCandidates.length > 0 ? sameFloorCandidates : SNAP_ANCHORS;
  let nearest: SnapAnchor | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const anchor of candidates) {
    const distance = distance2d(candidate, anchor.point);
    if (distance < nearestDistance) {
      nearest = anchor;
      nearestDistance = distance;
    }
  }

  if (nearest === null || nearestDistance > profile.reviewSnapM) {
    return null;
  }

  const sameFloor = nearest.floorId === floorId;
  return {
    candidateId: nearest.id,
    distanceM: nearestDistance,
    band: snapBand(nearestDistance, sameFloorCandidates.length, sameFloor, profile),
    sameFloor,
    point: nearest.point,
  };
}

function isFinitePoint(point: ScenePoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function snapshotOf(state: GraphEditorPrototypeState): StagedSnapshot {
  return {
    nodes: state.nodes,
    edges: state.edges,
    findings: state.findings,
    profile: state.profile,
    stagedChanges: state.stagedChanges,
  };
}

function hasDuplicateEdge(edges: GraphEdge[]): boolean {
  const pairs = new Set<string>();
  for (const edge of edges) {
    const pair = [edge.fromNodeId, edge.toNodeId].sort().join("\u0000");
    if (pairs.has(pair)) return true;
    pairs.add(pair);
  }
  return false;
}

function structuralNotice(
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphEditorPrototypeState["notice"] {
  if (hasDuplicateEdge(edges)) return "duplicate-connection";
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  if (nodes.some((node) => !isFinitePoint(node.point))) return "invalid-geometry";

  for (const edge of edges) {
    const from = nodesById.get(edge.fromNodeId);
    const to = nodesById.get(edge.toNodeId);
    if (
      from === undefined ||
      to === undefined ||
      from.id === to.id ||
      edge.controlPoints.some((point) => !isFinitePoint(point)) ||
      (edge.kind === "connector" && from.floorId === to.floorId) ||
      (edge.kind === "same-floor" && from.floorId !== to.floorId)
    ) {
      return "invalid-geometry";
    }
  }
  return null;
}

function findingWithEvaluation(
  previous: GraphFinding,
  state: GraphFinding["state"],
  measuredM: number | null,
  toleranceM: number | null,
): GraphFinding {
  if (state === "open" && previous.state === "accepted" && previous.exceptionReason !== null) {
    return { ...previous, measuredM, toleranceM };
  }
  return {
    ...previous,
    state,
    measuredM,
    toleranceM,
    exceptionReason: state === "resolved" ? null : previous.exceptionReason,
  };
}

function recomputeFindings(
  nodes: GraphNode[],
  edges: GraphEdge[],
  previous: GraphFinding[],
  profile: ValidationProfile,
  fullCheck = false,
): GraphFinding[] {
  return previous.map((finding) => {
    if (finding.id === "endpoint-off-stair") {
      const node = nodes.find((candidate) => candidate.id === finding.objectId);
      const measuredM = node === undefined ? null : distance2d(node.point, { x: 300, y: 300 });
      return findingWithEvaluation(
        finding,
        measuredM === null || measuredM <= 0.001 ? "resolved" : "open",
        measuredM,
        profile.autoSnapM,
      );
    }
    if (finding.id === "floor-drift") {
      const node = nodes.find((candidate) => candidate.id === finding.objectId);
      return findingWithEvaluation(
        finding,
        node === undefined || node.floorId === "1F" ? "resolved" : "open",
        node === undefined || node.floorId === "1F" ? 0 : 0.84,
        0.5,
      );
    }

    const associated = edges.some(
      (edge) => edge.kind === "connector" && edge.associationId === "lift-east",
    );
    if (associated) return findingWithEvaluation(finding, "resolved", null, null);
    if (fullCheck || finding.state === "resolved") {
      return findingWithEvaluation(finding, "open", null, null);
    }
    return finding;
  });
}

function findingDelta(previous: GraphFinding[], next: GraphFinding[]): string {
  for (const finding of next) {
    const prior = previous.find((candidate) => candidate.id === finding.id);
    if (prior === undefined) return `${finding.id}:newly-exposed`;
    if (prior.state === finding.state) continue;
    if (finding.state === "resolved") return `${finding.id}:resolved`;
    if (prior.state === "not-evaluated" && finding.state === "open") {
      return `${finding.id}:newly-exposed`;
    }
    if (finding.state === "open") return `${finding.id}:reopened`;
    if (finding.state === "accepted") return `${finding.id}:accepted`;
  }
  return "finding:none:unchanged";
}

function selectionExists(selection: GraphSelection, snapshot: StagedSnapshot): GraphSelection {
  if (selection === null || selection.kind === "venue") return selection;
  if (selection.kind === "node") {
    return snapshot.nodes.some((node) => node.id === selection.id) ? selection : null;
  }
  if (selection.kind === "edge") {
    return snapshot.edges.some((edge) => edge.id === selection.id) ? selection : null;
  }
  const edge = snapshot.edges.find((candidate) => candidate.id === selection.edgeId);
  return edge?.controlPoints.some((point) => point.id === selection.id) === true ? selection : null;
}

function commitSnapshot(
  state: GraphEditorPrototypeState,
  draft: Omit<StagedSnapshot, "findings" | "stagedChanges"> & { findings?: GraphFinding[] },
  change: string,
  selection: GraphSelection = state.selection,
): GraphEditorPrototypeState {
  const draftFindings = draft.findings ?? state.findings;
  const findings = recomputeFindings(draft.nodes, draft.edges, draftFindings, draft.profile);
  const nextSnapshot: StagedSnapshot = {
    nodes: draft.nodes,
    edges: draft.edges,
    findings,
    profile: draft.profile,
    stagedChanges: [...state.stagedChanges, change],
  };
  const notice = structuralNotice(nextSnapshot.nodes, nextSnapshot.edges);
  if (notice !== null) return { ...state, notice };

  return {
    ...state,
    ...nextSnapshot,
    past: [...state.past, snapshotOf(state)].slice(-MAX_HISTORY),
    future: [],
    selection: selectionExists(selection, nextSnapshot),
    pending: null,
    notice: null,
    findingDelta: findingDelta(state.findings, findings),
    checkState: "idle",
    saveState: "idle",
  };
}

function nextNumericId(prefix: string, ids: string[]): string {
  let highest = 0;
  for (const id of ids) {
    if (!id.startsWith(`${prefix}-`)) continue;
    const value = Number(id.slice(prefix.length + 1));
    if (Number.isInteger(value) && value > highest) highest = value;
  }
  return `${prefix}-${highest + 1}`;
}

function pointForCommit(pending: Extract<PendingOperation, { kind: "add" | "move" }>, mode: "snap" | "raw"):
  | ScenePoint
  | null {
  if (mode === "raw") return pending.candidate;
  if (
    pending.snap === null ||
    !pending.snap.sameFloor ||
    (pending.snap.band !== "auto" && pending.snap.band !== "review")
  ) {
    return null;
  }
  return { ...pending.snap.point, z: pending.candidate.z };
}

function deletionConsequences(
  state: GraphEditorPrototypeState,
  selection: Exclude<GraphSelection, null>,
): string[] {
  if (selection.kind === "node") {
    const incident = state.edges.filter(
      (edge) => edge.fromNodeId === selection.id || edge.toNodeId === selection.id,
    );
    const affectedFindings = state.findings.filter((finding) => finding.objectId === selection.id);
    return [`incident-edges:${incident.length}`, `affected-findings:${affectedFindings.length}`];
  }
  if (selection.kind === "edge") {
    const edge = state.edges.find((candidate) => candidate.id === selection.id);
    return edge === undefined
      ? []
      : [
          `disconnect:${edge.fromNodeId}:${edge.toNodeId}`,
          ...(edge.associationId === null ? [] : [`remove-association:${edge.associationId}`]),
        ];
  }
  if (selection.kind === "control-point") {
    return [`remove-control-point:${selection.edgeId}:${selection.id}`];
  }
  return [`venue-read-only:${selection.id}`];
}

function deletableSelectionExists(
  state: GraphEditorPrototypeState,
  selection: Exclude<GraphSelection, null>,
): boolean {
  if (selection.kind === "node") {
    return state.nodes.some((node) => node.id === selection.id);
  }
  if (selection.kind === "edge") {
    return state.edges.some((edge) => edge.id === selection.id);
  }
  if (selection.kind === "control-point") {
    const edge = state.edges.find((candidate) => candidate.id === selection.edgeId);
    return edge?.controlPoints.some((point) => point.id === selection.id) === true;
  }
  return false;
}

function applyScenarioPreset(
  state: GraphEditorPrototypeState,
  scenario: ScenarioId,
): GraphEditorPrototypeState {
  switch (scenario) {
    case "repair-endpoint":
      return {
        ...state,
        scenario,
        tool: "move",
        selection: { kind: "node", id: "b1-stair" },
        selectedFindingId: "endpoint-off-stair",
      };
    case "create-connector":
      return { ...state, scenario, tool: "add", activeFloor: "B1" };
    case "reject-duplicate":
      return {
        ...state,
        scenario,
        tool: "connect",
        selection: { kind: "node", id: "b1-entry" },
      };
    case "resolve-uncertainty":
      return {
        ...state,
        scenario,
        selection: { kind: "node", id: "floor-drift-node" },
        selectedFindingId: "floor-drift",
      };
    case "delete-consequences":
      return {
        ...state,
        scenario,
        tool: "delete",
        selection: { kind: "node", id: "floor-drift-node" },
      };
    case "check-save":
      return { ...state, scenario };
  }
}

function graphEditorReducer(
  state: GraphEditorPrototypeState,
  action: GraphEditorAction,
): GraphEditorPrototypeState {
  switch (action.type) {
    case "select-finding": {
      const finding = state.findings.find((candidate) => candidate.id === action.id);
      if (finding === undefined) return state;
      const nodeSelected = state.nodes.some((node) => node.id === finding.objectId);
      const edgeSelected = state.edges.some((edge) => edge.id === finding.objectId);
      const selection: GraphSelection = nodeSelected
        ? { kind: "node", id: finding.objectId }
        : edgeSelected
          ? { kind: "edge", id: finding.objectId }
          : { kind: "venue", id: finding.objectId };
      return { ...state, selectedFindingId: action.id, selection, notice: null };
    }
    case "select-object":
      return { ...state, selection: action.selection, notice: null };
    case "set-tool":
      return { ...state, tool: action.tool, pending: null, notice: null };
    case "set-active-floor":
      return { ...state, activeFloor: action.floorId, pending: null, notice: null };
    case "preview-add": {
      const candidate = { ...action.point, z: FLOOR_SCENE_Z[state.activeFloor] };
      return {
        ...state,
        tool: "add",
        pending: {
          kind: "add",
          floorId: state.activeFloor,
          candidate,
          snap: nearestAnchor(candidate, state.activeFloor, state.profile),
        },
        notice: null,
      };
    }
    case "commit-add": {
      if (state.pending?.kind !== "add") return state;
      const point = pointForCommit(state.pending, action.mode);
      if (point === null || !isFinitePoint(point)) return { ...state, notice: "invalid-geometry" };
      const id = nextNumericId(
        "manual-node",
        state.nodes.map((node) => node.id),
      );
      const node: GraphNode = {
        id,
        floorId: state.pending.floorId,
        point,
        sourceAltitude: null,
        provenance: "manual",
      };
      return commitSnapshot(
        state,
        { nodes: [...state.nodes, node], edges: state.edges, profile: state.profile },
        `add:${id}:${node.floorId}:${action.mode}`,
        { kind: "node", id },
      );
    }
    case "preview-move": {
      const node = state.nodes.find((candidate) => candidate.id === action.nodeId);
      if (node === undefined) return state;
      const candidate = { ...action.point, z: node.point.z };
      return {
        ...state,
        tool: "move",
        selection: { kind: "node", id: node.id },
        pending: {
          kind: "move",
          nodeId: node.id,
          candidate,
          snap: nearestAnchor(candidate, node.floorId, state.profile),
        },
        notice: null,
      };
    }
    case "commit-move": {
      if (state.pending?.kind !== "move") return state;
      const point = pointForCommit(state.pending, action.mode);
      if (point === null || !isFinitePoint(point)) return { ...state, notice: "invalid-geometry" };
      const nodeId = state.pending.nodeId;
      if (!state.nodes.some((node) => node.id === nodeId)) return state;
      const nodes = state.nodes.map((node) => (node.id === nodeId ? { ...node, point } : node));
      return commitSnapshot(
        state,
        { nodes, edges: state.edges, profile: state.profile },
        `move:${nodeId}:${action.mode}`,
        { kind: "node", id: nodeId },
      );
    }
    case "begin-connection": {
      if (!state.nodes.some((node) => node.id === action.nodeId)) return state;
      return {
        ...state,
        tool: "connect",
        selection: { kind: "node", id: action.nodeId },
        pending: {
          kind: "connect",
          fromNodeId: action.nodeId,
          toNodeId: null,
          associationId: null,
          controlPoints: [],
        },
        notice: null,
      };
    }
    case "choose-connection-endpoint": {
      if (
        state.pending?.kind !== "connect" ||
        !state.nodes.some((node) => node.id === action.nodeId)
      ) {
        return state;
      }
      return {
        ...state,
        selection: { kind: "node", id: action.nodeId },
        pending: { ...state.pending, toNodeId: action.nodeId },
        notice: null,
      };
    }
    case "set-draft-association":
      return state.pending?.kind === "connect"
        ? { ...state, pending: { ...state.pending, associationId: action.associationId }, notice: null }
        : state;
    case "add-connector-control-point": {
      if (state.pending?.kind !== "connect") return state;
      const pending = state.pending;
      const from = state.nodes.find((node) => node.id === pending.fromNodeId);
      const to = state.nodes.find((node) => node.id === pending.toNodeId);
      if (from === undefined || to === undefined || from.floorId === to.floorId) return state;
      const id = nextNumericId(
        "draft-control",
        pending.controlPoints.map((point) => point.id),
      );
      return {
        ...state,
        pending: {
          ...pending,
          controlPoints: [
            ...pending.controlPoints,
            { id, ...action.point, provenance: "manual" },
          ],
        },
        notice: null,
      };
    }
    case "nudge-control-point": {
      const edge = state.edges.find((candidate) => candidate.id === action.edgeId);
      if (edge === undefined || !edge.controlPoints.some((point) => point.id === action.pointId)) {
        return state;
      }
      const edges = state.edges.map((candidate) =>
        candidate.id === action.edgeId
          ? {
              ...candidate,
              controlPoints: candidate.controlPoints.map((point) =>
                point.id === action.pointId
                  ? { ...point, [action.axis]: point[action.axis] + action.delta }
                  : point,
              ),
            }
          : candidate,
      );
      return commitSnapshot(
        state,
        { nodes: state.nodes, edges, profile: state.profile },
        `nudge-control-point:${action.edgeId}:${action.pointId}:${action.axis}:${action.delta}`,
        { kind: "control-point", edgeId: action.edgeId, id: action.pointId },
      );
    }
    case "commit-connection": {
      if (state.pending?.kind !== "connect") return state;
      const pending = state.pending;
      const from = state.nodes.find((node) => node.id === pending.fromNodeId);
      const to = state.nodes.find((node) => node.id === pending.toNodeId);
      if (from === undefined || to === undefined || from.id === to.id) {
        return { ...state, notice: "invalid-geometry" };
      }
      const id = nextNumericId(
        from.floorId === to.floorId ? "edge" : "connector",
        state.edges.map((edge) => edge.id),
      );
      const edge: GraphEdge = {
        id,
        fromNodeId: from.id,
        toNodeId: to.id,
        kind: from.floorId === to.floorId ? "same-floor" : "connector",
        associationId: from.floorId === to.floorId ? null : pending.associationId,
        controlPoints: from.floorId === to.floorId ? [] : pending.controlPoints,
      };
      return commitSnapshot(
        state,
        { nodes: state.nodes, edges: [...state.edges, edge], profile: state.profile },
        `connect:${id}:${from.id}:${to.id}:${edge.associationId ?? "none"}`,
        { kind: "edge", id },
      );
    }
    case "reassign-node-floor": {
      const existing = state.nodes.find((node) => node.id === action.nodeId);
      if (existing === undefined || existing.floorId === action.floorId) return state;
      const nodes = state.nodes.map((node) =>
        node.id === action.nodeId
          ? {
              ...node,
              floorId: action.floorId,
              point: { ...node.point, z: FLOOR_SCENE_Z[action.floorId] },
            }
          : node,
      );
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const edges: GraphEdge[] = state.edges.map((edge) => {
        if (edge.fromNodeId !== action.nodeId && edge.toNodeId !== action.nodeId) return edge;
        const from = nodesById.get(edge.fromNodeId);
        const to = nodesById.get(edge.toNodeId);
        if (from === undefined || to === undefined) return edge;
        const sameFloor = from.floorId === to.floorId;
        return {
          ...edge,
          kind: sameFloor ? "same-floor" : "connector",
          associationId: sameFloor ? null : edge.associationId,
          controlPoints: sameFloor ? [] : edge.controlPoints,
        };
      });
      return commitSnapshot(
        state,
        { nodes, edges, profile: state.profile },
        `reassign-floor:${action.nodeId}:${existing.floorId}:${action.floorId}`,
        { kind: "node", id: action.nodeId },
      );
    }
    case "request-delete":
      if (!deletableSelectionExists(state, action.selection)) {
        return { ...state, notice: "invalid-geometry" };
      }
      return {
        ...state,
        tool: "delete",
        selection: action.selection,
        pending: {
          kind: "delete",
          selection: action.selection,
          consequences: deletionConsequences(state, action.selection),
        },
        notice: null,
      };
    case "confirm-delete": {
      if (state.pending?.kind !== "delete") return state;
      const selection = state.pending.selection;
      if (!deletableSelectionExists(state, selection)) {
        return { ...state, notice: "invalid-geometry" };
      }
      let nodes = state.nodes;
      let edges = state.edges;
      if (selection.kind === "node") {
        nodes = nodes.filter((node) => node.id !== selection.id);
        edges = edges.filter(
          (edge) => edge.fromNodeId !== selection.id && edge.toNodeId !== selection.id,
        );
      } else if (selection.kind === "edge") {
        edges = edges.filter((edge) => edge.id !== selection.id);
      } else if (selection.kind === "control-point") {
        edges = edges.map((edge) =>
          edge.id === selection.edgeId
            ? {
                ...edge,
                controlPoints: edge.controlPoints.filter((point) => point.id !== selection.id),
              }
            : edge,
        );
      } else {
        return state;
      }
      if (edges.length === 0) return { ...state, notice: "unusable-graph" };
      return commitSnapshot(
        state,
        { nodes, edges, profile: state.profile },
        `delete:${selection.kind}:${selection.id}`,
        null,
      );
    }
    case "begin-exception":
      return state.findings.some((finding) => finding.id === action.findingId)
        ? {
            ...state,
            selectedFindingId: action.findingId,
            pending: { kind: "exception", findingId: action.findingId, reason: "" },
            notice: null,
          }
        : state;
    case "update-exception-reason":
      return state.pending?.kind === "exception"
        ? { ...state, pending: { ...state.pending, reason: action.reason } }
        : state;
    case "accept-exception": {
      if (state.pending?.kind !== "exception" || state.pending.reason.trim() === "") return state;
      const findingId = state.pending.findingId;
      const reason = state.pending.reason.trim();
      const findings = state.findings.map((finding) =>
        finding.id === findingId
          ? { ...finding, state: "accepted" as const, exceptionReason: reason }
          : finding,
      );
      return commitSnapshot(
        state,
        { nodes: state.nodes, edges: state.edges, findings, profile: state.profile },
        `accept-exception:${findingId}`,
      );
    }
    case "update-profile-draft":
      return {
        ...state,
        pending: {
          kind: "profile",
          autoSnapM: action.autoSnapM,
          reviewSnapM: action.reviewSnapM,
          reason: action.reason,
        },
        notice: null,
      };
    case "commit-profile-override": {
      if (state.pending?.kind !== "profile") return state;
      const { autoSnapM, reviewSnapM } = state.pending;
      const reason = state.pending.reason.trim();
      if (
        !Number.isFinite(autoSnapM) ||
        !Number.isFinite(reviewSnapM) ||
        autoSnapM < 0 ||
        reviewSnapM < autoSnapM ||
        reason === ""
      ) {
        return state;
      }
      const profile: ValidationProfile = { autoSnapM, reviewSnapM, overrideReason: reason };
      return commitSnapshot(
        state,
        { nodes: state.nodes, edges: state.edges, profile },
        `override-profile:${autoSnapM}:${reviewSnapM}`,
      );
    }
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (previous === undefined) return state;
      return {
        ...state,
        ...previous,
        past: state.past.slice(0, -1),
        future: [snapshotOf(state), ...state.future].slice(0, MAX_HISTORY),
        selection: selectionExists(state.selection, previous),
        pending: null,
        notice: null,
        findingDelta: findingDelta(state.findings, previous.findings),
        checkState: "idle",
        saveState: "idle",
      };
    }
    case "redo": {
      const next = state.future[0];
      if (next === undefined) return state;
      return {
        ...state,
        ...next,
        past: [...state.past, snapshotOf(state)].slice(-MAX_HISTORY),
        future: state.future.slice(1),
        selection: selectionExists(state.selection, next),
        pending: null,
        notice: null,
        findingDelta: findingDelta(state.findings, next.findings),
        checkState: "idle",
        saveState: "idle",
      };
    }
    case "cancel":
      return { ...state, pending: null, notice: null };
    case "reset-scenario": {
      const fresh = createGraphEditingPrototypeState();
      return applyScenarioPreset(
        {
          ...fresh,
          locale: state.locale,
          reducedMotion: state.reducedMotion,
          cameraPreset: state.cameraPreset,
        },
        action.scenario,
      );
    }
    case "run-check":
      return { ...state, checkState: "checking" };
    case "complete-check": {
      if (state.checkState !== "checking") return state;
      const findings = recomputeFindings(state.nodes, state.edges, state.findings, state.profile, true);
      return {
        ...state,
        findings,
        checkState: "complete",
        findingDelta: findingDelta(state.findings, findings),
      };
    }
    case "request-save":
      return { ...state, saveState: "confirming" };
    case "confirm-save":
      return state.saveState === "confirming" ? { ...state, saveState: "saved" } : state;
    case "set-locale":
      return { ...state, locale: action.locale };
    case "toggle-reduced-motion":
      return { ...state, reducedMotion: !state.reducedMotion };
    case "set-camera-preset":
      return { ...state, cameraPreset: action.preset };
  }
}

export function useGraphEditingPrototype(): {
  state: GraphEditorPrototypeState;
  actions: GraphEditorPrototypeActions;
} {
  const [state, dispatch] = useReducer(
    graphEditorReducer,
    undefined,
    createGraphEditingPrototypeState,
  );
  const checkTimeout = useRef<number | null>(null);

  useEffect(
    () => () => window.clearTimeout(checkTimeout.current ?? undefined),
    [],
  );

  const actions = useMemo<GraphEditorPrototypeActions>(
    () => ({
      selectFinding: (id) => dispatch({ type: "select-finding", id }),
      selectObject: (selection) => dispatch({ type: "select-object", selection }),
      setTool: (tool) => dispatch({ type: "set-tool", tool }),
      setActiveFloor: (floorId) => dispatch({ type: "set-active-floor", floorId }),
      previewAdd: (point) => dispatch({ type: "preview-add", point }),
      commitAdd: (mode) => dispatch({ type: "commit-add", mode }),
      previewMove: (nodeId, point) => dispatch({ type: "preview-move", nodeId, point }),
      commitMove: (mode) => dispatch({ type: "commit-move", mode }),
      beginConnection: (nodeId) => dispatch({ type: "begin-connection", nodeId }),
      chooseConnectionEndpoint: (nodeId) =>
        dispatch({ type: "choose-connection-endpoint", nodeId }),
      setDraftAssociation: (associationId) =>
        dispatch({ type: "set-draft-association", associationId }),
      addConnectorControlPoint: (point) =>
        dispatch({ type: "add-connector-control-point", point }),
      nudgeControlPoint: (edgeId, pointId, axis, delta) =>
        dispatch({ type: "nudge-control-point", edgeId, pointId, axis, delta }),
      commitConnection: () => dispatch({ type: "commit-connection" }),
      reassignNodeFloor: (nodeId, floorId) =>
        dispatch({ type: "reassign-node-floor", nodeId, floorId }),
      requestDelete: (selection) => dispatch({ type: "request-delete", selection }),
      confirmDelete: () => dispatch({ type: "confirm-delete" }),
      beginException: (findingId) => dispatch({ type: "begin-exception", findingId }),
      updateExceptionReason: (reason) => dispatch({ type: "update-exception-reason", reason }),
      acceptException: () => dispatch({ type: "accept-exception" }),
      updateProfileDraft: (autoSnapM, reviewSnapM, reason) =>
        dispatch({ type: "update-profile-draft", autoSnapM, reviewSnapM, reason }),
      commitProfileOverride: () => dispatch({ type: "commit-profile-override" }),
      undo: () => dispatch({ type: "undo" }),
      redo: () => dispatch({ type: "redo" }),
      cancel: () => dispatch({ type: "cancel" }),
      resetScenario: (scenario) => {
        if (checkTimeout.current !== null) {
          window.clearTimeout(checkTimeout.current);
          checkTimeout.current = null;
        }
        dispatch({ type: "reset-scenario", scenario });
      },
      runCheck: () => {
        window.clearTimeout(checkTimeout.current ?? undefined);
        dispatch({ type: "run-check" });
        checkTimeout.current = window.setTimeout(() => {
          checkTimeout.current = null;
          dispatch({ type: "complete-check" });
        }, 450);
      },
      requestSave: () => dispatch({ type: "request-save" }),
      confirmSave: () => dispatch({ type: "confirm-save" }),
      setLocale: (locale) => dispatch({ type: "set-locale", locale }),
      toggleReducedMotion: () => dispatch({ type: "toggle-reduced-motion" }),
      setCameraPreset: (preset) => dispatch({ type: "set-camera-preset", preset }),
    }),
    [],
  );

  return { state, actions };
}
