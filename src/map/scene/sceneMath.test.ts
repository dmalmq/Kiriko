/**
 * Placement math. These are the assertions that catch a precision regression
 * before it reaches a GPU: a scene placed at the wrong mercator position, a
 * quantization fold that drifts, or lighting that rotates with the camera.
 */
import { MercatorCoordinate } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import {
  wgs84Ecef as wgs84EcefUnderTest,
  composeModelMatrix,
  ecefToGeodetic,
  enuRotationMatrix,
  foldQuantization,
  lightDirectionLocal,
  mat4Inverse,
  mat4Multiply,
  sceneAnchor,
} from "./sceneMath";

const TOKYO_LON = 139.7671;
const TOKYO_LAT = 35.6812;

/** WGS84 geodetic to ECEF — the forward of what the layer inverts. */
function wgs84Ecef(lonDeg: number, latDeg: number, height: number): [number, number, number] {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const a = 6378137.0;
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) * Math.sin(lat));
  return [
    (n + height) * Math.cos(lat) * Math.cos(lon),
    (n + height) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - e2) + height) * Math.sin(lat),
  ];
}

/** The generated source's world transform: the ENU basis plus translation. */
function enuWorldTransform(lonDeg: number, latDeg: number): number[] {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const [sinLat, cosLat, sinLon, cosLon] = [
    Math.sin(lat),
    Math.cos(lat),
    Math.sin(lon),
    Math.cos(lon),
  ];
  const origin = wgs84Ecef(lonDeg, latDeg, 0);
  return [
    -sinLon,
    cosLon,
    0,
    0,
    -sinLat * cosLon,
    -sinLat * sinLon,
    cosLat,
    0,
    cosLat * cosLon,
    cosLat * sinLon,
    sinLat,
    0,
    origin[0],
    origin[1],
    origin[2],
    1,
  ];
}

/** Apply a column-major 4x4 to a point. */
function apply(m: Float64Array, point: readonly [number, number, number]): [number, number, number] {
  const [x, y, z] = point;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

describe("ecefToGeodetic", () => {
  it("inverts the forward conversion to sub-millimetre agreement", () => {
    for (const [lon, lat, height] of [
      [TOKYO_LON, TOKYO_LAT, 0],
      [TOKYO_LON, TOKYO_LAT, 123.36],
      [-74.006, 40.7128, 12],
      [0, 0, 0],
      [151.2093, -33.8688, 58],
    ] as const) {
      const geodetic = ecefToGeodetic(wgs84Ecef(lon, lat, height));
      expect((geodetic.lonRad * 180) / Math.PI).toBeCloseTo(lon, 9);
      expect((geodetic.latRad * 180) / Math.PI).toBeCloseTo(lat, 9);
      expect(geodetic.altitude).toBeCloseTo(height, 6);
    }
  });
});

describe("wgs84Ecef", () => {
  it("agrees with the test's own reference conversion", () => {
    for (const [lon, lat] of [
      [TOKYO_LON, TOKYO_LAT],
      [0, 0],
      [-74.006, 40.7128],
      [151.2093, -33.8688],
    ] as const) {
      const reference = wgs84Ecef(lon, lat, 0);
      const actual = wgs84EcefUnderTest(lon, lat);
      for (const axis of [0, 1, 2]) {
        expect(actual[axis]!).toBeCloseTo(reference[axis]!, 6);
      }
    }
  });

  it("round-trips through the geodetic inverse", () => {
    const geodetic = ecefToGeodetic(wgs84EcefUnderTest(TOKYO_LON, TOKYO_LAT));
    expect((geodetic.lonRad * 180) / Math.PI).toBeCloseTo(TOKYO_LON, 9);
    expect((geodetic.latRad * 180) / Math.PI).toBeCloseTo(TOKYO_LAT, 9);
  });
});

describe("mat4 helpers", () => {
  it("multiplies in column-major order", () => {
    const translate = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]);
    const scale = new Float64Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
    // translate · scale scales first, then translates.
    expect([...apply(mat4Multiply(translate, scale), [1, 1, 1])]).toEqual([12, 22, 32]);
  });

  it("inverts a rotation to its transpose", () => {
    const rotation = enuRotationMatrix((TOKYO_LAT * Math.PI) / 180, (TOKYO_LON * Math.PI) / 180);
    const identity = mat4Multiply(rotation, mat4Inverse(rotation));
    for (let index = 0; index < 16; index += 1) {
      expect(identity[index]!).toBeCloseTo(index % 5 === 0 ? 1 : 0, 12);
    }
  });

  it("refuses a singular matrix rather than returning nonsense", () => {
    expect(() => mat4Inverse(new Float64Array(16))).toThrow(/singular/);
  });
});

describe("composeModelMatrix", () => {
  const frameOrigin = wgs84Ecef(TOKYO_LON, TOKYO_LAT, 0);
  const worldTransform = enuWorldTransform(TOKYO_LON, TOKYO_LAT);
  const anchor = sceneAnchor(frameOrigin);
  const model = composeModelMatrix(
    frameOrigin,
    worldTransform,
    anchor.geodetic,
    anchor.mercatorOrigin,
    anchor.metreScale,
  );

  it("places the venue-local origin at the frame's mercator position", () => {
    const [x, y, z] = apply(model, [0, 0, 0]);
    expect(x).toBeCloseTo(anchor.mercatorOrigin.x, 12);
    expect(y).toBeCloseTo(anchor.mercatorOrigin.y, 12);
    expect(z).toBeCloseTo(anchor.mercatorOrigin.z, 12);
  });

  /** Mercator units back to metres at the anchor, for error reporting. */
  const metresPerMercator = 1 / anchor.metreScale[0];

  it("registers against the map's own projection of the same physical point", () => {
    // Independent path: walk the ENU basis in ECEF, convert to geodetic, and
    // let MapLibre project it. Nothing here uses the model matrix.
    const lonRad = (TOKYO_LON * Math.PI) / 180;
    const latRad = (TOKYO_LAT * Math.PI) / 180;
    const east = [-Math.sin(lonRad), Math.cos(lonRad), 0];
    const north = [
      -Math.sin(latRad) * Math.cos(lonRad),
      -Math.sin(latRad) * Math.sin(lonRad),
      Math.cos(latRad),
    ];

    const drift = (local: readonly [number, number, number]): number => {
      const ecef: [number, number, number] = [
        frameOrigin[0] + east[0]! * local[0] + north[0]! * local[1],
        frameOrigin[1] + east[1]! * local[0] + north[1]! * local[1],
        frameOrigin[2] + east[2]! * local[0] + north[2]! * local[1],
      ];
      const geodetic = ecefToGeodetic(ecef);
      const expected = MercatorCoordinate.fromLngLat(
        { lng: (geodetic.lonRad * 180) / Math.PI, lat: (geodetic.latRad * 180) / Math.PI },
        0,
      );
      const placed = apply(model, local);
      return (
        Math.hypot(placed[0]! - expected.x, placed[1]! - expected.y) * metresPerMercator
      );
    };

    // Easting is exact; northing carries only the linear model's second-order
    // error. Across a station-sized venue — the anchor is its bounds centre,
    // so ±500 m is the realistic reach — the drift stays in centimetres.
    expect(drift([100, 0, 0])).toBeLessThan(0.001);
    expect(drift([0, 100, 0])).toBeLessThan(0.002);
    expect(drift([500, 500, 0])).toBeLessThan(0.05);
    expect(drift([1000, 1000, 0])).toBeLessThan(0.2);
  });

  it("would drift metres if the scale were MapLibre's spherical one", () => {
    // Guards the reason the per-axis ellipsoidal scale exists: swapping in
    // `meterInMercatorCoordinateUnits` misplaces a kilometre-wide venue by
    // metres against its own 2D features.
    const spherical = anchor.mercatorOrigin.meterInMercatorCoordinateUnits();
    const sphericalModel = composeModelMatrix(
      frameOrigin,
      worldTransform,
      anchor.geodetic,
      anchor.mercatorOrigin,
      [spherical, spherical, spherical],
    );
    const local: [number, number, number] = [1000, 0, 0];
    const gap =
      Math.abs(apply(sphericalModel, local)[0]! - apply(model, local)[0]!) * metresPerMercator;
    expect(gap).toBeGreaterThan(1);
  });

  it("grows Y southward, matching mercator rather than ENU north", () => {
    const north = apply(model, [0, 100, 0]);
    expect(north[1]!).toBeLessThan(anchor.mercatorOrigin.y);
  });

  it("lifts a floor plane above the anchor's plane", () => {
    const upper = apply(model, [0, 0, 12]);
    expect(upper[2]!).toBeGreaterThan(anchor.mercatorOrigin.z);
  });

  it("keeps a venue-sized offset stable when the matrix is downcast to f32", () => {
    // The load-bearing property of subtracting the frame origin: after the
    // downcast the layer performs, a 1 mm move must still register.
    const downcast = new Float32Array(model);
    const asF64 = new Float64Array(downcast);
    const here = apply(asF64, [1000, 1000, 0]);
    const millimetreAway = apply(asF64, [1000.001, 1000, 0]);
    expect(millimetreAway[0]).not.toBe(here[0]);
  });
});

describe("foldQuantization", () => {
  it("restores a quantized vertex to the position it encoded", () => {
    const frameOrigin = wgs84Ecef(TOKYO_LON, TOKYO_LAT, 0);
    const anchor = sceneAnchor(frameOrigin);
    const model = composeModelMatrix(
      frameOrigin,
      enuWorldTransform(TOKYO_LON, TOKYO_LAT),
      anchor.geodetic,
      anchor.mercatorOrigin,
      anchor.metreScale,
    );

    // A batch spanning 0..200 m, quantized across the u16 range.
    const origin: [number, number, number] = [0, 0, 4.5];
    const scale: [number, number, number] = [200 / 65535, 200 / 65535, 1 / 65535];
    const folded = foldQuantization(model, origin, scale);

    // The u16 midpoint is the batch's centre: 100 m east, 100 m north.
    const quantized: [number, number, number] = [32767, 32767, 0];
    const viaFold = apply(folded, quantized);
    const viaMetres = apply(model, [
      origin[0] + quantized[0] * scale[0],
      origin[1] + quantized[1] * scale[1],
      origin[2] + quantized[2] * scale[2],
    ]);
    for (const axis of [0, 1, 2]) {
      expect(viaFold[axis]!).toBeCloseTo(viaMetres[axis]!, 15);
    }
  });
});

describe("lightDirectionLocal", () => {
  it("returns the ENU direction unchanged for an ENU-aligned source", () => {
    const frameOrigin = wgs84Ecef(TOKYO_LON, TOKYO_LAT, 0);
    const light = lightDirectionLocal(
      enuWorldTransform(TOKYO_LON, TOKYO_LAT),
      frameOrigin,
      [-0.35, -0.35, 0.87],
    );
    const length = Math.hypot(light[0]!, light[1]!, light[2]!);
    expect(length).toBeCloseTo(1, 6);
    // Normalized input: the generated frame is ENU, so direction is preserved.
    const expected = 0.87 / Math.hypot(0.35, 0.35, 0.87);
    expect(light[2]!).toBeCloseTo(expected, 6);
    expect(light[0]!).toBeLessThan(0);
  });

  it("is independent of the venue's location, so lighting never rotates", () => {
    const enu: [number, number, number] = [-0.35, -0.35, 0.87];
    const tokyo = lightDirectionLocal(
      enuWorldTransform(TOKYO_LON, TOKYO_LAT),
      wgs84Ecef(TOKYO_LON, TOKYO_LAT, 0),
      enu,
    );
    const sydney = lightDirectionLocal(
      enuWorldTransform(151.2093, -33.8688),
      wgs84Ecef(151.2093, -33.8688, 0),
      enu,
    );
    for (const axis of [0, 1, 2]) {
      expect(sydney[axis]!).toBeCloseTo(tokyo[axis]!, 6);
    }
  });

  it("folds a rotated source's transform so the key stays world-stable", () => {
    // A source whose geometry is yawed 90° from ENU: the local light must
    // rotate with it, or the scene would appear lit from a different sky.
    const frameOrigin = wgs84Ecef(TOKYO_LON, TOKYO_LAT, 0);
    const enuAligned = enuWorldTransform(TOKYO_LON, TOKYO_LAT);
    const yaw = new Float64Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const rotated = [...mat4Multiply(Float64Array.from(enuAligned), yaw)];

    const enu: [number, number, number] = [-0.35, -0.35, 0.87];
    const straight = lightDirectionLocal(enuAligned, frameOrigin, enu);
    const yawed = lightDirectionLocal(rotated, frameOrigin, enu);

    // Yawing the source by +90° about up maps local x to ENU y.
    expect(yawed[0]!).toBeCloseTo(straight[1]!, 6);
    expect(yawed[1]!).toBeCloseTo(-straight[0]!, 6);
    expect(yawed[2]!).toBeCloseTo(straight[2]!, 6);
  });
});
