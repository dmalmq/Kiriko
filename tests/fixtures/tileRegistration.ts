/**
 * Shared registration fixtures (#74): the minimal IMDF fixture's own geometry,
 * projected independently of the compiler, and a tile package authored to sit
 * on it.
 *
 * The projection is deliberately re-derived here. A fixture that reads its
 * expected coordinates out of the code under test proves only that the code
 * agrees with itself, and the whole point of these suites is that a tile
 * package lands where the venue actually is.
 */
import { glbWithFeatures, type TileFeatureSpec } from "./tileFixtures";

export const CORRIDOR = [
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
export function rootTransform(): number[] {
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


/**
 * A GLB whose single walkable floor covers the fixture's B1 corridor, inset by
 * `inset` metres on every side, at `planeM`.
 */
export function corridorPackageGlb(inset = 0, planeM = 0): Uint8Array {
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
