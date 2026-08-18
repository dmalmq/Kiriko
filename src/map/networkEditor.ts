import {
  addConnection,
  addJunction,
  addPath,
  connectionKeys,
  deleteConnection,
  deleteJunction,
  moveJunction,
  type NetworkConnectionId,
  type NetworkMutationError,
  type ParsedNetwork,
} from "./networkFeatures";

/**
 * Pure state machine for the network geometry editor. Owns baseline/current
 * networks, a bounded undo/redo history, the active tool, selection, and any
 * pending multi-step operation. All geometry changes route through the
 * invariant-preserving mutations in {@link ./networkFeatures}; this module adds
 * only editor semantics (tools, history, selection, change summary).
 */

/** Active editing tool. `move-junction` is transient and entered from the inspector. */
export type NetworkEditTool = "select" | "add-junction" | "connect" | "delete" | "move-junction";

/** The currently highlighted junctions and logical connections, or nothing. */
export type NetworkSelection =
  | { kind: "set"; junctionIds: number[]; connectionIds: NetworkConnectionId[] }
  | null;

/** A one-object set containing only `nodeId`. */
export function singleJunction(nodeId: number): Exclude<NetworkSelection, null> {
  return { kind: "set", junctionIds: [nodeId], connectionIds: [] };
}

/** A one-object set containing only the normalized `id`. */
export function singleConnection(id: NetworkConnectionId): Exclude<NetworkSelection, null> {
  return { kind: "set", junctionIds: [], connectionIds: [normalizeConnectionId(id)] };
}

/** The lone junction id when the set is exactly one junction and no connections. */
export function selectedJunctionId(selection: NetworkSelection): number | null {
  if (selection === null) return null;
  if (selection.junctionIds.length === 1 && selection.connectionIds.length === 0) {
    return selection.junctionIds[0]!;
  }
  return null;
}

/** The lone connection id when the set is exactly one connection and no junctions. */
export function selectedConnectionId(selection: NetworkSelection): NetworkConnectionId | null {
  if (selection === null) return null;
  if (selection.connectionIds.length === 1 && selection.junctionIds.length === 0) {
    return selection.connectionIds[0]!;
  }
  return null;
}

/** Kinds of a Connect preview candidate. Matches the wasm propose DTO. */
export type PathCandidateKind = "current" | "along_network" | "shorter";

/** One proposed path: display polyline plus graph node ids for Current. */
export interface PathCandidate {
  kind: PathCandidateKind;
  coordinates: [number, number][];
  nodeIds: number[] | null;
}

/** Session state for a Connect preview between two junctions. */
export interface PathPreview {
  fromId: number;
  toId: number;
  candidates: PathCandidate[];
  selectedIndex: number;
}

/** Why a Connect preview is inspect-only, empty, or failed. */
export type NetworkPreviewStatus = "disconnected" | "no_walkable" | "propose_failed" | null;

/** A semantic pick reported by the map: an existing object or a bare coordinate. */
export type NetworkMapPick =
  | { kind: "junction"; nodeId: number }
  | { kind: "connection"; connectionId: NetworkConnectionId }
  | { kind: "map"; longitude: number; latitude: number };

/** Counts of pending edits relative to the loaded baseline. */
export interface NetworkChangeSummary {
  addedJunctions: number;
  movedJunctions: number;
  deletedJunctions: number;
  addedConnections: number;
  deletedConnections: number;
}

export interface NetworkEditorState {
  baseline: ParsedNetwork;
  past: ParsedNetwork[];
  present: ParsedNetwork;
  future: ParsedNetwork[];
  tool: NetworkEditTool;
  selection: NetworkSelection;
  /** Connect origin (tool `connect`) or the node being repositioned (tool `move-junction`). */
  pendingNodeId: number | null;
  notice: NetworkMutationError | null;
  preview: PathPreview | null;
  previewStatus: NetworkPreviewStatus;
}

export type NetworkEditorAction =
  | { type: "set_tool"; tool: Exclude<NetworkEditTool, "move-junction"> }
  | { type: "pick"; pick: NetworkMapPick; activeOrdinal: number }
  | { type: "box_select"; nodeIds: number[] }
  | { type: "start_move"; nodeId: number }
  | { type: "delete_selection" }
  | { type: "cancel_pending" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset" }
  | { type: "clear_selection" }
  | { type: "clear_notice" }
  | { type: "set_preview"; preview: PathPreview }
  | { type: "select_candidate"; index: number }
  | { type: "confirm_preview" }
  | { type: "select_current_route" }
  | { type: "set_preview_status"; status: NetworkPreviewStatus };

const HISTORY_LIMIT = 50;

export function createNetworkEditorState(network: ParsedNetwork): NetworkEditorState {
  return {
    baseline: network,
    past: [],
    present: network,
    future: [],
    tool: "select",
    selection: null,
    pendingNodeId: null,
    notice: null,
    preview: null,
    previewStatus: null,
  };
}

function normalizeConnectionId(id: NetworkConnectionId): NetworkConnectionId {
  return id.pathId < id.reversePathId
    ? id
    : { pathId: id.reversePathId, reversePathId: id.pathId };
}

function connectionKey(id: NetworkConnectionId): string {
  const n = normalizeConnectionId(id);
  return `pair:${n.pathId}:${n.reversePathId}`;
}

/** Whether every id in the current set still refers to something in `network`. */
function selectionPresent(network: ParsedNetwork, selection: NetworkSelection): boolean {
  if (selection === null) return true;
  for (const nodeId of selection.junctionIds) {
    if (!network.junctions.some((j) => j.properties.NODEID === nodeId)) return false;
  }
  const keys = connectionKeys(network);
  for (const id of selection.connectionIds) {
    if (!keys.has(connectionKey(id))) return false;
  }
  return true;
}

/** Logical connections between consecutive `nodeIds` that already exist. */
function connectionsAlongNodeIds(
  network: ParsedNetwork,
  nodeIds: number[],
): NetworkConnectionId[] {
  const seen = new Set<string>();
  const out: NetworkConnectionId[] = [];
  for (let i = 0; i < nodeIds.length - 1; i += 1) {
    const a = nodeIds[i]!;
    const b = nodeIds[i + 1]!;
    if (a === b) continue;
    for (const path of network.paths) {
      const from = path.properties.FNODEID;
      const to = path.properties.TNODEID;
      if (typeof from !== "number" || typeof to !== "number") continue;
      if (!((from === a && to === b) || (from === b && to === a))) continue;
      const pathId = path.properties.PATHID;
      const reversePathId = path.properties.RPATHID;
      if (typeof pathId !== "number" || typeof reversePathId !== "number") continue;
      const id = normalizeConnectionId({ pathId, reversePathId });
      const key = connectionKey(id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(id);
    }
  }
  return out;
}

/** Logical connections whose both endpoints are in `junctionIds`. */
function connectionsInsideJunctions(
  network: ParsedNetwork,
  junctionIds: Set<number>,
): NetworkConnectionId[] {
  const seen = new Set<string>();
  const out: NetworkConnectionId[] = [];
  for (const path of network.paths) {
    const from = path.properties.FNODEID;
    const to = path.properties.TNODEID;
    if (typeof from !== "number" || typeof to !== "number") continue;
    if (!junctionIds.has(from) || !junctionIds.has(to)) continue;
    const pathId = path.properties.PATHID;
    const reversePathId = path.properties.RPATHID;
    if (typeof pathId !== "number" || typeof reversePathId !== "number") continue;
    const id = normalizeConnectionId({ pathId, reversePathId });
    const key = connectionKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/** Push `next` onto history (capped) and clear the redo stack. */
function commit(
  state: NetworkEditorState,
  next: ParsedNetwork,
  patch: Partial<NetworkEditorState>,
): NetworkEditorState {
  const past = [...state.past, state.present].slice(-HISTORY_LIMIT);
  return {
    ...state,
    past,
    present: next,
    future: [],
    notice: null,
    preview: null,
    previewStatus: null,
    ...patch,
  };
}

function applyPick(state: NetworkEditorState, pick: NetworkMapPick, activeOrdinal: number): NetworkEditorState {
  switch (state.tool) {
    case "select":
      if (pick.kind === "junction") {
        return { ...state, selection: singleJunction(pick.nodeId) };
      }
      if (pick.kind === "connection") {
        return { ...state, selection: singleConnection(pick.connectionId) };
      }
      return state.selection === null ? state : { ...state, selection: null };

    case "add-junction": {
      if (pick.kind === "junction") {
        return { ...state, selection: singleJunction(pick.nodeId) };
      }
      if (pick.kind === "connection") {
        return { ...state, selection: singleConnection(pick.connectionId) };
      }
      const result = addJunction(state.present, {
        longitude: pick.longitude,
        latitude: pick.latitude,
        ordinal: activeOrdinal,
      });
      if (!result.ok) return { ...state, notice: result.error };
      return commit(state, result.network, { selection: null });
    }

    case "connect": {
      if (pick.kind !== "junction") return state;
      if (state.preview !== null) return state;
      if (state.pendingNodeId === null) {
        return {
          ...state,
          pendingNodeId: pick.nodeId,
          notice: null,
          preview: null,
          previewStatus: null,
        };
      }
      if (state.pendingNodeId === pick.nodeId) return state;
      const result = addConnection(state.present, state.pendingNodeId, pick.nodeId);
      if (!result.ok) return { ...state, pendingNodeId: null, notice: result.error };
      return commit(state, result.network, {
        pendingNodeId: null,
        selection:
          result.connectionId !== undefined ? singleConnection(result.connectionId) : null,
      });
    }

    case "delete": {
      if (pick.kind === "junction") {
        const result = deleteJunction(state.present, pick.nodeId);
        if (!result.ok) return { ...state, notice: result.error };
        return commit(state, result.network, { selection: null });
      }
      if (pick.kind === "connection") {
        const result = deleteConnection(state.present, pick.connectionId);
        if (!result.ok) return { ...state, notice: result.error };
        return commit(state, result.network, { selection: null });
      }
      return state;
    }

    case "move-junction": {
      if (pick.kind !== "map" || state.pendingNodeId === null) return state;
      const nodeId = state.pendingNodeId;
      const result = moveJunction(state.present, nodeId, {
        longitude: pick.longitude,
        latitude: pick.latitude,
      });
      if (!result.ok) {
        return { ...state, tool: "select", pendingNodeId: null, notice: result.error };
      }
      return commit(state, result.network, {
        tool: "select",
        pendingNodeId: null,
        selection: singleJunction(nodeId),
      });
    }
  }
}

function restore(
  state: NetworkEditorState,
  present: ParsedNetwork,
  past: ParsedNetwork[],
  future: ParsedNetwork[],
): NetworkEditorState {
  return {
    ...state,
    present,
    past,
    future,
    pendingNodeId: null,
    notice: null,
    preview: null,
    previewStatus: null,
    selection: selectionPresent(present, state.selection) ? state.selection : null,
    tool: state.tool === "move-junction" ? "select" : state.tool,
  };
}

function selectCurrentRoute(state: NetworkEditorState): NetworkEditorState {
  const candidate = state.preview?.candidates.find((item) => item.kind === "current");
  if (candidate === undefined || candidate.nodeIds === null || candidate.nodeIds.length === 0) {
    return state;
  }
  return {
    ...state,
    tool: "select",
    pendingNodeId: null,
    notice: null,
    preview: null,
    previewStatus: null,
    selection: {
      kind: "set",
      junctionIds: candidate.nodeIds,
      connectionIds: connectionsAlongNodeIds(state.present, candidate.nodeIds),
    },
  };
}

function confirmPreview(state: NetworkEditorState): NetworkEditorState {
  const preview = state.preview;
  if (preview === null) return state;
  const selected = preview.candidates[preview.selectedIndex];
  if (selected === undefined || selected.kind === "current") return state;
  const from = state.present.junctions.find((j) => j.properties.NODEID === preview.fromId);
  const ordinal = from?.ordinal;
  if (ordinal === undefined || ordinal === null) {
    return { ...state, notice: "unknown_junction" };
  }
  const result = addPath(state.present, selected.coordinates, ordinal);
  if (!result.ok) {
    return { ...state, notice: result.error };
  }
  if (result.network === state.present) {
    return { ...state, preview: null, previewStatus: null, pendingNodeId: null };
  }
  return commit(state, result.network, { pendingNodeId: null, selection: null });
}

export function networkEditorReducer(
  state: NetworkEditorState,
  action: NetworkEditorAction,
): NetworkEditorState {
  switch (action.type) {
    case "set_tool":
      return {
        ...state,
        tool: action.tool,
        pendingNodeId: null,
        notice: null,
        preview: null,
        previewStatus: null,
      };

    case "pick":
      return applyPick(state, action.pick, action.activeOrdinal);

    case "start_move":
      return {
        ...state,
        tool: "move-junction",
        pendingNodeId: action.nodeId,
        selection: singleJunction(action.nodeId),
        notice: null,
        preview: null,
        previewStatus: null,
      };

    case "box_select": {
      if (action.nodeIds.length === 0) return state;
      const junctionIds = [...new Set(action.nodeIds)].sort((a, b) => a - b);
      const connectionIds = connectionsInsideJunctions(state.present, new Set(junctionIds));
      return {
        ...state,
        selection: { kind: "set", junctionIds, connectionIds },
      };
    }

    case "delete_selection": {
      if (state.selection === null) return state;
      let working = state.present;
      let notice: NetworkMutationError | null = null;
      for (const nodeId of state.selection.junctionIds) {
        const result = deleteJunction(working, nodeId);
        if (result.ok) {
          working = result.network;
        } else {
          notice = result.error;
        }
      }
      for (const connectionId of state.selection.connectionIds) {
        const result = deleteConnection(working, connectionId);
        if (result.ok) {
          working = result.network;
        } else if (result.error !== "unknown_connection") {
          notice = result.error;
        }
      }
      if (working === state.present) {
        return notice === null ? state : { ...state, notice };
      }
      return commit(state, working, { selection: null });
    }

    case "cancel_pending":
      return {
        ...state,
        pendingNodeId: null,
        notice: null,
        preview: null,
        previewStatus: null,
        tool: state.tool === "move-junction" ? "select" : state.tool,
      };

    case "set_preview":
      return {
        ...state,
        preview: action.preview,
        previewStatus: null,
        notice: null,
      };

    case "select_candidate": {
      if (state.preview === null) return state;
      if (action.index < 0 || action.index >= state.preview.candidates.length) return state;
      return {
        ...state,
        preview: { ...state.preview, selectedIndex: action.index },
      };
    }

    case "confirm_preview":
      return confirmPreview(state);

    case "select_current_route":
      return selectCurrentRoute(state);

    case "set_preview_status":
      return {
        ...state,
        previewStatus: action.status,
        preview:
          action.status === "no_walkable" || action.status === "propose_failed"
            ? null
            : state.preview,
        pendingNodeId: action.status === "propose_failed" ? null : state.pendingNodeId,
        notice: null,
      };

    case "undo": {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1]!;
      return restore(
        state,
        previous,
        state.past.slice(0, -1),
        [state.present, ...state.future],
      );
    }

    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[0]!;
      return restore(
        state,
        next,
        [...state.past, state.present].slice(-HISTORY_LIMIT),
        state.future.slice(1),
      );
    }

    case "reset":
      return createNetworkEditorState(state.baseline);

    case "clear_selection":
      return state.selection === null ? state : { ...state, selection: null };

    case "clear_notice":
      return state.notice === null ? state : { ...state, notice: null };
  }
}

/** Finite [lon, lat] keyed by NODEID for the network's junctions. */
function junctionCoordinates(net: ParsedNetwork): Map<number, [number, number]> {
  const map = new Map<number, [number, number]>();
  for (const junction of net.junctions) {
    const id = junction.properties.NODEID;
    if (typeof id !== "number") continue;
    if (junction.geometry.type !== "Point") {
      map.set(id, [Number.NaN, Number.NaN]);
      continue;
    }
    const lon = junction.geometry.coordinates[0];
    const lat = junction.geometry.coordinates[1];
    map.set(id, [typeof lon === "number" ? lon : Number.NaN, typeof lat === "number" ? lat : Number.NaN]);
  }
  return map;
}

/**
 * Diff the loaded baseline against the current graph. Junctions diff by NODEID
 * (moved = present in both with changed Point coordinates); connections diff by
 * normalized reciprocal-id key, so endpoint shifts from moving a junction never
 * register as connection changes.
 */
export function summarizeNetworkChanges(state: NetworkEditorState): NetworkChangeSummary {
  const base = junctionCoordinates(state.baseline);
  const current = junctionCoordinates(state.present);
  let addedJunctions = 0;
  let movedJunctions = 0;
  let deletedJunctions = 0;
  for (const id of current.keys()) {
    if (!base.has(id)) addedJunctions += 1;
  }
  for (const [id, coord] of base) {
    const now = current.get(id);
    if (now === undefined) {
      deletedJunctions += 1;
    } else if (now[0] !== coord[0] || now[1] !== coord[1]) {
      movedJunctions += 1;
    }
  }
  const baseConnections = connectionKeys(state.baseline);
  const currentConnections = connectionKeys(state.present);
  let addedConnections = 0;
  let deletedConnections = 0;
  for (const key of currentConnections) {
    if (!baseConnections.has(key)) addedConnections += 1;
  }
  for (const key of baseConnections) {
    if (!currentConnections.has(key)) deletedConnections += 1;
  }
  return { addedJunctions, movedJunctions, deletedJunctions, addedConnections, deletedConnections };
}

export function hasNetworkChanges(summary: NetworkChangeSummary): boolean {
  return (
    summary.addedJunctions > 0 ||
    summary.movedJunctions > 0 ||
    summary.deletedJunctions > 0 ||
    summary.addedConnections > 0 ||
    summary.deletedConnections > 0
  );
}

/** Why the graph is not saveable yet, or null when it is. */
export function networkSaveProblem(
  network: ParsedNetwork,
): "missing_junction" | "missing_connection" | null {
  const hasJunction = network.junctions.some((j) => typeof j.properties.NODEID === "number");
  if (!hasJunction) return "missing_junction";
  if (connectionKeys(network).size === 0) return "missing_connection";
  return null;
}
