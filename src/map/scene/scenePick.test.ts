import { describe, expect, it } from "vitest";
import { MAX_PICKABLE_FEATURES, decodeFeatureId, encodeFeatureId } from "./scenePick";

describe("feature id codec", () => {
  it("round-trips every index the encoding can carry", () => {
    for (const index of [0, 1, 2, 254, 255, 256, 65_534, 65_535, 65_536, 1_000_000, 16_777_213]) {
      const encoded = encodeFeatureId(index);
      expect(decodeFeatureId(new Uint8Array(encoded))).toBe(index);
    }
  });

  it("reserves all-zero as the no-hit sentinel, so index 0 is never a miss", () => {
    expect(decodeFeatureId(new Uint8Array([0, 0, 0, 0]))).toBe(-1);
    expect(decodeFeatureId(new Uint8Array([0, 0, 0, 255]))).toBe(-1);
    const zero = encodeFeatureId(0);
    expect(zero.slice(0, 3)).not.toEqual([0, 0, 0]);
    expect(decodeFeatureId(new Uint8Array(zero))).toBe(0);
  });

  it("states the range it can address, so a larger scene fails loudly", () => {
    expect(MAX_PICKABLE_FEATURES).toBe(16_777_214);
    expect(() => encodeFeatureId(MAX_PICKABLE_FEATURES)).toThrow(/pickable/);
    expect(() => encodeFeatureId(-1)).toThrow(/pickable/);
  });
});
