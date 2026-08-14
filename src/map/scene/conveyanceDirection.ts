/**
 * Graph-evidenced static direction chevrons for 3D conveyance labels (#32 §9).
 *
 * The scene's conveyance badges show which floor a conveyance reaches — but
 * only when the routing graph actually says so. A chevron exists exactly when
 * a vertical network path (`HFLAG === 1`) has its active-floor endpoint
 * junction inside the conveyance's own footprint; a null network, a
 * non-polygonal footprint, or a link outside every footprint each simply
 * produce no entry. Absence renders as absence — nothing here is guessed.
 *
 * The endpoint resolution mirrors `networkFeatures.ts`' `verticalLinkOf`
 * (same exporter property names, including the exporter's `TFOOLR` spelling,
 * and the same reciprocal-pair collapse), so the direction a 3D badge shows
 * is the same evidence the 2D overlay already renders.
 *
 * Determinism is a requirement, not a nicety: when one conveyance carries
 * links to several floors, the entry is the link whose target floor is
 * nearest the active ordinal, with exact distance ties broken by lowest
 * target ordinal first (then lowest path id), so the badge never flickers
 * between frames.
 */
import type { ViewerFeature, ViewerLevel } from "../../imdf/types";
import { floorLabelToOrdinal, type NetworkFeature, type ParsedNetwork } from "../networkFeatures";

/** Direction evidence for one conveyance badge; absent when the graph says nothing. */
export interface ConveyanceDirection {
  arrow: "up" | "down";
  targetFloor: string;
}

/** A vertical link resolved onto the active floor, straight from the graph. */
interface ResolvedVerticalLink {
  /** Normalized lower id of the reciprocal pair, for deterministic ties. */
  pathId: number;
  reversePathId: number;
  /** The active-floor endpoint junction's exact coordinate. */
  coordinate: GeoJSON.Position;
  /** The exporter's floor label for the far end (e.g. `"F3"`, `"B1"`). */
  targetFloor: string;
  targetOrdinal: number;
  direction: "up" | "down";
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Floor ordinal of an exporter floor-label property, or null when absent. */
function floorOrdinalOf(value: unknown): number | null {
  return typeof value === "string" ? floorLabelToOrdinal(value) : null;
}

/** Point coordinate of a junction feature, or null when not a Point. */
function pointCoordinateOf(feature: NetworkFeature | undefined): GeoJSON.Position | null {
  if (feature === undefined || feature.geometry.type !== "Point") {
    return null;
  }
  return feature.geometry.coordinates;
}

/**
 * Resolve one directed vertical row onto the active floor: the active-floor
 * endpoint becomes the coordinate and the other endpoint the target. Returns
 * null for malformed metadata or when neither endpoint floor is active, so a
 * broken semantic edge disappears instead of becoming a chevron.
 */
function linkOnActiveFloor(
  path: NetworkFeature,
  junctionById: Map<number, NetworkFeature>,
  activeOrdinal: number,
): ResolvedVerticalLink | null {
  if (path.properties.HFLAG !== 1) {
    return null;
  }
  const pathId = asFiniteNumber(path.properties.PATHID);
  const reversePathId = asFiniteNumber(path.properties.RPATHID);
  const fromId = asFiniteNumber(path.properties.FNODEID);
  const toId = asFiniteNumber(path.properties.TNODEID);
  const fromOrdinal = floorOrdinalOf(path.properties.FFLOOR);
  const toOrdinal = floorOrdinalOf(path.properties.TFOOLR);
  if (
    pathId === null ||
    reversePathId === null ||
    fromId === null ||
    toId === null ||
    fromOrdinal === null ||
    toOrdinal === null
  ) {
    return null;
  }
  const fromCoordinate = pointCoordinateOf(junctionById.get(fromId));
  const toCoordinate = pointCoordinateOf(junctionById.get(toId));
  if (fromCoordinate === null || toCoordinate === null) {
    return null;
  }
  if (fromOrdinal === activeOrdinal) {
    return {
      // Normalized so the tie-break does not depend on which directed row of
      // the reciprocal pair the exporter happened to list first.
      pathId: Math.min(pathId, reversePathId),
      reversePathId: Math.max(pathId, reversePathId),
      coordinate: fromCoordinate,
      targetFloor: String(path.properties.TFOOLR),
      targetOrdinal: toOrdinal,
      direction: toOrdinal > activeOrdinal ? "up" : "down",
    };
  }
  if (toOrdinal === activeOrdinal) {
    return {
      pathId: Math.min(pathId, reversePathId),
      reversePathId: Math.max(pathId, reversePathId),
      coordinate: toCoordinate,
      targetFloor: String(path.properties.FFLOOR),
      targetOrdinal: fromOrdinal,
      direction: fromOrdinal > activeOrdinal ? "up" : "down",
    };
  }
  return null;
}

/** Group key collapsing a reciprocal pair into one logical connection. */
function pairKeyOf(pathId: number, reversePathId: number): string {
  return pathId < reversePathId ? `${pathId}:${reversePathId}` : `${reversePathId}:${pathId}`;
}

/** Every distinct vertical link whose active-floor endpoint is on this floor. */
function verticalLinksOnFloor(
  network: ParsedNetwork,
  activeOrdinal: number,
): ResolvedVerticalLink[] {
  const junctionById = new Map<number, NetworkFeature>();
  for (const junction of network.junctions) {
    const nodeId = asFiniteNumber(junction.properties.NODEID);
    if (nodeId !== null) {
      junctionById.set(nodeId, junction);
    }
  }
  const links: ResolvedVerticalLink[] = [];
  const emitted = new Set<string>();
  for (const path of network.paths) {
    if (path.properties.HFLAG !== 1) {
      continue;
    }
    const link = linkOnActiveFloor(path, junctionById, activeOrdinal);
    if (link === null) {
      continue;
    }
    const key = pairKeyOf(link.pathId, link.reversePathId);
    if (emitted.has(key)) {
      continue;
    }
    emitted.add(key);
    links.push(link);
  }
  return links;
}

/** Ray-cast containment of a point in a GeoJSON linear ring (lon/lat). */
function pointInRing(point: GeoJSON.Position, ring: GeoJSON.Position[]): boolean {
  if (ring.length < 3) {
    return false;
  }
  const x = point[0]!;
  const y = point[1]!;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    if (yi > y !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Containment in a Polygon: inside the outer ring and in no hole. */
function pointInPolygon(point: GeoJSON.Position, polygon: GeoJSON.Position[][]): boolean {
  const [outer, ...holes] = polygon;
  if (outer === undefined || !pointInRing(point, outer)) {
    return false;
  }
  return !holes.some((hole) => pointInRing(point, hole));
}

/** Containment in a Polygon or MultiPolygon; anything else contains nothing. */
function pointInGeometry(point: GeoJSON.Position, geometry: GeoJSON.Geometry | null): boolean {
  if (geometry === null) {
    return false;
  }
  switch (geometry.type) {
    case "Polygon":
      return pointInPolygon(point, geometry.coordinates);
    case "MultiPolygon":
      return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
    default:
      return false;
  }
}

/**
 * Pick the one chevron a conveyance badge may show. The best link is the one
 * whose target floor is nearest the active ordinal; exact distance ties break
 * by lowest target ordinal first, then lowest path id — always deterministic.
 */
function bestLinkForFeature(
  feature: ViewerFeature,
  links: readonly ResolvedVerticalLink[],
  activeOrdinal: number,
): ConveyanceDirection | null {
  let best: ResolvedVerticalLink | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const link of links) {
    if (!pointInGeometry(link.coordinate, feature.geometry)) {
      continue;
    }
    const distance = Math.abs(link.targetOrdinal - activeOrdinal);
    if (
      best === null ||
      distance < bestDistance ||
      (distance === bestDistance &&
        (link.targetOrdinal < best.targetOrdinal ||
          (link.targetOrdinal === best.targetOrdinal && link.pathId < best.pathId)))
    ) {
      best = link;
      bestDistance = distance;
    }
  }
  if (best === null) {
    return null;
  }
  return { arrow: best.direction, targetFloor: best.targetFloor };
}

/**
 * The direction evidence for the active floor's conveyance badges, keyed by
 * feature id. Every entry traces back to a real vertical network path whose
 * active-floor endpoint junction lies inside that feature's footprint; a null
 * network, an unknown level, a non-polygonal or absent footprint, and a link
 * outside every footprint all contribute nothing.
 */
export function conveyanceDirections(
  network: ParsedNetwork | null,
  levels: readonly ViewerLevel[],
  activeLevelId: string,
  conveyances: readonly ViewerFeature[],
): Map<string, ConveyanceDirection> {
  const directions = new Map<string, ConveyanceDirection>();
  if (network === null) {
    return directions;
  }
  const activeOrdinal = levels.find((level) => level.id === activeLevelId)?.ordinal;
  if (activeOrdinal === undefined) {
    return directions;
  }
  const links = verticalLinksOnFloor(network, activeOrdinal);
  for (const feature of conveyances) {
    const direction = bestLinkForFeature(feature, links, activeOrdinal);
    if (direction !== null) {
      directions.set(feature.id, direction);
    }
  }
  return directions;
}
