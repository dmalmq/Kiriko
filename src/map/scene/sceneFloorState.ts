import type { RouteResultDto } from "../../bundle/wasm";
import type { ViewerLevel } from "../../imdf/types";
import { levelIdsForOrdinal, ordinalOfLevel } from "../../state/floorGroups";
import type { SceneView } from "./sceneFormat";

export interface SceneFloorState {
  activeLevelIndices: number[];
  contextLevelIndices: number[];
  activePlaneM: number | null;
}

function sharedPlane(
  scene: SceneView,
  activeLevelIndices: readonly number[],
): number | null {
  let sharedMillimetres: number | null = null;
  for (const index of activeLevelIndices) {
    const plane = scene.levels[index]?.resolvedPlaneZ;
    if (plane === undefined || !Number.isFinite(plane)) {
      return null;
    }
    const millimetres = Math.round(plane * 1000);
    if (sharedMillimetres !== null && millimetres !== sharedMillimetres) {
      return null;
    }
    sharedMillimetres = millimetres;
  }
  return sharedMillimetres === null ? null : sharedMillimetres / 1000;
}

function routeOrdinalSequence(route: RouteResultDto | null): number[] {
  const ordinals: number[] = [];
  for (const segment of route?.segments ?? []) {
    if (!Number.isFinite(segment.ordinal) || ordinals.at(-1) === segment.ordinal) {
      continue;
    }
    ordinals.push(segment.ordinal);
  }
  return ordinals;
}

function contextOrdinal(
  venueLevels: ViewerLevel[],
  activeLevelId: string,
  route: RouteResultDto | null,
): number | null {
  const activeOrdinal = ordinalOfLevel(venueLevels, activeLevelId);
  if (activeOrdinal === null) {
    return null;
  }
  const ordinals = routeOrdinalSequence(route);
  const activeIndex =
    ordinals.at(-1) === activeOrdinal
      ? ordinals.length - 1
      : ordinals.indexOf(activeOrdinal);
  if (activeIndex < 0) {
    return null;
  }
  if (activeIndex + 1 < ordinals.length) {
    return ordinals[activeIndex + 1] ?? null;
  }
  return activeIndex > 0 ? ordinals[activeIndex - 1] ?? null : null;
}

export function resolveSceneFloorState(
  scene: SceneView,
  venueLevels: ViewerLevel[],
  activeLevelId: string,
  route: RouteResultDto | null,
): SceneFloorState {
  const activeLevelIndices: number[] = [];
  scene.levels.forEach((level, index) => {
    if (level.canonicalId === activeLevelId) {
      activeLevelIndices.push(index);
    }
  });

  const routeContextOrdinal = contextOrdinal(venueLevels, activeLevelId, route);
  const contextLevelIndices: number[] = [];
  if (routeContextOrdinal !== null) {
    const contextIds = new Set(levelIdsForOrdinal(venueLevels, routeContextOrdinal));
    scene.levels.forEach((level, index) => {
      if (contextIds.has(level.canonicalId)) {
        contextLevelIndices.push(index);
      }
    });
  }

  return {
    activeLevelIndices,
    contextLevelIndices,
    activePlaneM: sharedPlane(scene, activeLevelIndices),
  };
}
