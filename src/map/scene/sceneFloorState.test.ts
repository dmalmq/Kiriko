import { describe, expect, it } from "vitest";
import type { RouteResultDto } from "../../bundle/wasm";
import type { ViewerLevel } from "../../imdf/types";
import type { SceneLevelView, SceneView } from "./sceneFormat";
import { resolveSceneFloorState } from "./sceneFloorState";

const LEVELS: ViewerLevel[] = [
  { id: "f2", ordinal: 1, label: { en: "2F" }, shortName: { en: "2F" } },
  { id: "f1-east", ordinal: 0, label: { en: "1F" }, shortName: { en: "1F" } },
  { id: "f1-west", ordinal: 0, label: { en: "1F" }, shortName: { en: "1F" } },
  { id: "b1", ordinal: -1, label: { en: "B1" }, shortName: { en: "B1" } },
];

function sceneLevel(canonicalId: string, resolvedPlaneZ: number): SceneLevelView {
  return {
    canonicalId,
    sourceLevelKey: "",
    sourceLevelName: "",
    sourceElevationMeters: null,
    resolvedPlaneZ,
    quantizedElevationDm: Math.round(resolvedPlaneZ * 10),
  };
}

function scene(levels: SceneLevelView[]): SceneView {
  return {
    header: {
      formatVersion: 1,
      deriverVersion: 1,
      sourceHash: "scene-floor-state",
      frameOriginEcef: [0, 0, 0],
      worldTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      boundsMin: [0, 0, 0],
      boundsMax: [1, 1, 1],
    },
    levels,
    features: [],
    batches: [],
  };
}

function route(ordinals: number[]): RouteResultDto {
  return {
    segments: ordinals.map((ordinal, index) => ({
      ordinal,
      coordinates: [
        [139 + index * 0.001, 35],
        [139 + (index + 1) * 0.001, 35],
      ],
    })),
    totalWeight: 100,
    originProjected: [139, 35, ordinals[0] ?? 0],
    destProjected: [140, 36, ordinals.at(-1) ?? 0],
  };
}

const MULTI_FLOOR_SCENE = scene([
  sceneLevel("b1", 8),
  sceneLevel("f1-east", 12),
  sceneLevel("f1-west", 12),
  sceneLevel("f2", 16),
]);

describe("resolveSceneFloorState", () => {
  it("returns the active scene levels and their shared plane", () => {
    expect(resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "b1", null, null)).toEqual({
      activeLevelIndices: [0],
      contextLevelIndices: [],
      activePlaneM: 8,
    });
  });

  it("chooses the next route floor and all of its composite levels as context", () => {
    expect(
      resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "b1", route([-1, 0]), null),
    ).toEqual({
      activeLevelIndices: [0],
      contextLevelIndices: [1, 2],
      activePlaneM: 8,
    });
  });

  it("chooses the previous route floor when the active floor is final", () => {
    expect(
      resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "f2", route([-1, 0, 1]), null)
        .contextLevelIndices,
    ).toEqual([1, 2]);
  });
  it("uses the preceding floor when a route returns to its starting floor", () => {
    expect(
      resolveSceneFloorState(
        MULTI_FLOOR_SCENE,
        LEVELS,
        "b1",
        route([-1, 0, 1, -1]),
        null,
      ).contextLevelIndices,
    ).toEqual([3]);
  });

  it("collapses consecutive same-floor segments before choosing context", () => {
    expect(
      resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "b1", route([-1, -1, 0]), null)
        .contextLevelIndices,
    ).toEqual([1, 2]);
    expect(
      resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "f1-east", route([-1, 0, 0, 1]), null)
        .contextLevelIndices,
    ).toEqual([3]);
  });

  it("does not invent context when the active floor is absent from the route", () => {
    expect(
      resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "f2", route([-1, 0]), null)
        .contextLevelIndices,
    ).toEqual([]);
  });

  it("accepts composite active planes that quantize to the same millimetre", () => {
    const composite = scene([
      sceneLevel("b1", 8.0001),
      sceneLevel("b1", 8.0004),
      sceneLevel("f1-east", 12),
    ]);
    expect(resolveSceneFloorState(composite, LEVELS, "b1", null, null)).toEqual({
      activeLevelIndices: [0, 1],
      contextLevelIndices: [],
      activePlaneM: 8,
    });
  });

  it("keeps active indices but rejects absent, non-finite, or disagreeing planes", () => {
    expect(resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "missing", null, null)).toEqual({
      activeLevelIndices: [],
      contextLevelIndices: [],
      activePlaneM: null,
    });
    expect(
      resolveSceneFloorState(scene([sceneLevel("b1", Number.NaN)]), LEVELS, "b1", null, null),
    ).toMatchObject({ activeLevelIndices: [0], activePlaneM: null });
    expect(
      resolveSceneFloorState(
        scene([sceneLevel("b1", 8), sceneLevel("b1", 8.002)]),
        LEVELS,
        "b1",
        null,
        null,
      ),
    ).toMatchObject({ activeLevelIndices: [0, 1], activePlaneM: null });
  });

  it("omits an unmapped context floor without losing the active floor", () => {
    const activeOnly = scene([sceneLevel("b1", 8)]);
    expect(resolveSceneFloorState(activeOnly, LEVELS, "b1", route([-1, 0]), null)).toEqual({
      activeLevelIndices: [0],
      contextLevelIndices: [],
      activePlaneM: 8,
    });
  });

  it("adds a partner floor above the active floor as context", () => {
    expect(
      resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "b1", null, 1)
        .contextLevelIndices,
    ).toEqual([3]);
  });

  it("adds a partner floor below the active floor as context", () => {
    expect(
      resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "f2", null, -1)
        .contextLevelIndices,
    ).toEqual([0]);
  });

  it("unions a partner floor with a route context floor without duplicates", () => {
    // Route context is ordinal 0 (f1-east/f1-west); the partner names the same
    // floor, so the union must not repeat indices 1 and 2.
    expect(
      resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "b1", route([-1, 0]), 0)
        .contextLevelIndices,
    ).toEqual([1, 2]);
  });

  it("ignores a partner on the active floor itself", () => {
    expect(
      resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "f1-east", null, 0)
        .contextLevelIndices,
    ).toEqual([]);
  });

  it("ignores a partner ordinal with no scene level registered", () => {
    expect(
      resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "b1", null, 2)
        .contextLevelIndices,
    ).toEqual([]);
  });

  it("leaves today's behaviour untouched when the partner is null", () => {
    const withRoute = resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "b1", route([-1, 0]), null);
    const withPartnerOnly = resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "b1", null, 1);
    expect(withRoute.contextLevelIndices).toEqual([1, 2]);
    expect(withPartnerOnly.contextLevelIndices).toEqual([3]);
    // A null partner on top of an empty route stays empty, exactly as before.
    expect(resolveSceneFloorState(MULTI_FLOOR_SCENE, LEVELS, "f2", null, null).contextLevelIndices).toEqual([]);
  });
});
