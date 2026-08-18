import { describe, expect, it } from "vitest";
import { addConnection, addJunction, type ParsedNetwork } from "./networkFeatures";
import {
  createNetworkEditorState,
  hasNetworkChanges,
  networkEditorReducer as reduce,
  networkSaveProblem,
  selectedConnectionId,
  singleJunction,
  summarizeNetworkChanges,
  type PathCandidateKind,
  type PathPreview,
} from "./networkEditor";

function junction(id: number, lon: number, lat: number, ordinal = 0): ParsedNetwork["junctions"][number] {
  return {
    ordinal,
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { NODEID: id, FLOOR: ordinal < 0 ? `B${-ordinal}` : `F${ordinal + 1}` },
  };
}

const empty = (): ParsedNetwork => ({ junctions: [], paths: [] });
const twoPoints = (): ParsedNetwork => ({
  junctions: [junction(0, 139.7, 35.6, 0), junction(1, 139.7005, 35.6, 0)],
  paths: [],
});
function connected(): ParsedNetwork {
  const r = addConnection(twoPoints(), 0, 1);
  if (!r.ok) throw new Error("fixture setup failed");
  return r.network;
}

describe("networkEditorReducer tools", () => {
  it("starts in select with the baseline as present and no history", () => {
    const net = twoPoints();
    const s = createNetworkEditorState(net);
    expect(s.tool).toBe("select");
    expect(s.present).toBe(net);
    expect(s.baseline).toBe(net);
    expect(s.past).toHaveLength(0);
    expect(s.future).toHaveLength(0);
  });

  it("set_tool switches tool and clears any pending origin", () => {
    let s = createNetworkEditorState(twoPoints());
    s = reduce(s, { type: "set_tool", tool: "connect" });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    expect(s.pendingNodeId).toBe(0);
    s = reduce(s, { type: "set_tool", tool: "select" });
    expect(s.tool).toBe("select");
    expect(s.pendingNodeId).toBeNull();
  });

  it("add-junction adds a point on each bare-map pick and stays active", () => {
    let s = createNetworkEditorState(empty());
    s = reduce(s, { type: "set_tool", tool: "add-junction" });
    s = reduce(s, { type: "pick", pick: { kind: "map", longitude: 139.7, latitude: 35.6 }, activeOrdinal: 0 });
    s = reduce(s, { type: "pick", pick: { kind: "map", longitude: 139.701, latitude: 35.6 }, activeOrdinal: 0 });
    expect(s.tool).toBe("add-junction");
    expect(s.present.junctions).toHaveLength(2);
    expect(s.present.junctions.map((j) => j.properties.NODEID)).toEqual([0, 1]);
    expect(s.past).toHaveLength(2);
  });

  it("add-junction selects an existing object instead of stacking a point", () => {
    let s = createNetworkEditorState(twoPoints());
    s = reduce(s, { type: "set_tool", tool: "add-junction" });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 1 }, activeOrdinal: 0 });
    expect(s.present.junctions).toHaveLength(2);
    expect(s.selection).toEqual(singleJunction(1));
    expect(s.tool).toBe("add-junction");
  });

  it("connect links two junctions, selects the connection, and stays active", () => {
    let s = createNetworkEditorState(twoPoints());
    s = reduce(s, { type: "set_tool", tool: "connect" });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    expect(s.pendingNodeId).toBe(0);
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 1 }, activeOrdinal: 0 });
    expect(s.pendingNodeId).toBeNull();
    expect(s.present.paths).toHaveLength(2);
    expect(selectedConnectionId(s.selection)).not.toBeNull();
    expect(s.tool).toBe("connect");
  });

  it("connect rejects a cross-floor pair with a notice and clears pending", () => {
    const net: ParsedNetwork = {
      junctions: [junction(0, 139.7, 35.6, 0), junction(1, 139.7, 35.6, 1)],
      paths: [],
    };
    let s = createNetworkEditorState(net);
    s = reduce(s, { type: "set_tool", tool: "connect" });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 1 }, activeOrdinal: 1 });
    expect(s.present.paths).toHaveLength(0);
    expect(s.notice).toBe("cross_floor_connection");
    expect(s.pendingNodeId).toBeNull();
  });

  it("delete removes a picked junction and its incident paths, staying active", () => {
    let s = createNetworkEditorState(connected());
    s = reduce(s, { type: "set_tool", tool: "delete" });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    expect(s.tool).toBe("delete");
    expect(s.present.junctions.some((j) => j.properties.NODEID === 0)).toBe(false);
    expect(s.present.paths).toHaveLength(0);
  });

  it("move-junction applies one map pick then returns to select with the node selected", () => {
    let s = createNetworkEditorState(twoPoints());
    s = reduce(s, { type: "start_move", nodeId: 0 });
    expect(s.tool).toBe("move-junction");
    expect(s.pendingNodeId).toBe(0);
    s = reduce(s, { type: "pick", pick: { kind: "map", longitude: 139.72, latitude: 35.61 }, activeOrdinal: 0 });
    expect(s.tool).toBe("select");
    expect(s.pendingNodeId).toBeNull();
    expect(s.selection).toEqual(singleJunction(0));
    const moved = s.present.junctions.find((j) => j.properties.NODEID === 0)!;
    expect(moved.geometry).toEqual({ type: "Point", coordinates: [139.72, 35.61] });
  });

  it("cancel_pending exits move mode and drops the connect origin", () => {
    let s = createNetworkEditorState(twoPoints());
    s = reduce(s, { type: "set_tool", tool: "connect" });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    s = reduce(s, { type: "cancel_pending" });
    expect(s.pendingNodeId).toBeNull();
    s = reduce(s, { type: "start_move", nodeId: 1 });
    s = reduce(s, { type: "cancel_pending" });
    expect(s.tool).toBe("select");
    expect(s.pendingNodeId).toBeNull();
  });

  it("delete_selection removes the current junction selection", () => {
    let s = createNetworkEditorState(connected());
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    s = reduce(s, { type: "delete_selection" });
    expect(s.present.junctions.some((j) => j.properties.NODEID === 0)).toBe(false);
    expect(s.selection).toBeNull();
  });

  it("clear_selection drops the current selection without touching the graph", () => {
    let s = createNetworkEditorState(connected());
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    expect(s.selection).not.toBeNull();
    const before = s.present;
    s = reduce(s, { type: "clear_selection" });
    expect(s.selection).toBeNull();
    expect(s.present).toBe(before);
  });
});

describe("networkEditorReducer history", () => {
  it("undo and redo restore prior graphs; a new edit clears redo", () => {
    let s = createNetworkEditorState(empty());
    s = reduce(s, { type: "set_tool", tool: "add-junction" });
    s = reduce(s, { type: "pick", pick: { kind: "map", longitude: 139.7, latitude: 35.6 }, activeOrdinal: 0 });
    const afterAdd = s.present;
    s = reduce(s, { type: "undo" });
    expect(s.present.junctions).toHaveLength(0);
    expect(s.future).toHaveLength(1);
    s = reduce(s, { type: "redo" });
    expect(s.present).toBe(afterAdd);
    s = reduce(s, { type: "undo" });
    s = reduce(s, { type: "pick", pick: { kind: "map", longitude: 139.71, latitude: 35.6 }, activeOrdinal: 0 });
    expect(s.future).toHaveLength(0);
  });

  it("undo drops a selection whose target no longer exists", () => {
    let s = createNetworkEditorState(empty());
    s = reduce(s, { type: "set_tool", tool: "add-junction" });
    s = reduce(s, { type: "pick", pick: { kind: "map", longitude: 139.7, latitude: 35.6 }, activeOrdinal: 0 });
    s = reduce(s, { type: "set_tool", tool: "select" });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    expect(s.selection).toEqual(singleJunction(0));
    s = reduce(s, { type: "undo" });
    expect(s.selection).toBeNull();
  });

  it("caps undo history at 50 snapshots", () => {
    let s = createNetworkEditorState(empty());
    s = reduce(s, { type: "set_tool", tool: "add-junction" });
    for (let i = 0; i < 60; i += 1) {
      s = reduce(s, {
        type: "pick",
        pick: { kind: "map", longitude: 139.7 + i * 0.001, latitude: 35.6 },
        activeOrdinal: 0,
      });
    }
    expect(s.present.junctions).toHaveLength(60);
    expect(s.past.length).toBe(50);
  });

  it("reset returns to the baseline and clears history", () => {
    const baseline = twoPoints();
    let s = createNetworkEditorState(baseline);
    s = reduce(s, { type: "set_tool", tool: "add-junction" });
    s = reduce(s, { type: "pick", pick: { kind: "map", longitude: 139.7, latitude: 35.6 }, activeOrdinal: 0 });
    s = reduce(s, { type: "reset" });
    expect(s.present).toBe(baseline);
    expect(s.past).toHaveLength(0);
    expect(s.tool).toBe("select");
  });

  it("clear_notice clears the last rejection", () => {
    const net: ParsedNetwork = {
      junctions: [junction(0, 139.7, 35.6, 0), junction(1, 139.7, 35.6, 1)],
      paths: [],
    };
    let s = createNetworkEditorState(net);
    s = reduce(s, { type: "set_tool", tool: "connect" });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 1 }, activeOrdinal: 1 });
    expect(s.notice).toBe("cross_floor_connection");
    s = reduce(s, { type: "clear_notice" });
    expect(s.notice).toBeNull();
  });
});

describe("network change summary and save validation", () => {
  it("summarizes added and moved junctions without double-counting endpoint shifts", () => {
    let s = createNetworkEditorState(connected());
    s = reduce(s, { type: "set_tool", tool: "add-junction" });
    s = reduce(s, { type: "pick", pick: { kind: "map", longitude: 139.71, latitude: 35.6 }, activeOrdinal: 0 });
    s = reduce(s, { type: "start_move", nodeId: 0 });
    s = reduce(s, { type: "pick", pick: { kind: "map", longitude: 139.72, latitude: 35.61 }, activeOrdinal: 0 });
    const summary = summarizeNetworkChanges(s);
    expect(summary).toEqual({
      addedJunctions: 1,
      movedJunctions: 1,
      deletedJunctions: 0,
      addedConnections: 0,
      deletedConnections: 0,
    });
    expect(hasNetworkChanges(summary)).toBe(true);
  });

  it("nets an added-then-deleted junction to no change", () => {
    let s = createNetworkEditorState(connected());
    s = reduce(s, { type: "set_tool", tool: "add-junction" });
    s = reduce(s, { type: "pick", pick: { kind: "map", longitude: 139.71, latitude: 35.6 }, activeOrdinal: 0 });
    // The new point takes the next id (2); delete it.
    s = reduce(s, { type: "set_tool", tool: "delete" });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 2 }, activeOrdinal: 0 });
    const summary = summarizeNetworkChanges(s);
    expect(summary.addedJunctions).toBe(0);
    expect(summary.deletedJunctions).toBe(0);
    expect(hasNetworkChanges(summary)).toBe(false);
  });

  it("counts added and deleted connections", () => {
    let s = createNetworkEditorState(twoPoints());
    s = reduce(s, { type: "set_tool", tool: "connect" });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 1 }, activeOrdinal: 0 });
    expect(summarizeNetworkChanges(s).addedConnections).toBe(1);
  });

  it("networkSaveProblem flags empty and connectionless graphs", () => {
    expect(networkSaveProblem(empty())).toBe("missing_junction");
    expect(networkSaveProblem(twoPoints())).toBe("missing_connection");
    expect(networkSaveProblem(connected())).toBeNull();
  });
});

describe("networkEditorReducer multi-select", () => {
  it("box_select selects junctions and only connections with both ends in the box", () => {
    const net = connected(); // nodes 0-1 plus their pair
    const extra = addJunction(net, { longitude: 139.702, latitude: 35.6, ordinal: 0 });
    if (!extra.ok) throw new Error("fixture");
    let s = createNetworkEditorState(extra.network);
    s = reduce(s, { type: "box_select", nodeIds: [0, 1] });
    expect(s.selection).toEqual({
      kind: "set",
      junctionIds: [0, 1],
      connectionIds: [expect.objectContaining({ pathId: expect.any(Number) })],
    });
    expect(s.selection?.kind).toBe("set");
    if (s.selection?.kind === "set") {
      expect(s.selection.connectionIds).toHaveLength(1);
    }
    expect(s.past).toHaveLength(0);
  });

  it("box_select of no nodes leaves the selection unchanged", () => {
    let s = createNetworkEditorState(connected());
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    const before = s.selection;
    s = reduce(s, { type: "box_select", nodeIds: [] });
    expect(s.selection).toBe(before);
  });

  it("delete_selection removes a multi-set as one undo step", () => {
    let s = createNetworkEditorState(connected());
    s = reduce(s, { type: "box_select", nodeIds: [0, 1] });
    s = reduce(s, { type: "delete_selection" });
    expect(s.present.junctions).toHaveLength(0);
    expect(s.present.paths).toHaveLength(0);
    expect(s.selection).toBeNull();
    expect(s.past).toHaveLength(1);
    s = reduce(s, { type: "undo" });
    expect(s.present.junctions).toHaveLength(2);
    expect(s.present.paths).toHaveLength(2);
  });

  it("click pick replaces a multi-set with a single object", () => {
    let s = createNetworkEditorState(connected());
    s = reduce(s, { type: "box_select", nodeIds: [0, 1] });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    expect(s.selection).toEqual(singleJunction(0));
  });
});

const previewOf = (kind: PathCandidateKind, coords: [number, number][]): PathPreview => ({
  fromId: 0,
  toId: 1,
  candidates: [{ kind, coordinates: coords, nodeIds: kind === "current" ? [0, 1] : null }],
  selectedIndex: 0,
});

describe("networkEditorReducer preview", () => {
  it("starts with no preview", () => {
    const s = createNetworkEditorState(twoPoints());
    expect(s.preview).toBeNull();
    expect(s.previewStatus).toBeNull();
  });

  it("confirm_preview of current does not commit", () => {
    let s = createNetworkEditorState(twoPoints());
    s = { ...s, preview: previewOf("current", [[139.7, 35.6], [139.7005, 35.6]]) };
    s = reduce(s, { type: "confirm_preview" });
    expect(s.present.paths).toHaveLength(0);
    expect(s.past).toHaveLength(0);
  });

  it("confirm_preview of a new path is one undo that removes every added junction and connection", () => {
    let s = createNetworkEditorState(twoPoints());
    const mid: [number, number] = [139.70025, 35.6];
    s = reduce(s, {
      type: "set_preview",
      preview: {
        fromId: 0,
        toId: 1,
        candidates: [{ kind: "shorter", coordinates: [[139.7, 35.6], mid, [139.7005, 35.6]], nodeIds: null }],
        selectedIndex: 0,
      },
    });
    s = reduce(s, { type: "confirm_preview" });
    expect(s.present.junctions.length).toBeGreaterThanOrEqual(3);
    expect(s.present.paths.length).toBeGreaterThanOrEqual(4); // two new undirected pairs
    expect(s.past).toHaveLength(1);
    expect(s.preview).toBeNull();
    s = reduce(s, { type: "undo" });
    expect(s.present.junctions).toHaveLength(2);
    expect(s.present.paths).toHaveLength(0);
    expect(s.preview).toBeNull();
  });

  it("cancel_pending and set_tool drop preview without history", () => {
    let s = createNetworkEditorState(twoPoints());
    s = reduce(s, { type: "set_preview", preview: previewOf("shorter", [[139.7, 35.6], [139.7005, 35.6]]) });
    s = reduce(s, { type: "cancel_pending" });
    expect(s.preview).toBeNull();
    expect(s.past).toHaveLength(0);
    s = reduce(s, { type: "set_preview", preview: previewOf("shorter", [[139.7, 35.6], [139.7005, 35.6]]) });
    s = reduce(s, { type: "set_tool", tool: "select" });
    expect(s.preview).toBeNull();
    expect(s.past).toHaveLength(0);
  });

  it("set_preview does not push history", () => {
    let s = createNetworkEditorState(twoPoints());
    const before = s.present;
    s = reduce(s, { type: "set_preview", preview: previewOf("along_network", [[139.7, 35.6], [139.7005, 35.6]]) });
    expect(s.preview?.candidates[0]?.kind).toBe("along_network");
    expect(s.present).toBe(before);
    expect(s.past).toHaveLength(0);
  });

  it("select_candidate updates the highlighted index", () => {
    let s = createNetworkEditorState(twoPoints());
    s = reduce(s, {
      type: "set_preview",
      preview: {
        fromId: 0,
        toId: 1,
        candidates: [
          { kind: "current", coordinates: [[139.7, 35.6], [139.7005, 35.6]], nodeIds: [0, 1] },
          { kind: "shorter", coordinates: [[139.7, 35.6], [139.7005, 35.6]], nodeIds: null },
        ],
        selectedIndex: 0,
      },
    });
    s = reduce(s, { type: "select_candidate", index: 1 });
    expect(s.preview?.selectedIndex).toBe(1);
    expect(s.past).toHaveLength(0);
  });

  it("set_preview_status records absence without writing the graph", () => {
    let s = createNetworkEditorState(twoPoints());
    s = reduce(s, { type: "set_preview_status", status: "no_walkable" });
    expect(s.previewStatus).toBe("no_walkable");
    expect(s.preview).toBeNull();
    expect(s.present.paths).toHaveLength(0);
    expect(s.past).toHaveLength(0);
  });

  it("propose_failed clears pending without history", () => {
    let s = createNetworkEditorState(twoPoints());
    s = reduce(s, { type: "set_tool", tool: "connect" });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    expect(s.pendingNodeId).toBe(0);
    s = reduce(s, { type: "set_preview_status", status: "propose_failed" });
    expect(s.previewStatus).toBe("propose_failed");
    expect(s.pendingNodeId).toBeNull();
    expect(s.past).toHaveLength(0);
  });

  it("undo and redo after a confirmed path leave preview cleared", () => {
    let s = createNetworkEditorState(twoPoints());
    s = reduce(s, {
      type: "set_preview",
      preview: {
        fromId: 0,
        toId: 1,
        candidates: [
          {
            kind: "shorter",
            coordinates: [
              [139.7, 35.6],
              [139.70025, 35.6],
              [139.7005, 35.6],
            ],
            nodeIds: null,
          },
        ],
        selectedIndex: 0,
      },
    });
    s = reduce(s, { type: "confirm_preview" });
    s = reduce(s, { type: "set_preview", preview: previewOf("current", [[139.7, 35.6], [139.7005, 35.6]]) });
    s = reduce(s, { type: "undo" });
    expect(s.preview).toBeNull();
    s = reduce(s, { type: "redo" });
    expect(s.preview).toBeNull();
  });
});
