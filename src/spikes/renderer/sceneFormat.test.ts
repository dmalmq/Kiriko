import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadScene } from "./sceneFormat";

describe("loadScene", () => {
  it("decodes the tiny fixture into typed batch views", async () => {
    const bytes = new Uint8Array(readFileSync("src/spikes/renderer/fixtures/tiny.kscene"));
    const scene = await loadScene(bytes);

    expect(scene.levels).toHaveLength(2);
    expect(scene.features).toHaveLength(2);
    expect(scene.batches).toHaveLength(2);

    const batch = scene.batches[0]!;
    expect(batch.vertexCount).toBe(3);
    expect(batch.positions).toHaveLength(9);
    expect(batch.normals).toHaveLength(6);
    expect(batch.featureIndices).toHaveLength(3);
    for (const index of batch.featureIndices) {
      expect(index).toBeLessThan(scene.features.length);
    }
  });

  it("restores quantized positions within the batch bounds", async () => {
    const bytes = new Uint8Array(readFileSync("src/spikes/renderer/fixtures/tiny.kscene"));
    const scene = await loadScene(bytes);
    const batch = scene.batches[0]!;
    const [ox, oy, oz] = batch.quantizationOrigin;
    const [sx, sy, sz] = batch.quantizationScale;
    const x = ox + batch.positions[0]! * sx;
    const y = oy + batch.positions[1]! * sy;
    const z = oz + batch.positions[2]! * sz;
    expect(x).toBeGreaterThanOrEqual(scene.header.boundsMin[0] - 1e-3);
    expect(y).toBeGreaterThanOrEqual(scene.header.boundsMin[1] - 1e-3);
    expect(z).toBeGreaterThanOrEqual(scene.header.boundsMin[2] - 1e-3);
  });
});
