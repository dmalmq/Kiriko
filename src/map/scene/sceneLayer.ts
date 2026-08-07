/**
 * The scene layer: one renderer-owned WebGL2 custom layer inside the existing
 * MapLibre map (#23 D3), drawing the shared render document.
 *
 * The layer knows nothing about scene sources. It receives a `SceneView` —
 * merged `(level, role)` batches of quantized geometry — and draws it with the
 * Architectural Cutaway semantic materials (#32). A generated scene and a
 * derived tile scene reach this code as the same structure, so neither can
 * acquire its own look.
 *
 * Three properties are load-bearing and easy to lose:
 *
 * - **Precision.** Vertices arrive as `u16` inside per-batch bounds and are
 *   dequantized by the model matrix, which is composed in `f64` relative to
 *   the venue anchor. No `f32` value ever holds an un-offset ECEF component.
 * - **Draw calls.** Geometry is merged upstream, so a visible floor costs one
 *   call per semantic role present — the budget is 8 (#26 section 4), and
 *   `stats()` reports what the last frame actually spent.
 * - **Borrowed state.** MapLibre owns the context. Everything this layer
 *   changes is captured on entry and restored on exit, so a render never
 *   leaks depth, blend, or binding state into the basemap's own passes.
 *
 * Picking (#61), the fallback state machine (#62), and the rest of the visual
 * language — labels, occluder fade, provenance badges (#63) — build on this
 * layer rather than inside it. The per-vertex feature index the pick pass
 * needs is already uploaded here, so picking adds a program, not a format.
 */
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import type { SceneBatchView, SceneView, SemanticRoleName } from "./sceneFormat";
import { decodeFeatureId, MAX_PICKABLE_FEATURES, type PickCandidate } from "./scenePick";
import {
  ROLE_COLORS,
  ROLE_DEPTH_BIAS,
  ROLE_PAINT_ORDER,
  ROLE_VERTICAL_NUDGE_MM,
  batchOpacity,
} from "./scenePolicy";
import {
  composeModelMatrix,
  ecefToGeodetic,
  foldQuantization,
  mat4Inverse,
  wgs84Ecef,
  lightDirectionLocal,
  sceneAnchor,
} from "./sceneMath";

/**
 * Ai Indigo `#4F46E5` — the only interaction colour in the product (#32). Every
 * hover, selection, and route state uses this hue and nothing else does.
 */
const INTERACTION_COLOR: readonly [number, number, number] = [0.31, 0.275, 0.898];

/** Fixed ENU key direction: from above, north-west. World-stable by design. */
const KEY_LIGHT_ENU: readonly [number, number, number] = [-0.35, -0.35, 0.87];

/**
 * Attribute locations are declared explicitly so one vertex array serves both
 * the colour and pick programs. Letting the linker choose would let the two
 * disagree, and a pick pass reading positions through the normal's pointer is
 * the kind of bug that looks like "picking is slightly off".
 */
const ATTR_POSITION = 0;
const ATTR_NORMAL = 1;
const ATTR_FEATURE = 2;

const VERTEX_SHADER = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
layout(location = ${ATTR_POSITION}) in vec3 a_position;
layout(location = ${ATTR_NORMAL}) in vec2 a_normal;
layout(location = ${ATTR_FEATURE}) in uint a_featureIndex;
out vec3 v_normal;
// flat: a feature index is a per-surface constant, and interpolating it across
// a triangle lets 747 arrive as 746.9999 — an off-by-one that attributes a
// surface to the wrong feature, and the wrong floor.
flat out uint v_feature;
void main() {
  // Dequantization is folded into u_matrix, so the raw u16 attribute feeds
  // straight through and no intermediate holds a large offset in f32.
  v_normal = vec3(a_normal, 1.0 - abs(a_normal.x) - abs(a_normal.y));
  v_feature = a_featureIndex;
  gl_Position = u_matrix * vec4(a_position, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec3 u_baseColor;
uniform float u_opacity;
uniform vec3 u_lightDir;
uniform vec3 u_interactionColor;
// Feature indices shifted by one, so 0 means "nothing selected / hovered".
uniform uint u_selected;
uniform uint u_hovered;
in vec3 v_normal;
flat in uint v_feature;
out vec4 outColor;
void main() {
  vec3 normal = normalize(v_normal);
  float key = max(dot(normal, u_lightDir), 0.0);
  // A calm matte model: one world-stable soft key over a broad hemisphere
  // fill. The darkest a surface may go is 12% below its own colour (#32
  // section 5) — a wall turned away from the key still reads as cool stone,
  // never as a hole.
  float light = mix(0.88, 1.0, key);
  vec3 rgb = u_baseColor * light;
  // One interaction colour, two strengths: selection reads clearly, hover only
  // hints. Nothing else in the scene may use this hue (#32).
  uint shifted = v_feature + 1u;
  if (shifted == u_selected) {
    rgb = mix(rgb, u_interactionColor, 0.22);
  } else if (shifted == u_hovered) {
    rgb = mix(rgb, u_interactionColor, 0.10);
  }
  // Premultiplied alpha: MapLibre's blend convention.
  outColor = vec4(rgb * u_opacity, u_opacity);
}
`;

/**
 * The pick pass. Two colour attachments: the feature id, and the venue-local
 * position under the pixel. Position comes out of attachment 1 directly rather
 * than being reconstructed from depth, so "place at this point" reads a
 * measured coordinate instead of an inverse-projection estimate.
 *
 * GLSL ES 3.0 requires explicit output locations once a shader declares more
 * than one; without them the program fails to link on Chromium/ANGLE.
 */
const PICK_VERTEX_SHADER = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec3 u_localOrigin;
uniform vec3 u_localScale;
layout(location = ${ATTR_POSITION}) in vec3 a_position;
layout(location = ${ATTR_NORMAL}) in vec2 a_normal;
layout(location = ${ATTR_FEATURE}) in uint a_featureIndex;
flat out uint v_feature;
out vec3 v_localPos;
void main() {
  // The draw path folds dequantization into u_matrix; the pick path needs the
  // true venue-local metres as well, so it dequantizes from the batch's own
  // terms in parallel.
  v_localPos = u_localOrigin + a_position * u_localScale;
  v_feature = a_featureIndex;
  gl_Position = u_matrix * vec4(a_position, 1.0);
}
`;

const PICK_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
flat in uint v_feature;
in vec3 v_localPos;
layout(location = 0) out vec4 outFeature;
layout(location = 1) out vec4 outLocalPosition;
void main() {
  // Shifted by one so a cleared target (all zero) stays "no hit".
  uint shifted = v_feature + 1u;
  outFeature = vec4(
    float(shifted & 0xffu),
    float((shifted >> 8) & 0xffu),
    float((shifted >> 16) & 0xffu),
    255.0
  ) / 255.0;
  outLocalPosition = vec4(v_localPos, 1.0);
}
`;

interface BatchResources {
  vao: WebGLVertexArrayObject;
  positions: WebGLBuffer;
  normals: WebGLBuffer;
  /** Uploaded for the pick pass (#61); the colour program does not read it. */
  featureIndices: WebGLBuffer;
  vertexCount: number;
  levelIndex: number;
  role: SemanticRoleName;
  /** Depth-buffer bias resolving coplanar geometry against its neighbours. */
  depthBias: number;
  /** Model matrix with this batch's dequantization folded in, `f64`. */
  matrix: Float64Array;
  /** The batch's own dequantization terms, for the pick pass's position out. */
  quantizationOrigin: readonly [number, number, number];
  quantizationScale: readonly [number, number, number];
}

export interface SceneLayerStats {
  /** Draw calls issued by the last frame. */
  drawCalls: number;
  /** Batches the current visibility rules select. */
  visibleBatches: number;
  /** Batches the scene carries in total. */
  totalBatches: number;
  vertices: number;
  /**
   * Wall time of the last pick, milliseconds: the pass render plus the
   * synchronous readbacks. The budget is 8 ms (#26 section 4); `null` until a
   * pick has run.
   */
  lastPickMs: number | null;
  /**
   * Picks run since the layer was added. Counting them is how the suppression
   * rule is observable: no pick may run while the camera moves, and exactly one
   * runs when it settles.
   */
  pickCount: number;
}

/**
 * The renderer's diagnostics handle. The browser performance harness asserts
 * the structural budgets (#26 section 4) against what a real frame spent, so
 * the numbers have to leave the layer somehow; this is that seam, and it is
 * deliberately read-only and tiny. Present exactly while a scene layer is
 * attached.
 */
export interface SceneDiagnostics {
  stats(): SceneLayerStats;
  /** Pick at canvas CSS pixels, for the browser harness. */
  pickAt(x: number, y: number): PickCandidate | null;
  /** Whether the float pick path — the only supported one — is available. */
  pickable(): boolean;
  /** The feature index currently hovered, or `-1`. */
  hoveredFeatureIndex(): number;
  /** The camera's pitch ceiling while this layer is attached. */
  maxPitch(): number;
  sourceHash: string;
  levelCount: number;
  /** Canonical level ids in the document's own index order. */
  levelIds: readonly string[];
  activeLevelIndex(): number;
}

/** Global key carrying `SceneDiagnostics` while the layer is attached. */
export const SCENE_DIAGNOSTICS_KEY = "__kirikoScene";

export interface SceneLayerOptions {
  id?: string;
  /** Index into `scene.levels`; the floor drawn at full opacity. */
  activeLevelIndex?: number;
  /** Draw the other floors as quiet context. */
  showContextLevels?: boolean;
}

/** GL state this layer borrows from MapLibre and returns unchanged. */
interface BorrowedGlState {
  depthTest: boolean;
  depthWriteMask: boolean;
  depthFunc: number;
  cullFace: boolean;
  blend: boolean;
  blendSrcRgb: number;
  blendDstRgb: number;
  scissorTest: boolean;
  scissorBox: [number, number, number, number];
  polygonOffsetFill: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
  arrayBufferBinding: WebGLBuffer | null;
  vertexArrayBinding: WebGLVertexArrayObject | null;
  currentProgram: WebGLProgram | null;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("scene: WebGL failed to create a shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown";
    gl.deleteShader(shader);
    throw new Error(`scene: shader compile failed: ${log}`);
  }
  return shader;
}

/**
 * The scissor box, defensively. A context that dies mid-frame answers
 * `getParameter` with `null`, and spreading that throws from inside the
 * renderer during teardown — the one moment nothing should be throwing.
 */
function readScissorBox(gl: WebGL2RenderingContext): [number, number, number, number] {
  const box = gl.getParameter(gl.SCISSOR_BOX) as Int32Array | null;
  if (box === null || box.length < 4) {
    return [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight];
  }
  return [box[0]!, box[1]!, box[2]!, box[3]!];
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error("scene: WebGL failed to create a program");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown";
    gl.deleteProgram(program);
    throw new Error(`scene: program link failed: ${log}`);
  }
  return program;
}

/**
 * The custom layer. Construct it with a scene, hand it to `map.addLayer`, and
 * remove it with `map.removeLayer`; the layer allocates GPU resources in
 * `onAdd` and releases every one of them in `onRemove`.
 */
export class SceneLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private readonly _scene: SceneView;
  private readonly _model: Float64Array;
  private readonly _lightDir: Float32Array;
  private readonly _matrixF32 = new Float32Array(16);

  private _map: MapLibreMap | null = null;
  private _gl: WebGL2RenderingContext | null = null;
  private _program: WebGLProgram | null = null;
  private _uniforms: {
    matrix: WebGLUniformLocation;
    baseColor: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
    lightDir: WebGLUniformLocation;
    interactionColor: WebGLUniformLocation;
    selected: WebGLUniformLocation;
    hovered: WebGLUniformLocation;
  } | null = null;
  private _batches: BatchResources[] = [];
  private _pickProgram: WebGLProgram | null = null;
  private _pickUniforms: {
    matrix: WebGLUniformLocation;
    localOrigin: WebGLUniformLocation;
    localScale: WebGLUniformLocation;
  } | null = null;
  private _pickTargets: {
    framebuffer: WebGLFramebuffer;
    feature: WebGLTexture;
    position: WebGLTexture;
    depth: WebGLRenderbuffer;
    width: number;
    height: number;
  } | null = null;
  /** The frame's view-projection, kept so a pick can render the same camera. */
  private _viewProjection: Float64Array | null = null;
  private _pickWarmed = false;
  private _worldInverseCache: Float64Array | null = null;
  private _selectedFeature = 0;
  private _hoveredFeature = 0;
  private _contextLost = false;
  private _activeLevelIndex: number;
  private _showContextLevels: boolean;
  private _stats: SceneLayerStats;

  constructor(scene: SceneView, options: SceneLayerOptions = {}) {
    this._scene = scene;
    this.id = options.id ?? "kiriko-scene";
    this._activeLevelIndex = Math.min(
      Math.max(0, Math.floor(options.activeLevelIndex ?? 0)),
      Math.max(0, scene.levels.length - 1),
    );
    this._showContextLevels = options.showContextLevels ?? false;

    const anchor = sceneAnchor(scene.header.frameOriginEcef);
    this._model = composeModelMatrix(
      scene.header.frameOriginEcef,
      scene.header.worldTransform,
      anchor.geodetic,
      anchor.mercatorOrigin,
      anchor.metreScale,
    );
    this._lightDir = lightDirectionLocal(
      scene.header.worldTransform,
      scene.header.frameOriginEcef,
      KEY_LIGHT_ENU,
    );
    this._stats = {
      drawCalls: 0,
      visibleBatches: 0,
      totalBatches: scene.batches.length,
      vertices: scene.batches.reduce((total, batch) => total + batch.vertexCount, 0),
      lastPickMs: null,
      pickCount: 0,
    };
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext)) {
      // The capability floor is a hard gate: a WebGL1 context means the 2D
      // fallback should have been chosen instead of this layer (#26 section 1).
      throw new Error("scene: the scene layer requires a WebGL2 context");
    }
    this._map = map;
    this._gl = gl;
    this._contextLost = false;
    this._buildProgram(gl);
    this._buildBatches(gl);
    this._buildPick(gl);
  }

  onRemove(_map: MapLibreMap, _gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this._release();
    this._gl = null;
    this._map = null;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!(gl instanceof WebGL2RenderingContext) || this._contextLost || gl.isContextLost()) {
      return;
    }
    const program = this._program;
    const uniforms = this._uniforms;
    if (!program || !uniforms || this._batches.length === 0) {
      return;
    }

    const borrowed = this._save(gl);
    let drawCalls = 0;
    try {
      // `defaultProjectionData.mainMatrix` consumes mercator [0, 1]
      // coordinates, which is the space the model matrix produces.
      // `modelViewProjectionMatrix` consumes mercator × worldSize instead, and
      // using it places the scene entirely off-screen.
      const viewProjection = Float64Array.from(options.defaultProjectionData.mainMatrix);

      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      // Indoor geometry is authored without a reliable winding convention, and
      // a wall seen from its back face is still a wall.
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.POLYGON_OFFSET_FILL);

      this._viewProjection = viewProjection;

      gl.useProgram(program);
      gl.uniform3fv(uniforms.lightDir, this._lightDir);
      gl.uniform3f(
        uniforms.interactionColor,
        INTERACTION_COLOR[0],
        INTERACTION_COLOR[1],
        INTERACTION_COLOR[2],
      );
      gl.uniform1ui(uniforms.selected, this._selectedFeature);
      gl.uniform1ui(uniforms.hovered, this._hoveredFeature);

      let visible = 0;
      for (const batch of this._batches) {
        const opacity = batchOpacity(batch, {
          activeLevelIndex: this._activeLevelIndex,
          showContextLevels: this._showContextLevels,
        });
        if (opacity <= 0) {
          continue;
        }
        visible += 1;
        const color = ROLE_COLORS[batch.role];
        // f64 compose, downcast once: the translation is already anchor-
        // relative, so f32 keeps sub-millimetre resolution across the venue.
        const matrix = this._multiply(viewProjection, batch.matrix);
        for (let index = 0; index < 16; index += 1) {
          this._matrixF32[index] = matrix[index]!;
        }
        gl.uniformMatrix4fv(uniforms.matrix, false, this._matrixF32);
        gl.uniform3f(uniforms.baseColor, color[0], color[1], color[2]);
        gl.uniform1f(uniforms.opacity, opacity);
        gl.polygonOffset(0, batch.depthBias);
        gl.bindVertexArray(batch.vao);
        gl.drawArrays(gl.TRIANGLES, 0, batch.vertexCount);
        drawCalls += 1;
      }
      this._stats = { ...this._stats, drawCalls, visibleBatches: visible };
      // The first pick a driver runs pays for validating the multi-target float
      // path — measured near 20 ms against 2 ms warm. Spending it here, once,
      // during load hides it where nothing is waiting on it; leaving it to the
      // first hover would put a visible hitch on the reviewer's first move.
      if (!this._pickWarmed && this._pickTargets !== null) {
        this._pickWarmed = true;
        requestAnimationFrame(() => {
          this.pickAt(0, 0);
        });
      }
    } finally {
      this._restore(gl, borrowed);
    }
  }

  /**
   * The scene surface under a canvas point, or `null` when the pointer is over
   * nothing this layer drew.
   *
   * The depth buffer is the occlusion authority: the pass renders exactly the
   * batches the colour pass draws, with the same depth bias, so what wins the
   * pick is what the reviewer can see — the nearest visible floor, resolved by
   * the same rules that resolved the picture. No CPU ray, no floor guessing.
   */
  pickAt(x: number, y: number): PickCandidate | null {
    const gl = this._gl;
    const targets = this._pickTargets;
    const program = this._pickProgram;
    const uniforms = this._pickUniforms;
    const viewProjection = this._viewProjection;
    if (
      this._contextLost ||
      gl === null ||
      gl.isContextLost() ||
      targets === null ||
      program === null ||
      uniforms === null ||
      viewProjection === null
    ) {
      return null;
    }

    const started = performance.now();
    const canvas = gl.canvas;
    const cssWidth = canvas instanceof HTMLCanvasElement ? canvas.clientWidth : gl.drawingBufferWidth;
    const ratio = gl.drawingBufferWidth / Math.max(1, cssWidth);
    const pixelX = Math.round(x * ratio);
    // GL reads from the bottom-left; canvas coordinates come from the top-left.
    const pixelY = gl.drawingBufferHeight - Math.round(y * ratio) - 1;
    if (
      pixelX < 0 ||
      pixelY < 0 ||
      pixelX >= gl.drawingBufferWidth ||
      pixelY >= gl.drawingBufferHeight
    ) {
      return null;
    }

    const borrowed = this._save(gl);
    const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    try {
      if (targets.width !== gl.drawingBufferWidth || targets.height !== gl.drawingBufferHeight) {
        this._resizePickTargets(gl);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets.framebuffer);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      // The camera has to match the frame exactly — the pick must agree with
      // the picture — but only one pixel of it is ever read, so the scissor
      // confines both the clear and the rasterizer to that pixel. Without it
      // the pass shades a full-screen scene to answer a question about 1 px.
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(pixelX, pixelY, 1, 1);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      gl.useProgram(program);
      for (const batch of this._batches) {
        // Only what the reviewer can see is pickable: a hidden floor or a
        // hidden ceiling must not intercept a click on the room below it.
        if (
          batchOpacity(batch, {
            activeLevelIndex: this._activeLevelIndex,
            showContextLevels: this._showContextLevels,
          }) < 1
        ) {
          continue;
        }
        const matrix = this._multiply(viewProjection, batch.matrix);
        for (let index = 0; index < 16; index += 1) {
          this._matrixF32[index] = matrix[index]!;
        }
        gl.uniformMatrix4fv(uniforms.matrix, false, this._matrixF32);
        gl.uniform3f(
          uniforms.localOrigin,
          batch.quantizationOrigin[0],
          batch.quantizationOrigin[1],
          batch.quantizationOrigin[2],
        );
        gl.uniform3f(
          uniforms.localScale,
          batch.quantizationScale[0],
          batch.quantizationScale[1],
          batch.quantizationScale[2],
        );
        gl.polygonOffset(0, batch.depthBias);
        gl.bindVertexArray(batch.vao);
        gl.drawArrays(gl.TRIANGLES, 0, batch.vertexCount);
      }

      // With MRT, `readPixels` samples whichever attachment `readBuffer` names;
      // without switching it the second read would re-sample the id colour.
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      const idPixel = new Uint8Array(4);
      gl.readPixels(pixelX, pixelY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, idPixel);
      const featureIndex = decodeFeatureId(idPixel);
      if (featureIndex < 0) {
        return null;
      }
      const feature = this._scene.features[featureIndex];
      if (feature === undefined) {
        return null;
      }
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      const localPixel = new Float32Array(4);
      gl.readPixels(pixelX, pixelY, 1, 1, gl.RGBA, gl.FLOAT, localPixel);

      return {
        kind: "surface",
        featureIndex,
        canonicalFeatureId: feature.canonicalId,
        levelId: this._scene.levels[feature.levelIndex]?.canonicalId ?? "",
        sourceObjectId: feature.sourceObjectId,
        role: feature.role,
        localPoint: [localPixel[0] ?? 0, localPixel[1] ?? 0, localPixel[2] ?? 0],
        featureMinZ: feature.minZ,
        featureMaxZ: feature.maxZ,
      };
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
      gl.drawBuffers([gl.BACK]);
      this._restore(gl, borrowed);
      this._stats = {
        ...this._stats,
        lastPickMs: performance.now() - started,
        pickCount: this._stats.pickCount + 1,
      };
    }
  }

  /**
   * A longitude and latitude as venue-local metres on a given floor — the exact
   * inverse of `localToLngLat`, and the same projection the compiler used, so a
   * 2D feature's centre lands on its own floor rather than near it.
   */
  localFromLngLat(lng: number, lat: number, levelIndex: number): [number, number, number] {
    const ecef = wgs84Ecef(lng, lat);
    const inverse = this._worldInverse();
    const relative = [
      ecef[0] - this._scene.header.worldTransform[12]!,
      ecef[1] - this._scene.header.worldTransform[13]!,
      ecef[2] - this._scene.header.worldTransform[14]!,
    ];
    return [
      inverse[0]! * relative[0]! + inverse[4]! * relative[1]! + inverse[8]! * relative[2]!,
      inverse[1]! * relative[0]! + inverse[5]! * relative[1]! + inverse[9]! * relative[2]!,
      this.levelPlane(levelIndex),
    ];
  }

  /** The world transform's inverse rotation, computed once. */
  private _worldInverse(): Float64Array {
    this._worldInverseCache ??= mat4Inverse(Float64Array.from(this._scene.header.worldTransform));
    return this._worldInverseCache;
  }

  /**
   * Where a venue-local point lands on screen, in canvas CSS pixels, or `null`
   * when the camera cannot see it.
   *
   * Labels need this rather than MapLibre's `project`, which takes a longitude
   * and latitude and answers for the map plane at zero elevation. A label for a
   * surface twelve metres up would sit metres away from the thing it names.
   */
  projectLocal(local: readonly [number, number, number]): { x: number; y: number } | null {
    const viewProjection = this._viewProjection;
    const gl = this._gl;
    if (viewProjection === null || gl === null) {
      return null;
    }
    const matrix = this._multiply(viewProjection, this._model);
    const clip = [0, 0, 0, 0];
    for (let row = 0; row < 4; row += 1) {
      clip[row] =
        matrix[row]! * local[0] +
        matrix[4 + row]! * local[1] +
        matrix[8 + row]! * local[2] +
        matrix[12 + row]!;
    }
    const w = clip[3]!;
    if (!Number.isFinite(w) || w <= 0) {
      // Behind the camera, or degenerate: there is no on-screen position.
      return null;
    }
    const canvas = gl.canvas;
    const width = canvas instanceof HTMLCanvasElement ? canvas.clientWidth : gl.drawingBufferWidth;
    const height =
      canvas instanceof HTMLCanvasElement ? canvas.clientHeight : gl.drawingBufferHeight;
    return {
      x: ((clip[0]! / w) * 0.5 + 0.5) * width,
      // Clip space y grows upward; screen y grows downward.
      y: (0.5 - (clip[1]! / w) * 0.5) * height,
    };
  }

  /** The resolved plane of a level, in venue-local metres. */
  levelPlane(levelIndex: number): number {
    return this._scene.levels[levelIndex]?.resolvedPlaneZ ?? 0;
  }

  /**
   * Where a venue-local point is on the earth. The scene's world transform maps
   * local metres to ECEF by construction, so this is the exact inverse of the
   * projection the compiler used — not a re-derivation.
   *
   * This is what makes a pick placeable. MapLibre's own `lngLat` for a pointer
   * event unprojects onto the map plane at zero elevation, so on a pitched
   * camera a click on an upper floor reports a position metres away from the
   * surface actually clicked.
   */
  localToLngLat(local: readonly [number, number, number]): { lng: number; lat: number } {
    const transform = this._scene.header.worldTransform;
    const ecef: [number, number, number] = [
      transform[0]! * local[0] + transform[4]! * local[1] + transform[8]! * local[2] + transform[12]!,
      transform[1]! * local[0] + transform[5]! * local[1] + transform[9]! * local[2] + transform[13]!,
      transform[2]! * local[0] + transform[6]! * local[1] + transform[10]! * local[2] + transform[14]!,
    ];
    const geodetic = ecefToGeodetic(ecef);
    return {
      lng: (geodetic.lonRad * 180) / Math.PI,
      lat: (geodetic.latRad * 180) / Math.PI,
    };
  }

  /**
   * Highlight the selected feature, by source object id. Passing `null` clears
   * it. This is what makes panel selection and scene selection the same thing —
   * including for a keyboard user who never touches the canvas.
   */
  setSelectedSourceObject(sourceObjectId: string | null): void {
    this._selectedFeature = this._shiftedIndexOf(sourceObjectId);
    this._map?.triggerRepaint();
  }

  /** Highlight the hovered feature by index; `-1` clears it. */
  setHoveredFeature(featureIndex: number): void {
    const shifted = featureIndex >= 0 && featureIndex < this._scene.features.length
      ? featureIndex + 1
      : 0;
    if (shifted === this._hoveredFeature) {
      return;
    }
    this._hoveredFeature = shifted;
    this._map?.triggerRepaint();
  }

  /**
   * Highlight every primitive that represents one canonical venue feature. A
   * unit is a floor surface plus its ceiling and walls, so selecting "the shop"
   * from a list has to mean more than one primitive.
   */
  setSelectedCanonicalFeature(canonicalFeatureId: string | null): void {
    if (canonicalFeatureId === null) {
      this._selectedFeature = 0;
      this._map?.triggerRepaint();
      return;
    }
    const index = this._scene.features.findIndex(
      (feature) => feature.canonicalId === canonicalFeatureId,
    );
    this._selectedFeature = index < 0 ? 0 : index + 1;
    this._map?.triggerRepaint();
  }

  private _shiftedIndexOf(sourceObjectId: string | null): number {
    if (sourceObjectId === null) {
      return 0;
    }
    const index = this._scene.features.findIndex(
      (feature) => feature.sourceObjectId === sourceObjectId,
    );
    return index < 0 ? 0 : index + 1;
  }

  private _resizePickTargets(gl: WebGL2RenderingContext): void {
    const targets = this._pickTargets;
    if (targets === null) {
      return;
    }
    const width = Math.max(1, gl.drawingBufferWidth);
    const height = Math.max(1, gl.drawingBufferHeight);
    gl.bindTexture(gl.TEXTURE_2D, targets.feature);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, targets.position);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, targets.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    targets.width = width;
    targets.height = height;
  }

  /** Draw a different floor at full opacity. */
  setActiveLevel(levelIndex: number): void {
    this._activeLevelIndex = Math.min(
      Math.max(0, Math.floor(levelIndex)),
      Math.max(0, this._scene.levels.length - 1),
    );
  }

  /** Show or hide the other floors as quiet context. */
  setShowContextLevels(show: boolean): void {
    this._showContextLevels = show;
  }

  /** What the last frame cost, for the performance harness and diagnostics. */
  stats(): SceneLayerStats {
    return { ...this._stats };
  }

  /** The read-only diagnostics view of this layer. */
  diagnostics(): SceneDiagnostics {
    return {
      stats: () => this.stats(),
      pickAt: (x, y) => this.pickAt(x, y),
      pickable: () => this._pickTargets !== null,
      hoveredFeatureIndex: () => this._hoveredFeature - 1,
      maxPitch: () => this._map?.getMaxPitch() ?? 0,
      sourceHash: this._scene.header.sourceHash,
      levelCount: this._scene.levels.length,
      levelIds: this._scene.levels.map((level) => level.canonicalId),
      activeLevelIndex: () => this._activeLevelIndex,
    };
  }

  /** The level index a canonical level id maps to, or `null` when absent. */
  levelIndexOf(canonicalId: string): number | null {
    const index = this._scene.levels.findIndex((level) => level.canonicalId === canonicalId);
    return index < 0 ? null : index;
  }

  /**
   * Mark the context lost. The layer stops touching GL objects that no longer
   * exist; re-establishing the view is the recovery slice's decision (#62), not
   * something this layer does behind the caller's back.
   */
  markContextLost(): void {
    this._contextLost = true;
    this._batches = [];
    this._program = null;
    this._uniforms = null;
    this._pickProgram = null;
    this._pickUniforms = null;
    this._pickTargets = null;
  }

  /** Column-major 4x4 multiply in `f64`, allocation-free per frame. */
  private _multiply(a: Float64Array, b: Float64Array): Float64Array {
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

  private _buildProgram(gl: WebGL2RenderingContext): void {
    const program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    const matrix = gl.getUniformLocation(program, "u_matrix");
    const baseColor = gl.getUniformLocation(program, "u_baseColor");
    const opacity = gl.getUniformLocation(program, "u_opacity");
    const lightDir = gl.getUniformLocation(program, "u_lightDir");
    const interactionColor = gl.getUniformLocation(program, "u_interactionColor");
    const selected = gl.getUniformLocation(program, "u_selected");
    const hovered = gl.getUniformLocation(program, "u_hovered");
    if (
      !matrix ||
      !baseColor ||
      !opacity ||
      !lightDir ||
      !interactionColor ||
      !selected ||
      !hovered
    ) {
      gl.deleteProgram(program);
      throw new Error("scene: program is missing a required uniform");
    }
    this._program = program;
    this._uniforms = {
      matrix,
      baseColor,
      opacity,
      lightDir,
      interactionColor,
      selected,
      hovered,
    };
  }

  /**
   * The pick program and its render targets. Without `EXT_color_buffer_float`
   * there is no supported pick path — the RGBA8 depth approximation the spike
   * measured is evidence, not a product — so picking simply reports
   * unavailable and the capability floor (#62) is what decides what to do
   * about it.
   */
  private _buildPick(gl: WebGL2RenderingContext): void {
    if (gl.getExtension("EXT_color_buffer_float") === null) {
      return;
    }
    if (this._scene.features.length > MAX_PICKABLE_FEATURES) {
      throw new Error(
        `scene: ${this._scene.features.length} features exceed the pickable range`,
      );
    }
    const program = linkProgram(gl, PICK_VERTEX_SHADER, PICK_FRAGMENT_SHADER);
    const matrix = gl.getUniformLocation(program, "u_matrix");
    const localOrigin = gl.getUniformLocation(program, "u_localOrigin");
    const localScale = gl.getUniformLocation(program, "u_localScale");
    if (!matrix || !localOrigin || !localScale) {
      gl.deleteProgram(program);
      throw new Error("scene: pick program is missing a required uniform");
    }
    this._pickProgram = program;
    this._pickUniforms = { matrix, localOrigin, localScale };
    this._createPickTargets(gl);
  }

  private _createPickTargets(gl: WebGL2RenderingContext): void {
    const width = Math.max(1, gl.drawingBufferWidth);
    const height = Math.max(1, gl.drawingBufferHeight);
    const feature = gl.createTexture();
    const position = gl.createTexture();
    const depth = gl.createRenderbuffer();
    const framebuffer = gl.createFramebuffer();
    if (!feature || !position || !depth || !framebuffer) {
      throw new Error("scene: WebGL failed to create the pick framebuffer");
    }

    gl.bindTexture(gl.TEXTURE_2D, feature);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, position);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, feature, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, position, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(feature);
      gl.deleteTexture(position);
      gl.deleteRenderbuffer(depth);
      throw new Error(`scene: pick framebuffer incomplete: 0x${status.toString(16)}`);
    }
    this._pickTargets = { framebuffer, feature, position, depth, width, height };
  }

  private _buildBatches(gl: WebGL2RenderingContext): void {
    this._batches = this._scene.batches
      .map((batch) => this._createBatch(gl, batch))
      // Paint order is the renderer's own concern, not the producer's: batches
      // arrive keyed by (level, role) and are composited by role here.
      .sort((left, right) => ROLE_PAINT_ORDER[left.role] - ROLE_PAINT_ORDER[right.role]);
  }

  private _createBatch(gl: WebGL2RenderingContext, batch: SceneBatchView): BatchResources {
    const positions = gl.createBuffer();
    const normals = gl.createBuffer();
    const featureIndices = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!positions || !normals || !featureIndices || !vao) {
      throw new Error("scene: WebGL failed to create a batch resource");
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, positions);
    gl.bufferData(gl.ARRAY_BUFFER, batch.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, normals);
    gl.bufferData(gl.ARRAY_BUFFER, batch.normals, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, featureIndices);
    gl.bufferData(gl.ARRAY_BUFFER, batch.featureIndices, gl.STATIC_DRAW);

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, positions);
    gl.enableVertexAttribArray(ATTR_POSITION);
    // `u16` positions, unnormalized: the matrix dequantizes them.
    gl.vertexAttribPointer(ATTR_POSITION, 3, gl.UNSIGNED_SHORT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, normals);
    gl.enableVertexAttribArray(ATTR_NORMAL);
    // Octahedral `i16`, normalized to [-1, 1] for the shader's reconstruction.
    gl.vertexAttribPointer(ATTR_NORMAL, 2, gl.SHORT, true, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, featureIndices);
    gl.enableVertexAttribArray(ATTR_FEATURE);
    // Integer attribute: never normalized, never converted to float.
    gl.vertexAttribIPointer(ATTR_FEATURE, 1, gl.UNSIGNED_INT, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    return {
      vao,
      positions,
      normals,
      featureIndices,
      vertexCount: batch.vertexCount,
      levelIndex: batch.levelIndex,
      role: batch.role,
      depthBias: ROLE_DEPTH_BIAS[batch.role],
      quantizationOrigin: batch.quantizationOrigin,
      quantizationScale: batch.quantizationScale,
      matrix: foldQuantization(
        this._model,
        batch.quantizationOrigin,
        batch.quantizationScale,
        ROLE_VERTICAL_NUDGE_MM[batch.role] / 1000,
      ),
    };
  }

  private _release(): void {
    const gl = this._gl;
    if (gl && !this._contextLost) {
      for (const batch of this._batches) {
        gl.deleteBuffer(batch.positions);
        gl.deleteBuffer(batch.normals);
        gl.deleteBuffer(batch.featureIndices);
        gl.deleteVertexArray(batch.vao);
      }
      if (this._program) {
        gl.deleteProgram(this._program);
      }
      if (this._pickProgram) {
        gl.deleteProgram(this._pickProgram);
      }
      if (this._pickTargets) {
        gl.deleteFramebuffer(this._pickTargets.framebuffer);
        gl.deleteTexture(this._pickTargets.feature);
        gl.deleteTexture(this._pickTargets.position);
        gl.deleteRenderbuffer(this._pickTargets.depth);
      }
    }
    this._batches = [];
    this._program = null;
    this._uniforms = null;
    this._pickProgram = null;
    this._pickUniforms = null;
    this._pickTargets = null;
    this._viewProjection = null;
    this._pickWarmed = false;
  }

  private _save(gl: WebGL2RenderingContext): BorrowedGlState {
    return {
      depthTest: gl.getParameter(gl.DEPTH_TEST) as boolean,
      depthWriteMask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
      depthFunc: gl.getParameter(gl.DEPTH_FUNC) as number,
      cullFace: gl.getParameter(gl.CULL_FACE) as boolean,
      blend: gl.getParameter(gl.BLEND) as boolean,
      blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB) as number,
      blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB) as number,
      scissorTest: gl.getParameter(gl.SCISSOR_TEST) as boolean,
      scissorBox: readScissorBox(gl),
      polygonOffsetFill: gl.getParameter(gl.POLYGON_OFFSET_FILL) as boolean,
      polygonOffsetFactor: gl.getParameter(gl.POLYGON_OFFSET_FACTOR) as number,
      polygonOffsetUnits: gl.getParameter(gl.POLYGON_OFFSET_UNITS) as number,
      arrayBufferBinding: gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null,
      vertexArrayBinding: gl.getParameter(
        gl.VERTEX_ARRAY_BINDING,
      ) as WebGLVertexArrayObject | null,
      currentProgram: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
    };
  }

  private _restore(gl: WebGL2RenderingContext, state: BorrowedGlState): void {
    if (state.depthTest) {
      gl.enable(gl.DEPTH_TEST);
    } else {
      gl.disable(gl.DEPTH_TEST);
    }
    gl.depthMask(state.depthWriteMask);
    gl.depthFunc(state.depthFunc);
    if (state.cullFace) {
      gl.enable(gl.CULL_FACE);
    } else {
      gl.disable(gl.CULL_FACE);
    }
    if (state.blend) {
      gl.enable(gl.BLEND);
    } else {
      gl.disable(gl.BLEND);
    }
    gl.blendFunc(state.blendSrcRgb, state.blendDstRgb);
    if (state.scissorTest) {
      gl.enable(gl.SCISSOR_TEST);
    } else {
      gl.disable(gl.SCISSOR_TEST);
    }
    gl.scissor(state.scissorBox[0], state.scissorBox[1], state.scissorBox[2], state.scissorBox[3]);
    if (state.polygonOffsetFill) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
    } else {
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    gl.polygonOffset(state.polygonOffsetFactor, state.polygonOffsetUnits);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBufferBinding);
    gl.bindVertexArray(state.vertexArrayBinding);
    gl.useProgram(state.currentProgram);
  }
}
