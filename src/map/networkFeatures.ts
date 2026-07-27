import type { NetworkGeoJsonDto } from "../bundle/wasm";

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

interface NetworkFeature {
  ordinal: number | null;
  geometry: GeoJSON.Geometry;
  properties: Record<string, unknown>;
}

/** Parsed, floor-tagged network ready for per-floor overlay rendering. */
export interface ParsedNetwork {
  junctions: NetworkFeature[];
  paths: NetworkFeature[];
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
 * Project the parsed network onto one floor: every `net_path` on
 * `activeOrdinal` becomes a `kind:"path"` LineString and every `net_junction`
 * a `kind:"junction"` Point. Mirrors `buildRouteFeatures`' per-floor overlay
 * contract so the map renders only the active level's network.
 */
export function buildNetworkFeatures(
  network: ParsedNetwork | null,
  activeOrdinal: number,
  selectedJunctions: ReadonlySet<number> = new Set(),
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (network === null) {
    return { type: "FeatureCollection", features };
  }
  for (const path of network.paths) {
    if (path.ordinal === activeOrdinal) {
      features.push({
        type: "Feature",
        properties: { kind: "path", FNODEID: path.properties.FNODEID, TNODEID: path.properties.TNODEID },
        geometry: path.geometry,
      });
    }
  }
  for (const junction of network.junctions) {
    if (junction.ordinal === activeOrdinal) {
      const id = junction.properties.NODEID;
      features.push({
        type: "Feature",
        properties: {
          kind: "junction",
          NODEID: id,
          selected: typeof id === "number" && selectedJunctions.has(id),
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
/** Great-circle distance in metres between two lon/lat points. */
function haversineM(lon1: number, lat1: number, lon2: number, lat2: number): number {
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

/**
 * Append a straight forward+reverse `net_path` pair between two existing
 * junctions (cost = great-circle mm). No-op if either id is unknown, they are
 * the same, or an undirected edge already joins them.
 */
export function addEdge(net: ParsedNetwork, fromId: number, toId: number): ParsedNetwork {
  if (fromId === toId) return net;
  const exists = net.paths.some((p) => {
    const f = p.properties.FNODEID;
    const t = p.properties.TNODEID;
    return (f === fromId && t === toId) || (f === toId && t === fromId);
  });
  if (exists) return net;
  const from = net.junctions.find((j) => j.properties.NODEID === fromId);
  const to = net.junctions.find((j) => j.properties.NODEID === toId);
  if (from == null || to == null || from.geometry.type !== "Point" || to.geometry.type !== "Point") {
    return net;
  }
  const a = from.geometry.coordinates;
  const b = to.geometry.coordinates;
  // Browser adapter boundary: never emit a NaN/Infinity-cost edge from a
  // junction with non-finite coordinates.
  if (![a[0], a[1], b[0], b[1]].every((v) => typeof v === "number" && Number.isFinite(v))) {
    return net;
  }
  const cost = Math.round(haversineM(a[0]!, a[1]!, b[0]!, b[1]!) * 1000);
  const ordinal = from.ordinal;
  const floor =
    typeof from.properties.FLOOR === "string" ? from.properties.FLOOR : ordinalToFloorLabel(ordinal ?? 0);
  // Fresh, globally-unique reciprocal PATHID/RPATHID so the Rust importer
  // canonicalizes the forward+reverse pair into one logical undirected edge.
  const fwdPathId = nextPathId(net.paths);
  const revPathId = fwdPathId + 1;
  const mk = (
    f: number,
    t: number,
    pathId: number,
    reversePathId: number,
    coords: [number, number][],
  ): NetworkFeature => ({
    ordinal,
    geometry: { type: "LineString", coordinates: coords },
    properties: { FNODEID: f, TNODEID: t, cost, FLOOR: floor, PATHID: pathId, RPATHID: reversePathId },
  });
  const pa: [number, number] = [a[0]!, a[1]!];
  const pb: [number, number] = [b[0]!, b[1]!];
  return {
    junctions: net.junctions,
    paths: [
      ...net.paths,
      mk(fromId, toId, fwdPathId, revPathId, [pa, pb]),
      mk(toId, fromId, revPathId, fwdPathId, [pb, pa]),
    ],
  };
}

/** Remove both directed `net_path` features for an undirected pair. */
export function deleteEdge(net: ParsedNetwork, aId: number, bId: number): ParsedNetwork {
  const paths = net.paths.filter((p) => {
    const f = p.properties.FNODEID;
    const t = p.properties.TNODEID;
    return !((f === aId && t === bId) || (f === bId && t === aId));
  });
  return { junctions: net.junctions, paths };
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
