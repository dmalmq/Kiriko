/**
 * Placement math for the scene layer: venue-local metres to the mercator
 * space MapLibre's projection consumes.
 *
 * Precision is the whole point of this module. A venue's geometry is metric
 * and local, but its frame origin is an ECEF position seven digits long, so
 * anything that mixes the two in `f32` loses centimetres and z-fights. Every
 * value here is composed in `f64` and only downcast where it is handed to the
 * GPU as a matrix whose translation is already camera-relative (#23 D3, spike
 * gate 5).
 *
 * Nothing here touches WebGL, so it is unit-tested without a GPU.
 */
import { MercatorCoordinate } from "maplibre-gl";

const WGS84_SEMI_MAJOR = 6378137.0;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);

export interface Geodetic {
  lonRad: number;
  latRad: number;
  altitude: number;
}

/** Column-major 4x4 multiply, `a · b`, in `f64`. */
export function mat4Multiply(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] =
        a[row]! * b[column * 4]! +
        a[4 + row]! * b[column * 4 + 1]! +
        a[8 + row]! * b[column * 4 + 2]! +
        a[12 + row]! * b[column * 4 + 3]!;
    }
  }
  return out;
}

/** Column-major 4x4 inverse via the adjugate, in `f64`. */
export function mat4Inverse(m: Float64Array): Float64Array {
  const out = new Float64Array(16);
  const a00 = m[0]!;
  const a01 = m[1]!;
  const a02 = m[2]!;
  const a03 = m[3]!;
  const a10 = m[4]!;
  const a11 = m[5]!;
  const a12 = m[6]!;
  const a13 = m[7]!;
  const a20 = m[8]!;
  const a21 = m[9]!;
  const a22 = m[10]!;
  const a23 = m[11]!;
  const a30 = m[12]!;
  const a31 = m[13]!;
  const a32 = m[14]!;
  const a33 = m[15]!;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-30) {
    throw new Error("scene: singular matrix");
  }
  const invDet = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * invDet;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * invDet;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * invDet;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * invDet;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * invDet;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * invDet;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * invDet;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * invDet;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * invDet;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * invDet;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * invDet;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * invDet;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * invDet;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * invDet;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * invDet;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * invDet;
  return out;
}

/**
 * ECEF to WGS84 geodetic, iterated to convergence. The scene frame arrives as
 * an ECEF origin (both sources state one), and MapLibre needs a longitude and
 * latitude to anchor mercator, so this inverse is the bridge. Ten passes is
 * far past convergence at terrestrial altitudes.
 */
export function ecefToGeodetic(ecef: readonly [number, number, number]): Geodetic {
  const [x, y, z] = ecef;
  const p = Math.hypot(x, y);
  const lonRad = Math.atan2(y, x);
  let latRad = Math.atan2(z, p * (1 - WGS84_E2));
  let altitude = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    const sinLat = Math.sin(latRad);
    const n = WGS84_SEMI_MAJOR / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    altitude = p / Math.cos(latRad) - n;
    latRad = Math.atan2(z, p * (1 - WGS84_E2 * (n / (n + altitude))));
  }
  return { lonRad, latRad, altitude };
}

/**
 * ECEF to ENU rotation as a column-major 4x4 (rows east, north, up; zero
 * translation), evaluated at one geodetic position.
 */
export function enuRotationMatrix(latRad: number, lonRad: number): Float64Array {
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);
  return new Float64Array([
    -sinLon,
    -sinLat * cosLon,
    cosLat * cosLon,
    0,
    cosLon,
    -sinLat * sinLon,
    cosLat * sinLon,
    0,
    0,
    cosLat,
    sinLat,
    0,
    0,
    0,
    0,
    1,
  ]);
}

/**
 * The scene's mercator anchor and the per-axis scale that turns venue-local
 * metres into mercator units.
 *
 * The scale is derived from the WGS84 radii of curvature at the anchor, not
 * from MapLibre's `meterInMercatorCoordinateUnits`. That helper assumes a
 * mean-radius sphere, while the venue's local frame is a true ellipsoidal ENU
 * frame (the compiler projects each feature through WGS84 ECEF), so the
 * spherical scale stretches the scene by 0.23% — measured 2.26 m of drift
 * against the 2D features one kilometre from the anchor. Splitting east and
 * north keeps the remaining error second-order: exact in east, ~14 mm half a
 * kilometre north, and the anchor is the venue's own bounds centre.
 */
export function sceneAnchor(frameOriginEcef: readonly [number, number, number]): {
  geodetic: Geodetic;
  mercatorOrigin: MercatorCoordinate;
  /** Mercator units per local metre: east, north, up. */
  metreScale: readonly [number, number, number];
} {
  const geodetic = ecefToGeodetic(frameOriginEcef);
  const mercatorOrigin = MercatorCoordinate.fromLngLat(
    { lng: (geodetic.lonRad * 180) / Math.PI, lat: (geodetic.latRad * 180) / Math.PI },
    geodetic.altitude,
  );
  const sinLat = Math.sin(geodetic.latRad);
  const cosLat = Math.cos(geodetic.latRad);
  const primeVertical = WGS84_SEMI_MAJOR / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const meridional =
    (WGS84_SEMI_MAJOR * (1 - WGS84_E2)) / Math.pow(1 - WGS84_E2 * sinLat * sinLat, 1.5);
  const east = 1 / (2 * Math.PI * primeVertical * cosLat);
  const north = 1 / (2 * Math.PI * meridional * cosLat);
  // Up follows the east scale so a metre of height reads as a metre of
  // easting on screen; the 0.2% difference from MapLibre's own altitude
  // convention is a centimetre at indoor heights.
  return { geodetic, mercatorOrigin, metreScale: [east, north, east] };
}

/**
 * The scene's constant model matrix: venue-local metres to mercator units.
 *
 * Composed once per scene, in `f64`:
 *   1. the frame origin's geodetic position and its ECEF→ENU rotation;
 *   2. the source's own world transform folded in, with the frame origin
 *      subtracted so the result is relative to the anchor rather than to the
 *      centre of the earth — this subtraction is what keeps `f32` viable
 *      downstream;
 *   3. the per-axis mercator scale, with Y negated because mercator Y grows
 *      southward while ENU north grows northward;
 *   4. translation to the anchor's mercator position.
 */
export function composeModelMatrix(
  frameOriginEcef: readonly [number, number, number],
  worldTransform: readonly number[],
  geodetic: Geodetic,
  mercatorOrigin: MercatorCoordinate,
  metreScale: readonly [number, number, number],
): Float64Array {
  const rotation = enuRotationMatrix(geodetic.latRad, geodetic.lonRad);
  const toEnu = mat4Multiply(rotation, Float64Array.from(worldTransform));
  const [ox, oy, oz] = frameOriginEcef;
  toEnu[12] = toEnu[12]! - (rotation[0]! * ox + rotation[4]! * oy + rotation[8]! * oz);
  toEnu[13] = toEnu[13]! - (rotation[1]! * ox + rotation[5]! * oy + rotation[9]! * oz);
  toEnu[14] = toEnu[14]! - (rotation[2]! * ox + rotation[6]! * oy + rotation[10]! * oz);

  const model = new Float64Array(16);
  for (let row = 0; row < 3; row += 1) {
    const rowScale = row === 1 ? -metreScale[1]! : metreScale[row]!;
    model[row] = toEnu[row]! * rowScale;
    model[4 + row] = toEnu[4 + row]! * rowScale;
    model[8 + row] = toEnu[8 + row]! * rowScale;
    model[12 + row] = toEnu[12 + row]! * rowScale;
  }
  model[3] = toEnu[3]!;
  model[7] = toEnu[7]!;
  model[11] = toEnu[11]!;
  model[15] = 1;
  model[12] = model[12]! + mercatorOrigin.x;
  model[13] = model[13]! + mercatorOrigin.y;
  model[14] = model[14]! + mercatorOrigin.z;
  return model;
}

/**
 * Fold a batch's dequantization into the model matrix, so the shader feeds raw
 * `u16` attribute values straight into `gl_Position` and no intermediate ever
 * holds a large offset in `f32`.
 */
export function foldQuantization(
  model: Float64Array,
  quantizationOrigin: readonly [number, number, number],
  quantizationScale: readonly [number, number, number],
): Float64Array {
  const dequantize = new Float64Array([
    quantizationScale[0],
    0,
    0,
    0,
    0,
    quantizationScale[1],
    0,
    0,
    0,
    0,
    quantizationScale[2],
    0,
    quantizationOrigin[0],
    quantizationOrigin[1],
    quantizationOrigin[2],
    1,
  ]);
  return mat4Multiply(model, dequantize);
}

/**
 * A world-stable key light, expressed in the venue-local frame the encoded
 * normals live in: `d_local = W_lin⁻¹ · (east·x + north·y + up·z)`. The
 * direction is fixed in ENU — from above and to the north-west — so lighting
 * never rotates as the camera orbits (#32 section 5). Folding the source's own
 * world transform through the inverse keeps that true for a source whose
 * geometry is not already ENU-aligned.
 */
export function lightDirectionLocal(
  worldTransform: readonly number[],
  frameOriginEcef: readonly [number, number, number],
  enuLight: readonly [number, number, number],
): Float32Array {
  const { latRad, lonRad } = ecefToGeodetic(frameOriginEcef);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);
  const east = [-sinLon, cosLon, 0];
  const north = [-sinLat * cosLon, -sinLat * sinLon, cosLat];
  const up = [cosLat * cosLon, cosLat * sinLon, sinLat];
  const [x, y, z] = enuLight;
  const ecef = [
    east[0]! * x + north[0]! * y + up[0]! * z,
    east[1]! * x + north[1]! * y + up[1]! * z,
    east[2]! * x + north[2]! * y + up[2]! * z,
  ];
  const inverse = mat4Inverse(Float64Array.from(worldTransform));
  const local = [
    inverse[0]! * ecef[0]! + inverse[4]! * ecef[1]! + inverse[8]! * ecef[2]!,
    inverse[1]! * ecef[0]! + inverse[5]! * ecef[1]! + inverse[9]! * ecef[2]!,
    inverse[2]! * ecef[0]! + inverse[6]! * ecef[1]! + inverse[10]! * ecef[2]!,
  ];
  const length = Math.hypot(local[0]!, local[1]!, local[2]!);
  return new Float32Array([local[0]! / length, local[1]! / length, local[2]! / length]);
}
