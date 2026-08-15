import { describe, expect, it } from "vitest";
import type { ViewerFeature, ViewerLevel } from "../../imdf/types";
import type { NetworkFeature, ParsedNetwork } from "../networkFeatures";
import {
  conveyanceDirections,
  conveyanceLinks,
  linkEndsOnFloor,
  verticalLinks,
} from "./verticalLinks";

const LEVELS: ViewerLevel[] = [
  { id: "B1", ordinal: -1, label: { ja: "B1", en: "B1" }, shortName: { ja: "B1", en: "B1" } },
  { id: "F1", ordinal: 0, label: { ja: "F1", en: "F1" }, shortName: { ja: "F1", en: "F1" } },
  { id: "F2", ordinal: 1, label: { ja: "F2", en: "F2" }, shortName: { ja: "F2", en: "F2" } },
  { id: "F3", ordinal: 2, label: { ja: "F3", en: "F3" }, shortName: { ja: "F3", en: "F3" } },
  { id: "F4", ordinal: 3, label: { ja: "F4", en: "F4" }, shortName: { ja: "F4", en: "F4" } },
];

/** A square Polygon in lon/lat around `(lon, lat)`. */
function boxPolygon(lon: number, lat: number): GeoJSON.Polygon {
  return {
    type: "Polygon",
    coordinates: [
      [
        [lon - 0.01, lat - 0.01],
        [lon + 0.01, lat - 0.01],
        [lon + 0.01, lat + 0.01],
        [lon - 0.01, lat + 0.01],
        [lon - 0.01, lat - 0.01],
      ],
    ],
  };
}

function conveyance(id: string, geometry: GeoJSON.Geometry | null): ViewerFeature {
  return {
    id,
    featureType: "footprint",
    levelId: "F1",
    geometry,
    center: null,
    labels: {},
    altLabels: {},
    category: "escalator",
    accessibility: [],
    restriction: null,
    sourceProperties: {},
  };
}

function junction(nodeId: number, ordinal: number, lon: number, lat: number): NetworkFeature {
  return {
    ordinal,
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { NODEID: nodeId },
  };
}

/** A directed vertical `net_path` (`HFLAG === 1`), exporter property names. */
function verticalPath(options: {
  pathId: number;
  reversePathId: number;
  fromId: number;
  toId: number;
  fromFloor: string;
  toFloor: string;
  kind?: string;
}): NetworkFeature {
  return {
    ordinal: null,
    geometry: { type: "LineString", coordinates: [[0, 0]] },
    properties: {
      PATHID: options.pathId,
      RPATHID: options.reversePathId,
      FNODEID: options.fromId,
      TNODEID: options.toId,
      FFLOOR: options.fromFloor,
      TFOOLR: options.toFloor,
      HFLAG: 1,
      ...(options.kind === undefined ? {} : { TRANSITION_CATEGORY: options.kind }),
    },
  };
}

/** One vertical connection between junctions on two floors, as both directions. */
function verticalPair(options: {
  pathId: number;
  reversePathId: number;
  fromId: number;
  toId: number;
  fromFloor: string;
  toFloor: string;
  kind?: string;
}): NetworkFeature[] {
  return [
    verticalPath(options),
    verticalPath({
      pathId: options.reversePathId,
      reversePathId: options.pathId,
      fromId: options.toId,
      toId: options.fromId,
      fromFloor: options.toFloor,
      toFloor: options.fromFloor,
      ...(options.kind === undefined ? {} : { kind: options.kind }),
    }),
  ];
}

describe("verticalLinks", () => {
  const pairAcrossF1F2 = {
    junctions: [junction(1, 0, 139.767, 35.681), junction(2, 1, 139.767, 35.681)],
    paths: verticalPair({
      pathId: 20,
      reversePathId: 10,
      fromId: 2,
      toId: 1,
      fromFloor: "F2",
      toFloor: "F1",
      kind: "escalator",
    }),
  };

  it("orders the ends by elevation whichever way the exporter listed the row", () => {
    // The row above runs F2 → F1, so a reader that trusted row order would
    // draw the connector upside down and label the wrong floor.
    const links = verticalLinks(pairAcrossF1F2);
    expect(links).toHaveLength(1);
    expect(links[0]?.lower.floor).toBe("F1");
    expect(links[0]?.lower.ordinal).toBe(0);
    expect(links[0]?.upper.floor).toBe("F2");
    expect(links[0]?.upper.ordinal).toBe(1);
    expect(links[0]?.lower.nodeId).toBe(1);
    expect(links[0]?.upper.nodeId).toBe(2);
  });

  it("collapses the reciprocal pair into one normalized connection", () => {
    const links = verticalLinks(pairAcrossF1F2);
    expect(links).toHaveLength(1);
    expect(links[0]?.connectionId).toEqual({ pathId: 10, reversePathId: 20 });
  });

  it("carries the transport the graph states and nothing when it states none", () => {
    expect(verticalLinks(pairAcrossF1F2)[0]?.kind).toBe("escalator");
    const untyped: ParsedNetwork = {
      junctions: pairAcrossF1F2.junctions,
      paths: verticalPair({
        pathId: 1,
        reversePathId: 2,
        fromId: 1,
        toId: 2,
        fromFloor: "F1",
        toFloor: "F2",
      }),
    };
    // Never borrowed from a nearby unit's category: absent evidence stays absent.
    expect(verticalLinks(untyped)[0]?.kind).toBeNull();
  });

  it("drops a vertical row whose two ends land on one floor", () => {
    const sameFloor: ParsedNetwork = {
      junctions: [junction(1, 0, 139.767, 35.681), junction(2, 0, 139.768, 35.681)],
      paths: verticalPair({
        pathId: 1,
        reversePathId: 2,
        fromId: 1,
        toId: 2,
        fromFloor: "F1",
        toFloor: "F1",
      }),
    };
    expect(verticalLinks(sameFloor)).toEqual([]);
  });

  it("drops a link whose junction the network never exported", () => {
    const missing: ParsedNetwork = {
      junctions: [junction(1, 0, 139.767, 35.681)],
      paths: verticalPair({
        pathId: 1,
        reversePathId: 2,
        fromId: 1,
        toId: 99,
        fromFloor: "F1",
        toFloor: "F2",
      }),
    };
    expect(verticalLinks(missing)).toEqual([]);
  });

  it("has nothing to say about a venue with no loaded network", () => {
    expect(verticalLinks(null)).toEqual([]);
  });

  it("orders links by connection id so every surface walks them alike", () => {
    const many: ParsedNetwork = {
      junctions: [
        junction(1, 0, 139.767, 35.681),
        junction(2, 1, 139.767, 35.681),
        junction(3, 0, 139.77, 35.681),
        junction(4, 1, 139.77, 35.681),
      ],
      paths: [
        ...verticalPair({ pathId: 40, reversePathId: 41, fromId: 3, toId: 4, fromFloor: "F1", toFloor: "F2" }),
        ...verticalPair({ pathId: 8, reversePathId: 9, fromId: 1, toId: 2, fromFloor: "F1", toFloor: "F2" }),
      ],
    };
    expect(verticalLinks(many).map((link) => link.connectionId.pathId)).toEqual([8, 40]);
  });
});

describe("linkEndsOnFloor", () => {
  const link = verticalLinks({
    junctions: [junction(1, 0, 139.767, 35.681), junction(2, 2, 139.767, 35.681)],
    paths: verticalPair({
      pathId: 1,
      reversePathId: 2,
      fromId: 1,
      toId: 2,
      fromFloor: "F1",
      toFloor: "F3",
    }),
  })[0]!;

  it("answers from whichever floor is asking", () => {
    expect(linkEndsOnFloor(link, 0)?.far.floor).toBe("F3");
    expect(linkEndsOnFloor(link, 2)?.far.floor).toBe("F1");
    expect(linkEndsOnFloor(link, 0)?.near.floor).toBe("F1");
  });

  it("says nothing for a floor the link does not touch", () => {
    // F2 sits between the two ends; a link that passes it does not stop there.
    expect(linkEndsOnFloor(link, 1)).toBeNull();
  });
});

describe("conveyanceLinks", () => {
  it("gives a conveyance the connection a reviewer would otherwise hunt for", () => {
    const network: ParsedNetwork = {
      junctions: [junction(1, 0, 139.767, 35.681), junction(2, 1, 139.767, 35.681)],
      paths: verticalPair({
        pathId: 7,
        reversePathId: 8,
        fromId: 1,
        toId: 2,
        fromFloor: "F1",
        toFloor: "F2",
      }),
    };
    const links = conveyanceLinks(network, LEVELS, "F1", [
      conveyance("esc-1", boxPolygon(139.767, 35.681)),
    ]);
    expect(links.get("esc-1")?.connectionId).toEqual({ pathId: 7, reversePathId: 8 });
    expect(links.get("esc-1")?.upper.floor).toBe("F2");
  });

  it("leaves a conveyance the graph never linked without a connection", () => {
    const network: ParsedNetwork = {
      junctions: [junction(1, 0, 139.9, 35.9), junction(2, 1, 139.9, 35.9)],
      paths: verticalPair({
        pathId: 7,
        reversePathId: 8,
        fromId: 1,
        toId: 2,
        fromFloor: "F1",
        toFloor: "F2",
      }),
    };
    expect(
      conveyanceLinks(network, LEVELS, "F1", [
        conveyance("esc-1", boxPolygon(139.767, 35.681)),
      ]).size,
    ).toBe(0);
    expect(conveyanceLinks(null, LEVELS, "F1", [conveyance("esc-1", boxPolygon(139.767, 35.681))]).size).toBe(0);
  });
});

describe("conveyanceDirections", () => {
  it("yields ↑ plus the target floor token when a vertical link's active endpoint is inside the footprint", () => {
    const network: ParsedNetwork = {
      junctions: [
        junction(1, 0, 139.767, 35.681), // F1
        junction(2, 1, 139.768, 35.682), // F2
      ],
      paths: verticalPair({
        pathId: 10,
        reversePathId: 11,
        fromId: 1,
        toId: 2,
        fromFloor: "F1",
        toFloor: "F2",
      }),
    };
    const directions = conveyanceDirections(
      network,
      LEVELS,
      "F1",
      [conveyance("escalator-1", boxPolygon(139.767, 35.681))],
    );
    expect([...directions.entries()]).toEqual([["escalator-1", { arrow: "up", targetFloor: "F2" }]]);
  });

  it("yields ↓ with the lower floor token when the active floor is the higher endpoint", () => {
    const network: ParsedNetwork = {
      junctions: [
        junction(1, 0, 139.767, 35.681), // F1
        junction(2, 1, 139.768, 35.682), // F2
      ],
      paths: verticalPair({
        pathId: 10,
        reversePathId: 11,
        fromId: 1,
        toId: 2,
        fromFloor: "F1",
        toFloor: "F2",
      }),
    };
    const directions = conveyanceDirections(
      network,
      LEVELS,
      "F2",
      [conveyance("escalator-1", boxPolygon(139.768, 35.682))],
    );
    expect([...directions.entries()]).toEqual([["escalator-1", { arrow: "down", targetFloor: "F1" }]]);
  });

  it("leaves a conveyance without any matching link out of the map entirely", () => {
    const network: ParsedNetwork = {
      junctions: [
        junction(1, 0, 139.767, 35.681), // F1
        junction(2, 1, 139.768, 35.682), // F2
      ],
      paths: verticalPair({
        pathId: 10,
        reversePathId: 11,
        fromId: 1,
        toId: 2,
        fromFloor: "F1",
        toFloor: "F2",
      }),
    };
    const directions = conveyanceDirections(
      network,
      LEVELS,
      "F1",
      [conveyance("escalator-1", boxPolygon(139.9, 35.9))],
    );
    expect(directions.size).toBe(0);
  });

  it("yields an empty map for a null network — absence is never fabricated", () => {
    const directions = conveyanceDirections(
      null,
      LEVELS,
      "F1",
      [conveyance("escalator-1", boxPolygon(139.767, 35.681))],
    );
    expect(directions.size).toBe(0);
  });

  it("yields no entry for a feature with null geometry", () => {
    const network: ParsedNetwork = {
      junctions: [
        junction(1, 0, 139.767, 35.681),
        junction(2, 1, 139.768, 35.682),
      ],
      paths: verticalPair({
        pathId: 10,
        reversePathId: 11,
        fromId: 1,
        toId: 2,
        fromFloor: "F1",
        toFloor: "F2",
      }),
    };
    const directions = conveyanceDirections(
      network,
      LEVELS,
      "F1",
      [conveyance("escalator-1", null)],
    );
    expect(directions.size).toBe(0);
  });

  it("yields no entry for non-polygonal geometry even when a link is nearby", () => {
    const network: ParsedNetwork = {
      junctions: [
        junction(1, 0, 139.767, 35.681),
        junction(2, 1, 139.768, 35.682),
      ],
      paths: verticalPair({
        pathId: 10,
        reversePathId: 11,
        fromId: 1,
        toId: 2,
        fromFloor: "F1",
        toFloor: "F2",
      }),
    };
    const pointGeometry: GeoJSON.Geometry = { type: "Point", coordinates: [139.767, 35.681] };
    const directions = conveyanceDirections(
      network,
      LEVELS,
      "F1",
      [conveyance("escalator-1", pointGeometry)],
    );
    expect(directions.size).toBe(0);
  });

  it("supports MultiPolygon footprints", () => {
    const network: ParsedNetwork = {
      junctions: [
        junction(1, 0, 139.767, 35.681),
        junction(2, 1, 139.768, 35.682),
      ],
      paths: verticalPair({
        pathId: 10,
        reversePathId: 11,
        fromId: 1,
        toId: 2,
        fromFloor: "F1",
        toFloor: "F2",
      }),
    };
    const multi: GeoJSON.MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [boxPolygon(139.9, 35.9).coordinates, boxPolygon(139.767, 35.681).coordinates],
    };
    const directions = conveyanceDirections(network, LEVELS, "F1", [conveyance("esc-1", multi)]);
    expect([...directions.entries()]).toEqual([["esc-1", { arrow: "up", targetFloor: "F2" }]]);
  });

  it("excludes a link whose endpoint sits in a polygon hole", () => {
    const network: ParsedNetwork = {
      junctions: [
        junction(1, 0, 139.767, 35.681),
        junction(2, 1, 139.768, 35.682),
      ],
      paths: verticalPair({
        pathId: 10,
        reversePathId: 11,
        fromId: 1,
        toId: 2,
        fromFloor: "F1",
        toFloor: "F2",
      }),
    };
    const withHole: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [139.75, 35.67],
          [139.78, 35.67],
          [139.78, 35.69],
          [139.75, 35.69],
          [139.75, 35.67],
        ],
        [
          [139.7665, 35.6805],
          [139.7675, 35.6805],
          [139.7675, 35.6815],
          [139.7665, 35.6815],
          [139.7665, 35.6805],
        ],
      ],
    };
    const directions = conveyanceDirections(network, LEVELS, "F1", [conveyance("esc-1", withHole)]);
    expect(directions.size).toBe(0);
  });

  it("prefers the link whose target floor is nearest the active floor", () => {
    const network: ParsedNetwork = {
      junctions: [
        junction(1, 0, 139.767, 35.681), // F1 → F2
        junction(2, 1, 139.768, 35.682), // F2
        junction(3, 0, 139.767, 35.681), // F1 → F3
        junction(4, 2, 139.769, 35.683), // F3
      ],
      paths: [
        ...verticalPair({ pathId: 10, reversePathId: 11, fromId: 1, toId: 2, fromFloor: "F1", toFloor: "F2" }),
        ...verticalPair({ pathId: 12, reversePathId: 13, fromId: 3, toId: 4, fromFloor: "F1", toFloor: "F3" }),
      ],
    };
    const directions = conveyanceDirections(
      network,
      LEVELS,
      "F1",
      [conveyance("escalator-1", boxPolygon(139.767, 35.681))],
    );
    // Both endpoints are inside the footprint; F2 is nearer than F3.
    expect([...directions.entries()]).toEqual([["escalator-1", { arrow: "up", targetFloor: "F2" }]]);
  });

  it("breaks an exact target-floor distance tie with the lowest target ordinal first", () => {
    const network: ParsedNetwork = {
      junctions: [
        junction(1, 1, 139.768, 35.682), // F2 → F3 (distance 1)
        junction(2, 2, 139.769, 35.683), // F3
        junction(3, 1, 139.768, 35.682), // F2 → F1 (distance 1)
        junction(4, 0, 139.767, 35.681), // F1
      ],
      paths: [
        ...verticalPair({ pathId: 10, reversePathId: 11, fromId: 1, toId: 2, fromFloor: "F2", toFloor: "F3" }),
        ...verticalPair({ pathId: 12, reversePathId: 13, fromId: 3, toId: 4, fromFloor: "F2", toFloor: "F1" }),
      ],
    };
    const directions = conveyanceDirections(
      network,
      LEVELS,
      "F2",
      [conveyance("elevator-1", boxPolygon(139.768, 35.682))],
    );
    // F1 (ordinal 0) and F3 (ordinal 2) are equidistant from F2; the lower
    // target ordinal wins, deterministically, so the badge never flickers.
    expect([...directions.entries()]).toEqual([["elevator-1", { arrow: "down", targetFloor: "F1" }]]);
  });

  it("keeps a single entry per logical connection even when both directions are exported", () => {
    const network: ParsedNetwork = {
      junctions: [
        junction(1, 0, 139.767, 35.681),
        junction(2, 1, 139.768, 35.682),
      ],
      paths: verticalPair({ pathId: 10, reversePathId: 11, fromId: 1, toId: 2, fromFloor: "F1", toFloor: "F2" }),
    };
    const directions = conveyanceDirections(
      network,
      LEVELS,
      "F1",
      [conveyance("escalator-1", boxPolygon(139.767, 35.681))],
    );
    expect(directions.size).toBe(1);
  });

  it("breaks a same-target tie by lowest pair id, independent of path order", () => {
    // Two distinct connections, both F1 → F2, both endpoints inside the
    // footprint: distance and target ordinal tie, so the lowest pair id must
    // win — and it must win even when its rows are listed after the other
    // pair's rows, so the badge never flickers with export order.
    const network: ParsedNetwork = {
      junctions: [
        junction(1, 0, 139.767, 35.681), // F1
        junction(2, 1, 139.768, 35.682), // F2
        junction(3, 0, 139.767, 35.681), // F1
        junction(4, 1, 139.768, 35.682), // F2
      ],
      paths: [
        ...verticalPair({ pathId: 12, reversePathId: 13, fromId: 3, toId: 4, fromFloor: "F1", toFloor: "F2" }),
        ...verticalPair({ pathId: 10, reversePathId: 11, fromId: 1, toId: 2, fromFloor: "F1", toFloor: "F2" }),
      ],
    };
    const directions = conveyanceDirections(
      network,
      LEVELS,
      "F1",
      [conveyance("escalator-1", boxPolygon(139.767, 35.681))],
    );
    expect([...directions.entries()]).toEqual([["escalator-1", { arrow: "up", targetFloor: "F2" }]]);
  });

  it("yields an empty map when the active level has no ordinal", () => {
    const network: ParsedNetwork = {
      junctions: [junction(1, 0, 139.767, 35.681)],
      paths: [],
    };
    const directions = conveyanceDirections(network, LEVELS, "missing-level", [
      conveyance("escalator-1", boxPolygon(139.767, 35.681)),
    ]);
    expect(directions.size).toBe(0);
  });
});
