import { describe, expect, it } from "vitest";
import { TILE_GATE_CODES, tileGateMessage } from "./tileGates";

/**
 * Every gate `kiriko-scene` can block an activation on. A literal list, so a
 * new gate without producer copy fails here rather than shipping a refusal a
 * producer cannot read.
 */
const GATE_CODES = [
  "integrityUnresolved",
  "capabilityProfileMissing",
  "registrationOutOfBand",
  "coherentShiftOutOfBand",
  "coherentResidual",
  "levelPlaneUnresolved",
  "levelNotMapped",
  "unclassifiedOpaqueContent",
] as const;

describe("tileGateMessage", () => {
  it("answers for every gate, in both languages", () => {
    for (const code of GATE_CODES) {
      expect(TILE_GATE_CODES, `${code} has copy`).toContain(code);
      for (const locale of ["ja", "en"] as const) {
        const message = tileGateMessage({ code, subject: "x", measured: null, band: null }, locale);
        expect(message.length, `${code} ${locale}`).toBeGreaterThan(0);
        // A producer is told what is wrong with their export, not which gate
        // identifier fired.
        expect(message).not.toContain(code);
      }
    }
  });

  it("quotes the measurement against its band so the gap is legible", () => {
    const message = tileGateMessage(
      { code: "registrationOutOfBand", subject: "level-1", measured: 0.626, band: 0.5 },
      "en",
    );
    expect(message).toContain("0.63");
    expect(message).toContain("0.50");
    expect(message).toContain("level-1");
  });

  it("names the subject even when the gate carries no measurement", () => {
    for (const locale of ["ja", "en"] as const) {
      const message = tileGateMessage(
        { code: "levelNotMapped", subject: "asset-v1|station.rvt||b1fl|-40", measured: null, band: null },
        locale,
      );
      expect(message).toContain("asset-v1|station.rvt||b1fl|-40");
    }
  });

  it("falls back rather than rendering an empty message for an unknown gate", () => {
    for (const locale of ["ja", "en"] as const) {
      const message = tileGateMessage(
        { code: "something_new", subject: "x", measured: null, band: null },
        locale,
      );
      expect(message.length).toBeGreaterThan(0);
    }
  });
});
