import { describe, expect, it } from "vitest";
import {
  addConnection,
  addJunction,
  buildNetworkFeatures,
  deleteConnection,
  deleteJunction,
  floorLabelToOrdinal,
  moveJunction,
  ordinalToFloorLabel,
  parseNetworkOverlay,
  serializeNetwork,
  type ParsedNetwork,
} from "./networkFeatures";

describe("floorLabelToOrdinal", () => {
  it("inverts the exported floor labels", () => {
    expect(floorLabelToOrdinal("F1")).toBe(0);
    expect(floorLabelToOrdinal("F9")).toBe(8);
    expect(floorLabelToOrdinal("B1")).toBe(-1);
    expect(floorLabelToOrdinal("B3")).toBe(-3);
    expect(floorLabelToOrdinal("M2")).toBe(2);
    expect(floorLabelToOrdinal("garbage")).toBeNull();
    expect(floorLabelToOrdinal("")).toBeNull();
  });
});

const DTO = {
  junctions: JSON.stringify({
    type: "FeatureCollection",
    name: "net_junction",
    features: [
      { type: "Feature", properties: { NODEID: 0, FLOOR: "F1" }, geometry: { type: "Point", coordinates: [139.7, 35.69] } },
      { type: "Feature", properties: { NODEID: 1, FLOOR: "B1" }, geometry: { type: "Point", coordinates: [139.7, 35.69] } },
    ],
  }),
  paths: JSON.stringify({
    type: "FeatureCollection",
    name: "net_path",
    features: [
      { type: "Feature", properties: { FNODEID: 0, TNODEID: 1, FLOOR: "F1" }, geometry: { type: "LineString", coordinates: [[139.7, 35.69], [139.701, 35.69]] } },
      { type: "Feature", properties: { FNODEID: 2, TNODEID: 3, FLOOR: "B1" }, geometry: { type: "LineString", coordinates: [[139.7, 35.69], [139.701, 35.69]] } },
    ],
  }),
};

describe("parseNetworkOverlay + buildNetworkFeatures", () => {
  it("filters junctions and paths to the active floor ordinal", () => {
    const parsed = parseNetworkOverlay(DTO);
    expect(parsed.junctions).toHaveLength(2);
    expect(parsed.paths).toHaveLength(2);

    const f1 = buildNetworkFeatures(parsed, 0);
    // one path + one junction on F1 (ordinal 0)
    expect(f1.features).toHaveLength(2);
    expect(f1.features.filter((f) => f.properties?.kind === "path")).toHaveLength(1);
    expect(f1.features.filter((f) => f.properties?.kind === "junction")).toHaveLength(1);

    const b1 = buildNetworkFeatures(parsed, -1);
    expect(b1.features).toHaveLength(2);

    // A floor with no network features yields an empty collection.
    expect(buildNetworkFeatures(parsed, 5).features).toHaveLength(0);
  });

  it("returns an empty collection for a null network", () => {
    expect(buildNetworkFeatures(null, 0).features).toHaveLength(0);
  });
});

function jn(id: number, lon: number, lat: number, ordinal: number): ParsedNetwork["junctions"][number] {
  return {
    ordinal,
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { NODEID: id, FLOOR: ordinalToFloorLabel(ordinal) },
  };
}

/** A directed `net_path` with an explicit reciprocal id pair, for parallel-edge fixtures. */
function pathFeature(
  from: number,
  to: number,
  pathId: number,
  reversePathId: number,
  ordinal = 0,
): ParsedNetwork["paths"][number] {
  return {
    ordinal,
    geometry: { type: "LineString", coordinates: [[139.7, 35.6], [139.7005, 35.6]] },
    properties: {
      FNODEID: from,
      TNODEID: to,
      cost: 100,
      FLOOR: ordinalToFloorLabel(ordinal),
      PATHID: pathId,
      RPATHID: reversePathId,
    },
  };
}

/** A reciprocal cross-floor pair: exporter-guaranteed vertical metadata. */
function verticalNetwork(): ParsedNetwork {
  return {
    junctions: [
      jn(10, 139.7000, 35.6000, 0),
      jn(20, 139.7008, 35.6004, 1),
    ],
    paths: [
      {
        ordinal: 0,
        geometry: { type: "LineString", coordinates: [[139.7000, 35.6000], [139.7008, 35.6004]] },
        properties: {
          FNODEID: 10,
          TNODEID: 20,
          FLOOR: "F1",
          PATHID: 8,
          RPATHID: 7,
          HFLAG: 1,
          FFLOOR: "F1",
          TFOOLR: "F2",
          passage_type: 1,
        },
      },
      {
        ordinal: 0,
        geometry: { type: "LineString", coordinates: [[139.7008, 35.6004], [139.7000, 35.6000]] },
        properties: {
          FNODEID: 20,
          TNODEID: 10,
          FLOOR: "F1",
          PATHID: 7,
          RPATHID: 8,
          HFLAG: 1,
          FFLOOR: "F2",
          TFOOLR: "F1",
          passage_type: 1,
        },
      },
    ],
  };
}

describe("vertical network link projection", () => {
  it("projects a reciprocal vertical pair as one lower-floor marker and no line", () => {
    const collection = buildNetworkFeatures(verticalNetwork(), 0);
    const links = collection.features.filter((feature) => feature.properties?.kind === "vertical-link");
    expect(links).toHaveLength(1);
    expect(collection.features.filter((feature) => feature.properties?.kind === "path")).toHaveLength(0);
    expect(links[0]).toMatchObject({
      properties: {
        PATHID: 7,
        RPATHID: 8,
        endpointNodeId: 10,
        targetNodeId: 20,
        activeFloor: "F1",
        targetFloor: "F2",
        targetDirection: "up",
        passageType: 1,
        selected: false,
      },
      geometry: { type: "Point", coordinates: [139.7, 35.6] },
    });
  });

  it("moves the same vertical link to the upper endpoint", () => {
    const links = buildNetworkFeatures(verticalNetwork(), 1).features.filter(
      (feature) => feature.properties?.kind === "vertical-link",
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      properties: {
        endpointNodeId: 20,
        targetNodeId: 10,
        activeFloor: "F2",
        targetFloor: "F1",
        targetDirection: "down",
      },
      geometry: { type: "Point", coordinates: [139.7008, 35.6004] },
    });
  });

  it("tags every vertical marker with a glyph-free label image id", () => {
    const down = buildNetworkFeatures(verticalNetwork(), 0).features.filter(
      (feature) => feature.properties?.kind === "vertical-link",
    );
    expect(down[0]?.properties).toMatchObject({
      targetDirection: "up",
      targetFloor: "F2",
      labelImage: "vertical-link-label-up-F2",
    });
    const up = buildNetworkFeatures(verticalNetwork(), 1).features.filter(
      (feature) => feature.properties?.kind === "vertical-link",
    );
    expect(up[0]?.properties).toMatchObject({
      targetDirection: "down",
      targetFloor: "F1",
      labelImage: "vertical-link-label-down-F1",
    });
  });

  it("selects a vertical marker by canonical reciprocal identity", () => {
    const links = buildNetworkFeatures(verticalNetwork(), 0, {
      selectedJunctionIds: [],
      selectedConnections: [{ pathId: 7, reversePathId: 8 }],
      pendingJunctionId: null,
    }).features.filter((feature) => feature.properties?.kind === "vertical-link");
    expect(links[0]?.properties?.selected).toBe(true);
  });

  it("emits nothing for malformed vertical metadata instead of a fake horizontal path", () => {
    const net = verticalNetwork();
    for (const path of net.paths) {
      delete path.properties.TFOOLR;
    }
    const collection = buildNetworkFeatures(net, 0);
    expect(collection.features.filter((f) => f.properties?.kind === "vertical-link")).toHaveLength(0);
    expect(collection.features.filter((f) => f.properties?.kind === "path")).toHaveLength(0);
  });

  it("emits nothing when an endpoint junction is not a Point", () => {
    const net = verticalNetwork();
    net.junctions[0] = {
      ...net.junctions[0]!,
      geometry: { type: "LineString", coordinates: [[139.7, 35.6], [139.7005, 35.6]] },
    };
    const collection = buildNetworkFeatures(net, 0);
    expect(collection.features.filter((f) => f.properties?.kind === "vertical-link")).toHaveLength(0);
    expect(collection.features.filter((f) => f.properties?.kind === "path")).toHaveLength(0);
  });
});

describe("ordinalToFloorLabel", () => {
  it("round-trips through floorLabelToOrdinal", () => {
    for (const o of [-3, -1, 0, 1, 5]) {
      expect(floorLabelToOrdinal(ordinalToFloorLabel(o))).toBe(o);
    }
  });
});

describe("network mutations", () => {
  const base = (): ParsedNetwork => ({
    junctions: [jn(0, 139.7, 35.6, 0), jn(1, 139.7005, 35.6, 0)],
    paths: [],
  });

  it("addJunction appends a NODEID one past the max with canonical defaults", () => {
    const r = addJunction(base(), { longitude: 139.701, latitude: 35.6, ordinal: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nodeId).toBe(2);
    expect(r.network.junctions).toHaveLength(3);
    const added = r.network.junctions[2]!;
    expect(added.ordinal).toBe(0);
    expect(added.geometry).toEqual({ type: "Point", coordinates: [139.701, 35.6] });
    expect(added.properties).toMatchObject({
      NODEID: 2,
      PATH_COUNT: 0,
      FLOOR: "F1",
      BARRIER: 0,
      STARTTIME: -1,
      ENDTIME: -1,
      GATE: 0,
      NAME: null,
      relative_height: null,
      altitude: 0,
    });
  });

  it("addJunction allocates altitude from the floor ordinal", () => {
    const r = addJunction(base(), { longitude: 139.7, latitude: 35.6, ordinal: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.network.junctions[2]!.properties).toMatchObject({ FLOOR: "F3", altitude: 8 });
  });

  it("addJunction rejects non-finite coordinates", () => {
    const net = base();
    const r = addJunction(net, { longitude: Number.NaN, latitude: 35.6, ordinal: 0 });
    expect(r).toEqual({ ok: false, network: net, error: "invalid_coordinate" });
  });

  it("addConnection emits a reciprocal pair with canonical defaults and positive cost", () => {
    const r = addConnection(base(), 0, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.network.paths).toHaveLength(2);
    const [fwd, rev] = r.network.paths;
    expect(fwd!.properties.FNODEID).toBe(0);
    expect(fwd!.properties.TNODEID).toBe(1);
    expect(rev!.properties.FNODEID).toBe(1);
    expect(rev!.properties.TNODEID).toBe(0);
    expect(Number(fwd!.properties.cost)).toBeGreaterThan(0);
    expect(fwd!.properties.RPATHID).toBe(rev!.properties.PATHID);
    expect(rev!.properties.RPATHID).toBe(fwd!.properties.PATHID);
    expect(fwd!.properties.passage_type).toBe(0);
    expect(fwd!.properties.indoor).toBe(1);
    expect(fwd!.properties.FFLOOR).toBeNull();
    expect(fwd!.properties.FLOOR).toBe("F1");
    expect(fwd!.ordinal).toBe(0);
    expect(r.connectionId).toEqual({ pathId: 1, reversePathId: 2 });
  });

  it("addConnection recomputes PATH_COUNT for both endpoints", () => {
    const r = addConnection(base(), 0, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.network.junctions.map((j) => j.properties.PATH_COUNT)).toEqual([1, 1]);
  });

  it("addConnection rejects same, unknown, existing, and cross-floor endpoints", () => {
    expect(addConnection(base(), 0, 0)).toMatchObject({ ok: false, error: "same_junction" });
    expect(addConnection(base(), 0, 9)).toMatchObject({ ok: false, error: "unknown_junction" });
    const once = addConnection(base(), 0, 1);
    expect(once.ok).toBe(true);
    if (once.ok) {
      expect(addConnection(once.network, 1, 0)).toMatchObject({ ok: false, error: "existing_connection" });
    }
    const cross: ParsedNetwork = {
      junctions: [jn(0, 139.7, 35.6, 0), jn(1, 139.7, 35.6, 1)],
      paths: [],
    };
    expect(addConnection(cross, 0, 1)).toMatchObject({ ok: false, error: "cross_floor_connection" });
  });

  it("addConnection assigns globally-unique reciprocal ids across connections", () => {
    const seeded: ParsedNetwork = {
      junctions: [jn(0, 139.7, 35.6, 0), jn(1, 139.7005, 35.6, 0), jn(2, 139.701, 35.6, 0)],
      paths: [],
    };
    const first = addConnection(seeded, 0, 1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = addConnection(first.network, 1, 2);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.network.paths).toHaveLength(4);
    const ids = new Set(
      second.network.paths.flatMap((p) => [p.properties.PATHID, p.properties.RPATHID]),
    );
    expect(ids.size).toBe(4);
  });

  it("deleteConnection removes exactly one of two parallel connections", () => {
    const net: ParsedNetwork = {
      junctions: [jn(0, 139.7, 35.6, 0), jn(1, 139.7005, 35.6, 0)],
      paths: [
        pathFeature(0, 1, 1, 2),
        pathFeature(1, 0, 2, 1),
        pathFeature(0, 1, 3, 4),
        pathFeature(1, 0, 4, 3),
      ],
    };
    const r = deleteConnection(net, { pathId: 3, reversePathId: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.network.paths).toHaveLength(2);
    expect(r.network.paths.every((p) => p.properties.PATHID === 1 || p.properties.PATHID === 2)).toBe(true);
    // Two parallel edges collapse to one remaining logical connection per node.
    expect(r.network.junctions.map((j) => j.properties.PATH_COUNT)).toEqual([1, 1]);
  });

  it("deleteConnection normalizes the id pair order", () => {
    const net: ParsedNetwork = {
      junctions: [jn(0, 139.7, 35.6, 0), jn(1, 139.7005, 35.6, 0)],
      paths: [pathFeature(0, 1, 3, 4), pathFeature(1, 0, 4, 3)],
    };
    const r = deleteConnection(net, { pathId: 4, reversePathId: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.network.paths).toHaveLength(0);
  });

  it("deletes a vertical reciprocal pair by the marker's canonical identity", () => {
    const net = verticalNetwork();
    const result = deleteConnection(net, { pathId: 8, reversePathId: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.network.paths).toHaveLength(0);
    expect(result.network.junctions.map((junction) => junction.properties.PATH_COUNT)).toEqual([0, 0]);
  });

  it("deleteConnection reports unknown_connection for a missing pair", () => {
    const withEdge = addConnection(base(), 0, 1);
    expect(withEdge.ok).toBe(true);
    if (!withEdge.ok) return;
    expect(deleteConnection(withEdge.network, { pathId: 99, reversePathId: 100 })).toMatchObject({
      ok: false,
      error: "unknown_connection",
    });
  });

  it("moveJunction moves a LineString endpoint and preserves stored cost", () => {
    const withEdge = addConnection(base(), 0, 1);
    expect(withEdge.ok).toBe(true);
    if (!withEdge.ok) return;
    const originalCost = withEdge.network.paths[0]!.properties.cost;
    const moved = moveJunction(withEdge.network, 0, { longitude: 139.702, latitude: 35.601 });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const j0 = moved.network.junctions.find((j) => j.properties.NODEID === 0)!;
    expect(j0.geometry).toEqual({ type: "Point", coordinates: [139.702, 35.601] });
    const fwd = moved.network.paths.find((p) => p.properties.FNODEID === 0)!;
    expect((fwd.geometry as GeoJSON.LineString).coordinates[0]).toEqual([139.702, 35.601]);
    expect(fwd.properties.cost).toBe(originalCost);
    const rev = moved.network.paths.find((p) => p.properties.TNODEID === 0)!;
    const revCoords = (rev.geometry as GeoJSON.LineString).coordinates;
    expect(revCoords[revCoords.length - 1]).toEqual([139.702, 35.601]);
  });

  it("moveJunction updates a MultiLineString endpoint keeping interior vertices", () => {
    const net: ParsedNetwork = {
      junctions: [jn(0, 139.7, 35.6, 0), jn(1, 139.71, 35.6, 0)],
      paths: [
        {
          ordinal: 0,
          geometry: {
            type: "MultiLineString",
            coordinates: [[[139.7, 35.6], [139.705, 35.6005], [139.71, 35.6]]],
          },
          properties: { FNODEID: 0, TNODEID: 1, cost: 500, PATHID: 1, RPATHID: 2, FLOOR: "F1" },
        },
      ],
    };
    const moved = moveJunction(net, 1, { longitude: 139.72, latitude: 35.61 });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const geom = moved.network.paths[0]!.geometry as GeoJSON.MultiLineString;
    const line = geom.coordinates[0]!;
    expect(line[line.length - 1]).toEqual([139.72, 35.61]);
    expect(line[1]).toEqual([139.705, 35.6005]);
  });

  it("moveJunction rejects unknown nodes and non-finite coordinates", () => {
    expect(moveJunction(base(), 9, { longitude: 139.7, latitude: 35.6 })).toMatchObject({
      ok: false,
      error: "unknown_junction",
    });
    expect(
      moveJunction(base(), 0, { longitude: 139.7, latitude: Number.POSITIVE_INFINITY }),
    ).toMatchObject({ ok: false, error: "invalid_coordinate" });
  });

  it("deleteJunction removes the node and every incident path", () => {
    const seeded: ParsedNetwork = {
      junctions: [jn(0, 139.7, 35.6, 0), jn(1, 139.7005, 35.6, 0), jn(2, 139.701, 35.6, 0)],
      paths: [],
    };
    const c1 = addConnection(seeded, 0, 1);
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    const c2 = addConnection(c1.network, 1, 2);
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    const del = deleteJunction(c2.network, 1);
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.network.junctions.map((j) => j.properties.NODEID)).toEqual([0, 2]);
    expect(del.network.paths).toHaveLength(0);
    expect(del.network.junctions.map((j) => j.properties.PATH_COUNT)).toEqual([0, 0]);
  });

  it("deleteJunction reports unknown_junction for a missing node", () => {
    expect(deleteJunction(base(), 9)).toMatchObject({ ok: false, error: "unknown_junction" });
  });

  it("serializeNetwork emits named FeatureCollections that re-parse", () => {
    const withEdge = addConnection(base(), 0, 1);
    expect(withEdge.ok).toBe(true);
    if (!withEdge.ok) return;
    const { junctions, paths } = serializeNetwork(withEdge.network);
    const j = JSON.parse(junctions) as { name: string; features: unknown[] };
    const p = JSON.parse(paths) as { name: string; features: unknown[] };
    expect(j.name).toBe("net_junction");
    expect(j.features).toHaveLength(2);
    expect(p.name).toBe("net_path");
    expect(p.features).toHaveLength(2);
    const reparsed = parseNetworkOverlay({ junctions, paths });
    expect(reparsed.junctions).toHaveLength(2);
    expect(reparsed.paths).toHaveLength(2);
  });

  it("rejected mutations return the original network object", () => {
    const net = base();
    expect(addConnection(net, 0, 0).network).toBe(net);
    expect(moveJunction(net, 9, { longitude: 1, latitude: 1 }).network).toBe(net);
    expect(deleteJunction(net, 9).network).toBe(net);
  });
});

describe("buildNetworkFeatures render state", () => {
  it("marks the selected junction, selected connection, and pending origin", () => {
    const net: ParsedNetwork = {
      junctions: [jn(0, 139.7, 35.6, 0), jn(1, 139.7005, 35.6, 0)],
      paths: [pathFeature(0, 1, 1, 2), pathFeature(1, 0, 2, 1)],
    };
    const fc = buildNetworkFeatures(net, 0, {
      selectedJunctionIds: [0],
      selectedConnections: [{ pathId: 1, reversePathId: 2 }],
      pendingJunctionId: 1,
    });
    const junctions = fc.features.filter((f) => f.properties?.kind === "junction");
    const paths = fc.features.filter((f) => f.properties?.kind === "path");
    const j0 = junctions.find((f) => f.properties?.NODEID === 0)!;
    const j1 = junctions.find((f) => f.properties?.NODEID === 1)!;
    expect(j0.properties?.selected).toBe(true);
    expect(j0.properties?.pending).toBe(false);
    expect(j1.properties?.pending).toBe(true);
    expect(j1.properties?.selected).toBe(false);
    // Both directed paths of connection {1,2} are marked selected.
    expect(paths).toHaveLength(2);
    expect(paths.every((f) => f.properties?.selected === true)).toBe(true);
    expect(paths[0]?.properties?.PATHID).toBeDefined();
    expect(paths[0]?.properties?.RPATHID).toBeDefined();
  });

  it("leaves everything unmarked without render state", () => {
    const net: ParsedNetwork = { junctions: [jn(0, 139.7, 35.6, 0)], paths: [] };
    const fc = buildNetworkFeatures(net, 0);
    expect(fc.features[0]?.properties?.selected).toBe(false);
    expect(fc.features[0]?.properties?.pending).toBe(false);
  });
});
