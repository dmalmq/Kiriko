/**
 * Tile registration and activation gating through the real native bridge (#74).
 *
 * The tile geometry here is authored against the minimal IMDF fixture's own
 * units, projected independently of the compiler (see
 * `tileRegistrationFixtures`): a fixture that derives its expected coordinates
 * from the code under test proves only that the code agrees with itself.
 *
 * Coordinates travel the real chain — glTF Y-up, the tileset root transform
 * (an ENU-to-ECEF matrix, applied unchanged as #31 decided), and back into the
 * venue's own §8 frame — so a broken step in it fails these tests.
 */
import { compileImdf } from "@kiriko/node";
import { describe, expect, it } from "vitest";
import { buildMinimalImdfZip } from "../../tests/fixtures/buildMinimalImdfZip";
import {
  CoreTileActivationError,
  evaluateTileActivation,
  type TileActivationRequest,
} from "../src/core/native";
import { corridorPackageGlb, rootTransform } from "../../tests/fixtures/tileRegistration";
import { venuePlaneFromBundle } from "./tileRegistrationFixtures";

const LEVEL_B1 = "b1000001-0000-4000-8000-0000000000b1";

async function fixtureBundle(): Promise<Buffer> {
  const source = Buffer.from(await buildMinimalImdfZip());
  const response = await compileImdf(source, "test/minimal", 1);
  if (response.ok !== true || response.bundle === undefined) {
    throw new Error(`fixture compile failed: ${String(response.errorJson)}`);
  }
  return response.bundle;
}

function request(overrides: Partial<TileActivationRequest> = {}): TileActivationRequest {
  return {
    assetVersion: "asset-v1",
    rootTransform: rootTransform(),
    integrityVerified: true,
    capabilityProfile: "webgl2-mrt-float",
    contextualSourceObjects: [],
    ...overrides,
  };
}

describe("tile activation evaluation", () => {
  it("passes every gate for a package aligned to the venue's own geometry", async () => {
    const bundle = await fixtureBundle();
    const plane = await venuePlaneFromBundle(bundle, LEVEL_B1);

    const evaluation = await evaluateTileActivation(
      bundle,
      [Buffer.from(corridorPackageGlb(0, plane))],
      request(),
    );

    expect(evaluation.gates).toEqual([]);
    expect(evaluation.floorMappings).toEqual([
      [LEVEL_B1, [`asset-v1|station.rvt||b1fl|${Math.round(plane * 10)}`]],
    ]);
    expect(evaluation.report.floors[0]?.canonicalLevelId).toBe(LEVEL_B1);
    // A mapped, sampled floor has residuals; absence would be a different bug.
    expect(evaluation.report.floors[0]?.stats?.p90M).toBeLessThan(0.01);
    expect(evaluation.report.levels[0]?.resolvedPlaneM).toBeCloseTo(plane, 3);
  });

  it("blocks a package whose floor is inset from the venue outline", async () => {
    const bundle = await fixtureBundle();
    const plane = await venuePlaneFromBundle(bundle, LEVEL_B1);

    const evaluation = await evaluateTileActivation(
      bundle,
      [Buffer.from(corridorPackageGlb(0.8, plane))],
      request(),
    );

    expect(evaluation.gates.map((gate) => gate.code)).toEqual(["registrationOutOfBand"]);
    expect(evaluation.gates[0]?.subject).toBe(LEVEL_B1);
    expect(evaluation.gates[0]?.measured).toBeCloseTo(0.8, 2);
    expect(evaluation.gates[0]?.band).toBe(0.5);
  });

  it("reports a level the venue has no floor for rather than snapping it", async () => {
    const bundle = await fixtureBundle();

    const evaluation = await evaluateTileActivation(
      bundle,
      [Buffer.from(corridorPackageGlb(0, 40))],
      request(),
    );

    expect(evaluation.gates.map((gate) => gate.code)).toEqual(["levelNotMapped"]);
    expect(evaluation.report.unmappedLevels).toEqual(["asset-v1|station.rvt||b1fl|400"]);
  });

  it("holds a floor to its own band when the profile carries one", async () => {
    const bundle = await fixtureBundle();
    const plane = await venuePlaneFromBundle(bundle, LEVEL_B1);

    const evaluation = await evaluateTileActivation(
      bundle,
      [Buffer.from(corridorPackageGlb(0.8, plane))],
      request({ profile: { floorP90MaxM: { [LEVEL_B1]: 0.9 } } }),
    );

    expect(evaluation.gates).toEqual([]);
    expect(evaluation.report.profileId).toBe("default");
  });

  it("refuses content it cannot decode, by name", async () => {
    const bundle = await fixtureBundle();

    await expect(
      evaluateTileActivation(bundle, [Buffer.from("not a glb")], request()),
    ).rejects.toMatchObject({ code: "undecodable_content" });
  });

  it("refuses a bundle it cannot decode, by name", async () => {
    await expect(
      evaluateTileActivation(Buffer.from("not a bundle"), [Buffer.from(corridorPackageGlb())], request()),
    ).rejects.toBeInstanceOf(CoreTileActivationError);
  });

  it("treats a malformed native response as a bridge error", async () => {
    const bundle = await fixtureBundle();

    await expect(
      evaluateTileActivation(bundle, [Buffer.from(corridorPackageGlb())], request(), async () => ({
        ok: true,
        evaluationJson: "{}",
      })),
    ).rejects.toMatchObject({ code: "bridge_error" });
  });
});
