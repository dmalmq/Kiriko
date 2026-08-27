/**
 * The scene reader against the real built wasm and the committed golden
 * bundle — not a mock. If the Rust producer and this reader ever disagree
 * about the format, these fail.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { initKirikoWasm } from "../../bundle/wasm";
import {
  drawCallsForLevel,
  primitiveCollapse,
  readGeneratedScene,
  readScene,
  type SceneView,
} from "./sceneFormat";

/** The frozen scene-carrying bundle (§8 + §9 + graph + facilities). */
const GOLDEN_BUNDLE = "tests/fixtures/stage0.kvb";

/** A bundle published before §8/§9 existed — no scene to read. */
const LEGACY_BUNDLE = "tests/fixtures/legacy-minimal.kvb";

/** A scene whose §8 dependency is unavailable: present bytes, unplaceable. */
const DISABLED_BUNDLE = "tests/fixtures/stage0-disabled.kvb";

let scene: SceneView;

beforeAll(async () => {
  await initKirikoWasm();
  scene = readGeneratedScene(new Uint8Array(readFileSync(GOLDEN_BUNDLE)));
});

describe("readGeneratedScene", () => {
  it("reads the header's frame and world transform", () => {
    expect(scene.header.formatVersion).toBe(1);
    expect(scene.header.sourceHash).toMatch(/^[0-9a-f]{64}$/);

    // The frame origin is a real ECEF position, not an origin-centred stub.
    const [x, y, z] = scene.header.frameOriginEcef;
    expect(Math.hypot(x, y, z)).toBeGreaterThan(6_000_000);

    // Column-major 4x4 with a normalized rotation and the homogeneous row.
    expect(scene.header.worldTransform).toHaveLength(16);
    expect(scene.header.worldTransform[15]).toBe(1);
    const east = scene.header.worldTransform.slice(0, 3);
    expect(Math.hypot(east[0]!, east[1]!, east[2]!)).toBeCloseTo(1, 6);
  });

  it("describes every level with a resolved plane", () => {
    expect(scene.levels.length).toBeGreaterThan(0);
    for (const level of scene.levels) {
      expect(level.canonicalId).not.toBe("");
      expect(Number.isFinite(level.resolvedPlaneZ)).toBe(true);
      // The generated source has no composite source level; §8 is the
      // provenance authority and this field must not invent one.
      expect(level.sourceLevelKey).toBe("");
    }
  });

  it("builds typed views whose lengths match the vertex counts", () => {
    expect(scene.batches.length).toBeGreaterThan(0);
    for (const batch of scene.batches) {
      expect(batch.positions).toHaveLength(batch.vertexCount * 3);
      expect(batch.normals).toHaveLength(batch.vertexCount * 2);
      expect(batch.featureIndices).toHaveLength(batch.vertexCount);
      if (batch.colors !== null) {
        expect(batch.colors).toHaveLength(batch.vertexCount * 3);
      }
      expect(batch.vertexCount % 3).toBe(0);
      for (const axis of [0, 1, 2]) {
        expect(batch.quantizationScale[axis]).toBeGreaterThan(0);
      }
    }
  });

  it("attributes every vertex to a feature that agrees with its batch", () => {
    for (const batch of scene.batches) {
      for (const index of batch.featureIndices) {
        const feature = scene.features[index];
        expect(feature).toBeDefined();
        expect(feature!.levelIndex).toBe(batch.levelIndex);
        expect(feature!.role).toBe(batch.role);
      }
    }
  });

  it("keeps every visible floor inside the draw-call budget", () => {
    const levelIndices = new Set(scene.batches.map((batch) => batch.levelIndex));
    expect(levelIndices.size).toBeGreaterThan(0);
    for (const levelIndex of levelIndices) {
      expect(drawCallsForLevel(scene, levelIndex)).toBeLessThanOrEqual(8);
    }
    expect(scene.batches.length).toBeLessThanOrEqual(320);
    expect(primitiveCollapse(scene)).toBeGreaterThan(1);
  });

  it("restores quantized positions inside the batch bounds", () => {
    const batch = scene.batches[0]!;
    const restored: number[][] = [];
    for (let vertex = 0; vertex < batch.vertexCount; vertex += 1) {
      restored.push([0, 1, 2].map((axis) =>
        batch.quantizationOrigin[axis]! +
        batch.positions[vertex * 3 + axis]! * batch.quantizationScale[axis]!,
      ));
    }
    for (const point of restored) {
      for (const axis of [0, 1, 2]) {
        expect(point[axis]!).toBeGreaterThanOrEqual(
          scene.header.boundsMin[axis]! - 0.01,
        );
        expect(point[axis]!).toBeLessThanOrEqual(scene.header.boundsMax[axis]! + 0.01);
      }
    }
  });

  it("carries the semantic roles the visual language styles", () => {
    const roles = new Set(scene.features.map((feature) => feature.role));
    expect(roles.has("Walkable")).toBe(true);
    expect(roles.has("Structure")).toBe(true);

    // Navigable surfaces never fade for the camera; ceilings may.
    for (const feature of scene.features) {
      if (feature.role === "Walkable") {
        expect(feature.occlusion).toBe("Never");
      }
      if (feature.role === "Ceiling") {
        expect(feature.occlusion).toBe("ProtectedCorridor");
      }
    }
  });

  it("reads identical views from identical bytes", () => {
    const bytes = new Uint8Array(readFileSync(GOLDEN_BUNDLE));
    const first = readGeneratedScene(bytes);
    const second = readGeneratedScene(bytes);
    expect(second.header).toEqual(first.header);
    expect(second.batches.map((batch) => batch.vertexCount)).toEqual(
      first.batches.map((batch) => batch.vertexCount),
    );
    expect([...second.batches[0]!.positions]).toEqual([...first.batches[0]!.positions]);
  });

  it("refuses a bundle that carries no scene rather than rendering nothing", () => {
    const legacy = new Uint8Array(readFileSync(LEGACY_BUNDLE));
    expect(() => readGeneratedScene(legacy)).toThrow(/no generated scene|no spatial context/);
  });

  it("refuses a scene whose spatial context is unavailable rather than placing it", () => {
    const disabled = new Uint8Array(readFileSync(DISABLED_BUNDLE));
    expect(() => readGeneratedScene(disabled)).toThrow(/no spatial context|no generated scene/);
  });
});

describe("readScene colors", () => {
  it("treats a missing colorsOffset as no per-vertex tints", () => {
    const payload = new Uint8Array(44);
    new Uint16Array(payload.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    new Int16Array(payload.buffer, 20, 6).set([0, 0, 0, 0, 0, 0]);
    new Uint32Array(payload.buffer, 32, 3).set([0, 0, 0]);
    const scene = readScene({
      meta: JSON.stringify({
        header: {
          formatVersion: 1,
          deriverVersion: 1,
          sourceHash: "0".repeat(64),
          frameOriginEcef: [0, 0, 0],
          worldTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          boundsMin: [0, 0, 0],
          boundsMax: [1, 1, 1],
        },
        levels: [
          {
            canonicalId: "l1",
            sourceLevelKey: "",
            sourceLevelName: "",
            sourceElevationMeters: null,
            resolvedPlaneZ: 0,
            quantizedElevationDm: 0,
          },
        ],
        features: [
          {
            sourceObjectId: "f1",
            canonicalId: null,
            levelIndex: 0,
            role: "TicketGate",
            occlusion: "Never",
            minZ: 0,
            maxZ: 1,
          },
        ],
        batches: [
          {
            levelIndex: 0,
            role: "TicketGate",
            quantizationOrigin: [0, 0, 0],
            quantizationScale: [1, 1, 1],
            vertexCount: 3,
            positionsOffset: 0,
            normalsOffset: 20,
            featureIndicesOffset: 32,
          },
        ],
      }),
      payload,
    });
    expect(scene.batches[0]!.colors).toBeNull();
  });
});
