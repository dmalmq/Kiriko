import { describe, expect, it } from "vitest";
import { capabilityNotice, evaluateCapability, type CapabilityFacts } from "./sceneCapability";

/** Every requirement met — the only shape that offers 3D. */
const COMPLETE: CapabilityFacts = {
  webgl2: true,
  drawBuffers: 8,
  multiTargetProgramLinks: true,
  colorBufferFloat: true,
  floatTargetComplete: true,
};

describe("evaluateCapability", () => {
  it("offers 3D only when every requirement holds", () => {
    const report = evaluateCapability(COMPLETE);
    expect(report.supported).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it("has no partial tier: one missing requirement means 2D", () => {
    const partials: [keyof CapabilityFacts, CapabilityFacts][] = [
      ["webgl2", { ...COMPLETE, webgl2: false }],
      ["drawBuffers", { ...COMPLETE, drawBuffers: 1 }],
      ["multiTargetProgramLinks", { ...COMPLETE, multiTargetProgramLinks: false }],
      ["colorBufferFloat", { ...COMPLETE, colorBufferFloat: false }],
      ["floatTargetComplete", { ...COMPLETE, floatTargetComplete: false }],
    ];
    for (const [label, facts] of partials) {
      const report = evaluateCapability(facts);
      expect(report.supported, `${label} missing must not offer 3D`).toBe(false);
      expect(report.missing.length).toBeGreaterThan(0);
    }
  });

  it("names the missing requirements in a stable order", () => {
    const report = evaluateCapability({
      webgl2: true,
      drawBuffers: 1,
      multiTargetProgramLinks: false,
      colorBufferFloat: false,
      floatTargetComplete: false,
    });
    expect(report.missing).toEqual(["multiple_render_targets", "color_buffer_float"]);
  });

  it("reports only WebGL2 when there is no context at all", () => {
    // Nothing else is knowable without a context, and listing derived failures
    // would misdescribe the device.
    const report = evaluateCapability({
      webgl2: false,
      drawBuffers: 0,
      multiTargetProgramLinks: false,
      colorBufferFloat: false,
      floatTargetComplete: false,
    });
    expect(report.missing).toEqual(["webgl2"]);
  });

  it("treats a float extension that yields an incomplete target as missing", () => {
    // The extension being advertised is not the same as an RGBA32F attachment
    // working: the pick path needs the attachment, so that is what is checked.
    const report = evaluateCapability({ ...COMPLETE, floatTargetComplete: false });
    expect(report.supported).toBe(false);
    expect(report.missing).toEqual(["color_buffer_float"]);
  });
});

describe("capabilityNotice", () => {
  it("explains the outcome in both languages without naming an extension", () => {
    const notice = capabilityNotice(["multiple_render_targets"]);
    expect(notice.ja).not.toBe("");
    expect(notice.en).not.toBe("");
    // A reviewer is told what they get, not which GL extension is absent.
    expect(notice.en.toLowerCase()).not.toContain("webgl");
    expect(notice.en.toLowerCase()).not.toContain("ext_");
    expect(notice.ja).not.toContain("WebGL");
  });

  it("says the same thing for every unmet requirement: 2D, with everything working", () => {
    const first = capabilityNotice(["webgl2"]);
    const second = capabilityNotice(["color_buffer_float"]);
    expect(second).toEqual(first);
  });
});
