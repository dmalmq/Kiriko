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
import {
  ROLE_COLORS,
  ROLE_DEPTH_BIAS,
  ROLE_PAINT_ORDER,
  batchOpacity,
} from "./scenePolicy";
import {
  composeModelMatrix,
  foldQuantization,
  lightDirectionLocal,
  sceneAnchor,
} from "./sceneMath";

/** Fixed ENU key direction: from above, north-west. World-stable by design. */
const KEY_LIGHT_ENU: readonly [number, number, number] = [-0.35, -0.35, 0.87];

const VERTEX_SHADER = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
in vec3 a_position;
in vec2 a_normal;
out vec3 v_normal;
void main() {
  // Dequantization is folded into u_matrix, so the raw u16 attribute feeds
  // straight through and no intermediate holds a large offset in f32.
  v_normal = vec3(a_normal, 1.0 - abs(a_normal.x) - abs(a_normal.y));
  gl_Position = u_matrix * vec4(a_position, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec3 u_baseColor;
uniform float u_opacity;
uniform vec3 u_lightDir;
in vec3 v_normal;
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
  // Premultiplied alpha: MapLibre's blend convention.
  outColor = vec4(rgb * u_opacity, u_opacity);
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
}

export interface SceneLayerStats {
  /** Draw calls issued by the last frame. */
  drawCalls: number;
  /** Batches the current visibility rules select. */
  visibleBatches: number;
  /** Batches the scene carries in total. */
  totalBatches: number;
  vertices: number;
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
  sourceHash: string;
  levelCount: number;
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

  private _gl: WebGL2RenderingContext | null = null;
  private _program: WebGLProgram | null = null;
  private _uniforms: {
    matrix: WebGLUniformLocation;
    baseColor: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
    lightDir: WebGLUniformLocation;
  } | null = null;
  private _attributes: { position: number; normal: number } | null = null;
  private _batches: BatchResources[] = [];
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
    };
  }

  onAdd(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext)) {
      // The capability floor is a hard gate: a WebGL1 context means the 2D
      // fallback should have been chosen instead of this layer (#26 section 1).
      throw new Error("scene: the scene layer requires a WebGL2 context");
    }
    this._gl = gl;
    this._contextLost = false;
    this._buildProgram(gl);
    this._buildBatches(gl);
  }

  onRemove(_map: MapLibreMap, _gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this._release();
    this._gl = null;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!(gl instanceof WebGL2RenderingContext) || this._contextLost) {
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

      gl.useProgram(program);
      gl.uniform3fv(uniforms.lightDir, this._lightDir);

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
    } finally {
      this._restore(gl, borrowed);
    }
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
      sourceHash: this._scene.header.sourceHash,
      levelCount: this._scene.levels.length,
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
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
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

    const matrix = gl.getUniformLocation(program, "u_matrix");
    const baseColor = gl.getUniformLocation(program, "u_baseColor");
    const opacity = gl.getUniformLocation(program, "u_opacity");
    const lightDir = gl.getUniformLocation(program, "u_lightDir");
    if (!matrix || !baseColor || !opacity || !lightDir) {
      gl.deleteProgram(program);
      throw new Error("scene: program is missing a required uniform");
    }
    this._program = program;
    this._uniforms = { matrix, baseColor, opacity, lightDir };
    this._attributes = {
      position: gl.getAttribLocation(program, "a_position"),
      normal: gl.getAttribLocation(program, "a_normal"),
    };
  }

  private _buildBatches(gl: WebGL2RenderingContext): void {
    const attributes = this._attributes;
    if (!attributes) {
      throw new Error("scene: attribute locations missing");
    }
    this._batches = this._scene.batches
      .map((batch) => this._createBatch(gl, batch, attributes))
      // Paint order is the renderer's own concern, not the producer's: batches
      // arrive keyed by (level, role) and are composited by role here.
      .sort((left, right) => ROLE_PAINT_ORDER[left.role] - ROLE_PAINT_ORDER[right.role]);
  }

  private _createBatch(
    gl: WebGL2RenderingContext,
    batch: SceneBatchView,
    attributes: { position: number; normal: number },
  ): BatchResources {
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
    gl.enableVertexAttribArray(attributes.position);
    // `u16` positions, unnormalized: the matrix dequantizes them.
    gl.vertexAttribPointer(attributes.position, 3, gl.UNSIGNED_SHORT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, normals);
    gl.enableVertexAttribArray(attributes.normal);
    // Octahedral `i16`, normalized to [-1, 1] for the shader's reconstruction.
    gl.vertexAttribPointer(attributes.normal, 2, gl.SHORT, true, 0, 0);
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
      matrix: foldQuantization(this._model, batch.quantizationOrigin, batch.quantizationScale),
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
    }
    this._batches = [];
    this._program = null;
    this._uniforms = null;
    this._attributes = null;
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
