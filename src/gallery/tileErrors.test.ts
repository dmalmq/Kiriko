import { describe, expect, it } from "vitest";
import { TILE_ERROR_CODES, tileErrorMessage } from "./tileErrors";

/**
 * Every refusal the Rust validator can emit. Kept as a literal list so adding a
 * refusal without producer copy fails here rather than shipping a code a
 * producer cannot read.
 */
const VALIDATOR_CODES = [
  "missingRootTileset",
  "malformedTileset",
  "unsupportedAssetVersion",
  "unsupportedExtension",
  "unsupportedFeature",
  "pathTraversal",
  "absolutePath",
  "externalReference",
  "unresolvedMember",
  "unsupportedContentFormat",
  "undecodableContent",
  "tilesetCycle",
  "tilesetTooDeep",
  "sizeMismatch",
  "memberTooLarge",
  "tooManyMembers",
  "packageTooLarge",
  "unreadableArchive",
] as const;

/**
 * Codes the tile routes themselves return, as opposed to the validator's. A
 * producer reads these in the same place, so they need the same copy.
 */
const ROUTE_CODES = [
  "package_not_found",
  "package_in_use",
  "no_published_version",
  "not_evaluated",
  "activation_blocked",
  "evaluation_stale",
  "no_spatial_context",
  "undecodable_content",
  "malformed_request",
] as const;

describe("tileErrorMessage", () => {
  it("answers for every refusal the validator can emit, in both languages", () => {
    for (const code of VALIDATOR_CODES) {
      expect(TILE_ERROR_CODES, `${code} has copy`).toContain(code);
      for (const locale of ["ja", "en"] as const) {
        const message = tileErrorMessage({ code, message: code }, locale);
        expect(message.length, `${code} ${locale}`).toBeGreaterThan(0);
        // The producer is told what to look at, not which internal stage failed.
        expect(message).not.toContain(code);
      }
    }
  });

  it("answers for every refusal the tile routes return, in both languages", () => {
    for (const code of ROUTE_CODES) {
      expect(TILE_ERROR_CODES, `${code} has copy`).toContain(code);
      for (const locale of ["ja", "en"] as const) {
        const message = tileErrorMessage({ code, message: code }, locale);
        expect(message.length, `${code} ${locale}`).toBeGreaterThan(0);
        expect(message).not.toContain(code);
      }
    }
  });

  it("names the offending path when the refusal carried one", () => {
    const message = tileErrorMessage(
      { code: "externalReference", message: "x", details: { uri: "https://example.com/a.glb" } },
      "en",
    );
    expect(message).toContain("https://example.com/a.glb");
  });

  it("falls back rather than rendering an empty message for an unknown code", () => {
    for (const locale of ["ja", "en"] as const) {
      expect(tileErrorMessage({ code: "something_new", message: "x" }, locale).length).toBeGreaterThan(
        0,
      );
    }
  });
});
