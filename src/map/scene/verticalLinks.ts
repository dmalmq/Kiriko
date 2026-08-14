/**
 * The venue's cross-floor graph links, as the viewer needs them: both
 * endpoints, their floors, and the connection identity the network editor
 * already selects by.
 *
 * One module owns this because three surfaces ask the same question and must
 * never disagree about the answer — the 3D conveyance badge's direction
 * chevron (#32 §9), the 3D inter-floor connector drawn between two floor
 * planes (#32 §6, §11), and the review list a producer sweeps for QA. The
 * endpoint resolution mirrors `networkFeatures.ts`' `verticalLinkOf`: the same
 * exporter property names, including the exporter's `TFOOLR` spelling, and the
 * same reciprocal-pair collapse, so every surface shows the same evidence the
 * 2D overlay already renders.
 *
 * Nothing here is inferred. A vertical row with malformed metadata, a missing
 * junction, or two endpoints on one floor produces no link; a conveyance whose
 * footprint contains no endpoint gets no connection; a null network yields
 * nothing at all. Absence renders as absence.
 */
import type { ViewerFeature, ViewerLevel } from "../../imdf/types";
import {
  floorLabelToOrdinal,
  type NetworkConnectionId,
  type NetworkFeature,
  type ParsedNetwork,
} from "../networkFeatures";

/** One end of a cross-floor link, on the floor the graph puts it on. */
export interface VerticalLinkEnd {
  nodeId: number;
  ordinal: number;
  /** The exporter's own floor label, e.g. `"F3"` or `"B1"`. */
  floor: string;
  coordinate: readonly [number, number];
}

/**
 * One cross-floor connection: the reciprocal path pair collapsed into the
 * identity the editor selects, plus its two ends ordered by elevation.
 */
export interface VerticalLink {
  connectionId: NetworkConnectionId;
  /**
   * The transport the graph states (`TRANSITION_CATEGORY`), or `null` when the
   * export names none. A missing category is never filled in from a nearby
   * unit's category — that would be the renderer inventing machinery.
   */
  kind: string | null;
  lower: VerticalLinkEnd;
  upper: VerticalLinkEnd;
}

/** Direction evidence for one conveyance badge; absent when the graph says nothing. */
export interface ConveyanceDirection {
  arrow: "up" | "down";
  targetFloor: string;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Floor ordinal of an exporter floor-label property, or null when absent. */
function floorOrdinalOf(value: unknown): number | null {
  return typeof value === "string" ? floorLabelToOrdinal(value) : null;
}

/** Point coordinate of a junction feature, or null when not a Point. */
function pointCoordinateOf(
  feature: NetworkFeature | undefined,
): readonly [number, number] | null {
  if (feature === undefined || feature.geometry.type !== "Point") {
    return null;
  }
  const [longitude, latitude] = feature.geometry.coordinates;
  return longitude === undefined || latitude === undefined ? null : [longitude, latitude];
}

/** Group key collapsing a reciprocal pair into one logical connection. */
function pairKeyOf(pathId: number, reversePathId: number): string {
  return pathId < reversePathId ? `${pathId}:${reversePathId}` : `${reversePathId}:${pathId}`;
}

/**
 * Resolve one directed vertical row into an elevation-ordered link. Returns
 * null for malformed metadata, an endpoint whose junction is missing, or two
 * endpoints the export puts on the same floor — a broken semantic edge
 * disappears rather than becoming a line between two identical planes.
 */
function linkOf(
  path: NetworkFeature,
  junctionById: Map<number, NetworkFeature>,
): VerticalLink | null {
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
    toOrdinal === null ||
    fromOrdinal === toOrdinal
  ) {
    return null;
  }
  const fromCoordinate = pointCoordinateOf(junctionById.get(fromId));
  const toCoordinate = pointCoordinateOf(junctionById.get(toId));
  if (fromCoordinate === null || toCoordinate === null) {
    return null;
  }
  const from: VerticalLinkEnd = {
    nodeId: fromId,
    ordinal: fromOrdinal,
    floor: String(path.properties.FFLOOR),
    coordinate: fromCoordinate,
  };
  const to: VerticalLinkEnd = {
    nodeId: toId,
    ordinal: toOrdinal,
    floor: String(path.properties.TFOOLR),
    coordinate: toCoordinate,
  };
  const category = path.properties.TRANSITION_CATEGORY;
  return {
    // Normalized so nothing downstream depends on which directed row of the
    // reciprocal pair the exporter happened to list first.
    connectionId: {
      pathId: Math.min(pathId, reversePathId),
      reversePathId: Math.max(pathId, reversePathId),
    },
    kind: typeof category === "string" && category !== "" ? category : null,
    lower: fromOrdinal < toOrdinal ? from : to,
    upper: fromOrdinal < toOrdinal ? to : from,
  };
}

/**
 * Every distinct cross-floor link in the network, ordered by connection id so
 * a draw pass, a pick, and a list all walk them the same way on every frame.
 */
export function verticalLinks(network: ParsedNetwork | null): VerticalLink[] {
  if (network === null) {
    return [];
  }
  const junctionById = new Map<number, NetworkFeature>();
  for (const junction of network.junctions) {
    const nodeId = asFiniteNumber(junction.properties.NODEID);
    if (nodeId !== null) {
      junctionById.set(nodeId, junction);
    }
  }
  const links: VerticalLink[] = [];
  const emitted = new Set<string>();
  for (const path of network.paths) {
    // The exporter sets HFLAG exactly when the endpoint ordinals differ.
    if (path.properties.HFLAG !== 1) {
      continue;
    }
    const link = linkOf(path, junctionById);
    if (link === null) {
      continue;
    }
    const key = pairKeyOf(link.connectionId.pathId, link.connectionId.reversePathId);
    if (emitted.has(key)) {
      continue;
    }
    emitted.add(key);
    links.push(link);
  }
  return links.sort((left, right) => left.connectionId.pathId - right.connectionId.pathId);
}

/**
 * The link's ends relative to one floor: `near` is the end on that floor and
 * `far` the end it reaches. `null` when the link does not touch the floor.
 */
export function linkEndsOnFloor(
  link: VerticalLink,
  ordinal: number,
): { near: VerticalLinkEnd; far: VerticalLinkEnd } | null {
  if (link.lower.ordinal === ordinal) {
    return { near: link.lower, far: link.upper };
  }
  if (link.upper.ordinal === ordinal) {
    return { near: link.upper, far: link.lower };
  }
  return null;
}

/** Ray-cast containment of a point in a GeoJSON linear ring (lon/lat). */
function pointInRing(point: readonly [number, number], ring: GeoJSON.Position[]): boolean {
  if (ring.length < 3) {
    return false;
  }
  const x = point[0];
  const y = point[1];
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
function pointInPolygon(
  point: readonly [number, number],
  polygon: GeoJSON.Position[][],
): boolean {
  const [outer, ...holes] = polygon;
  if (outer === undefined || !pointInRing(point, outer)) {
    return false;
  }
  return !holes.some((hole) => pointInRing(point, hole));
}

/** Containment in a Polygon or MultiPolygon; anything else contains nothing. */
function pointInGeometry(
  point: readonly [number, number],
  geometry: GeoJSON.Geometry | null,
): boolean {
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
 * The one link a conveyance may speak for: the link whose end on this floor
 * lies inside the conveyance's own footprint and whose far floor is nearest.
 *
 * Determinism is a requirement, not a nicety. A conveyance serving several
 * floors resolves to the nearest one, exact ties break by lowest far ordinal
 * and then lowest path id, so neither a badge nor a highlighted edge flickers
 * between frames.
 */
function linkForFeature(
  feature: ViewerFeature,
  links: readonly VerticalLink[],
  ordinal: number,
): VerticalLink | null {
  let best: VerticalLink | null = null;
  let bestFar: VerticalLinkEnd | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const link of links) {
    const ends = linkEndsOnFloor(link, ordinal);
    if (ends === null || !pointInGeometry(ends.near.coordinate, feature.geometry)) {
      continue;
    }
    const distance = Math.abs(ends.far.ordinal - ordinal);
    if (
      best === null ||
      bestFar === null ||
      distance < bestDistance ||
      (distance === bestDistance &&
        (ends.far.ordinal < bestFar.ordinal ||
          (ends.far.ordinal === bestFar.ordinal &&
            link.connectionId.pathId < best.connectionId.pathId)))
    ) {
      best = link;
      bestFar = ends.far;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The cross-floor link behind each of the active floor's conveyances, keyed by
 * feature id. This is the mapping that lets a reviewer click the escalator
 * they can see instead of hunting the offset marker beside it.
 */
export function conveyanceLinks(
  network: ParsedNetwork | null,
  levels: readonly ViewerLevel[],
  activeLevelId: string,
  conveyances: readonly ViewerFeature[],
): Map<string, VerticalLink> {
  const resolved = new Map<string, VerticalLink>();
  const activeOrdinal = levels.find((level) => level.id === activeLevelId)?.ordinal;
  if (activeOrdinal === undefined) {
    return resolved;
  }
  const links = verticalLinks(network);
  if (links.length === 0) {
    return resolved;
  }
  for (const feature of conveyances) {
    const link = linkForFeature(feature, links, activeOrdinal);
    if (link !== null) {
      resolved.set(feature.id, link);
    }
  }
  return resolved;
}

/**
 * The direction evidence for the active floor's conveyance badges, keyed by
 * feature id. Every entry traces back to a real vertical network path whose
 * active-floor endpoint junction lies inside that feature's footprint.
 */
export function conveyanceDirections(
  network: ParsedNetwork | null,
  levels: readonly ViewerLevel[],
  activeLevelId: string,
  conveyances: readonly ViewerFeature[],
): Map<string, ConveyanceDirection> {
  const directions = new Map<string, ConveyanceDirection>();
  const activeOrdinal = levels.find((level) => level.id === activeLevelId)?.ordinal;
  if (activeOrdinal === undefined) {
    return directions;
  }
  for (const [featureId, link] of conveyanceLinks(
    network,
    levels,
    activeLevelId,
    conveyances,
  )) {
    const ends = linkEndsOnFloor(link, activeOrdinal);
    if (ends === null) {
      continue;
    }
    directions.set(featureId, {
      arrow: ends.far.ordinal > activeOrdinal ? "up" : "down",
      targetFloor: ends.far.floor,
    });
  }
  return directions;
}
