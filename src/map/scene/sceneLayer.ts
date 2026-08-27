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
 *   call per merged batch — the budget is 8 (#26 section 4), and
 *   `stats()` reports what the last frame actually spent. Illustrated
 *   conveyances are a sibling batch so a leftover shell can stay see-through.
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
import type { NetworkConnectionId } from "../networkFeatures";
import {
  buildConnectorMesh,
  type ConnectorEndpoint,
  type ConnectorInput,
  type ConnectorMesh,
} from "./sceneConnectors";
import {
  decodeFeatureId,
  MAX_PICKABLE_FEATURES,
  PICK_ALPHA_CONNECTOR,
  type PickCandidate,
} from "./scenePick";
import {
  CONNECTOR_COLOR,
  CONNECTOR_HIT_WIDTH_PX,
  CONNECTOR_SELECTED_WIDTH_PX,
  CONNECTOR_WIDTH_PX,
  CONTEXT_LEVEL_OPACITY,
  ROLE_COLORS,
  ROLE_DEPTH_BIAS,
  ROLE_PAINT_ORDER,
  ROLE_VERTICAL_NUDGE_MM,
  batchPickable,
  planSceneDraw,
  type PlannedBatch,
  type VisibilityState,
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
const ATTR_COLOR = 3;

const VERTEX_SHADER = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
layout(location = ${ATTR_POSITION}) in vec3 a_position;
layout(location = ${ATTR_NORMAL}) in vec2 a_normal;
layout(location = ${ATTR_FEATURE}) in uint a_featureIndex;
layout(location = ${ATTR_COLOR}) in vec3 a_color;
out vec3 v_normal;
out vec3 v_color;
// flat: a feature index is a per-surface constant, and interpolating it across
// a triangle lets 747 arrive as 746.9999 — an off-by-one that attributes a
// surface to the wrong feature, and the wrong floor.
flat out uint v_feature;
void main() {
  // Dequantization is folded into u_matrix, so the raw u16 attribute feeds
  // straight through and no intermediate holds a large offset in f32.
  v_normal = vec3(a_normal, 1.0 - abs(a_normal.x) - abs(a_normal.y));
  v_color = a_color;
  v_feature = a_featureIndex;
  gl_Position = u_matrix * vec4(a_position, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform float u_opacity;
uniform vec3 u_lightDir;
uniform vec3 u_interactionColor;
// Feature indices shifted by one, so 0 means "nothing selected / hovered".
uniform uint u_selected;
uniform uint u_hovered;
in vec3 v_normal;
in vec3 v_color;
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
  vec3 rgb = v_color * light;
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

/**
 * The inter-floor connector pass. Attribute locations are its own; the program
 * shares nothing with the surface pass but the frame.
 */
const ATTR_CONNECTOR_POSITION = 0;
const ATTR_CONNECTOR_OTHER = 1;
const ATTR_CONNECTOR_SIDE = 2;
const ATTR_CONNECTOR_ID = 3;

/**
 * One vertex shader for both connector passes, so the ribbon a reviewer clicks
 * is exactly the ribbon they can see. GPU picking is per-pixel and has no hit
 * tolerance, so any disagreement between the two would be a target that misses.
 *
 * The width is applied in screen space: a world-width ribbon would vanish at
 * venue zoom and swallow the floor at door zoom, and rebuilding geometry per
 * zoom step would churn a buffer on every wheel tick.
 */
const CONNECTOR_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_halfWidth;
uniform float u_selectedHalfWidth;
uniform uint u_selected;
layout(location = ${ATTR_CONNECTOR_POSITION}) in vec3 a_position;
layout(location = ${ATTR_CONNECTOR_OTHER}) in vec3 a_other;
layout(location = ${ATTR_CONNECTOR_SIDE}) in float a_side;
layout(location = ${ATTR_CONNECTOR_ID}) in uint a_connector;
flat out uint v_connector;
out vec3 v_localPos;
void main() {
  vec4 own = u_matrix * vec4(a_position, 1.0);
  vec4 opposite = u_matrix * vec4(a_other, 1.0);
  // Guard the perspective divide: an endpoint behind the eye has w <= 0, and
  // the quad is clipped anyway — it must not become NaN on the way there.
  vec2 ownScreen = own.xy / max(abs(own.w), 1e-6) * u_viewport;
  vec2 oppositeScreen = opposite.xy / max(abs(opposite.w), 1e-6) * u_viewport;
  vec2 delta = oppositeScreen - ownScreen;
  // A purely vertical link projects both ends onto one screen point when the
  // camera looks straight down. Falling back to a fixed axis keeps it a visible
  // stub instead of a degenerate triangle.
  vec2 direction = length(delta) < 1e-4 ? vec2(0.0, 1.0) : normalize(delta);
  vec2 normal = vec2(-direction.y, direction.x);
  float halfWidth = (u_selected != 0u && a_connector + 1u == u_selected)
    ? u_selectedHalfWidth
    : u_halfWidth;
  vec2 offset = normal * a_side * halfWidth / u_viewport;
  gl_Position = vec4(own.xy + offset * abs(own.w), own.zw);
  v_connector = a_connector;
  v_localPos = a_position;
}
`;

const CONNECTOR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform vec3 u_color;
uniform vec3 u_selectedColor;
uniform float u_opacity;
uniform uint u_selected;
flat in uint v_connector;
out vec4 outColor;
void main() {
  // One interaction colour for the selected link and the network's own hue for
  // the rest: #32 allows no second hue here.
  vec3 rgb = (u_selected != 0u && v_connector + 1u == u_selected) ? u_selectedColor : u_color;
  outColor = vec4(rgb * u_opacity, u_opacity);
}
`;

const CONNECTOR_PICK_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
flat in uint v_connector;
in vec3 v_localPos;
layout(location = 0) out vec4 outFeature;
layout(location = 1) out vec4 outLocalPosition;
void main() {
  // Shifted by one so a cleared target stays "no hit"; alpha records which
  // pass wrote the pixel, because both share the 24-bit index space.
  uint shifted = v_connector + 1u;
  outFeature = vec4(
    float(shifted & 0xffu),
    float((shifted >> 8) & 0xffu),
    float((shifted >> 16) & 0xffu),
    ${PICK_ALPHA_CONNECTOR}.0
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
  /** Per-vertex RGB, or `null` when the batch paints from `ROLE_COLORS`. */
  colors: WebGLBuffer | null;
  vertexCount: number;
  levelIndex: number;
  role: SemanticRoleName;
  /** Vertex-colored silhouette, so typed conveyances may paint opaque. */
  illustrated: boolean;
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
  /**
   * Wall time the scene's GPU resources took to create, milliseconds: programs,
   * buffers, vertex arrays, and the pick targets. The budget is 200 ms (#26
   * section 4); `null` before the layer is added.
   */
  uploadMs: number | null;
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
  /** The camera the last frame was drawn with. */
  camera(): { zoom: number; pitch: number; bearing: number };
  sourceHash: string;
  levelCount: number;
  /** Canonical level ids in the document's own index order. */
  levelIds: readonly string[];
  /**
   * Resolved plane per level, venue-local metres, in the same index order.
   * Elevation is what decides which floor of a retained pair is looked
   * through, so the harness has to be able to read the number that decided it.
   */
  levelPlanesM: readonly number[];
  activeLevelIndices(): number[];
  /** Registered levels retained as non-pickable route context. */
  contextLevelIndices(): number[];
}

/** Global key carrying `SceneDiagnostics` while the layer is attached. */
export const SCENE_DIAGNOSTICS_KEY = "__kirikoScene";

export interface SceneLayerOptions {
  id?: string;
  /** Index into `scene.levels`; the floor drawn at full opacity. */
  activeLevelIndex?: number;
  /** Registered levels retained as quiet route context. */
  contextLevelIndices?: readonly number[];
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
  private _stats: SceneLayerStats;
  private _connectorProgram: WebGLProgram | null = null;
  private _connectorPickProgram: WebGLProgram | null = null;
  private _connectorUniforms: {
    matrix: WebGLUniformLocation;
    viewport: WebGLUniformLocation;
    halfWidth: WebGLUniformLocation;
    selectedHalfWidth: WebGLUniformLocation;
    selected: WebGLUniformLocation;
    color: WebGLUniformLocation;
    selectedColor: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
  } | null = null;
  private _connectorPickUniforms: {
    matrix: WebGLUniformLocation;
    viewport: WebGLUniformLocation;
    halfWidth: WebGLUniformLocation;
    selectedHalfWidth: WebGLUniformLocation;
    selected: WebGLUniformLocation;
  } | null = null;
  private _connectorBuffers: {
    vao: WebGLVertexArrayObject;
    position: WebGLBuffer;
    other: WebGLBuffer;
    side: WebGLBuffer;
    ids: WebGLBuffer;
  } | null = null;
  private _connectorInputs: readonly ConnectorInput[] = [];
  private _contextGraphInputs: readonly ConnectorInput[] = [];
  private _verticalConnectorCount = 0;
  private _connectorMesh: ConnectorMesh | null = null;
  /** Selected connector index shifted by one; `0` means none. */
  private _selectedConnector = 0;
  private _viewProjection: Float64Array | null = null;
  private _pickWarmed = false;
  private _worldInverseCache: Float64Array | null = null;
  private _selectedFeature = 0;
  private _hoveredFeature = 0;
  private _contextLost = false;
  private _activeLevelIndices: number[];
  private _contextLevelIndices: number[];
  private _showContextLevels: boolean;
  private readonly _levelPlanesM: readonly number[];
  /**
   * The frame's two passes, recomputed only when the floor selection changes.
   * A camera move repaints far more often than a floor changes, and the plan
   * depends on neither the camera nor the clock.
   */
  private _drawPlan: {
    opaque: PlannedBatch<BatchResources>[];
    translucent: PlannedBatch<BatchResources>[];
  } | null = null;

  constructor(scene: SceneView, options: SceneLayerOptions = {}) {
    this._scene = scene;
    this.id = options.id ?? "kiriko-scene";
    this._activeLevelIndices = [
      Math.min(
        Math.max(0, Math.floor(options.activeLevelIndex ?? 0)),
        Math.max(0, scene.levels.length - 1),
      ),
    ];
    this._contextLevelIndices = (options.contextLevelIndices ?? [])
      .map((index) => Math.floor(index))
      .filter((index) => index >= 0 && index < scene.levels.length);
    this._showContextLevels = options.showContextLevels ?? false;
    this._levelPlanesM = scene.levels.map((level) => level.resolvedPlaneZ);

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
      uploadMs: null,
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
    const started = performance.now();
    this._buildProgram(gl);
    this._buildBatches(gl);
    this._buildPick(gl);
    this._buildConnectors(gl);
    // Upload is everything between having the scene and being able to draw it:
    // programs, buffers, vertex arrays, pick targets.
    this._stats = { ...this._stats, uploadMs: performance.now() - started };
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

      const plan = this._plan();
      gl.depthMask(true);
      drawCalls += this._drawBatches(gl, uniforms, viewProjection, plan.opaque);
      // See-through geometry must not own the depth buffer. A surface the
      // reviewer is looking through would otherwise reject the floor behind it
      // — the subject of a cross-floor connection view — and the result would
      // depend on the order batches happened to be built in.
      gl.depthMask(false);
      drawCalls += this._drawBatches(gl, uniforms, viewProjection, plan.translucent);
      gl.depthMask(true);
      // The connector draws last of all: it is the subject of a cross-floor
      // inspection, and a floor the reviewer is deliberately looking through
      // must not also hide the edge they are looking for. Depth test stays on,
      // so a solid wall in front of it still wins.
      drawCalls += this._drawConnectors(gl, viewProjection);
      const visible = plan.opaque.length + plan.translucent.length;
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
      // The pick pass mirrors the colour pass exactly, including which phase
      // owns the depth buffer: see-through geometry writes no depth there, so
      // if it wrote depth here a conveyance shell would intercept clicks meant
      // for the connector drawn inside it — a target that misses the thing the
      // reviewer is looking straight at.
      const plan = this._plan();
      gl.depthMask(true);
      this._pickBatches(gl, uniforms, viewProjection, plan.opaque);
      gl.depthMask(false);
      this._pickBatches(gl, uniforms, viewProjection, plan.translucent);
      this._pickConnectors(gl, viewProjection);

      // With MRT, `readPixels` samples whichever attachment `readBuffer` names;
      // without switching it the second read would re-sample the id colour.
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      const idPixel = new Uint8Array(4);
      gl.readPixels(pixelX, pixelY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, idPixel);
      const featureIndex = decodeFeatureId(idPixel);
      if (featureIndex < 0) {
        return null;
      }
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      const localPixel = new Float32Array(4);
      gl.readPixels(pixelX, pixelY, 1, 1, gl.RGBA, gl.FLOAT, localPixel);
      if (idPixel[3] === PICK_ALPHA_CONNECTOR) {
        // A connector belongs to no single floor, so it answers with the
        // connection the editor selects by rather than a scene feature.
        if (
          featureIndex >= this._verticalConnectorCount ||
          this._connectorMesh?.connectionIds[featureIndex] === undefined
        ) {
          return null;
        }
        return {
          kind: "connector",
          connectorIndex: featureIndex,
          localPoint: [localPixel[0] ?? 0, localPixel[1] ?? 0, localPixel[2] ?? 0],
        };
      }
      const feature = this._scene.features[featureIndex];
      if (feature === undefined) {
        return null;
      }

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

  /**
   * Draw a different floor at full opacity.
   *
   * Takes every scene level the floor renders, because a canonical floor maps
   * to one or more composite source levels. Indices outside the document are
   * dropped rather than clamped: clamping would silently draw a floor the
   * caller did not ask for.
   */
  setActiveLevels(levelIndices: readonly number[]): void {
    const last = this._scene.levels.length - 1;
    this._activeLevelIndices = levelIndices
      .map((index) => Math.floor(index))
      .filter((index) => index >= 0 && index <= last);
    this._drawPlan = null;
  }

  /** Retain registered levels for one route floor as quiet, non-pickable context. */
  setContextLevels(levelIndices: readonly number[]): void {
    const last = this._scene.levels.length - 1;
    this._contextLevelIndices = levelIndices
      .map((index) => Math.floor(index))
      .filter((index) => index >= 0 && index <= last);
    this._drawPlan = null;
    this._map?.triggerRepaint();
  }

  /** Show or hide the other floors as quiet context. */
  setShowContextLevels(show: boolean): void {
    this._showContextLevels = show;
    this._drawPlan = null;
  }

  /**
   * The cross-floor links to draw as edges between floor planes. Replaces the
   * previous set whole: the graph and the shown floors change together, and a
   * connector that outlived either would be a line to a floor nobody is
   * looking at.
   */
  setConnectors(connectors: readonly ConnectorInput[]): void {
    this._connectorInputs = connectors;
    const gl = this._gl;
    if (gl !== null && !this._contextLost) {
      this._uploadConnectors(gl);
    }
    this._map?.triggerRepaint();
  }

  /**
   * Same-floor network paths on the context floor. Drawn as translucent
   * ribbons on that floor's plane; they are not pickable.
   */
  setContextGraph(connectors: readonly ConnectorInput[]): void {
    this._contextGraphInputs = connectors;
    const gl = this._gl;
    if (gl !== null && !this._contextLost) {
      this._uploadConnectors(gl);
    }
    this._map?.triggerRepaint();
  }

  /** Emphasise one connection, or none. Unknown ids clear the emphasis. */
  setSelectedConnection(connectionId: NetworkConnectionId | null): void {
    const index =
      connectionId === null
        ? -1
        : (this._connectorMesh?.connectionIds.findIndex(
            (candidate) =>
              candidate.pathId === connectionId.pathId &&
              candidate.reversePathId === connectionId.reversePathId,
          ) ?? -1);
    this._selectedConnector = index < 0 ? 0 : index + 1;
    this._map?.triggerRepaint();
  }

  /** The connection one connector index stands for, or `null`. */
  connectionAt(connectorIndex: number): NetworkConnectionId | null {
    return this._connectorMesh?.connectionIds[connectorIndex] ?? null;
  }

  /**
   * The connector programs and their one vertex array. Both passes share the
   * vertex shader, so the ribbon that answers a click is the ribbon on screen.
   */
  private _buildConnectors(gl: WebGL2RenderingContext): void {
    this._connectorProgram = linkProgram(
      gl,
      CONNECTOR_VERTEX_SHADER,
      CONNECTOR_FRAGMENT_SHADER,
    );
    this._connectorPickProgram = linkProgram(
      gl,
      CONNECTOR_VERTEX_SHADER,
      CONNECTOR_PICK_FRAGMENT_SHADER,
    );
    const uniform = (program: WebGLProgram, name: string): WebGLUniformLocation => {
      const location = gl.getUniformLocation(program, name);
      if (location === null) {
        throw new Error(`scene: connector uniform ${name} is missing`);
      }
      return location;
    };
    this._connectorUniforms = {
      matrix: uniform(this._connectorProgram, "u_matrix"),
      viewport: uniform(this._connectorProgram, "u_viewport"),
      halfWidth: uniform(this._connectorProgram, "u_halfWidth"),
      selectedHalfWidth: uniform(this._connectorProgram, "u_selectedHalfWidth"),
      selected: uniform(this._connectorProgram, "u_selected"),
      color: uniform(this._connectorProgram, "u_color"),
      selectedColor: uniform(this._connectorProgram, "u_selectedColor"),
      opacity: uniform(this._connectorProgram, "u_opacity"),
    };
    this._connectorPickUniforms = {
      matrix: uniform(this._connectorPickProgram, "u_matrix"),
      viewport: uniform(this._connectorPickProgram, "u_viewport"),
      halfWidth: uniform(this._connectorPickProgram, "u_halfWidth"),
      selectedHalfWidth: uniform(this._connectorPickProgram, "u_selectedHalfWidth"),
      selected: uniform(this._connectorPickProgram, "u_selected"),
    };

    const vao = gl.createVertexArray();
    const position = gl.createBuffer();
    const other = gl.createBuffer();
    const side = gl.createBuffer();
    const ids = gl.createBuffer();
    if (!vao || !position || !other || !side || !ids) {
      throw new Error("scene: WebGL failed to create a connector resource");
    }
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, position);
    gl.enableVertexAttribArray(ATTR_CONNECTOR_POSITION);
    gl.vertexAttribPointer(ATTR_CONNECTOR_POSITION, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, other);
    gl.enableVertexAttribArray(ATTR_CONNECTOR_OTHER);
    gl.vertexAttribPointer(ATTR_CONNECTOR_OTHER, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, side);
    gl.enableVertexAttribArray(ATTR_CONNECTOR_SIDE);
    gl.vertexAttribPointer(ATTR_CONNECTOR_SIDE, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, ids);
    gl.enableVertexAttribArray(ATTR_CONNECTOR_ID);
    gl.vertexAttribIPointer(ATTR_CONNECTOR_ID, 1, gl.UNSIGNED_INT, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this._connectorBuffers = { vao, position, other, side, ids };
    this._uploadConnectors(gl);
  }

  /**
   * Rebuild and upload the ribbon vertices. Endpoints resolve through the
   * layer's own frame and resolved floor planes, so a connector lands on the
   * same planes the floors are drawn on rather than near them.
   */
  private _uploadConnectors(gl: WebGL2RenderingContext): void {
    const buffers = this._connectorBuffers;
    if (buffers === null) {
      return;
    }
    const localOf = (endpoint: ConnectorEndpoint): readonly [number, number, number] =>
      this.localFromLngLat(endpoint.lng, endpoint.lat, endpoint.levelIndex);
    const mesh = buildConnectorMesh(
      [...this._connectorInputs, ...this._contextGraphInputs],
      localOf,
    );
    if (this._connectorInputs.length >= MAX_PICKABLE_FEATURES) {
      throw new Error("scene: more cross-floor connectors than the pick codec can address");
    }
    this._verticalConnectorCount = this._connectorInputs.length;
    this._connectorMesh = mesh;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.position, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.other);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.other, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.side);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.side, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.ids);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.ids, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** Viewport in device pixels, halved — the shader offsets in NDC. */
  private _halfViewport(gl: WebGL2RenderingContext): [number, number] {
    return [Math.max(1, gl.drawingBufferWidth) / 2, Math.max(1, gl.drawingBufferHeight) / 2];
  }

  /**
   * Render one pass of pickable batches into the id target. Visibility comes
   * from the draw plan, pickability from policy: a see-through active-floor
   * surface is still a target, a retained context floor never is.
   */
  private _pickBatches(
    gl: WebGL2RenderingContext,
    uniforms: NonNullable<SceneLayer["_pickUniforms"]>,
    viewProjection: Float64Array,
    entries: readonly PlannedBatch<BatchResources>[],
  ): void {
    for (const entry of entries) {
      const batch = entry.batch;
      if (!batchPickable(batch, this._visibility())) {
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
  }

  private _drawConnectors(gl: WebGL2RenderingContext, viewProjection: Float64Array): number {
    const program = this._connectorProgram;
    const uniforms = this._connectorUniforms;
    const buffers = this._connectorBuffers;
    const mesh = this._connectorMesh;
    if (program === null || uniforms === null || buffers === null || mesh === null) {
      return 0;
    }
    if (mesh.vertexCount === 0) {
      return 0;
    }
    const matrix = this._multiply(viewProjection, this._model);
    for (let index = 0; index < 16; index += 1) {
      this._matrixF32[index] = matrix[index]!;
    }
    const [halfWidth, halfHeight] = this._halfViewport(gl);
    const ratio = gl.drawingBufferWidth / Math.max(1, this._cssWidth(gl));
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.matrix, false, this._matrixF32);
    gl.uniform2f(uniforms.viewport, halfWidth, halfHeight);
    gl.uniform1f(uniforms.halfWidth, (CONNECTOR_WIDTH_PX * ratio) / 2);
    gl.uniform1f(uniforms.selectedHalfWidth, (CONNECTOR_SELECTED_WIDTH_PX * ratio) / 2);
    gl.uniform1ui(uniforms.selected, this._selectedConnector);
    gl.uniform3f(uniforms.color, CONNECTOR_COLOR[0], CONNECTOR_COLOR[1], CONNECTOR_COLOR[2]);
    gl.uniform3f(
      uniforms.selectedColor,
      INTERACTION_COLOR[0],
      INTERACTION_COLOR[1],
      INTERACTION_COLOR[2],
    );
    gl.polygonOffset(0, 0);
    gl.bindVertexArray(buffers.vao);
    const verticesPerConnector = 6;
    const verticalVertices = this._verticalConnectorCount * verticesPerConnector;
    gl.uniform1f(uniforms.opacity, 1);
    if (verticalVertices > 0) {
      gl.drawArrays(gl.TRIANGLES, 0, verticalVertices);
    }
    const contextVertices = mesh.vertexCount - verticalVertices;
    if (contextVertices > 0) {
      gl.uniform1f(uniforms.opacity, CONTEXT_LEVEL_OPACITY);
      gl.drawArrays(gl.TRIANGLES, verticalVertices, contextVertices);
    }
    gl.bindVertexArray(null);
    return 1;
  }

  private _pickConnectors(gl: WebGL2RenderingContext, viewProjection: Float64Array): void {
    const program = this._connectorPickProgram;
    const uniforms = this._connectorPickUniforms;
    const buffers = this._connectorBuffers;
    const mesh = this._connectorMesh;
    if (
      program === null ||
      uniforms === null ||
      buffers === null ||
      mesh === null ||
      mesh.vertexCount === 0
    ) {
      return;
    }
    const matrix = this._multiply(viewProjection, this._model);
    for (let index = 0; index < 16; index += 1) {
      this._matrixF32[index] = matrix[index]!;
    }
    const [halfWidth, halfHeight] = this._halfViewport(gl);
    const ratio = gl.drawingBufferWidth / Math.max(1, this._cssWidth(gl));
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.matrix, false, this._matrixF32);
    gl.uniform2f(uniforms.viewport, halfWidth, halfHeight);
    gl.uniform1f(uniforms.halfWidth, (CONNECTOR_HIT_WIDTH_PX * ratio) / 2);
    gl.uniform1f(uniforms.selectedHalfWidth, (CONNECTOR_HIT_WIDTH_PX * ratio) / 2);
    gl.uniform1ui(uniforms.selected, this._selectedConnector);
    gl.polygonOffset(0, 0);
    gl.bindVertexArray(buffers.vao);
    const verticalVertices = this._verticalConnectorCount * 6;
    if (verticalVertices > 0) {
      gl.drawArrays(gl.TRIANGLES, 0, verticalVertices);
    }
    gl.bindVertexArray(null);
  }

  /** The canvas' CSS width, for the device-pixel ratio the ribbon scales by. */
  private _cssWidth(gl: WebGL2RenderingContext): number {
    const canvas = gl.canvas;
    return canvas instanceof HTMLCanvasElement ? canvas.clientWidth : gl.drawingBufferWidth;
  }

  /** The floor selection every policy decision reads. */
  private _visibility(): VisibilityState {
    return {
      activeLevelIndices: this._activeLevelIndices,
      contextLevelIndices: this._contextLevelIndices,
      showContextLevels: this._showContextLevels,
      levelPlanesM: this._levelPlanesM,
    };
  }

  private _plan(): {
    opaque: PlannedBatch<BatchResources>[];
    translucent: PlannedBatch<BatchResources>[];
  } {
    this._drawPlan ??= planSceneDraw(this._batches, this._visibility());
    return this._drawPlan;
  }

  private _drawBatches(
    gl: WebGL2RenderingContext,
    uniforms: NonNullable<SceneLayer["_uniforms"]>,
    viewProjection: Float64Array,
    entries: readonly PlannedBatch<BatchResources>[],
  ): number {
    for (const entry of entries) {
      const batch = entry.batch;
      // f64 compose, downcast once: the translation is already anchor-
      // relative, so f32 keeps sub-millimetre resolution across the venue.
      const matrix = this._multiply(viewProjection, batch.matrix);
      for (let index = 0; index < 16; index += 1) {
        this._matrixF32[index] = matrix[index]!;
      }
      gl.uniformMatrix4fv(uniforms.matrix, false, this._matrixF32);
      gl.uniform1f(uniforms.opacity, entry.opacity);
      gl.polygonOffset(0, batch.depthBias);
      gl.bindVertexArray(batch.vao);
      if (batch.colors !== null) {
        gl.bindBuffer(gl.ARRAY_BUFFER, batch.colors);
        gl.enableVertexAttribArray(ATTR_COLOR);
        gl.vertexAttribPointer(ATTR_COLOR, 3, gl.UNSIGNED_BYTE, true, 0, 0);
      } else {
        const color = ROLE_COLORS[batch.role];
        gl.disableVertexAttribArray(ATTR_COLOR);
        gl.vertexAttrib3f(ATTR_COLOR, color[0], color[1], color[2]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, batch.vertexCount);
    }
    return entries.length;
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
      camera: () => ({
        zoom: this._map?.getZoom() ?? 0,
        pitch: this._map?.getPitch() ?? 0,
        bearing: this._map?.getBearing() ?? 0,
      }),
      sourceHash: this._scene.header.sourceHash,
      levelCount: this._scene.levels.length,
      levelIds: this._scene.levels.map((level) => level.canonicalId),
      levelPlanesM: this._levelPlanesM,
      activeLevelIndices: () => [...this._activeLevelIndices],
      contextLevelIndices: () => [...this._contextLevelIndices],
    };
  }

  /**
   * Every scene level a canonical floor renders — the registered set of
   * composite source levels for the generated source's one, for tiles
   * potentially several. Empty when the scene has no such floor.
   */
  levelIndicesOf(canonicalId: string): number[] {
    const indices: number[] = [];
    this._scene.levels.forEach((level, index) => {
      if (level.canonicalId === canonicalId) {
        indices.push(index);
      }
    });
    return indices;
  }

  /**
   * Mark the context lost. The layer stops touching GL objects that no longer
   * exist; re-establishing the view is the recovery slice's decision (#62), not
   * something this layer does behind the caller's back.
   */
  markContextLost(): void {
    this._contextLost = true;
    this._batches = [];
    this._drawPlan = null;
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
    const opacity = gl.getUniformLocation(program, "u_opacity");
    const lightDir = gl.getUniformLocation(program, "u_lightDir");
    const interactionColor = gl.getUniformLocation(program, "u_interactionColor");
    const selected = gl.getUniformLocation(program, "u_selected");
    const hovered = gl.getUniformLocation(program, "u_hovered");
    if (
      !matrix ||
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
      // arrive keyed by (level, role), with illustrated conveyances as a
      // sibling when a leftover shell must not inherit their opacity.
      .sort((left, right) => ROLE_PAINT_ORDER[left.role] - ROLE_PAINT_ORDER[right.role]);
    this._drawPlan = null;
  }

  private _createBatch(gl: WebGL2RenderingContext, batch: SceneBatchView): BatchResources {
    const positions = gl.createBuffer();
    const normals = gl.createBuffer();
    const featureIndices = gl.createBuffer();
    const colors =
      batch.colors === null ? null : gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!positions || !normals || !featureIndices || !vao || (batch.colors !== null && !colors)) {
      throw new Error("scene: WebGL failed to create a batch resource");
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, positions);
    gl.bufferData(gl.ARRAY_BUFFER, batch.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, normals);
    gl.bufferData(gl.ARRAY_BUFFER, batch.normals, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, featureIndices);
    gl.bufferData(gl.ARRAY_BUFFER, batch.featureIndices, gl.STATIC_DRAW);
    if (colors !== null && batch.colors !== null) {
      gl.bindBuffer(gl.ARRAY_BUFFER, colors);
      gl.bufferData(gl.ARRAY_BUFFER, batch.colors, gl.STATIC_DRAW);
    }

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
      colors,
      vertexCount: batch.vertexCount,
      levelIndex: batch.levelIndex,
      role: batch.role,
      illustrated: batch.colors !== null,
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
        if (batch.colors !== null) {
          gl.deleteBuffer(batch.colors);
        }
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
      if (this._connectorBuffers) {
        gl.deleteBuffer(this._connectorBuffers.position);
        gl.deleteBuffer(this._connectorBuffers.other);
        gl.deleteBuffer(this._connectorBuffers.side);
        gl.deleteBuffer(this._connectorBuffers.ids);
        gl.deleteVertexArray(this._connectorBuffers.vao);
      }
      if (this._connectorProgram) {
        gl.deleteProgram(this._connectorProgram);
      }
      if (this._connectorPickProgram) {
        gl.deleteProgram(this._connectorPickProgram);
      }
    }
    this._batches = [];
    this._connectorBuffers = null;
    this._connectorProgram = null;
    this._connectorPickProgram = null;
    this._connectorUniforms = null;
    this._connectorPickUniforms = null;
    this._connectorMesh = null;
    this._drawPlan = null;
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
