import { describe, expect, it } from "vitest";
import {
  addEdge,
  buildNetworkFeatures,
  deleteEdge,
  floorLabelToOrdinal,
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

describe("ordinalToFloorLabel", () => {
  it("round-trips through floorLabelToOrdinal", () => {
    for (const o of [-3, -1, 0, 1, 5]) {
      expect(floorLabelToOrdinal(ordinalToFloorLabel(o))).toBe(o);
    }
  });
});

describe("network editing", () => {
  const base = (): ParsedNetwork => ({
    junctions: [jn(0, 139.7, 35.6, 0), jn(1, 139.7005, 35.6, 0)],
    paths: [],
  });

  it("addEdge appends a forward + reverse path with a positive cost", () => {
    const net = addEdge(base(), 0, 1);
    expect(net.paths).toHaveLength(2);
    const [fwd, rev] = net.paths;
    expect(fwd!.properties.FNODEID).toBe(0);
    expect(fwd!.properties.TNODEID).toBe(1);
    expect(rev!.properties.FNODEID).toBe(1);
    expect(rev!.properties.TNODEID).toBe(0);
    expect(Number(fwd!.properties.cost)).toBeGreaterThan(0);
    expect(fwd!.ordinal).toBe(0);
  });

  it("addEdge is idempotent for an existing undirected pair", () => {
    const net = addEdge(addEdge(base(), 0, 1), 1, 0);
    expect(net.paths).toHaveLength(2);
  });

  it("deleteEdge removes both directions", () => {
    const net = deleteEdge(addEdge(base(), 0, 1), 0, 1);
    expect(net.paths).toHaveLength(0);
  });

  it("serializeNetwork emits named FeatureCollections that re-parse", () => {
    const net = addEdge(base(), 0, 1);
    const { junctions, paths } = serializeNetwork(net);
    const j = JSON.parse(junctions) as { name: string; features: unknown[] };
    const p = JSON.parse(paths) as { name: string; features: unknown[] };
    expect(j.name).toBe("net_junction");
    expect(j.features).toHaveLength(2);
    expect(p.name).toBe("net_path");
    expect(p.features).toHaveLength(2);
  });

  it("addEdge links the forward and reverse path with a reciprocal PATHID pair", () => {
    const net = addEdge(base(), 0, 1);
    const [fwd, rev] = net.paths;
    // A proper reciprocal pair: each path's PATHID is the other's RPATHID, so
    // the Rust importer can canonicalize the two directed features into one edge.
    expect(typeof fwd!.properties.PATHID).toBe("number");
    expect(typeof rev!.properties.PATHID).toBe("number");
    expect(fwd!.properties.RPATHID).toBe(rev!.properties.PATHID);
    expect(rev!.properties.RPATHID).toBe(fwd!.properties.PATHID);
    expect(fwd!.properties.PATHID).not.toBe(fwd!.properties.RPATHID);
  });

  it("addEdge assigns PATHIDs that stay globally unique across edges", () => {
    const seeded: ParsedNetwork = {
      junctions: [jn(0, 139.7, 35.6, 0), jn(1, 139.7005, 35.6, 0), jn(2, 139.701, 35.6, 0)],
      paths: [],
    };
    const net = addEdge(addEdge(seeded, 0, 1), 1, 2);
    expect(net.paths).toHaveLength(4); // two undirected edges → four directed paths
    // Two logical edges use four distinct path ids (1..4); the second edge
    // never reuses the first edge's ids. Within a reciprocal pair the two ids
    // are shared (swapped), so the distinct count is 4, not 8.
    const distinct = new Set(net.paths.flatMap((p) => [p.properties.PATHID, p.properties.RPATHID]));
    expect(distinct.size).toBe(4);
  });

  it("addEdge is a no-op when a junction has non-finite coordinates", () => {
    const bad: ParsedNetwork = {
      junctions: [
        {
          ordinal: 0,
          geometry: { type: "Point", coordinates: [Number.NaN, 35.6] },
          properties: { NODEID: 0, FLOOR: "F1" },
        },
        jn(1, 139.7005, 35.6, 0),
      ],
      paths: [],
    };
    // No NaN-cost path is ever emitted at the browser adapter boundary.
    expect(addEdge(bad, 0, 1).paths).toHaveLength(0);
  });
});
