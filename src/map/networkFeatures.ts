import type { NetworkGeoJsonDto } from "../bundle/wasm";
import { verticalLinkLabelImageName } from "./verticalLinkLabels";

/**
 * Parse an exported network `FLOOR` label back to a level ordinal — the
 * inverse of the Rust `ordinal_to_floor_label` (`F1 → 0`, `F{n} → n-1`,
 * `B{n} → -n`), with `M{n} → n` tolerated for hand-authored data. Returns
 * `null` for anything unrecognized so the feature is simply not shown.
 */
export function floorLabelToOrdinal(label: string): number | null {
  const match = /^([A-Za-z]+)(\d+)$/.exec(label.trim());
  if (match === null) {
    return null;
  }
  const prefix = match[1]!.toUpperCase();
  const n = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(n)) {
    return null;
  }
  if (prefix === "F") {
    return n - 1;
  }
  if (prefix === "M") {
    return n;
  }
  // `B` or a building-prefixed basement (`KB`, `SB`, …) → negative ordinal.
  if (prefix === "B" || prefix.endsWith("B")) {
    return -n;
  }
  return null;
}

export interface NetworkFeature {
  ordinal: number | null;
  geometry: GeoJSON.Geometry;
  properties: Record<string, unknown>;
}

/** Parsed, floor-tagged network ready for per-floor overlay rendering. */
export interface ParsedNetwork {
  junctions: NetworkFeature[];
  paths: NetworkFeature[];
}

/**
 * One cross-floor (`HFLAG === 1`) reciprocal path pair, projected onto the
 * active endpoint floor as a single semantic point. The coordinate is the
 * active endpoint's exact junction position; no vertical LineString exists
 * on any floor.
 */
export interface VerticalNetworkLink {
  kind: "vertical-link";
  pathId: number;
  reversePathId: number;
  endpointNodeId: number;
  targetNodeId: number;
  activeFloor: string;
  targetFloor: string;
  targetDirection: "up" | "down";
  passageType: number;
  coordinate: GeoJSON.Position;
  selected: boolean;
}

/** Structural reason a network mutation was rejected; surfaced as editor copy. */
export type NetworkMutationError =
  | "invalid_coordinate"
  | "node_id_exhausted"
  | "unknown_junction"
  | "unknown_connection"
  | "same_junction"
  | "existing_connection"
  | "cross_floor_connection";

/**
 * Stable identity of one logical (undirected) connection: the reciprocal
 * `PATHID`/`RPATHID` pair of its two directed `net_path` features, always
 * normalized so `pathId < reversePathId`. Parallel connections between the
 * same two junctions stay distinct because their id pairs differ.
 */
export interface NetworkConnectionId {
  pathId: number;
  reversePathId: number;
}

/** Result of a pure network mutation; `network` is the original on rejection. */
export type NetworkMutationResult =
  | {
      ok: true;
      network: ParsedNetwork;
      nodeId?: number;
      connectionId?: NetworkConnectionId;
    }
  | { ok: false; network: ParsedNetwork; error: NetworkMutationError };

/** Per-floor render highlights for the network overlay (selection + pending). */
export interface NetworkRenderState {
  selectedJunctionIds: number[];
  selectedConnections: NetworkConnectionId[];
  pendingJunctionId: number | null;
}

function connectionIsSelected(
  id: NetworkConnectionId | null,
  selected: NetworkConnectionId[] | undefined,
): boolean {
  if (id === null || selected === undefined) return false;
  return selected.some((c) => c.pathId === id.pathId && c.reversePathId === id.reversePathId);
}

function parseCollection(text: string): NetworkFeature[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || !("features" in parsed)) {
    return [];
  }
  const features = parsed.features;
  if (!Array.isArray(features)) {
    return [];
  }
  const out: NetworkFeature[] = [];
  for (const feature of features) {
    if (typeof feature !== "object" || feature === null || !("geometry" in feature)) {
      continue;
    }
    // GeoJSON produced by our own wasm exporter; shape is exporter-guaranteed.
    const geometry = feature.geometry as GeoJSON.Geometry | null | undefined;
    const rawProps = "properties" in feature ? feature.properties : undefined;
    const properties: Record<string, unknown> =
      typeof rawProps === "object" && rawProps !== null ? { ...rawProps } : {};
    const floor = properties.FLOOR;
    if (geometry == null || typeof floor !== "string") {
      continue;
    }
    out.push({ ordinal: floorLabelToOrdinal(floor), geometry, properties });
  }
  return out;
}

/** Parse the wasm `exportNetwork` DTO into floor-tagged features. */
export function parseNetworkOverlay(dto: NetworkGeoJsonDto): ParsedNetwork {
  return {
    junctions: parseCollection(dto.junctions),
    paths: parseCollection(dto.paths),
  };
}
/**
 * Project the parsed network onto one floor: every horizontal `net_path` on
 * `activeOrdinal` becomes a `kind:"path"` LineString, every cross-floor
 * (`HFLAG === 1`) reciprocal pair whose endpoint is on the active floor
 * becomes one `kind:"vertical-link"` Point at that endpoint, and every
 * `net_junction` a `kind:"junction"` Point. Mirrors `buildRouteFeatures`'
 * per-floor overlay contract so the map renders only the active level's
 * network. Malformed vertical metadata is dropped, never faked as a line.
 */
export function buildNetworkFeatures(
  network: ParsedNetwork | null,
  activeOrdinal: number,
  render?: NetworkRenderState,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (network === null) {
    return { type: "FeatureCollection", features };
  }
  const selectedConnections = render?.selectedConnections ?? [];
  const junctionById = new Map<number, NetworkFeature>();
  for (const junction of network.junctions) {
    const nodeId = asFiniteNumber(junction.properties.NODEID);
    if (nodeId !== null) {
      junctionById.set(nodeId, junction);
    }
  }
  const emittedVertical = new Set<string>();
  for (const path of network.paths) {
    if (isVerticalPath(path)) {
      const link = verticalLinkOf(path, junctionById, activeOrdinal, selectedConnections);
      if (link === null) {
        continue;
      }
      const key = `pair:${link.pathId}:${link.reversePathId}`;
      if (emittedVertical.has(key)) {
        continue;
      }
      emittedVertical.add(key);
      features.push({
        type: "Feature",
        properties: {
          kind: link.kind,
          PATHID: link.pathId,
          RPATHID: link.reversePathId,
          endpointNodeId: link.endpointNodeId,
          targetNodeId: link.targetNodeId,
          activeFloor: link.activeFloor,
          targetFloor: link.targetFloor,
          targetDirection: link.targetDirection,
          passageType: link.passageType,
          selected: link.selected,
          // Style-image id for the glyph-independent label (see
          // verticalLinkLabels.ts); consumed by the label layer's icon-image.
          labelImage: verticalLinkLabelImageName(link.targetDirection, link.targetFloor),
        },
        geometry: { type: "Point", coordinates: link.coordinate },
      });
      continue;
    }
    if (path.ordinal === activeOrdinal) {
      const id = connectionIdOf(path);
      const selected = connectionIsSelected(id, selectedConnections);
      features.push({
        type: "Feature",
        properties: {
          kind: "path",
          FNODEID: path.properties.FNODEID,
          TNODEID: path.properties.TNODEID,
          PATHID: id?.pathId ?? path.properties.PATHID,
          RPATHID: id?.reversePathId ?? path.properties.RPATHID,
          selected,
        },
        geometry: path.geometry,
      });
    }
  }
  for (const junction of network.junctions) {
    if (junction.ordinal === activeOrdinal) {
      const id = junction.properties.NODEID;
      const numericId = typeof id === "number" ? id : null;
      features.push({
        type: "Feature",
        properties: {
          kind: "junction",
          NODEID: id,
          selected: numericId !== null && (render?.selectedJunctionIds.includes(numericId) ?? false),
          pending: numericId !== null && render?.pendingJunctionId === numericId,
        },
        geometry: junction.geometry,
      });
    }
  }
  return { type: "FeatureCollection", features };
}

export interface NetworkConnectivity {
  nodes: number;
  edges: number;
  components: number;
  /** Largest component's share of all nodes, 0..1. */
  largestFraction: number;
  /** Distinct floor ordinals spanned by the largest component. */
  floorsInLargest: number;
  /** Nodes with no incident edge. */
  isolated: number;
}

/**
 * Connectivity report over a parsed network: union-find on `net_path`
 * FNODEID/TNODEID, keyed by `net_junction` NODEID. Directed reverse pairs are
 * harmless (they union the same roots). Pure; computed where the graph already
 * lives so no server round-trip is needed.
 */
export function networkConnectivity(net: ParsedNetwork): NetworkConnectivity {
  const index = new Map<number, number>();
  const ordinals: number[] = [];
  for (const j of net.junctions) {
    const id = j.properties.NODEID;
    if (typeof id === "number" && !index.has(id)) {
      index.set(id, ordinals.length);
      ordinals.push(j.ordinal ?? Number.NaN);
    }
  }
  const n = ordinals.length;
  if (n === 0) {
    return { nodes: 0, edges: 0, components: 0, largestFraction: 0, floorsInLargest: 0, isolated: 0 };
  }
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const degree = new Array<number>(n).fill(0);
  let edges = 0;
  for (const p of net.paths) {
    const from = p.properties.FNODEID;
    const to = p.properties.TNODEID;
    const f = typeof from === "number" ? index.get(from) : undefined;
    const t = typeof to === "number" ? index.get(to) : undefined;
    if (f === undefined || t === undefined) continue;
    edges += 1;
    degree[f]! += 1;
    degree[t]! += 1;
    const a = find(f);
    const b = find(t);
    if (a !== b) parent[a] = b;
  }
  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  let largestRoot = -1;
  let largest = 0;
  for (const [root, size] of sizes) {
    if (size > largest) {
      largest = size;
      largestRoot = root;
    }
  }
  const floors = new Set<number>();
  for (let i = 0; i < n; i += 1) {
    if (find(i) === largestRoot && Number.isFinite(ordinals[i]!)) floors.add(ordinals[i]!);
  }
  return {
    nodes: n,
    edges,
    components: sizes.size,
    largestFraction: largest / n,
    floorsInLargest: floors.size,
    isolated: degree.filter((d) => d === 0).length,
  };
}

/**
 * Inverse of {@link floorLabelToOrdinal} matching the Rust `ordinal_to_floor_label`
 * (`0 → "F1"`, `n ≥ 0 → "F{n+1}"`, `n < 0 → "B{-n}"`) so an edited graph
 * re-imports to the same ordinals.
 */
export function ordinalToFloorLabel(ordinal: number): string {
  const n = Math.trunc(ordinal);
  return n < 0 ? `B${-n}` : `F${n + 1}`;
}

const EARTH_RADIUS_M = 6_371_000;
/** Snap a new path vertex onto an existing same-floor junction (spec §5.5). */
const PATH_SNAP_RADIUS_M = 0.8;

/** Great-circle distance in metres between two lon/lat points. */
export function haversineM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** One past the largest PATHID/RPATHID already present (so new ids stay globally unique); ≥ 1. */
function nextPathId(paths: NetworkFeature[]): number {
  let max = 0;
  for (const p of paths) {
    for (const key of ["PATHID", "RPATHID"] as const) {
      const v = p.properties[key];
      if (typeof v === "number" && Number.isFinite(v) && v > max) max = v;
    }
  }
  return max + 1;
}

const FLOOR_HEIGHT_M = 4;
const WALK_SPEED_MPS = 1.4;

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Normalized reciprocal id pair of a directed `net_path`, or null when absent. */
function connectionIdOf(path: NetworkFeature): NetworkConnectionId | null {
  const p = asFiniteNumber(path.properties.PATHID);
  const r = asFiniteNumber(path.properties.RPATHID);
  if (p === null || r === null || p === r) return null;
  return p < r ? { pathId: p, reversePathId: r } : { pathId: r, reversePathId: p };
}

/** Group key that collapses a reciprocal pair into one logical connection. */
function connectionKeyOf(path: NetworkFeature): string | null {
  const f = asFiniteNumber(path.properties.FNODEID);
  const t = asFiniteNumber(path.properties.TNODEID);
  if (f === null || t === null) return null;
  const id = connectionIdOf(path);
  return id !== null
    ? `pair:${id.pathId}:${id.reversePathId}`
    : `endpoints:${Math.min(f, t)}:${Math.max(f, t)}`;
}

/** Point coordinate of a junction feature, or null when not a Point. */
function pointCoordinate(feature: NetworkFeature | undefined): GeoJSON.Position | null {
  if (feature === undefined || feature.geometry.type !== "Point") {
    return null;
  }
  return feature.geometry.coordinates;
}

/** The exporter sets `HFLAG === 1` exactly when endpoint ordinals differ. */
function isVerticalPath(path: NetworkFeature): boolean {
  return path.properties.HFLAG === 1;
}

/** Floor ordinal of an exporter floor-label property, or null when absent. */
function floorOrdinalOfProperty(value: unknown): number | null {
  return typeof value === "string" ? floorLabelToOrdinal(value) : null;
}

/**
 * Resolve one directed vertical row onto the active floor: the active-floor
 * endpoint becomes the marker coordinate and the other endpoint its target.
 * Returns null for malformed metadata or when neither endpoint floor is
 * active, so a broken semantic edge disappears instead of becoming a line.
 */
function verticalLinkOf(
  path: NetworkFeature,
  junctionById: Map<number, NetworkFeature>,
  activeOrdinal: number,
  selectedConnections: NetworkConnectionId[],
): VerticalNetworkLink | null {
  const id = connectionIdOf(path);
  const fromId = asFiniteNumber(path.properties.FNODEID);
  const toId = asFiniteNumber(path.properties.TNODEID);
  const fromOrdinal = floorOrdinalOfProperty(path.properties.FFLOOR);
  const toOrdinal = floorOrdinalOfProperty(path.properties.TFOOLR);
  if (id === null || fromId === null || toId === null || fromOrdinal === null || toOrdinal === null) {
    return null;
  }
  const fromCoordinate = pointCoordinate(junctionById.get(fromId));
  const toCoordinate = pointCoordinate(junctionById.get(toId));
  if (fromCoordinate === null || toCoordinate === null) {
    return null;
  }
  const passageType = asFiniteNumber(path.properties.passage_type) ?? 1;
  const selected = connectionIsSelected(id, selectedConnections);
  let endpointNodeId: number;
  let targetNodeId: number;
  let activeFloor: string;
  let targetFloor: string;
  let targetOrdinal: number;
  let coordinate: GeoJSON.Position;
  if (fromOrdinal === activeOrdinal) {
    endpointNodeId = fromId;
    targetNodeId = toId;
    activeFloor = String(path.properties.FFLOOR);
    targetFloor = String(path.properties.TFOOLR);
    targetOrdinal = toOrdinal;
    coordinate = fromCoordinate;
  } else if (toOrdinal === activeOrdinal) {
    endpointNodeId = toId;
    targetNodeId = fromId;
    activeFloor = String(path.properties.TFOOLR);
    targetFloor = String(path.properties.FFLOOR);
    targetOrdinal = fromOrdinal;
    coordinate = toCoordinate;
  } else {
    return null;
  }
  return {
    kind: "vertical-link",
    pathId: id.pathId,
    reversePathId: id.reversePathId,
    endpointNodeId,
    targetNodeId,
    activeFloor,
    targetFloor,
    targetDirection: targetOrdinal > activeOrdinal ? "up" : "down",
    passageType,
    coordinate,
    selected,
  };
}

/** Distinct logical connections keyed for degree counting, with their endpoints. */
function logicalConnections(paths: NetworkFeature[]): Map<string, { a: number; b: number }> {
  const map = new Map<string, { a: number; b: number }>();
  for (const path of paths) {
    const key = connectionKeyOf(path);
    if (key === null || map.has(key)) continue;
    const a = asFiniteNumber(path.properties.FNODEID);
    const b = asFiniteNumber(path.properties.TNODEID);
    if (a === null || b === null) continue;
    map.set(key, { a, b });
  }
  return map;
}

/** Rewrite each junction's PATH_COUNT to its incident logical-connection degree. */
function withPathCounts(junctions: NetworkFeature[], paths: NetworkFeature[]): NetworkFeature[] {
  const degree = new Map<number, number>();
  for (const { a, b } of logicalConnections(paths).values()) {
    degree.set(a, (degree.get(a) ?? 0) + 1);
    if (b !== a) degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  return junctions.map((j) => {
    const id = asFiniteNumber(j.properties.NODEID);
    if (id === null) return j;
    const next = degree.get(id) ?? 0;
    if (j.properties.PATH_COUNT === next) return j;
    return { ...j, properties: { ...j.properties, PATH_COUNT: next } };
  });
}

/** Replace one endpoint of a path polyline, preserving interior vertices. */
function movePathEndpoint(
  geometry: GeoJSON.Geometry,
  endpoint: "start" | "end",
  coord: [number, number],
): GeoJSON.Geometry {
  if (geometry.type === "LineString") {
    const coords = geometry.coordinates.map((c) => [...c]);
    if (coords.length === 0) return geometry;
    coords[endpoint === "start" ? 0 : coords.length - 1] = [coord[0], coord[1]];
    return { type: "LineString", coordinates: coords };
  }
  if (geometry.type === "MultiLineString") {
    const lines = geometry.coordinates.map((line) => line.map((c) => [...c]));
    if (lines.length === 0) return geometry;
    const line = endpoint === "start" ? lines[0]! : lines[lines.length - 1]!;
    if (line.length === 0) return geometry;
    line[endpoint === "start" ? 0 : line.length - 1] = [coord[0], coord[1]];
    return { type: "MultiLineString", coordinates: lines };
  }
  return geometry;
}

/** Finite [lon, lat] of a junction Point, or null. */
function pointCoordinates(feature: NetworkFeature): [number, number] | null {
  if (feature.geometry.type !== "Point") return null;
  const lon = feature.geometry.coordinates[0];
  const lat = feature.geometry.coordinates[1];
  return typeof lon === "number" &&
    Number.isFinite(lon) &&
    typeof lat === "number" &&
    Number.isFinite(lat)
    ? [lon, lat]
    : null;
}

/**
 * Append a new `net_junction` on `ordinal` with the canonical export defaults
 * (mirroring `core/crates/kiriko-bundle/src/export.rs`). The new NODEID is one
 * past the largest existing non-negative integer id.
 */
export function addJunction(
  net: ParsedNetwork,
  point: { longitude: number; latitude: number; ordinal: number },
): NetworkMutationResult {
  if (!Number.isFinite(point.longitude) || !Number.isFinite(point.latitude)) {
    return { ok: false, network: net, error: "invalid_coordinate" };
  }
  let max = -1;
  for (const j of net.junctions) {
    const id = asFiniteNumber(j.properties.NODEID);
    if (id !== null && Number.isInteger(id) && id > max) max = id;
  }
  const nodeId = max + 1;
  if (!Number.isSafeInteger(nodeId)) {
    return { ok: false, network: net, error: "node_id_exhausted" };
  }
  const feature: NetworkFeature = {
    ordinal: point.ordinal,
    geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
    properties: {
      NODEID: nodeId,
      PATH_COUNT: 0,
      FLOOR: ordinalToFloorLabel(point.ordinal),
      BARRIER: 0,
      STARTTIME: -1,
      ENDTIME: -1,
      GATE: 0,
      NAME: null,
      relative_height: null,
      altitude: point.ordinal * FLOOR_HEIGHT_M,
    },
  };
  return {
    ok: true,
    network: { junctions: [...net.junctions, feature], paths: net.paths },
    nodeId,
  };
}

/**
 * Move a junction to a new position on its own floor, dragging every incident
 * path endpoint with it. Interior vertices and edge `cost` are preserved.
 */
export function moveJunction(
  net: ParsedNetwork,
  nodeId: number,
  point: { longitude: number; latitude: number },
): NetworkMutationResult {
  if (!Number.isFinite(point.longitude) || !Number.isFinite(point.latitude)) {
    return { ok: false, network: net, error: "invalid_coordinate" };
  }
  const index = net.junctions.findIndex((j) => j.properties.NODEID === nodeId);
  if (index === -1) {
    return { ok: false, network: net, error: "unknown_junction" };
  }
  const coord: [number, number] = [point.longitude, point.latitude];
  const junctions = net.junctions.map((j, i) =>
    i === index
      ? { ...j, geometry: { type: "Point", coordinates: [coord[0], coord[1]] } as GeoJSON.Point }
      : j,
  );
  const paths = net.paths.map((p) => {
    const from = p.properties.FNODEID === nodeId;
    const to = p.properties.TNODEID === nodeId;
    if (!from && !to) return p;
    let geometry = p.geometry;
    if (from) geometry = movePathEndpoint(geometry, "start", coord);
    if (to) geometry = movePathEndpoint(geometry, "end", coord);
    return { ...p, geometry };
  });
  return { ok: true, network: { junctions, paths } };
}

/** Remove a junction and every path incident to it. */
export function deleteJunction(net: ParsedNetwork, nodeId: number): NetworkMutationResult {
  const exists = net.junctions.some((j) => j.properties.NODEID === nodeId);
  if (!exists) {
    return { ok: false, network: net, error: "unknown_junction" };
  }
  const junctions = net.junctions.filter((j) => j.properties.NODEID !== nodeId);
  const paths = net.paths.filter(
    (p) => p.properties.FNODEID !== nodeId && p.properties.TNODEID !== nodeId,
  );
  return { ok: true, network: { junctions: withPathCounts(junctions, paths), paths } };
}

/**
 * Append a straight forward+reverse `net_path` pair between two existing
 * junctions on the same floor, with the canonical export defaults. Rejects
 * unknown, identical, cross-floor, or already-connected endpoints.
 */
export function addConnection(net: ParsedNetwork, fromId: number, toId: number): NetworkMutationResult {
  if (fromId === toId) {
    return { ok: false, network: net, error: "same_junction" };
  }
  const from = net.junctions.find((j) => j.properties.NODEID === fromId);
  const to = net.junctions.find((j) => j.properties.NODEID === toId);
  if (from == null || to == null) {
    return { ok: false, network: net, error: "unknown_junction" };
  }
  if (from.ordinal !== to.ordinal) {
    return { ok: false, network: net, error: "cross_floor_connection" };
  }
  const exists = net.paths.some((p) => {
    const f = p.properties.FNODEID;
    const t = p.properties.TNODEID;
    return (f === fromId && t === toId) || (f === toId && t === fromId);
  });
  if (exists) {
    return { ok: false, network: net, error: "existing_connection" };
  }
  const a = pointCoordinates(from);
  const b = pointCoordinates(to);
  if (a === null || b === null) {
    return { ok: false, network: net, error: "invalid_coordinate" };
  }
  const distanceM = haversineM(a[0], a[1], b[0], b[1]);
  const cost = Math.round(distanceM * 1000);
  const travelTime = Math.round(distanceM / WALK_SPEED_MPS);
  const floor =
    typeof from.properties.FLOOR === "string"
      ? from.properties.FLOOR
      : ordinalToFloorLabel(from.ordinal ?? 0);
  const fwdPathId = nextPathId(net.paths);
  const revPathId = fwdPathId + 1;
  const mk = (
    f: number,
    t: number,
    pathId: number,
    reversePathId: number,
    coords: [number, number][],
  ): NetworkFeature => ({
    ordinal: from.ordinal,
    geometry: { type: "LineString", coordinates: coords },
    properties: {
      FNODEID: f,
      TNODEID: t,
      passage_type: 0,
      cost,
      TRAVELTIME: travelTime,
      RFLAG: 0,
      BARRIER: 0,
      FLOOR: floor,
      PATHID: pathId,
      RPATHID: reversePathId,
      HFLAG: 0,
      STARTTIME: -1,
      ENDTIME: -1,
      direction: null,
      FFLOOR: null,
      TFOOLR: null,
      indoor: 1,
    },
  });
  const paths = [
    ...net.paths,
    mk(fromId, toId, fwdPathId, revPathId, [a, b]),
    mk(toId, fromId, revPathId, fwdPathId, [b, a]),
  ];
  return {
    ok: true,
    network: { junctions: withPathCounts(net.junctions, paths), paths },
    connectionId: { pathId: fwdPathId, reversePathId: revPathId },
  };
}

/** Same-floor NODEID within `PATH_SNAP_RADIUS_M`, or null. Closest wins; ties take the smaller id. */
function snapJunctionId(
  net: ParsedNetwork,
  lon: number,
  lat: number,
  ordinal: number,
): number | null {
  let bestId: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const junction of net.junctions) {
    if (junction.ordinal !== ordinal) continue;
    const id = asFiniteNumber(junction.properties.NODEID);
    const coord = pointCoordinates(junction);
    if (id === null || coord === null) continue;
    const dist = haversineM(lon, lat, coord[0], coord[1]);
    if (dist > PATH_SNAP_RADIUS_M) continue;
    if (dist < bestDist || (dist === bestDist && (bestId === null || id < bestId))) {
      bestDist = dist;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * Insert a same-floor polyline as junctions + connections on a working copy.
 * Vertices snap to existing same-floor nodes within 0.8 m; consecutive
 * identical ids collapse; an already-present pair is skipped rather than
 * failing the whole path. Fatal `node_id_exhausted` / `invalid_coordinate`
 * discard the copy and return the original network.
 */
export function addPath(
  net: ParsedNetwork,
  coordinates: [number, number][],
  ordinal: number,
): NetworkMutationResult {
  if (coordinates.length < 2) {
    return { ok: true, network: net };
  }
  let working = net;
  const resolved: number[] = [];
  for (const coord of coordinates) {
    const lon = coord[0];
    const lat = coord[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return { ok: false, network: net, error: "invalid_coordinate" };
    }
    const snapped = snapJunctionId(working, lon, lat, ordinal);
    if (snapped !== null) {
      if (resolved[resolved.length - 1] !== snapped) resolved.push(snapped);
      continue;
    }
    const added = addJunction(working, { longitude: lon, latitude: lat, ordinal });
    if (!added.ok) {
      return { ok: false, network: net, error: added.error };
    }
    working = added.network;
    if (added.nodeId !== undefined && resolved[resolved.length - 1] !== added.nodeId) {
      resolved.push(added.nodeId);
    }
  }
  if (resolved.length < 2) {
    return { ok: true, network: net };
  }
  for (let i = 0; i < resolved.length - 1; i += 1) {
    const fromId = resolved[i]!;
    const toId = resolved[i + 1]!;
    const linked = addConnection(working, fromId, toId);
    if (linked.ok) {
      working = linked.network;
      continue;
    }
    if (linked.error === "existing_connection") continue;
    if (linked.error === "node_id_exhausted" || linked.error === "invalid_coordinate") {
      return { ok: false, network: net, error: linked.error };
    }
    return { ok: false, network: net, error: linked.error };
  }
  return { ok: true, network: working };
}

/** Remove exactly the reciprocal pair identified by `connectionId`. */
export function deleteConnection(
  net: ParsedNetwork,
  connectionId: NetworkConnectionId,
): NetworkMutationResult {
  const target =
    connectionId.pathId < connectionId.reversePathId
      ? connectionId
      : { pathId: connectionId.reversePathId, reversePathId: connectionId.pathId };
  let removed = false;
  const paths = net.paths.filter((p) => {
    const id = connectionIdOf(p);
    if (id !== null && id.pathId === target.pathId && id.reversePathId === target.reversePathId) {
      removed = true;
      return false;
    }
    return true;
  });
  if (!removed) {
    return { ok: false, network: net, error: "unknown_connection" };
  }
  return { ok: true, network: { junctions: withPathCounts(net.junctions, paths), paths } };
}

/** Reconstruct the two named GeoJSON FeatureCollections for re-import. */
export function serializeNetwork(net: ParsedNetwork): { junctions: string; paths: string } {
  const collection = (name: string, feats: NetworkFeature[]): string =>
    JSON.stringify({
      type: "FeatureCollection",
      name,
      features: feats.map((f) => ({ type: "Feature", properties: f.properties, geometry: f.geometry })),
    });
  return {
    junctions: collection("net_junction", net.junctions),
    paths: collection("net_path", net.paths),
  };
}

/**
 * Set of group keys for the network's distinct logical (undirected) connections
 * — reciprocal `PATHID`/`RPATHID` pairs collapse to one, parallel edges stay
 * distinct. Used by the editor to diff and validate a graph before save.
 */
export function connectionKeys(net: ParsedNetwork): Set<string> {
  return new Set(logicalConnections(net.paths).keys());
}
