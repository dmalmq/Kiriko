import type { FeatureCollection } from "geojson";
import type { LoadedVenue } from "../../imdf/types";
import { buildRenderFeatures } from "../buildRenderFeatures";
import type { ParsedNetwork } from "../networkFeatures";
import { levelIdsForOrdinal } from "../../state/floorGroups";
import type { ConnectorInput } from "./sceneConnectors";
import type { SceneView } from "./sceneFormat";

export const INDOOR_CONTEXT_SOURCE_ID = "indoor-context-features";
export const LAYER_INDOOR_CONTEXT_EXTRUSION = "indoor-context-extrusion";

function sceneLevelIndexForOrdinal(
  scene: SceneView,
  venue: LoadedVenue,
  ordinal: number,
): number | null {
  const canonicalIds = new Set(levelIdsForOrdinal(venue.levels, ordinal));
  const index = scene.levels.findIndex((level) => canonicalIds.has(level.canonicalId));
  return index < 0 ? null : index;
}

function lineSegments(geometry: GeoJSON.Geometry): Array<[[number, number], [number, number]]> {
  if (geometry.type === "LineString") {
    const out: Array<[[number, number], [number, number]]> = [];
    for (let i = 1; i < geometry.coordinates.length; i += 1) {
      const a = geometry.coordinates[i - 1];
      const b = geometry.coordinates[i];
      const a0 = a?.[0];
      const a1 = a?.[1];
      const b0 = b?.[0];
      const b1 = b?.[1];
      if (a0 === undefined || a1 === undefined || b0 === undefined || b1 === undefined) {
        continue;
      }
      out.push([
        [a0, a1],
        [b0, b1],
      ]);
    }
    return out;
  }
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.flatMap((line) =>
      lineSegments({ type: "LineString", coordinates: line }),
    );
  }
  return [];
}

/**
 * Same-floor network paths on context ordinals, as scene-layer ribbons so they
 * sit on the partner plane instead of draping onto the active terrain.
 */
export function contextGraphConnectors(
  network: ParsedNetwork | null,
  scene: SceneView,
  venue: LoadedVenue,
  contextOrdinals: readonly number[],
): ConnectorInput[] {
  const connectors: ConnectorInput[] = [];
  if (network === null || contextOrdinals.length === 0) {
    return connectors;
  }
  const ordinals = new Set(contextOrdinals);
  for (const path of network.paths) {
    if (path.ordinal === null || !ordinals.has(path.ordinal)) {
      continue;
    }
    if (path.properties.HFLAG === 1) {
      continue;
    }
    const levelIndex = sceneLevelIndexForOrdinal(scene, venue, path.ordinal);
    if (levelIndex === null) {
      continue;
    }
    const pathId = typeof path.properties.PATHID === "number" ? path.properties.PATHID : -1;
    const reversePathId =
      typeof path.properties.RPATHID === "number" ? path.properties.RPATHID : pathId - 1;
    const connectionId = { pathId, reversePathId };
    for (const [from, to] of lineSegments(path.geometry)) {
      connectors.push({
        connectionId,
        lower: { lng: from[0], lat: from[1], levelIndex },
        upper: { lng: to[0], lat: to[1], levelIndex },
      });
    }
  }
  return connectors;
}

/** Indoor plan features for every context ordinal (one representative level each). */
export function contextIndoorFeatures(
  venue: LoadedVenue,
  contextOrdinals: readonly number[],
): FeatureCollection {
  const features: FeatureCollection["features"] = [];
  const seen = new Set<string>();
  for (const ordinal of contextOrdinals) {
    const levelId = levelIdsForOrdinal(venue.levels, ordinal)[0];
    if (levelId === undefined) {
      continue;
    }
    for (const feature of buildRenderFeatures(venue, levelId).features) {
      const id = String(feature.id ?? feature.properties?.["__feature_id"] ?? "");
      if (id !== "" && seen.has(id)) {
        continue;
      }
      if (id !== "") {
        seen.add(id);
      }
      features.push(feature);
    }
  }
  return { type: "FeatureCollection", features };
}
