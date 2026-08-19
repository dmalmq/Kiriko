import { describe, expect, it } from "vitest";
import type { LoadedVenue } from "../../imdf/types";
import type { ParsedNetwork } from "../networkFeatures";
import type { SceneView } from "./sceneFormat";
import { contextGraphConnectors, contextIndoorFeatures } from "./contextOverlay";

const VENUE = {
  levels: [
    { id: "level-1", ordinal: 0, shortName: { en: "F1" }, name: { en: "F1" } },
    { id: "level-2", ordinal: 1, shortName: { en: "F2" }, name: { en: "F2" } },
  ],
  renderFeaturesByLevel: new Map([
    [
      "level-2",
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "u-context",
            properties: { __feature_id: "u-context" },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [139.7, 35.6],
                  [139.71, 35.6],
                  [139.71, 35.61],
                  [139.7, 35.61],
                  [139.7, 35.6],
                ],
              ],
            },
          },
        ],
      },
    ],
  ]),
  featuresById: new Map(),
  venue: {
    id: "v",
    featureType: "venue",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [139.7, 35.6],
          [139.71, 35.6],
          [139.71, 35.61],
          [139.7, 35.61],
          [139.7, 35.6],
        ],
      ],
    },
    levelId: null,
    category: "transit",
    restriction: null,
    sourceProperties: {},
  },
} as unknown as LoadedVenue;

const SCENE = {
  levels: [
    { canonicalId: "level-1", resolvedPlaneZ: 0 },
    { canonicalId: "level-2", resolvedPlaneZ: 4 },
  ],
} as unknown as SceneView;

function path(ordinal: number, coords: number[][], hflag?: number): ParsedNetwork["paths"][number] {
  return {
    ordinal,
    geometry: { type: "LineString", coordinates: coords },
    properties: { PATHID: 10, RPATHID: 11, HFLAG: hflag ?? 0 },
  };
}

describe("contextGraphConnectors", () => {
  it("emits one ribbon per same-floor context path segment", () => {
    const network: ParsedNetwork = {
      junctions: [],
      paths: [
        path(1, [
          [139.7, 35.6],
          [139.71, 35.6],
          [139.71, 35.61],
        ]),
        path(0, [
          [139.7, 35.6],
          [139.72, 35.6],
        ]),
      ],
    };
    const connectors = contextGraphConnectors(network, SCENE, VENUE, [1]);
    expect(connectors).toHaveLength(2);
    expect(connectors[0]?.lower.levelIndex).toBe(1);
    expect(connectors[0]?.upper.levelIndex).toBe(1);
    expect(connectors.every((c) => c.lower.levelIndex === c.upper.levelIndex)).toBe(true);
  });

  it("skips vertical paths and empty context", () => {
    const network: ParsedNetwork = {
      junctions: [],
      paths: [path(1, [[139.7, 35.6], [139.71, 35.6]], 1)],
    };
    expect(contextGraphConnectors(network, SCENE, VENUE, [1])).toEqual([]);
    expect(contextGraphConnectors(network, SCENE, VENUE, [])).toEqual([]);
    expect(contextGraphConnectors(null, SCENE, VENUE, [1])).toEqual([]);
  });
});

describe("contextIndoorFeatures", () => {
  it("includes the partner floor's plan features", () => {
    const collection = contextIndoorFeatures(VENUE, [1]);
    expect(collection.features.some((f) => f.id === "u-context")).toBe(true);
  });

  it("is empty when no context ordinals are shown", () => {
    expect(contextIndoorFeatures(VENUE, []).features).toEqual([]);
  });
});
