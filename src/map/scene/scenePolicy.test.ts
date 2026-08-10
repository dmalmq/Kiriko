import { describe, expect, it } from "vitest";
import type { SemanticRoleName } from "./sceneFormat";
import {
  CONTEXT_HANDOFF_MS,
  CONTEXT_LEVEL_OPACITY,
  OCCLUDER_FADE_OPACITY,
  ROLE_COLORS,
  ROLE_DEPTH_BIAS,
  ROLE_PAINT_ORDER,
  batchOpacity,
} from "./scenePolicy";

const ALL_ROLES: SemanticRoleName[] = [
  "Walkable",
  "Public",
  "Service",
  "Restricted",
  "Structure",
  "Ceiling",
  "Opening",
  "Elevator",
  "Escalator",
  "Stairs",
  "Ramp",
  "Context",
  "Conveyance",
];

describe("batchOpacity", () => {
  it("draws every source level registered to the active floor", () => {
    // A canonical floor maps to one or more composite tile levels (#31), and
    // the reviewer selected the floor, not one of its source documents.
    const state = { activeLevelIndices: [1, 2], showContextLevels: false };
    expect(batchOpacity({ levelIndex: 1, role: "Walkable" }, state)).toBe(1);
    expect(batchOpacity({ levelIndex: 2, role: "Walkable" }, state)).toBe(1);
    expect(batchOpacity({ levelIndex: 3, role: "Walkable" }, state)).toBe(0);
  });

  it("draws the active floor and hides every other one", () => {
    const state = { activeLevelIndices: [1], showContextLevels: false };
    expect(batchOpacity({ levelIndex: 1, role: "Walkable" }, state)).toBe(1);
    expect(batchOpacity({ levelIndex: 0, role: "Walkable" }, state)).toBe(0);
    expect(batchOpacity({ levelIndex: 2, role: "Structure" }, state)).toBe(0);
  });

  it("hides the active floor's ceilings so the space below is legible", () => {
    const state = { activeLevelIndices: [0], showContextLevels: false };
    expect(batchOpacity({ levelIndex: 0, role: "Ceiling" }, state)).toBe(0);
    // A ceiling is the only role hidden by default; walls stay.
    expect(batchOpacity({ levelIndex: 0, role: "Structure" }, state)).toBe(1);
  });

  it("fades a context floor's ceiling further than the floor itself", () => {
    const state = { activeLevelIndices: [0], showContextLevels: true };
    const floor = batchOpacity({ levelIndex: 1, role: "Walkable" }, state);
    const ceiling = batchOpacity({ levelIndex: 1, role: "Ceiling" }, state);
    // The ceiling is the protected-corridor occluder between the camera and the
    // active floor; everything else on that floor keeps context opacity.
    expect(ceiling).toBe(OCCLUDER_FADE_OPACITY);
    expect(ceiling).toBeLessThan(floor);
    expect(batchOpacity({ levelIndex: 1, role: "Structure" }, state)).toBe(floor);
  });

  it("dissolves nothing for the camera on the active floor beyond its ceilings", () => {
    const state = { activeLevelIndices: [0], showContextLevels: true };
    // A wall between the camera and the selection stays solid: #32 dissolves
    // only protected-corridor occluders, and only on context floors.
    expect(batchOpacity({ levelIndex: 0, role: "Structure" }, state)).toBe(1);
    expect(batchOpacity({ levelIndex: 0, role: "Context" }, state)).toBe(1);
  });

  it("shows other floors as quiet context when asked", () => {
    const state = { activeLevelIndices: [0], showContextLevels: true };
    expect(batchOpacity({ levelIndex: 1, role: "Walkable" }, state)).toBe(CONTEXT_LEVEL_OPACITY);
    expect(batchOpacity({ levelIndex: 0, role: "Walkable" }, state)).toBe(1);
    expect(CONTEXT_LEVEL_OPACITY).toBeGreaterThan(0);
    expect(CONTEXT_LEVEL_OPACITY).toBeLessThan(0.5);
  });
});

describe("motion window", () => {
  it("keeps the context handoff inside the 140-180 ms motion window (#32)", () => {
    expect(CONTEXT_HANDOFF_MS).toBeGreaterThanOrEqual(140);
    expect(CONTEXT_HANDOFF_MS).toBeLessThanOrEqual(180);
  });
});

describe("paint order and depth bias", () => {
  it("covers every semantic role, so no geometry draws unordered", () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_PAINT_ORDER[role]).toBeTypeOf("number");
      expect(ROLE_DEPTH_BIAS[role]).toBeTypeOf("number");
      expect(ROLE_COLORS[role]).toHaveLength(3);
    }
  });

  it("puts contextual mass under the finishes that sit coplanar on it", () => {
    // The level plate and a unit's floor share a plane; the plate must lose.
    expect(ROLE_PAINT_ORDER.Context).toBeLessThan(ROLE_PAINT_ORDER.Walkable);
    expect(ROLE_PAINT_ORDER.Context).toBeLessThan(ROLE_PAINT_ORDER.Public);
    expect(ROLE_DEPTH_BIAS.Context).toBeGreaterThan(ROLE_DEPTH_BIAS.Walkable);
  });

  it("puts openings in front of the walls they pierce", () => {
    expect(ROLE_PAINT_ORDER.Opening).toBeGreaterThan(ROLE_PAINT_ORDER.Structure);
    expect(ROLE_DEPTH_BIAS.Opening).toBeLessThan(ROLE_DEPTH_BIAS.Structure);
  });

  it("keeps navigable surfaces the brightest thing in the palette", () => {
    const luma = (role: SemanticRoleName): number => {
      const [r, g, b] = ROLE_COLORS[role];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const role of ALL_ROLES) {
      if (role !== "Walkable") {
        expect(luma("Walkable")).toBeGreaterThanOrEqual(luma(role));
      }
      // Nothing in this palette is dark: it is a calm matte model, and an
      // opening reads as a gap rather than a shadow.
      expect(luma(role)).toBeGreaterThan(0.35);
    }
  });

  it("separates navigable, public, and service surfaces", () => {
    expect(ROLE_COLORS.Walkable).not.toEqual(ROLE_COLORS.Public);
    expect(ROLE_COLORS.Public).not.toEqual(ROLE_COLORS.Service);
    expect(ROLE_COLORS.Walkable).not.toEqual(ROLE_COLORS.Service);
  });
});
