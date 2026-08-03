/**
 * MapLibre custom layer that renders a decoded `.kscene` (3D rendering spike
 * Task 5) — evidence for gates 2 (GL-state interop + context-loss recovery),
 * 5 (precision composition), and 6 (floor filtering).
 *
 * The layer owns its own picking because custom-layer geometry never appears
 * in `queryRenderedFeatures`: `pickAt` renders a feature-ID pass into an MRT
 * framebuffer (attachment 0 = RGBA8 feature index, attachment 1 = view-space
 * position) and reads back a single pixel.
 */
import { MercatorCoordinate } from "maplibre-gl";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import type {
  SceneBatchView,
  SceneFeatureView,
  SceneView,
  SemanticRoleName,
} from "./sceneFormat";
import {
  compileProgram,
  createFeatureStateTexture,
  restoreGlState,
  saveGlState,
  type FeatureStateTexture,
} from "./glUtil";

/** Issue #32 role colors — the renderer never sees a source material. */
function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

export const ROLE_COLORS: Readonly<Record<SemanticRoleName, readonly [number, number, number]>> = {
  Walkable: hexToRgb("#FAFAF9"),
  Public: hexToRgb("#E9EDF4"),
  Service: hexToRgb("#F0EBE0"),
  Restricted: hexToRgb("#D5DAE3"),
  Structure: hexToRgb("#D5DAE3"),
  Ceiling: hexToRgb("#D5DAE3"),
  Opening: hexToRgb("#D5DAE3"),
  Elevator: hexToRgb("#D5DAE3"),
  Escalator: hexToRgb("#D5DAE3"),
  Stairs: hexToRgb("#D5DAE3"),
  Ramp: hexToRgb("#D5DAE3"),
  Context: hexToRgb("#D5DAE3"),
};

/** Opening stroke and semantic edge colors — reserved for the edge pass (D3). */
export const OPENING_STROKE_COLOR: readonly [number, number, number] = hexToRgb("#9AA3B2");
export const SEMANTIC_EDGE_COLOR: readonly [number, number, number] = hexToRgb("#C8CEDA");

/** Issue #32 opacities. */
export const CONTEXT_OPACITY = 0.24;
export const INACTIVE_ROUTE_FLOOR_OPACITY = 0.28;
export const FADED_OCCLUDER_OPACITY = 0.15;

/** Per-feature flags written to the state texture (channel 1 / channel 2). */
export interface FeatureStateFlags {
  selected?: boolean;
  hovered?: boolean;
  /** Diagnostic severity; `>= diagnosticThreshold` gets emphasis. */
  diagnostic?: 0 | 1 | 2 | 3;
}

/** Result of a surface pick: feature index plus the hit point in the
 *  venue-local metric frame (meters, z-up — the frame quantization origins
 *  are expressed in). */
export interface SurfacePick {
  featureIndex: number;
  world: readonly [number, number, number];
}

export interface SceneLayerOptions {
  /** Layer id (must be unique in the style). Defaults to `"scene-3d"`. */
  id?: string;
  /** Role → base color table (issue #32). Defaults to `ROLE_COLORS`. */
  roleColors?: Readonly<Record<SemanticRoleName, readonly [number, number, number]>>;
  /** Render non-active levels at context opacity instead of hiding them. */
  showContextLevels?: boolean;
  /** Severity at which features receive diagnostic emphasis; 0 disables. */
  diagnosticThreshold?: number;
  /** Level rendered opaque when the layer is created. Defaults to 0. */
  activeLevelIndex?: number;
  /** Non-active level opacity (issue #32: 0.24). */
  contextOpacity?: number;
  /** Non-active walkable-floor opacity (issue #32: 0.28). */
  inactiveRouteFloorOpacity?: number;
  /** Protected-corridor / ceiling-above-active fade (issue #32: 0.15). */
  fadedOccluderOpacity?: number;
}

export interface SceneLayerStats {
  /** `drawArrays` calls in the last render. */
  drawCalls: number;
  /** Batches actually drawn in the last render. */
  visibleBatches: number;
  /** Attachment-1 encoding: `rgba32f` when `EXT_color_buffer_float` was
   *  granted, `rgba8` (packed view-space depth) when it was not. */
  pickPath: "rgba32f" | "rgba8";
  /** Whether `EXT_color_buffer_float` is active. */
  floatColorBuffer: boolean;
}

export interface SceneLayer extends CustomLayerInterface {
  renderingMode: "3d";
  /** Make `levelIndex` the opaque active level; re-derives per-feature
   *  visibility and uploads the state texture. */
  setActiveLevel(levelIndex: number): void;
  /** Toggle rendering of non-active levels as faded context. */
  setShowContextLevels(show: boolean): void;
  /** Update selection / hover / diagnostic state for one feature. */
  setFeatureState(featureIndex: number, state: FeatureStateFlags): void;
  /** GPU feature-ID pick at CSS-pixel (x, y) on the map canvas. */
  pickAt(x: number, y: number): SurfacePick | null;
  /** Last-render draw statistics plus the active pick-encoding path. */
  stats(): SceneLayerStats;
  /** Spike-only diagnostic used by the gate matrix; see implementation. */
  debugProject(local: readonly [number, number, number]): {
    clip: [number, number, number, number];
    ndc: [number, number, number] | null;
    inFrustum: boolean;
    hasFrame: boolean;
    translation: [number, number, number];
  };
}

// ---------------------------------------------------------------------------
// Double-precision matrix and geodesy helpers. Everything the layer uploads
// starts as f64 and is downcast to f32 only at the `uniformMatrix4fv` call
// (gate 5: never let a Float32Array hold a value derived from an un-offset
// ECEF component).
// ---------------------------------------------------------------------------

/** Column-major 4x4 multiply, `a · b`, in f64. The fixed 16-element layout
 *  makes every indexed read defined; `!` narrows `noUncheckedIndexedAccess`. */
function mat4Multiply(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r]! * b[c * 4]! +
        a[4 + r]! * b[c * 4 + 1]! +
        a[8 + r]! * b[c * 4 + 2]! +
        a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return out;
}

/** Column-major 4x4 inverse via the adjugate, in f64. */
function mat4Inverse(m: Float64Array): Float64Array {
  const out = new Float64Array(16);
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!
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
    throw new Error("singular matrix in mat4Inverse");
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

function mat4Translate(x: number, y: number, z: number): Float64Array {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

function mat4Scale(x: number, y: number, z: number): Float64Array {
  return new Float64Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
}

const WGS84_SEMI_MAJOR = 6378137.0;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);

interface Geodetic {
  lonRad: number;
  latRad: number;
  altitude: number;
}

/** ECEF → WGS84 geodetic (iterative; converges in a few passes). Verified
 *  against the plan's pinned values: Tokyo origin → 139.764457, 35.678519,
 *  123.36 m. */
function ecefToGeodetic(ecef: readonly [number, number, number]): Geodetic {
  const [x, y, z] = ecef;
  const p = Math.hypot(x, y);
  const lonRad = Math.atan2(y, x);
  let latRad = Math.atan2(z, p * (1 - WGS84_E2));
  let altitude = 0;
  for (let i = 0; i < 10; i++) {
    const sinLat = Math.sin(latRad);
    const n = WGS84_SEMI_MAJOR / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    altitude = p / Math.cos(latRad) - n;
    latRad = Math.atan2(z, p * (1 - WGS84_E2 * (n / (n + altitude))));
  }
  return { lonRad, latRad, altitude };
}

/** ECEF → ENU rotation as a 4x4 (rows East, North, Up; zero translation).
 *  Columns are the basis rows expressed in ECEF. */
function enuRotationMatrix(latRad: number, lonRad: number): Float64Array {
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);
  return new Float64Array([
    -sinLon, -sinLat * cosLon, cosLat * cosLon, 0,
    cosLon, -sinLat * sinLon, cosLat * sinLon, 0,
    0, cosLat, sinLat, 0,
    0, 0, 0, 1,
  ]);
}

/**
 * Precision recipe (gate 5), steps 1–5:
 *   1. `frameOriginEcef` → geodetic `(lon0, lat0, alt0)`.
 *   2. ECEF → ENU rotation at that origin.
 *   3. Fold the column-major tileset transform: `M_model_to_enu` has rotation
 *      `R·W_lin` and translation `R·(W_t − frameOriginEcef)` (zero when the
 *      origin is the transform's own translation, which the deriver pins).
 *   4. Mercator origin `MercatorCoordinate.fromLngLat(...)` + metre scale.
 *   5. `translate(origin) · scale(s, −s, s) · M_model_to_enu` — the negative Y
 *      scale because mercator Y increases southward while ENU north increases
 *      northward. The result is constant per scene, so it is computed once at
 *      load in f64.
 */
function composeModelMatrix(
  frameOriginEcef: readonly [number, number, number],
  worldTransform: readonly number[],
  geodetic: Geodetic,
  mercatorOrigin: MercatorCoordinate,
  metreScale: number,
): Float64Array {
  const rotation = enuRotationMatrix(geodetic.latRad, geodetic.lonRad);
  const toEnu = mat4Multiply(rotation, Float64Array.from(worldTransform));
  const [ox, oy, oz] = frameOriginEcef;
  toEnu[12] = toEnu[12]! - (rotation[0]! * ox + rotation[4]! * oy + rotation[8]! * oz);
  toEnu[13] = toEnu[13]! - (rotation[1]! * ox + rotation[5]! * oy + rotation[9]! * oz);
  toEnu[14] = toEnu[14]! - (rotation[2]! * ox + rotation[6]! * oy + rotation[10]! * oz);

  const model = new Float64Array(16);
  for (let row = 0; row < 3; row++) {
    const rowScale = row === 1 ? -metreScale : metreScale;
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

function normalize3(v: [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * World-stable key light, expressed in the tile-local frame the oct-encoded
 * normals live in: `d_local = W_lin⁻¹ · Rᵀ · d_enu`. The ENU direction is
 * fixed — from above and camera-left for a north-up view — so the lighting
 * never rotates as the camera orbits.
 */
function lightDirectionLocal(
  worldTransform: readonly number[],
  enuLight: [number, number, number],
): Float32Array {
  const worldInverse = mat4Inverse(Float64Array.from(worldTransform));
  const [x, y, z] = enuLight;
  // Rᵀ maps ENU → ECEF: columns of R (rows East, North, Up) are the ENU basis
  // in ECEF. R is built at the world transform's own translation.
  const frameOrigin: readonly [number, number, number] = [
    worldTransform[12] ?? 0,
    worldTransform[13] ?? 0,
    worldTransform[14] ?? 0,
  ];
  const geodetic = ecefToGeodetic(frameOrigin);
  const sinLat = Math.sin(geodetic.latRad);
  const cosLat = Math.cos(geodetic.latRad);
  const sinLon = Math.sin(geodetic.lonRad);
  const cosLon = Math.cos(geodetic.lonRad);
  const east: [number, number, number] = [-sinLon, cosLon, 0];
  const north: [number, number, number] = [-sinLat * cosLon, -sinLat * sinLon, cosLat];
  const up: [number, number, number] = [cosLat * cosLon, cosLat * sinLon, sinLat];
  const dEcef: [number, number, number] = [
    east[0] * x + north[0] * y + up[0] * z,
    east[1] * x + north[1] * y + up[1] * z,
    east[2] * x + north[2] * y + up[2] * z,
  ];
  const local: [number, number, number] = [
    worldInverse[0]! * dEcef[0] + worldInverse[4]! * dEcef[1] + worldInverse[8]! * dEcef[2],
    worldInverse[1]! * dEcef[0] + worldInverse[5]! * dEcef[1] + worldInverse[9]! * dEcef[2],
    worldInverse[2]! * dEcef[0] + worldInverse[6]! * dEcef[1] + worldInverse[10]! * dEcef[2],
  ];
  return new Float32Array(normalize3(local));
}

// ---------------------------------------------------------------------------
// Shaders. The vertex shader follows the plan's outline; quantization is
// folded into `u_matrix`/`u_modelViewMatrix` (precision recipe step 6), so
// `u_quantOrigin`/`u_quantScale` stay at identity by construction — the
// expansion line is kept verbatim to match the plan's shader.
// ---------------------------------------------------------------------------

const VERTEX_SHADER = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform mat4 u_modelViewMatrix;
uniform vec3 u_quantOrigin;
uniform vec3 u_quantScale;
uniform sampler2D u_featureState;
uniform vec2 u_featureTexSize;
in vec3 a_position;   // u16, expanded by the attribute pointer
in vec2 a_normal;     // i16 oct-encoded, normalized
in uint a_featureIndex;
out vec3 v_normal;
out vec4 v_state;
out vec3 v_viewPos;
// Venue-local metres. Issue #27's "place at this point" wants local scene
// coordinates, not the mercator-scaled view space u_modelViewMatrix yields, so
// the pick pass writes this straight out on the float path.
out vec3 v_localPos;
out float v_featureIndex;
void main() {
  vec3 local = u_quantOrigin + a_position * u_quantScale;
  float index = float(a_featureIndex);
  vec2 texel = vec2(mod(index, u_featureTexSize.x), floor(index / u_featureTexSize.x));
  v_state = texture(u_featureState, (texel + 0.5) / u_featureTexSize);
  v_normal = vec3(a_normal, 1.0 - abs(a_normal.x) - abs(a_normal.y));
  v_featureIndex = index;
  vec4 localPos = vec4(local, 1.0);
  v_localPos = local;
  v_viewPos = (u_modelViewMatrix * localPos).xyz;
  gl_Position = u_matrix * localPos;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform vec4 u_baseColor;
uniform vec3 u_lightDir;
uniform float u_pickMode;
uniform float u_pickDepthEncode;
uniform vec2 u_pickZRange;
uniform float u_diagnosticThreshold;

in vec3 v_normal;
in vec3 v_viewPos;
in vec3 v_localPos;
in vec4 v_state;
in float v_featureIndex;

// GLSL ES 3.0 requires explicit locations once a shader declares more than one
// fragment output, unless EXT_blend_func_extended is enabled. Without these the
// program fails to link on Chromium/ANGLE.
layout(location = 0) out vec4 outColor0;
layout(location = 1) out vec4 outColor1;

// Pack a [0, 1] float into RGBA8 with ~24-bit precision (EncodeFloatRGBA).
vec4 packFloat01(float t) {
  vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * clamp(t, 0.0, 1.0);
  enc = fract(enc);
  enc -= enc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  return enc;
}

void main() {
  float opacity = v_state.r;
  if (opacity < 0.02) discard;

  if (u_pickMode > 0.5) {
    // Only opaque surfaces are pickable; faded context/occluders are not.
    if (opacity < 0.5) discard;
    int packed = int(v_featureIndex) + 1; // pick.ts encodeFeatureId convention
    outColor0 = vec4(
      float(packed & 0xff),
      float((packed >> 8) & 0xff),
      float((packed >> 16) & 0xff),
      255.0
    ) / 255.0;
    if (u_pickDepthEncode > 0.5) {
      // EXT_color_buffer_float unavailable: pack view-space depth into RGBA8 and
      // reconstruct an approximate position on the CPU.
      float t = (-v_viewPos.z - u_pickZRange.x) / (u_pickZRange.y - u_pickZRange.x);
      outColor1 = packFloat01(t);
    } else {
      // Float path: venue-local metres straight out, which is what issue #27's
      // "place at this point" consumes.
      outColor1 = vec4(v_localPos, 1.0);
    }
    return;
  }

  vec3 n = normalize(v_normal);
  float ndl = max(dot(n, u_lightDir), 0.0);
  // One world-stable soft key from above and camera-left; the key's minimum
  // contribution (contact darkness) is clamped at 0.12 (issue #32 section 5).
  float light = clamp(0.35 + 0.65 * ndl, 0.12, 1.0);
  vec3 rgb = u_baseColor.rgb * light;

  float flags = v_state.g * 255.0;
  if (mod(flags, 2.0) > 0.5) {
    // selected: warm lift
    rgb = rgb * 1.25 + vec3(0.08, 0.04, 0.0);
  } else if (mod(floor(flags / 2.0), 2.0) > 0.5) {
    // hovered: slight brighten
    rgb *= 1.12;
  }

  float severity = v_state.b * 255.0;
  if (u_diagnosticThreshold > 0.5 && severity >= u_diagnosticThreshold) {
    rgb = mix(rgb, vec3(0.95, 0.35, 0.35), 0.35);
  }

  // Premultiplied alpha (MapLibre's blend convention).
  outColor0 = vec4(rgb * opacity, opacity);
}
`;

/** Matches `pick.ts` `encodeFeatureId`: index + 1, all-zero RGBA = no hit. */
function decodeFeatureId(rgba: Uint8Array): number {
  const r = rgba[0] ?? 0;
  const g = rgba[1] ?? 0;
  const b = rgba[2] ?? 0;
  if (r === 0 && g === 0 && b === 0) {
    return -1;
  }
  return (r | (g << 8) | (b << 16)) - 1;
}

/** Decode the shader's `packFloat01` from an RGBA8 readback. */
function decodeFloat01(rgba: Uint8Array): number {
  const r = rgba[0] ?? 0;
  const g = rgba[1] ?? 0;
  const b = rgba[2] ?? 0;
  const a = rgba[3] ?? 0;
  return r + g / 255 + b / 65025 + a / 16581375;
}

/**
 * Recover the view-space point under the pixel from its view-space Z, by
 * inverting the projection's top-left 2×2. Used only by the RGBA8 fallback
 * path, so pixel-quantization error (≤ half a pixel) is acceptable.
 */
function unprojectPixel(
  px: number,
  readY: number,
  width: number,
  height: number,
  viewZ: number,
  projection: Float64Array,
): [number, number, number] {
  const ndcX = ((px + 0.5) / width) * 2 - 1;
  const ndcY = ((readY + 0.5) / height) * 2 - 1;
  const w = projection[11]! * viewZ + projection[15]!;
  const p00 = projection[0]!;
  const p01 = projection[4]!;
  const p10 = projection[1]!;
  const p11 = projection[5]!;
  const det = p00 * p11 - p01 * p10;
  if (Math.abs(det) < 1e-30) {
    return [0, 0, viewZ];
  }
  const rhsX = ndcX * w - projection[8]! * viewZ - projection[12]!;
  const rhsY = ndcY * w - projection[9]! * viewZ - projection[13]!;
  const vx = (rhsX * p11 - p01 * rhsY) / det;
  const vy = (p00 * rhsY - rhsX * p10) / det;
  return [vx, vy, viewZ];
}

function assertWebGL2(gl: WebGLRenderingContext | WebGL2RenderingContext): WebGL2RenderingContext {
  if (!(gl instanceof WebGL2RenderingContext)) {
    throw new Error("scene layer requires a WebGL2 context");
  }
  return gl;
}

interface BatchResources {
  vao: WebGLVertexArrayObject;
  positions: WebGLBuffer;
  normals: WebGLBuffer;
  featureIndices: WebGLBuffer;
  vertexCount: number;
  role: SemanticRoleName;
  /** `T(quantizationOrigin)·S(quantizationScale)`, precomputed in f64. */
  quantTransform: Float64Array;
  /** Unique global feature indices referenced by this batch. */
  featureIndexSet: Set<number>;
}

interface FrameState {
  /** World → clip (f64 view of MapLibre's matrix). */
  mvp: Float64Array;
  /** Local → view. */
  modelView: Float64Array;
  /** View → clip. */
  projection: Float64Array;
  /** View → local. */
  modelViewInverse: Float64Array;
  near: number;
  far: number;
}

interface UniformLocations {
  matrix: WebGLUniformLocation | null;
  modelView: WebGLUniformLocation | null;
  quantOrigin: WebGLUniformLocation | null;
  quantScale: WebGLUniformLocation | null;
  featureState: WebGLUniformLocation | null;
  featureTexSize: WebGLUniformLocation | null;
  baseColor: WebGLUniformLocation | null;
  lightDir: WebGLUniformLocation | null;
  pickMode: WebGLUniformLocation | null;
  pickDepthEncode: WebGLUniformLocation | null;
  pickZRange: WebGLUniformLocation | null;
  diagnosticThreshold: WebGLUniformLocation | null;
}

interface AttribLocations {
  position: number;
  normal: number;
  feature: number;
}

class SceneLayerImpl implements SceneLayer {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private readonly _scene: SceneView;
  private readonly _roleColors: Readonly<Record<SemanticRoleName, readonly [number, number, number]>>;
  private readonly _contextOpacity: number;
  private readonly _inactiveRouteFloorOpacity: number;
  private readonly _fadedOccluderOpacity: number;
  private readonly _diagnosticThreshold: number;
  private readonly _modelMatrix: Float64Array;
  private readonly _lightDirLocal: Float32Array;
  private readonly _stateSize: number;
  private readonly _stateData: Uint8Array;

  private _map: MapLibreMap | null = null;
  private _gl: WebGL2RenderingContext | null = null;
  private _contextLost = false;

  private _program: WebGLProgram | null = null;
  private _attrLoc: AttribLocations | null = null;
  private _uLoc: UniformLocations | null = null;
  private _batches: BatchResources[] = [];
  private _visibleBatches: Set<number> = new Set();
  private _stateTex: FeatureStateTexture | null = null;

  private _pickFramebuffer: WebGLFramebuffer | null = null;
  private _pickIdTarget: WebGLTexture | null = null;
  private _pickPositionTarget: WebGLTexture | null = null;
  private _pickDepth: WebGLRenderbuffer | null = null;
  private _floatColorBuffer = false;
  private _pickPath: "rgba32f" | "rgba8" = "rgba8";

  private _frame: FrameState | null = null;
  private _lastDrawCalls = 0;
  private _lastVisibleBatches = 0;

  private readonly _uMatrixF32 = new Float32Array(16);
  private readonly _uModelViewF32 = new Float32Array(16);

  private _activeLevelIndex: number;
  private _showContextLevels: boolean;

  constructor(scene: SceneView, options: SceneLayerOptions) {
    this._scene = scene;
    this.id = options.id ?? "scene-3d";
    this._roleColors = options.roleColors ?? ROLE_COLORS;
    this._contextOpacity = options.contextOpacity ?? CONTEXT_OPACITY;
    this._inactiveRouteFloorOpacity = options.inactiveRouteFloorOpacity ?? INACTIVE_ROUTE_FLOOR_OPACITY;
    this._fadedOccluderOpacity = options.fadedOccluderOpacity ?? FADED_OCCLUDER_OPACITY;
    this._diagnosticThreshold = options.diagnosticThreshold ?? 0;
    this._showContextLevels = options.showContextLevels ?? false;
    this._activeLevelIndex = Math.min(
      Math.max(0, Math.floor(options.activeLevelIndex ?? 0)),
      Math.max(0, scene.levels.length - 1),
    );

    const geodetic = ecefToGeodetic(scene.header.frameOriginEcef);
    const mercatorOrigin = MercatorCoordinate.fromLngLat(
      { lng: (geodetic.lonRad * 180) / Math.PI, lat: (geodetic.latRad * 180) / Math.PI },
      geodetic.altitude,
    );
    const metreScale = mercatorOrigin.meterInMercatorCoordinateUnits();
    this._modelMatrix = composeModelMatrix(
      scene.header.frameOriginEcef,
      scene.header.worldTransform,
      geodetic,
      mercatorOrigin,
      metreScale,
    );
    this._lightDirLocal = lightDirectionLocal(
      scene.header.worldTransform,
      normalize3([-0.35, -0.35, 0.87]),
    );

    const stateSize = Math.max(1, Math.ceil(Math.sqrt(scene.features.length)));
    this._stateSize = stateSize;
    this._stateData = new Uint8Array(stateSize * stateSize * 4);
    this._recomputeVisibility();
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    const gl2 = assertWebGL2(gl);
    this._map = map;
    this._gl = gl2;
    this._buildResources(gl2);
    this._uploadStateTexture();
    const canvas = map.getCanvas();
    canvas.addEventListener("webglcontextlost", this._onContextLost, false);
    canvas.addEventListener("webglcontextrestored", this._onContextRestored, false);
    map.on("resize", this._onResize);
  }

  onRemove(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    assertWebGL2(gl);
    this._releaseResources();
    const canvas = map.getCanvas();
    canvas.removeEventListener("webglcontextlost", this._onContextLost, false);
    canvas.removeEventListener("webglcontextrestored", this._onContextRestored, false);
    map.off("resize", this._onResize);
    this._map = null;
    this._gl = null;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const gl2 = assertWebGL2(gl);
    if (this._contextLost || !this._program || !this._stateTex) {
      return;
    }
    const state = saveGlState(gl2);
    try {
      // `defaultProjectionData.mainMatrix` consumes mercator [0, 1] coordinates,
      // which is the space the model matrix produces. `modelViewProjectionMatrix`
      // consumes mercator x worldSize (pixel) coordinates instead, so using it
      // here placed the whole scene ~1.1 mercator units off-screen. Measured:
      // feeding the frame origin to mainMatrix yields NDC x = 0 with the camera
      // centred on it, while modelViewProjectionMatrix yields NDC x = -4.88.
      const mvp = Float64Array.from(options.defaultProjectionData.mainMatrix);
      const projection = Float64Array.from(options.projectionMatrix);
      const projectionInverse = mat4Inverse(projection);
      const modelView = mat4Multiply(projectionInverse, mvp); // world → view
      this._frame = {
        mvp,
        modelView,
        projection,
        modelViewInverse: mat4Inverse(modelView),
        near: options.nearZ,
        far: options.farZ,
      };

      // Depth-compose with the basemap; blend premultiplied alpha the way
      // MapLibre expects. Everything here is restored on exit.
      gl2.enable(gl2.DEPTH_TEST);
      gl2.depthMask(true);
      gl2.depthFunc(gl2.LEQUAL);
      gl2.disable(gl2.CULL_FACE);
      gl2.enable(gl2.BLEND);
      gl2.blendFunc(gl2.ONE, gl2.ONE_MINUS_SRC_ALPHA);
      gl2.drawBuffers([gl2.BACK]);

      this._bindSharedUniforms(gl2, 0, options.nearZ, options.farZ);
      this._drawVisibleBatches(gl2);
    } finally {
      restoreGlState(gl2, state);
    }
  }

  setActiveLevel(levelIndex: number): void {
    const clamped = Math.min(Math.max(0, Math.floor(levelIndex)), Math.max(0, this._scene.levels.length - 1));
    if (clamped === this._activeLevelIndex) {
      return;
    }
    this._activeLevelIndex = clamped;
    this._recomputeVisibility();
    this._uploadStateTexture();
  }

  setShowContextLevels(show: boolean): void {
    if (show === this._showContextLevels) {
      return;
    }
    this._showContextLevels = show;
    this._recomputeVisibility();
    this._uploadStateTexture();
  }

  setFeatureState(featureIndex: number, state: FeatureStateFlags): void {
    if (featureIndex < 0 || featureIndex >= this._scene.features.length) {
      return;
    }
    const index4 = featureIndex * 4;
    let flags = this._stateData[index4 + 1] ?? 0;
    if (state.selected !== undefined) {
      flags = state.selected ? flags | 1 : flags & ~1;
    }
    if (state.hovered !== undefined) {
      flags = state.hovered ? flags | 2 : flags & ~2;
    }
    this._stateData[index4 + 1] = flags;
    this._stateData[index4 + 2] = state.diagnostic ?? 0;
    const gl = this._gl;
    const stateTex = this._stateTex;
    if (!gl || !stateTex) {
      return; // pre-onAdd: applied to _stateData; uploaded once resources exist
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, stateTex.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      featureIndex % this._stateSize,
      Math.floor(featureIndex / this._stateSize),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this._stateData.subarray(index4, index4 + 4),
    );
  }

  pickAt(x: number, y: number): SurfacePick | null {
    const gl = this._gl;
    const frame = this._frame;
    const stateTex = this._stateTex;
    if (!gl || !frame || !stateTex || this._contextLost || !this._pickFramebuffer) {
      return null;
    }
    const state = saveGlState(gl);
    let result: SurfacePick | null = null;
    try {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const canvas = this._map?.getCanvas();
      const cssWidth = canvas?.clientWidth ?? 0;
      const cssHeight = canvas?.clientHeight ?? 0;
      if (cssWidth <= 0 || cssHeight <= 0 || width <= 0 || height <= 0) {
        return null;
      }
      const px = Math.min(width - 1, Math.max(0, Math.floor(x * (width / cssWidth))));
      const py = Math.min(height - 1, Math.max(0, Math.floor(y * (height / cssHeight))));
      const readY = height - 1 - py; // GL origin is bottom-left

      gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFramebuffer);
      gl.viewport(0, 0, width, height);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.clearColor(0, 0, 0, 1);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);

      this._bindSharedUniforms(gl, 1, frame.near, frame.far);
      this._drawVisibleBatches(gl);

      // With MRT, `readPixels` always samples the buffer named by `readBuffer`.
      // Without these two calls the second read re-samples attachment 0 and the
      // "position" is really the packed feature-id colour.
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      const idPixel = new Uint8Array(4);
      gl.readPixels(px, readY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, idPixel);
      const featureIndex = decodeFeatureId(idPixel);
      if (featureIndex >= 0) {
        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        if (this._pickPath === "rgba32f") {
          // Float path: attachment 1 already holds venue-local metres, so no
          // view-space inverse is involved.
          const localPixel = new Float32Array(4);
          gl.readPixels(px, readY, 1, 1, gl.RGBA, gl.FLOAT, localPixel);
          result = {
            featureIndex,
            world: [localPixel[0] ?? 0, localPixel[1] ?? 0, localPixel[2] ?? 0],
          };
        } else {
          // Degraded path: only depth survives RGBA8, so the position is
          // reconstructed through view space and then back into local metres.
          const depthPixel = new Uint8Array(4);
          gl.readPixels(px, readY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, depthPixel);
          const t = decodeFloat01(depthPixel);
          const viewZ = -(frame.near + t * (frame.far - frame.near));
          const viewPos = unprojectPixel(px, readY, width, height, viewZ, frame.projection);
          const inv = frame.modelViewInverse;
          const mx = inv[0]! * viewPos[0] + inv[4]! * viewPos[1] + inv[8]! * viewPos[2] + inv[12]!;
          const my = inv[1]! * viewPos[0] + inv[5]! * viewPos[1] + inv[9]! * viewPos[2] + inv[13]!;
          const mz = inv[2]! * viewPos[0] + inv[6]! * viewPos[1] + inv[10]! * viewPos[2] + inv[14]!;
          const local = this._mercatorToLocal([mx, my, mz]);
          result = { featureIndex, world: local };
        }
      }
    } finally {
      gl.drawBuffers([gl.BACK]);
      restoreGlState(gl, state);
    }
    return result;
  }


  /**
   * Degraded-path helper: mercator world → venue-local metres, via the inverse
   * of the composed model matrix. Only the RGBA8 fallback needs this; the float
   * path reads local metres straight out of attachment 1.
   */
  private _mercatorToLocal(
    mercator: readonly [number, number, number],
  ): [number, number, number] {
    const inv = mat4Inverse(this._modelMatrix);
    const [x, y, z] = mercator;
    return [
      (inv[0] ?? 0) * x + (inv[4] ?? 0) * y + (inv[8] ?? 0) * z + (inv[12] ?? 0),
      (inv[1] ?? 0) * x + (inv[5] ?? 0) * y + (inv[9] ?? 0) * z + (inv[13] ?? 0),
      (inv[2] ?? 0) * x + (inv[6] ?? 0) * y + (inv[10] ?? 0) * z + (inv[14] ?? 0),
    ];
  }
  /**
   * Spike-only diagnostic: project a local scene point through the exact
   * matrices the draw path uses and report the result in clip and NDC space,
   * plus the composed model translation. Used by the gate matrix to tell
   * "geometry mis-placed" apart from "geometry discarded".
   */
  debugProject(local: readonly [number, number, number]): {
    clip: [number, number, number, number];
    ndc: [number, number, number] | null;
    inFrustum: boolean;
    hasFrame: boolean;
    translation: [number, number, number];
  } {
    const frame = this._frame;
    const translation: [number, number, number] = [
      this._modelMatrix[12] ?? 0,
      this._modelMatrix[13] ?? 0,
      this._modelMatrix[14] ?? 0,
    ];
    if (!frame) {
      return { clip: [0, 0, 0, 0], ndc: null, inFrustum: false, hasFrame: false, translation };
    }
    const m = mat4Multiply(frame.mvp, this._modelMatrix);
    const [x, y, z] = local;
    const clip: [number, number, number, number] = [
      (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
      (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
      (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
      (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[11] ?? 0) * z + (m[15] ?? 0),
    ];
    const w = clip[3];
    const ndc: [number, number, number] | null =
      Math.abs(w) > 1e-12 ? [clip[0] / w, clip[1] / w, clip[2] / w] : null;
    const inFrustum =
      ndc !== null && Math.abs(ndc[0]) <= 1 && Math.abs(ndc[1]) <= 1 && ndc[2] >= -1 && ndc[2] <= 1;
    return { clip, ndc, inFrustum, hasFrame: true, translation };
  }

  stats(): SceneLayerStats {
    return {
      drawCalls: this._lastDrawCalls,
      visibleBatches: this._lastVisibleBatches,
      pickPath: this._pickPath,
      floatColorBuffer: this._floatColorBuffer,
    };
  }

  // -- internals ------------------------------------------------------------

  private _onContextLost = (event: Event): void => {
    event.preventDefault(); // allow the browser to restore the context
    this._contextLost = true;
    this._releaseResources();
  };

  private _onContextRestored = (): void => {
    const gl = this._gl;
    if (!gl) {
      return;
    }
    this._buildResources(gl); // rebuild every GL object from the retained scene
    this._uploadStateTexture();
    this._contextLost = false;
  };

  private _onResize = (): void => {
    const gl = this._gl;
    if (!gl || !this._pickFramebuffer) {
      return;
    }
    this._resizePickTargets(gl);
  };

  /** Floor filtering (gate 6): visibility is per feature via the state
   *  texture, not per batch. Channel 0 carries opacity (0..255). */
  private _recomputeVisibility(): void {
    const features = this._scene.features;
    for (let i = 0; i < features.length; i++) {
      const feature = features[i];
      if (!feature) {
        continue;
      }
      this._stateData[i * 4] = this._visibilityForFeature(feature);
    }
    const visibleBatches = new Set<number>();
    for (let i = 0; i < this._batches.length; i++) {
      const batch = this._batches[i];
      if (!batch) {
        continue;
      }
      for (const featureIndex of batch.featureIndexSet) {
        if ((this._stateData[featureIndex * 4] ?? 0) > 0) {
          visibleBatches.add(i);
          break;
        }
      }
    }
    this._visibleBatches = visibleBatches;
  }

  private _visibilityForFeature(feature: SceneFeatureView): number {
    if (feature.levelIndex === this._activeLevelIndex) {
      return 255;
    }
    if (!this._showContextLevels) {
      return 0;
    }
    // Occluders and ceilings above the active level fade to 0.15.
    if (feature.levelIndex > this._activeLevelIndex) {
      if (feature.occlusion === "ProtectedCorridor" || feature.role === "Ceiling") {
        return Math.round(this._fadedOccluderOpacity * 255);
      }
    }
    if (feature.role === "Walkable") {
      return Math.round(this._inactiveRouteFloorOpacity * 255);
    }
    return Math.round(this._contextOpacity * 255);
  }

  private _uploadStateTexture(): void {
    const gl = this._gl;
    const stateTex = this._stateTex;
    if (!gl || !stateTex) {
      return;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, stateTex.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      stateTex.width,
      stateTex.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      stateTex.data,
    );
  }

  private _buildResources(gl: WebGL2RenderingContext): void {
    this._releaseResources();
    const program = compileProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this._program = program;
    this._attrLoc = {
      position: gl.getAttribLocation(program, "a_position"),
      normal: gl.getAttribLocation(program, "a_normal"),
      feature: gl.getAttribLocation(program, "a_featureIndex"),
    };
    this._uLoc = {
      matrix: gl.getUniformLocation(program, "u_matrix"),
      modelView: gl.getUniformLocation(program, "u_modelViewMatrix"),
      quantOrigin: gl.getUniformLocation(program, "u_quantOrigin"),
      quantScale: gl.getUniformLocation(program, "u_quantScale"),
      featureState: gl.getUniformLocation(program, "u_featureState"),
      featureTexSize: gl.getUniformLocation(program, "u_featureTexSize"),
      baseColor: gl.getUniformLocation(program, "u_baseColor"),
      lightDir: gl.getUniformLocation(program, "u_lightDir"),
      pickMode: gl.getUniformLocation(program, "u_pickMode"),
      pickDepthEncode: gl.getUniformLocation(program, "u_pickDepthEncode"),
      pickZRange: gl.getUniformLocation(program, "u_pickZRange"),
      diagnosticThreshold: gl.getUniformLocation(program, "u_diagnosticThreshold"),
    };

    this._batches = this._scene.batches.map((batch) => this._createBatchResources(gl, batch));

    // Visibility must be current before the texture is uploaded, so a
    // setActiveLevel/setShowContextLevels call between construction and
    // onAdd cannot leave stale channel-0 values on the GPU.
    this._recomputeVisibility();

    const created = createFeatureStateTexture(gl, this._scene.features.length);
    created.data.set(this._stateData);
    this._stateTex = created;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, created.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      created.width,
      created.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      created.data,
    );
    this._stateData.set(created.data);

    this._floatColorBuffer = gl.getExtension("EXT_color_buffer_float") !== null;
    this._pickPath = this._floatColorBuffer ? "rgba32f" : "rgba8";
    this._createPickTargets(gl);
  }

  private _createBatchResources(gl: WebGL2RenderingContext, batch: SceneBatchView): BatchResources {
    const positions = gl.createBuffer();
    const normals = gl.createBuffer();
    const featureIndices = gl.createBuffer();
    if (!positions || !normals || !featureIndices) {
      throw new Error("WebGL failed to create a batch buffer");
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, positions);
    gl.bufferData(gl.ARRAY_BUFFER, batch.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, normals);
    gl.bufferData(gl.ARRAY_BUFFER, batch.normals, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, featureIndices);
    gl.bufferData(gl.ARRAY_BUFFER, batch.featureIndices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const attr = this._attrLoc;
    if (!attr) {
      throw new Error("attribute locations missing");
    }
    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error("WebGL failed to create a vertex array");
    }
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, positions);
    gl.enableVertexAttribArray(attr.position);
    gl.vertexAttribPointer(attr.position, 3, gl.UNSIGNED_SHORT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, normals);
    gl.enableVertexAttribArray(attr.normal);
    gl.vertexAttribPointer(attr.normal, 2, gl.SHORT, true, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, featureIndices);
    gl.enableVertexAttribArray(attr.feature);
    gl.vertexAttribIPointer(attr.feature, 1, gl.UNSIGNED_INT, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const [qx, qy, qz] = batch.quantizationOrigin;
    const [sx, sy, sz] = batch.quantizationScale;
    return {
      vao,
      positions,
      normals,
      featureIndices,
      vertexCount: batch.vertexCount,
      role: batch.role,
      quantTransform: mat4Multiply(mat4Translate(qx, qy, qz), mat4Scale(sx, sy, sz)),
      featureIndexSet: new Set(batch.featureIndices),
    };
  }

  /** MRT pick framebuffer: RGBA8 feature ID + RGBA32F view-space position
   *  (RGBA8-encoded depth when `EXT_color_buffer_float` is missing) plus a
   *  depth renderbuffer, sized to the drawing buffer. */
  private _createPickTargets(gl: WebGL2RenderingContext): void {
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;

    const idTarget = gl.createTexture();
    const positionTarget = gl.createTexture();
    const depth = gl.createRenderbuffer();
    const framebuffer = gl.createFramebuffer();
    if (!idTarget || !positionTarget || !depth || !framebuffer) {
      throw new Error("WebGL failed to create the pick framebuffer");
    }
    this._pickIdTarget = idTarget;
    this._pickPositionTarget = positionTarget;
    this._pickDepth = depth;
    this._pickFramebuffer = framebuffer;

    gl.bindTexture(gl.TEXTURE_2D, idTarget);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, positionTarget);
    if (this._pickPath === "rgba32f") {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, idTarget, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, positionTarget, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`pick framebuffer incomplete: 0x${status.toString(16)}`);
    }
  }

  private _resizePickTargets(gl: WebGL2RenderingContext): void {
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const idTarget = this._pickIdTarget;
    const positionTarget = this._pickPositionTarget;
    const depth = this._pickDepth;
    if (!idTarget || !positionTarget || !depth) {
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, idTarget);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, positionTarget);
    if (this._pickPath === "rgba32f") {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }

  private _releaseResources(): void {
    const gl = this._gl;
    if (gl) {
      if (this._program) {
        gl.deleteProgram(this._program);
      }
      for (const batch of this._batches) {
        gl.deleteBuffer(batch.positions);
        gl.deleteBuffer(batch.normals);
        gl.deleteBuffer(batch.featureIndices);
        gl.deleteVertexArray(batch.vao);
      }
      if (this._stateTex) {
        gl.deleteTexture(this._stateTex.texture);
      }
      if (this._pickIdTarget) {
        gl.deleteTexture(this._pickIdTarget);
      }
      if (this._pickPositionTarget) {
        gl.deleteTexture(this._pickPositionTarget);
      }
      if (this._pickDepth) {
        gl.deleteRenderbuffer(this._pickDepth);
      }
      if (this._pickFramebuffer) {
        gl.deleteFramebuffer(this._pickFramebuffer);
      }
    }
    this._program = null;
    this._attrLoc = null;
    this._uLoc = null;
    this._batches = [];
    this._stateTex = null;
    this._pickIdTarget = null;
    this._pickPositionTarget = null;
    this._pickDepth = null;
    this._pickFramebuffer = null;
  }

  private _bindSharedUniforms(gl: WebGL2RenderingContext, pickMode: number, near: number, far: number): void {
    const program = this._program;
    const uLoc = this._uLoc;
    const stateTex = this._stateTex;
    if (!program || !uLoc || !stateTex) {
      return;
    }
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, stateTex.texture);
    gl.uniform1i(uLoc.featureState, 0);
    gl.uniform2f(uLoc.featureTexSize, stateTex.width, stateTex.height);
    gl.uniform3fv(uLoc.lightDir, this._lightDirLocal);
    gl.uniform1f(uLoc.pickMode, pickMode);
    gl.uniform1f(uLoc.pickDepthEncode, this._pickPath === "rgba8" ? 1 : 0);
    gl.uniform2f(uLoc.pickZRange, near, far);
    gl.uniform1f(uLoc.diagnosticThreshold, this._diagnosticThreshold);
  }

  /** Draw every batch that has at least one visible feature, skipping the
   *  rest so the draw-call count stays honest (gate 6). */
  private _drawVisibleBatches(gl: WebGL2RenderingContext): void {
    const frame = this._frame;
    const uLoc = this._uLoc;
    if (!frame || !uLoc) {
      return;
    }
    // u_matrix / u_modelViewMatrix are scene-wide; only the quantization
    // transform and role color vary per batch.
    const base = mat4Multiply(frame.mvp, this._modelMatrix);
    const baseModelView = mat4Multiply(frame.modelView, this._modelMatrix);

    let drawCalls = 0;
    let visibleBatches = 0;
    for (let i = 0; i < this._batches.length; i++) {
      if (!this._visibleBatches.has(i)) {
        continue;
      }
      const batch = this._batches[i];
      if (!batch) {
        continue;
      }
      const uMatrix = mat4Multiply(base, batch.quantTransform);
      const uModelView = mat4Multiply(baseModelView, batch.quantTransform);
      this._uMatrixF32.set(uMatrix);
      this._uModelViewF32.set(uModelView);
      gl.uniformMatrix4fv(uLoc.matrix, false, this._uMatrixF32);
      gl.uniformMatrix4fv(uLoc.modelView, false, this._uModelViewF32);
      // Quantization is folded into u_matrix/u_modelViewMatrix (precision
      // recipe step 6), so these stay identity by construction.
      gl.uniform3f(uLoc.quantOrigin, 0, 0, 0);
      gl.uniform3f(uLoc.quantScale, 1, 1, 1);
      const color = this._roleColors[batch.role]!; // the record covers all 12 roles
      gl.uniform4f(uLoc.baseColor, color[0], color[1], color[2], 1);
      gl.bindVertexArray(batch.vao);
      gl.drawArrays(gl.TRIANGLES, 0, batch.vertexCount);
      drawCalls++;
      visibleBatches++;
    }
    this._lastDrawCalls = drawCalls;
    this._lastVisibleBatches = visibleBatches;
  }
}

/**
 * Create a MapLibre custom layer that renders `scene`. The layer must be
 * added with `map.addLayer(layer)`; it draws venue batches depth-composed
 * with the basemap and owns its own picking (custom-layer geometry never
 * appears in `queryRenderedFeatures`).
 */
export function createSceneLayer(scene: SceneView, options: SceneLayerOptions): SceneLayer {
  return new SceneLayerImpl(scene, options);
}
