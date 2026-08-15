import { describe, expect, it } from "vitest";
import { buildConnectorMesh, type ConnectorEndpoint, type ConnectorInput } from "./sceneConnectors";

/** Local metres straight from the endpoint, so the expansion is what is tested. */
function localOf(endpoint: ConnectorEndpoint): readonly [number, number, number] {
  return [endpoint.lng, endpoint.lat, endpoint.levelIndex * 4];
}

function connector(pathId: number, lower: [number, number], upper: [number, number]): ConnectorInput {
  return {
    connectionId: { pathId, reversePathId: pathId + 1 },
    lower: { lng: lower[0], lat: lower[1], levelIndex: 0 },
    upper: { lng: upper[0], lat: upper[1], levelIndex: 1 },
  };
}

describe("buildConnectorMesh", () => {
  it("expands one link into a ribbon quad carrying both of its endpoints", () => {
    // Each vertex needs its own endpoint and the opposite one: the shader
    // derives the screen-space direction from the pair, which is the only way
    // a ribbon keeps a constant pixel width at every zoom.
    const mesh = buildConnectorMesh([connector(10, [1, 2], [1, 2])], localOf);

    expect(mesh.vertexCount).toBe(6);
    expect(mesh.connectionIds).toEqual([{ pathId: 10, reversePathId: 11 }]);
    const positions: number[][] = [];
    const others: number[][] = [];
    for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
      positions.push([...mesh.position.subarray(vertex * 3, vertex * 3 + 3)]);
      others.push([...mesh.other.subarray(vertex * 3, vertex * 3 + 3)]);
    }
    // Two triangles: lower, lower, upper / lower, upper, upper.
    expect(positions.map((p) => p[2])).toEqual([0, 0, 4, 0, 4, 4]);
    expect(others.map((p) => p[2])).toEqual([4, 4, 0, 4, 0, 0]);
    expect([...mesh.side]).toEqual([-1, 1, -1, 1, 1, -1]);
  });

  it("keeps each connector's vertices addressable by its own index", () => {
    const mesh = buildConnectorMesh(
      [connector(10, [1, 2], [1, 2]), connector(20, [3, 4], [3, 4])],
      localOf,
    );

    expect(mesh.vertexCount).toBe(12);
    expect([...mesh.ids]).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    expect(mesh.connectionIds.map((id) => id.pathId)).toEqual([10, 20]);
  });

  it("has nothing to draw when the graph links no floors", () => {
    const mesh = buildConnectorMesh([], localOf);

    expect(mesh.vertexCount).toBe(0);
    expect(mesh.connectionIds).toEqual([]);
    expect(mesh.position).toHaveLength(0);
  });

  it("places both ends on their own floor plane", () => {
    const mesh = buildConnectorMesh(
      [
        {
          connectionId: { pathId: 1, reversePathId: 2 },
          lower: { lng: 139.7, lat: 35.6, levelIndex: 0 },
          upper: { lng: 139.8, lat: 35.7, levelIndex: 2 },
        },
      ],
      localOf,
    );

    // A connector that ignored the planes would be a flat line on one floor —
    // exactly the thing the 2D overlay cannot escape.
    expect(mesh.position[0]).toBeCloseTo(139.7, 4);
    expect(mesh.position[1]).toBeCloseTo(35.6, 4);
    expect(mesh.position[2]).toBe(0);
    expect(mesh.position[6]).toBeCloseTo(139.8, 4);
    expect(mesh.position[7]).toBeCloseTo(35.7, 4);
    expect(mesh.position[8]).toBe(8);
  });
});
