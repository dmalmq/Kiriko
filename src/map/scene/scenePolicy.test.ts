import { describe, expect, it } from "vitest";
import type { SemanticRoleName } from "./sceneFormat";
import {
  CONNECTOR_COLOR,
  CONNECTOR_HIT_WIDTH_PX,
  CONNECTOR_SELECTED_WIDTH_PX,
  CONNECTOR_WIDTH_PX,
  CONTEXT_HANDOFF_MS,
  CONTEXT_LEVEL_OPACITY,
  CONVEYANCE_SHELL_OPACITY,
  OCCLUDER_FADE_OPACITY,
  OPENING_THRESHOLD_OPACITY,
  ROLE_COLORS,
  ROLE_DEPTH_BIAS,
  ROLE_PAINT_ORDER,
  UPPER_FLOOR_OPACITY,
  batchOpacity,
  batchPickable,
  planSceneDraw,
} from "./scenePolicy";

const CONVEYANCE_ROLE_NAMES: SemanticRoleName[] = [
  "Elevator",
  "Escalator",
  "Stairs",
  "Ramp",
  "Conveyance",
];

const CONVEYANCE_SHELL_ROLE_NAMES: SemanticRoleName[] = [
  "Elevator",
  "Escalator",
  "Stairs",
  "Ramp",
  "Conveyance",
];

const ILLUSTRATED_CONVEYANCE_ROLE_NAMES: SemanticRoleName[] = [
  "Elevator",
  "Escalator",
  "Stairs",
];

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
  "TicketGate",
];

describe("batchOpacity", () => {
  it("draws every source level registered to the active floor", () => {
    // A canonical floor maps to one or more composite tile levels (#31), and
    // the reviewer selected the floor, not one of its source documents.
    const state = {
      activeLevelIndices: [1, 2],
      contextLevelIndices: [],
      showContextLevels: false,
      levelPlanesM: [0, 4, 4, 8],
    };
    expect(batchOpacity({ levelIndex: 1, role: "Walkable" }, state)).toBe(1);
    expect(batchOpacity({ levelIndex: 2, role: "Walkable" }, state)).toBe(1);
    expect(batchOpacity({ levelIndex: 3, role: "Walkable" }, state)).toBe(0);
  });

  it("draws the active floor and hides every other one", () => {
    const state = {
      activeLevelIndices: [1],
      contextLevelIndices: [],
      showContextLevels: false,
      levelPlanesM: [0, 4, 8],
    };
    expect(batchOpacity({ levelIndex: 1, role: "Walkable" }, state)).toBe(1);
    expect(batchOpacity({ levelIndex: 0, role: "Walkable" }, state)).toBe(0);
    expect(batchOpacity({ levelIndex: 2, role: "Structure" }, state)).toBe(0);
  });

  it("hides the active floor's ceilings so the space below is legible", () => {
    const state = {
      activeLevelIndices: [0],
      contextLevelIndices: [],
      showContextLevels: false,
      levelPlanesM: [0, 4],
    };
    expect(batchOpacity({ levelIndex: 0, role: "Ceiling" }, state)).toBe(0);
    // A ceiling is the only role hidden by default; walls stay.
    expect(batchOpacity({ levelIndex: 0, role: "Structure" }, state)).toBe(1);
  });

  it("fades a context floor's ceiling further than the floor itself", () => {
    const state = {
      activeLevelIndices: [0],
      contextLevelIndices: [],
      showContextLevels: true,
      levelPlanesM: [0, 4],
    };
    const floor = batchOpacity({ levelIndex: 1, role: "Walkable" }, state);
    const ceiling = batchOpacity({ levelIndex: 1, role: "Ceiling" }, state);
    // The ceiling is the protected-corridor occluder between the camera and the
    // active floor; everything else on that floor keeps context opacity.
    expect(ceiling).toBe(OCCLUDER_FADE_OPACITY);
    expect(ceiling).toBeLessThan(floor);
    expect(batchOpacity({ levelIndex: 1, role: "Structure" }, state)).toBe(floor);
  });

  it("keeps the lower floor of a retained route pair solid and the upper see-through", () => {
    // The reported defect: an active floor above its route partner hid the
    // connector entirely. Elevation decides see-through, not selection.
    const state = {
      activeLevelIndices: [0],
      contextLevelIndices: [1],
      showContextLevels: false,
      levelPlanesM: [8, 4, 12],
    };
    expect(batchOpacity({ levelIndex: 0, role: "Walkable" }, state)).toBe(
      UPPER_FLOOR_OPACITY,
    );
    expect(batchOpacity({ levelIndex: 1, role: "Walkable" }, state)).toBe(1);
    expect(batchOpacity({ levelIndex: 1, role: "Ceiling" }, state)).toBe(
      OCCLUDER_FADE_OPACITY,
    );
    // Only the one route floor is retained; the rest of the venue stays away.
    expect(batchOpacity({ levelIndex: 2, role: "Walkable" }, state)).toBe(0);
  });

  it("applies the same elevation rule when the active floor is the lower one", () => {
    const state = {
      activeLevelIndices: [1],
      contextLevelIndices: [0],
      showContextLevels: false,
      levelPlanesM: [8, 4],
    };
    expect(batchOpacity({ levelIndex: 1, role: "Walkable" }, state)).toBe(1);
    expect(batchOpacity({ levelIndex: 0, role: "Walkable" }, state)).toBe(
      UPPER_FLOOR_OPACITY,
    );
  });

  it("keeps every registered level of one floor solid when they share a plane", () => {
    const state = {
      activeLevelIndices: [0, 1],
      contextLevelIndices: [2],
      showContextLevels: false,
      levelPlanesM: [4, 4, 0],
    };
    expect(batchOpacity({ levelIndex: 0, role: "Walkable" }, state)).toBe(
      UPPER_FLOOR_OPACITY,
    );
    expect(batchOpacity({ levelIndex: 1, role: "Walkable" }, state)).toBe(
      UPPER_FLOOR_OPACITY,
    );
    expect(batchOpacity({ levelIndex: 2, role: "Walkable" }, state)).toBe(1);
  });

  it("keeps selection-keyed opacity when a level plane is missing", () => {
    // No plane, no ordering: the renderer must not invent one, so the pair
    // falls back to the selection-keyed treatment rather than guessing.
    const state = {
      activeLevelIndices: [0],
      contextLevelIndices: [1],
      showContextLevels: false,
      levelPlanesM: [8],
    };
    expect(batchOpacity({ levelIndex: 0, role: "Walkable" }, state)).toBe(1);
    expect(batchOpacity({ levelIndex: 1, role: "Walkable" }, state)).toBe(
      CONTEXT_LEVEL_OPACITY,
    );
  });

  it("dissolves nothing for the camera on the active floor beyond its ceilings", () => {
    const state = {
      activeLevelIndices: [0],
      contextLevelIndices: [],
      showContextLevels: true,
      levelPlanesM: [0, 4],
    };
    // A wall between the camera and the selection stays solid: #32 dissolves
    // only protected-corridor occluders, and only on context floors.
    expect(batchOpacity({ levelIndex: 0, role: "Structure" }, state)).toBe(1);
    expect(batchOpacity({ levelIndex: 0, role: "Context" }, state)).toBe(1);
  });

  it("shows other floors as quiet context when asked", () => {
    const state = {
      activeLevelIndices: [0],
      contextLevelIndices: [],
      showContextLevels: true,
      levelPlanesM: [0, 4],
    };
    expect(batchOpacity({ levelIndex: 1, role: "Walkable" }, state)).toBe(CONTEXT_LEVEL_OPACITY);
    expect(batchOpacity({ levelIndex: 0, role: "Walkable" }, state)).toBe(1);
    expect(CONTEXT_LEVEL_OPACITY).toBeGreaterThan(0);
    expect(CONTEXT_LEVEL_OPACITY).toBeLessThan(0.5);
  });
});

describe("conveyance shells", () => {
  const state = {
    activeLevelIndices: [0],
    contextLevelIndices: [],
    showContextLevels: false,
    levelPlanesM: [0, 4],
  };

  it("renders conveyance shells see-through so the graph inside stays visible", () => {
    // A shell exists to say "a conveyance is here", not to hide the routing
    // graph it explains. Illustrated stairs / escalators / elevators are the
    // exception: they are station silhouettes, like a ticket-gate row.
    for (const role of CONVEYANCE_SHELL_ROLE_NAMES) {
      expect(batchOpacity({ levelIndex: 0, role }, state)).toBe(
        CONVEYANCE_SHELL_OPACITY,
      );
    }
    expect(batchOpacity({ levelIndex: 0, role: "Structure" }, state)).toBe(1);
    expect(CONVEYANCE_SHELL_OPACITY).toBeGreaterThan(0);
    expect(CONVEYANCE_SHELL_OPACITY).toBeLessThan(1);
  });

  it("paints illustrated stairs, escalators, and elevators opaque on the active floor", () => {
    for (const role of ILLUSTRATED_CONVEYANCE_ROLE_NAMES) {
      expect(
        batchOpacity({ levelIndex: 0, role, illustrated: true }, state),
      ).toBe(1);
    }
    expect(batchOpacity({ levelIndex: 0, role: "TicketGate" }, state)).toBe(1);
  });

  it("never draws a shell more opaque than the floor carrying it", () => {
    const pair = {
      activeLevelIndices: [0],
      contextLevelIndices: [1],
      showContextLevels: false,
      levelPlanesM: [8, 4],
    };
    expect(batchOpacity({ levelIndex: 0, role: "Ramp" }, pair)).toBe(
      Math.min(UPPER_FLOOR_OPACITY, CONVEYANCE_SHELL_OPACITY),
    );
    expect(batchOpacity({ levelIndex: 0, role: "Escalator" }, pair)).toBe(
      Math.min(UPPER_FLOOR_OPACITY, CONVEYANCE_SHELL_OPACITY),
    );
    expect(
      batchOpacity(
        { levelIndex: 0, role: "Escalator", illustrated: true },
        pair,
      ),
    ).toBe(UPPER_FLOOR_OPACITY);
    const handoff = {
      activeLevelIndices: [0],
      contextLevelIndices: [],
      showContextLevels: true,
      levelPlanesM: [0, 4],
    };
    expect(batchOpacity({ levelIndex: 1, role: "Conveyance" }, handoff)).toBe(
      Math.min(CONTEXT_LEVEL_OPACITY, CONVEYANCE_SHELL_OPACITY),
    );
    expect(batchOpacity({ levelIndex: 1, role: "Elevator" }, handoff)).toBe(
      Math.min(CONTEXT_LEVEL_OPACITY, CONVEYANCE_SHELL_OPACITY),
    );
    expect(
      batchOpacity(
        { levelIndex: 1, role: "Elevator", illustrated: true },
        handoff,
      ),
    ).toBe(CONTEXT_LEVEL_OPACITY);
  });

  it("tints each conveyance kind apart from neutral structure", () => {
    for (const role of CONVEYANCE_ROLE_NAMES) {
      expect(ROLE_COLORS[role]).not.toEqual(ROLE_COLORS.Structure);
    }
    const typed: SemanticRoleName[] = ["Elevator", "Escalator", "Stairs", "Ramp"];
    const seen = new Set(typed.map((role) => ROLE_COLORS[role].join(",")));
    expect(seen.size).toBe(typed.length);
    // An untyped conveyance must not borrow a kind it was never given.
    for (const role of typed) {
      expect(ROLE_COLORS.Conveyance).not.toEqual(ROLE_COLORS[role]);
    }
  });

  it("renders a portal as a threshold rather than a closed leaf", () => {
    // A portal is the evidence that you can pass through here (#32 section 9).
    // Drawn as an opaque slab it became the door leaf the source never stated,
    // and at a conveyance it hid the very graph the shell was opened up to show.
    expect(batchOpacity({ levelIndex: 0, role: "Opening" }, state)).toBe(
      OPENING_THRESHOLD_OPACITY,
    );
    expect(OPENING_THRESHOLD_OPACITY).toBeGreaterThan(0);
    expect(OPENING_THRESHOLD_OPACITY).toBeLessThan(1);
    const pair = {
      activeLevelIndices: [0],
      contextLevelIndices: [1],
      showContextLevels: false,
      levelPlanesM: [8, 4],
    };
    expect(batchOpacity({ levelIndex: 0, role: "Opening" }, pair)).toBe(
      Math.min(UPPER_FLOOR_OPACITY, OPENING_THRESHOLD_OPACITY),
    );
  });
});

describe("inter-floor connectors", () => {
  it("matches ordinary network edges visually and keeps a wide pick target", () => {
    // Same paint as indoor-network-path / indoor-network-path-selected /
    // indoor-network-path-hit: thin to look at, fat to click.
    expect(CONNECTOR_WIDTH_PX).toBe(1.5);
    expect(CONNECTOR_SELECTED_WIDTH_PX).toBe(3);
    expect(CONNECTOR_HIT_WIDTH_PX).toBe(12);
    expect(CONNECTOR_HIT_WIDTH_PX).toBeGreaterThan(CONNECTOR_WIDTH_PX);
  });

  it("borrows the network's own hue rather than inventing a second one", () => {
    // #d81b8c, the colour the 2D network overlay already draws paths in.
    expect(CONNECTOR_COLOR.map((channel) => Math.round(channel * 255))).toEqual([216, 27, 140]);
    for (const role of ALL_ROLES) {
      expect(CONNECTOR_COLOR).not.toEqual(ROLE_COLORS[role]);
    }
  });
});

describe("batchPickable", () => {
  it("keeps see-through active-floor geometry selectable", () => {
    // A shell and an upper-floor surface are translucent by policy, not gone:
    // the reviewer must still be able to click either one. Illustrated
    // conveyances on the upper floor of a pair stay pickable at that floor's
    // see-through opacity.
    const state = {
      activeLevelIndices: [0],
      contextLevelIndices: [1],
      showContextLevels: false,
      levelPlanesM: [8, 4],
    };
    expect(batchPickable({ levelIndex: 0, role: "Walkable" }, state)).toBe(true);
    expect(batchPickable({ levelIndex: 0, role: "Escalator" }, state)).toBe(true);
  });

  it("never lets hidden or context geometry intercept a click", () => {
    const state = {
      activeLevelIndices: [0],
      contextLevelIndices: [1],
      showContextLevels: false,
      levelPlanesM: [8, 4],
    };
    expect(batchPickable({ levelIndex: 0, role: "Ceiling" }, state)).toBe(false);
    expect(batchPickable({ levelIndex: 1, role: "Walkable" }, state)).toBe(false);
    expect(batchPickable({ levelIndex: 2, role: "Walkable" }, state)).toBe(false);
  });
});

describe("planSceneDraw", () => {
  it("draws solid geometry before anything see-through", () => {
    const state = {
      activeLevelIndices: [0],
      contextLevelIndices: [1],
      showContextLevels: false,
      levelPlanesM: [8, 4],
    };
    const plan = planSceneDraw(
      [
        { levelIndex: 0, role: "Walkable" as const },
        { levelIndex: 1, role: "Walkable" as const },
        { levelIndex: 0, role: "Ramp" as const },
        { levelIndex: 1, role: "Stairs" as const, illustrated: true },
      ],
      state,
    );
    expect(plan.opaque.map((entry) => entry.batch.role)).toEqual(["Walkable", "Stairs"]);
    expect(plan.translucent.map((entry) => entry.batch.role)).toEqual([
      "Walkable",
      "Ramp",
    ]);
  });

  it("orders see-through geometry bottom-up so blending reaches the floor below", () => {
    // The camera never goes below the model, so ascending elevation is
    // back-to-front. Drawing it the other way loses the lower floor.
    const state = {
      activeLevelIndices: [0, 1, 2],
      contextLevelIndices: [3],
      showContextLevels: false,
      levelPlanesM: [12, 8, 4, 0],
    };
    const plan = planSceneDraw(
      [
        { levelIndex: 0, role: "Walkable" as const },
        { levelIndex: 2, role: "Walkable" as const },
        { levelIndex: 1, role: "Walkable" as const },
      ],
      state,
    );
    expect(plan.translucent.map((entry) => entry.batch.levelIndex)).toEqual([2, 1, 0]);
  });

  it("drops hidden batches instead of drawing them at zero", () => {
    const state = {
      activeLevelIndices: [0],
      contextLevelIndices: [],
      showContextLevels: false,
      levelPlanesM: [0, 4],
    };
    const plan = planSceneDraw(
      [
        { levelIndex: 1, role: "Walkable" as const },
        { levelIndex: 0, role: "Ceiling" as const },
        { levelIndex: 0, role: "Structure" as const },
      ],
      state,
    );
    expect(plan.opaque).toHaveLength(1);
    expect(plan.translucent).toHaveLength(0);
    expect(plan.opaque[0]?.batch.role).toBe("Structure");
    expect(plan.opaque[0]?.opacity).toBe(1);
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

  it("locks stairs fill bytes to the producer's mixed-batch backfill", () => {
    // kiriko-scene `role_fill_rgb(Stairs)` copies this so a unit surface that
    // shares a batch with an illustrated run stays the stairs colour, not
    // ticket-gate stainless.
    expect(ROLE_COLORS.Stairs.map((channel) => Math.round(channel * 255))).toEqual(
      [197, 205, 222],
    );
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
