import { describe, expect, it } from "vitest";
import { createGraphIndex, decodeFeatureId, encodeFeatureId, JUNCTION_HIT_PX, PATH_HIT_PX } from "./pick";

describe("feature id packing", () => {
  it("round-trips every byte boundary", () => {
    for (const index of [0, 1, 255, 256, 65_535, 65_536, 22_386, 16_777_214]) {
      expect(decodeFeatureId(new Uint8Array(encodeFeatureId(index)))).toBe(index);
    }
  });

  it("reserves all-zero as no-hit", () => {
    expect(decodeFeatureId(new Uint8Array([0, 0, 0, 0]))).toBe(-1);
  });
});

describe("graph picking", () => {
  const nodes = [{ id: 7, screen: [100, 100] as const }];
  const edges = [{ id: 42, from: [0, 200] as const, to: [200, 200] as const }];
  const index = createGraphIndex(nodes, edges);

  it("preserves the shipped affordances", () => {
    expect(JUNCTION_HIT_PX).toBe(10);
    expect(PATH_HIT_PX).toBe(12);
  });

  it("hits a junction inside 10 px", () => {
    expect(index.pickAt(107, 100)).toEqual({ kind: "junction", id: 7 });
  });

  it("misses a junction outside 10 px", () => {
    expect(index.pickAt(115, 100)).toBeNull();
  });

  it("hits a path inside 12 px of the segment", () => {
    expect(index.pickAt(100, 209)).toEqual({ kind: "path", id: 42 });
  });

  it("prefers a junction over an overlapping path", () => {
    const overlapping = createGraphIndex(
      [{ id: 7, screen: [100, 200] as const }],
      [{ id: 42, from: [0, 200] as const, to: [200, 200] as const }],
    );
    expect(overlapping.pickAt(100, 200)).toEqual({ kind: "junction", id: 7 });
  });

  it("prefers the nearest junction when two are in range", () => {
    const twoNodes = createGraphIndex(
      [
        { id: 1, screen: [100, 100] as const },
        { id: 2, screen: [104, 100] as const },
      ],
      [],
    );
    expect(twoNodes.pickAt(103, 100)).toEqual({ kind: "junction", id: 2 });
  });

  it("ignores a point beyond a segment's ends", () => {
    expect(index.pickAt(-20, 200)).toBeNull();
  });
});
