/**
 * The inter-floor connector's geometry: one screen-width ribbon per cross-floor
 * graph link, spanning the two floor planes it actually connects.
 *
 * #32 asks for the inter-floor connector in two places — section 6's route
 * overview and section 11's route presentation — and nothing drew it, because a
 * MapLibre overlay is draped on one plane at a time by the floor-elevation DEM.
 * A line that leaves its floor has to be real geometry in the scene layer, so
 * this builds it: the vertex data for a camera-facing quad per link, expanded
 * to a constant pixel width in the vertex shader.
 *
 * Each vertex carries its own endpoint and the opposite one. That is what makes
 * a constant screen width possible without rebuilding geometry on every zoom:
 * the shader projects both ends, takes the direction between them in clip
 * space, and offsets perpendicular to it.
 *
 * This module is pure. The local-metre resolver is supplied by the layer, which
 * owns the scene frame and the resolved floor planes.
 */
import type { NetworkConnectionId } from "../networkFeatures";

/** One end of a connector: a graph junction on a specific scene level. */
export interface ConnectorEndpoint {
  lng: number;
  lat: number;
  levelIndex: number;
}

/** One cross-floor link to draw, already resolved to scene levels. */
export interface ConnectorInput {
  connectionId: NetworkConnectionId;
  lower: ConnectorEndpoint;
  upper: ConnectorEndpoint;
}

/**
 * Non-indexed ribbon vertices, six per connector. Non-indexed on purpose: the
 * count is small, and an element buffer would only add a binding to manage for
 * geometry that is rebuilt whole whenever the graph or the floor changes.
 */
export interface ConnectorMesh {
  /** The vertex's own endpoint, venue-local metres. */
  position: Float32Array;
  /** The connector's opposite endpoint, venue-local metres. */
  other: Float32Array;
  /** Which side of the line this vertex is offset toward: `-1` or `1`. */
  side: Float32Array;
  /** The connector index each vertex belongs to, for the pick pass. */
  ids: Uint32Array;
  /** Connection identity per connector index. */
  connectionIds: NetworkConnectionId[];
  vertexCount: number;
}

/** Vertex order of the two triangles: lower, lower, upper / lower, upper, upper. */
const FROM_LOWER: readonly boolean[] = [true, true, false, true, false, false];
const SIDES: readonly number[] = [-1, 1, -1, 1, 1, -1];
const VERTICES_PER_CONNECTOR = 6;

export function buildConnectorMesh(
  connectors: readonly ConnectorInput[],
  localOf: (endpoint: ConnectorEndpoint) => readonly [number, number, number],
): ConnectorMesh {
  const vertexCount = connectors.length * VERTICES_PER_CONNECTOR;
  const position = new Float32Array(vertexCount * 3);
  const other = new Float32Array(vertexCount * 3);
  const side = new Float32Array(vertexCount);
  const ids = new Uint32Array(vertexCount);
  const connectionIds: NetworkConnectionId[] = [];

  connectors.forEach((connector, index) => {
    const lower = localOf(connector.lower);
    const upper = localOf(connector.upper);
    connectionIds.push(connector.connectionId);
    for (let corner = 0; corner < VERTICES_PER_CONNECTOR; corner += 1) {
      const vertex = index * VERTICES_PER_CONNECTOR + corner;
      const own = FROM_LOWER[corner] === true ? lower : upper;
      const opposite = FROM_LOWER[corner] === true ? upper : lower;
      position[vertex * 3] = own[0];
      position[vertex * 3 + 1] = own[1];
      position[vertex * 3 + 2] = own[2];
      other[vertex * 3] = opposite[0];
      other[vertex * 3 + 1] = opposite[1];
      other[vertex * 3 + 2] = opposite[2];
      side[vertex] = SIDES[corner]!;
      ids[vertex] = index;
    }
  });

  return { position, other, side, ids, connectionIds, vertexCount };
}
