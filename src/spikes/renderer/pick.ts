/**
 * Pick support for the spike renderer: decode the feature-id color readback
 * and a CPU screen-space index over the routing graph.
 *
 * All code in this file is disposable spike code (see the spike plan).
 */

/**
 * Hit radii for network picking, in screen pixels. Source of truth:
 * `src/map/featureLayers.ts` (`buildNetworkLayers`): hit paths are 12 px
 * wide lines and hit junctions are 10 px radius circles. Keep in sync.
 */
export const JUNCTION_HIT_PX = 10;
export const PATH_HIT_PX = 12;

/**
 * Pack a feature index into an RGBA color. All-zero RGBA means "no hit",
 * so the index is shifted by one: feature 0 becomes (1, 0, 0, 255).
 */
export function encodeFeatureId(index: number): [number, number, number, number] {
  const packed = index + 1;
  return [packed & 0xff, (packed >> 8) & 0xff, (packed >> 16) & 0xff, 255];
}

/**
 * Unpack an RGBA color read from the pick framebuffer back into a feature
 * index. Returns -1 for the all-zero "no hit" sentinel.
 */
export function decodeFeatureId(rgba: Uint8Array): number {
  const r = rgba[0] ?? 0;
  const g = rgba[1] ?? 0;
  const b = rgba[2] ?? 0;
  const a = rgba[3] ?? 0;
  if (r === 0 && g === 0 && b === 0 && a === 0) {
    return -1;
  }
  return (r | (g << 8) | (b << 16)) - 1;
}

/** One routing junction in screen space. */
export interface GraphNode {
  id: number;
  screen: readonly [number, number];
}

/** One routing path segment in screen space. */
export interface GraphEdge {
  id: number;
  from: readonly [number, number];
  to: readonly [number, number];
}

/** Result of a screen-space pick: either a junction or a path. */
export type GraphPick =
  | { kind: "junction"; id: number }
  | { kind: "path"; id: number };

/** Screen-space index over a routing graph. */
export interface GraphIndex {
  pickAt(x: number, y: number): GraphPick | null;
}

interface NodeEntry {
  id: number;
  x: number;
  y: number;
}

interface EdgeEntry {
  id: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;

/**
 * Closest distance from point `(px, py)` to segment `(ax, ay)`–`(bx, by)`,
 * clamped to the segment's ends (a pick never lands past the endpoints).
 */
function pointToSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(px - ax, py - ay);
  }
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Build a uniform screen-space grid over junctions and path segments.
 * Cell size covers both hit radii, so a pick needs only its 3x3 cell
 * neighborhood. Junctions take precedence; within each kind the nearest
 * candidate wins.
 */
export function createGraphIndex(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphIndex {
  const cellSize = Math.max(JUNCTION_HIT_PX, PATH_HIT_PX) * 2;
  const nodeCells = new Map<string, NodeEntry[]>();
  const edgeCells = new Map<string, EdgeEntry[]>();

  for (const node of nodes) {
    const [x, y] = node.screen;
    const key = cellKey(Math.floor(x / cellSize), Math.floor(y / cellSize));
    const bucket = nodeCells.get(key);
    if (bucket === undefined) {
      nodeCells.set(key, [{ id: node.id, x, y }]);
    } else {
      bucket.push({ id: node.id, x, y });
    }
  }

  for (const edge of edges) {
    const [ax, ay] = edge.from;
    const [bx, by] = edge.to;
    const minX = Math.floor(Math.min(ax, bx) / cellSize);
    const maxX = Math.floor(Math.max(ax, bx) / cellSize);
    const minY = Math.floor(Math.min(ay, by) / cellSize);
    const maxY = Math.floor(Math.max(ay, by) / cellSize);
    const entry: EdgeEntry = { id: edge.id, ax, ay, bx, by };
    for (let cy = minY; cy <= maxY; cy += 1) {
      for (let cx = minX; cx <= maxX; cx += 1) {
        const key = cellKey(cx, cy);
        const bucket = edgeCells.get(key);
        if (bucket === undefined) {
          edgeCells.set(key, [entry]);
        } else {
          bucket.push(entry);
        }
      }
    }
  }

  return {
    pickAt(x: number, y: number): GraphPick | null {
      const cx = Math.floor(x / cellSize);
      const cy = Math.floor(y / cellSize);
      const junctionRadiusSq = JUNCTION_HIT_PX * JUNCTION_HIT_PX;
      let bestJunction: { id: number; distSq: number } | null = null;
      let bestPath: { id: number; dist: number } | null = null;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const key = cellKey(cx + dx, cy + dy);

          const junctionBucket = nodeCells.get(key);
          if (junctionBucket !== undefined) {
            for (const entry of junctionBucket) {
              const offX = x - entry.x;
              const offY = y - entry.y;
              const distSq = offX * offX + offY * offY;
              if (distSq <= junctionRadiusSq && (bestJunction === null || distSq < bestJunction.distSq)) {
                bestJunction = { id: entry.id, distSq };
              }
            }
          }

          const pathBucket = edgeCells.get(key);
          if (pathBucket !== undefined) {
            for (const entry of pathBucket) {
              const dist = pointToSegmentDistance(x, y, entry.ax, entry.ay, entry.bx, entry.by);
              if (dist <= PATH_HIT_PX && (bestPath === null || dist < bestPath.dist)) {
                bestPath = { id: entry.id, dist };
              }
            }
          }
        }
      }

      if (bestJunction !== null) {
        return { kind: "junction", id: bestJunction.id };
      }
      if (bestPath !== null) {
        return { kind: "path", id: bestPath.id };
      }
      return null;
    },
  };
}
