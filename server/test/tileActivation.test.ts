/**
 * Tile registration and activation gating through the real native bridge (#74).
 *
 * The tile geometry here is authored against the minimal IMDF fixture's own
 * units, projected independently in this file rather than read back out of the
 * compiler: a fixture that derives its expected coordinates from the code under
 * test proves only that the code agrees with itself.
 *
 * Coordinates travel the real chain — glTF Y-up, the tileset root transform
 * (an ENU-to-ECEF matrix, applied unchanged as #31 decided), and back into the
 * venue's own §8 frame — so a broken step in it fails these tests.
 */
import { compileImdf, sceneProjection } from "@kiriko/node";
import { describe, expect, it } from "vitest";
import { buildMinimalImdfZip } from "../../tests/fixtures/buildMinimalImdfZip";
import {
  CoreTileActivationError,
  evaluateTileActivation,
  type TileActivationRequest,
} from "../src/core/native";
import { glbWithFeatures, type TileFeatureSpec } from "./tileFixtures";

/** The minimal fixture's B1 level and its corridor unit. */
const LEVEL_B1 = "b1000001-0000-4000-8000-0000000000b1";
const CORRIDOR = [
  [139.7662, 35.6806],
  [139.7678, 35.6806],
  [139.7678, 35.6814],
  [139.7662, 35.6814],
] as const;
/** The fixture venue's bounds centre — the §8 frame anchor. */
const ANCHOR: [number, number] = [139.767, 35.681];

const WGS84_A = 6378137.0;
const WGS84_INVERSE_FLATTENING = 298.257223563;

type Vec3 = [number, number, number];

/** WGS84 geodetic to ECEF metres, at ellipsoidal height 0. */
function ecef(lonDeg: number, latDeg: number): Vec3 {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const e2 = 2 / WGS84_INVERSE_FLATTENING - 1 / WGS84_INVERSE_FLATTENING ** 2;
  const n = WGS84_A / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [
    n * Math.cos(lat) * Math.cos(lon),
    n * Math.cos(lat) * Math.sin(lon),
    n * (1 - e2) * Math.sin(lat),
  ];
}

/** The ENU basis at the anchor, as ECEF unit vectors: east, north, up. */
function enuBasis(lonDeg: number, latDeg: number): [Vec3, Vec3, Vec3] {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  return [
    [-Math.sin(lon), Math.cos(lon), 0],
    [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)],
    [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)],
  ];
}

/** A lon/lat position in venue-local ENU metres. */
function toLocal(lon: number, lat: number): [number, number] {
  const origin = ecef(...ANCHOR);
  const point = ecef(lon, lat);
  const delta: Vec3 = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
  const [east, north] = enuBasis(...ANCHOR);
  return [
    east[0] * delta[0] + east[1] * delta[1] + east[2] * delta[2],
    north[0] * delta[0] + north[1] * delta[1] + north[2] * delta[2],
  ];
}

/**
 * The tileset root transform a real export carries: ENU at the tileset origin
 * to ECEF, column-major. Using the venue's own anchor is what a producer's
 * export of this venue would produce.
 */
function rootTransform(): number[] {
  const [east, north, up] = enuBasis(...ANCHOR);
  const origin = ecef(...ANCHOR);
  return [...east, 0, ...north, 0, ...up, 0, ...origin, 1];
}

/**
 * A floor quad in glTF Y-up tile coordinates covering the venue-local
 * rectangle `ring`, at height `planeM`. Y-up to Z-up maps (x, y, z) to
 * (x, −z, y), so a venue-local (east, north) is authored as (east, plane,
 * −north).
 */
function floorTriangles(
  ring: readonly (readonly [number, number])[],
  planeM: number,
  inset = 0,
): [number, number, number][][] {
  const east = ring.map(([lon, lat]) => toLocal(lon, lat)[0]);
  const north = ring.map(([lon, lat]) => toLocal(lon, lat)[1]);
  const west = Math.min(...east) + inset;
  const easting = Math.max(...east) - inset;
  const south = Math.min(...north) + inset;
  const northing = Math.max(...north) - inset;
  const corner = (e: number, n: number): [number, number, number] => [e, planeM, -n];
  return [
    [corner(west, south), corner(easting, south), corner(easting, northing)],
    [corner(west, south), corner(easting, northing), corner(west, northing)],
  ];
}

async function fixtureBundle(): Promise<Buffer> {
  const source = Buffer.from(await buildMinimalImdfZip());
  const response = await compileImdf(source, "test/minimal", 1);
  if (response.ok !== true || response.bundle === undefined) {
    throw new Error(`fixture compile failed: ${String(response.errorJson)}`);
  }
  return response.bundle;
}

/**
 * B1's own floor plane in the frame tile heights arrive in: the §8 record's
 * scene Z with the frame's normalisation offset removed. Read from the bundle
 * rather than assumed, so this suite stays about registration and not about
 * whatever spacing floor-plane resolution happens to assume.
 */
async function venuePlaneM(bundle: Buffer, levelId: string): Promise<number> {
  const response = await sceneProjection(bundle);
  if (response.ok !== true || response.projectionJson === undefined) {
    throw new Error("the fixture bundle has no scene projection");
  }
  const projection = JSON.parse(response.projectionJson) as {
    frame: { verticalNormalisationOffsetMm: number };
    levels: { levelId: string; resolvedSceneZMm: number }[];
  };
  const level = projection.levels.find((entry) => entry.levelId === levelId);
  if (level === undefined) {
    throw new Error(`the fixture has no level ${levelId}`);
  }
  return (level.resolvedSceneZMm - projection.frame.verticalNormalisationOffsetMm) / 1000;
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

function corridorPackage(inset = 0, planeM = 0): Uint8Array {
  const feature: TileFeatureSpec = {
    revitUniqueId: "floor-b1",
    category: "Floors",
    levelKey: "b1fl",
    levelName: "B1",
    levelElevationMeters: planeM,
    sourceDocument: "station.rvt",
    sourceLinkName: "",
    triangles: floorTriangles(CORRIDOR, planeM, inset),
  };
  return glbWithFeatures([feature]);
}

describe("tile activation evaluation", () => {
  it("passes every gate for a package aligned to the venue's own geometry", async () => {
    const bundle = await fixtureBundle();
    const plane = await venuePlaneM(bundle, LEVEL_B1);

    const evaluation = await evaluateTileActivation(
      bundle,
      [Buffer.from(corridorPackage(0, plane))],
      request(),
    );

    expect(evaluation.gates).toEqual([]);
    expect(evaluation.floorMappings).toEqual([
      [LEVEL_B1, [`asset-v1|station.rvt||b1fl|${Math.round(plane * 10)}`]],
    ]);
    expect(evaluation.report.floors[0]?.canonicalLevelId).toBe(LEVEL_B1);
    expect(evaluation.report.floors[0]?.stats.p90M).toBeLessThan(0.01);
    expect(evaluation.report.levels[0]?.resolvedPlaneM).toBeCloseTo(plane, 3);
  });

  it("blocks a package whose floor is inset from the venue outline", async () => {
    const bundle = await fixtureBundle();
    const plane = await venuePlaneM(bundle, LEVEL_B1);

    const evaluation = await evaluateTileActivation(
      bundle,
      [Buffer.from(corridorPackage(0.8, plane))],
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
      [Buffer.from(corridorPackage(0, 40))],
      request(),
    );

    expect(evaluation.gates.map((gate) => gate.code)).toEqual(["levelNotMapped"]);
    expect(evaluation.report.unmappedLevels).toEqual(["asset-v1|station.rvt||b1fl|400"]);
  });

  it("holds a floor to its own band when the profile carries one", async () => {
    const bundle = await fixtureBundle();
    const plane = await venuePlaneM(bundle, LEVEL_B1);

    const evaluation = await evaluateTileActivation(
      bundle,
      [Buffer.from(corridorPackage(0.8, plane))],
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
      evaluateTileActivation(Buffer.from("not a bundle"), [Buffer.from(corridorPackage())], request()),
    ).rejects.toBeInstanceOf(CoreTileActivationError);
  });

  it("treats a malformed native response as a bridge error", async () => {
    const bundle = await fixtureBundle();

    await expect(
      evaluateTileActivation(bundle, [Buffer.from(corridorPackage())], request(), async () => ({
        ok: true,
        evaluationJson: "{}",
      })),
    ).rejects.toMatchObject({ code: "bridge_error" });
  });
});
