/**
 * The rendered palette against the accessibility floors this design commits to
 * (#26 section 5, #32).
 *
 * These are computed, not eyeballed. The prototype that preceded production
 * shipped a review amber at 3.19:1 and only measurement caught it; the same
 * mistake in the scene palette would be just as invisible.
 */
import { describe, expect, it } from "vitest";
import { conveyanceIcon } from "./useSceneLabels";
import { ROLE_COLORS } from "./scenePolicy";
import type { SemanticRoleName } from "./sceneFormat";

/** WCAG relative luminance for an sRGB triple in 0..1. */
function luminance(rgb: readonly [number, number, number]): number {
  const channel = (value: number): number =>
    value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

function hex(value: string): [number, number, number] {
  const int = Number.parseInt(value.replace("#", ""), 16);
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

/** Product tokens the labels and interaction states are drawn with. */
const TEXT = hex("#1c1917");
const PANEL = hex("#ffffff");
const AI_INDIGO = hex("#4f46e5");
const REVIEW_AMBER = hex("#b45309");

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

describe("scene palette contrast", () => {
  it("carries label text at AA over its own plate", () => {
    // Labels are drawn on the panel surface, not directly on scene geometry —
    // that is what the halo is for — so this is the contrast a reviewer reads.
    expect(contrast(TEXT, PANEL)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps every scene surface light enough for label text to sit on it", () => {
    // The halo does the heavy lifting, but a surface dark enough to swallow a
    // 1 px halo would still fail: 3:1 against the label plate is the floor.
    for (const role of ALL_ROLES) {
      expect(contrast(TEXT, ROLE_COLORS[role]), `text over ${role}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("carries the selection as a discrete indicator that meets 1.4.11", () => {
    // A 22% tint over a surface can never reach 3:1 against that surface, and
    // pretending otherwise is how a design ends up claiming a floor it misses.
    // So selection is not carried by the tint alone: the selected object always
    // has a label, and that label is a solid Ai Indigo pill on the panel
    // surface. These are the contrasts a reviewer actually resolves.
    expect(contrast(PANEL, AI_INDIGO)).toBeGreaterThanOrEqual(3);
    expect(contrast(hex("#ffffff"), AI_INDIGO)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the scene tint perceptible on every surface it can cover", () => {
    // The tint is the supporting cue. It has to be visible — a selection that
    // changes nothing on the geometry is a lie — but its job is reinforcement,
    // not identification.
    for (const role of ALL_ROLES) {
      const base = ROLE_COLORS[role];
      const tinted: [number, number, number] = [
        base[0] + (AI_INDIGO[0] - base[0]) * 0.22,
        base[1] + (AI_INDIGO[1] - base[1]) * 0.22,
        base[2] + (AI_INDIGO[2] - base[2]) * 0.22,
      ];
      const delta = Math.abs(luminance(base) - luminance(tinted));
      expect(delta, `tint over ${role}`).toBeGreaterThan(0.02);
    }
  });

  it("keeps review amber out of the scene palette", () => {
    // Amber is Review semantics and never a route, handoff, or surface colour
    // (#32). This asserts the palette has not quietly borrowed it.
    for (const role of ALL_ROLES) {
      expect(contrast(REVIEW_AMBER, ROLE_COLORS[role])).toBeGreaterThan(1.5);
      const [r, g, b] = ROLE_COLORS[role];
      const amberish = r > 0.6 && g > 0.35 && g < 0.75 && b < 0.35;
      expect(amberish, `${role} must not be amber`).toBe(false);
    }
  });

  it("keeps the navigable surface the lightest thing a route can sit on", () => {
    for (const role of ALL_ROLES) {
      if (role !== "Walkable") {
        expect(luminance(ROLE_COLORS.Walkable)).toBeGreaterThanOrEqual(
          luminance(ROLE_COLORS[role]),
        );
      }
    }
  });
});

describe("conveyance pictograms", () => {
  it("uses the JIS set where it has a pictogram", () => {
    for (const category of ["elevator", "escalator", "stairs", "steps"]) {
      const icon = conveyanceIcon(category);
      expect(icon.startsWith("<svg"), category).toBe(true);
      // The traced JIS files carry figures in currentColor and knockouts in
      // --marker-bg; the neutral form is stroked instead.
      expect(icon).toContain("currentColor");
    }
  });

  it("gives a ramp the neutral inclined plane with one slope chevron", () => {
    // The JIS set has no ramp pictogram, and borrowing one that means something
    // else would be worse than the neutral form (#32).
    const ramp = conveyanceIcon("ramp");
    expect(ramp).toContain("<svg");
    expect(ramp).toContain("stroke=\"currentColor\"");
    // Three strokes: ground line, incline, and exactly one chevron.
    expect(ramp.match(/<path /g)).toHaveLength(3);
    // Static: nothing about a conveyance animates (#32's motion rules).
    expect(ramp).not.toContain("animate");
  });

  it("gives a moving walkway the same neutral form rather than nothing", () => {
    expect(conveyanceIcon("movingwalkway")).toBe(conveyanceIcon("ramp"));
  });
});
