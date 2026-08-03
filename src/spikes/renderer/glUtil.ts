/**
 * GL helpers for the spike renderer (3D rendering spike Task 5).
 *
 * Everything here is raw WebGL2 with no dependencies. The state save/restore
 * pair is gate 2's primary evidence: MapLibre must render identically before
 * and after the custom layer, so every piece of GL state this layer touches is
 * captured on entry and restored on exit.
 */

/** GL state captured by `saveGlState`. */
export interface GlState {
  depthTest: boolean;
  depthWriteMask: boolean;
  depthFunc: number;
  cullFace: boolean;
  cullFaceMode: number;
  blend: boolean;
  blendSrcRgb: number;
  blendDstRgb: number;
  arrayBufferBinding: WebGLBuffer | null;
  vertexArrayBinding: WebGLVertexArrayObject | null;
  currentProgram: WebGLProgram | null;
  activeTexture: number;
  textureBinding2d: WebGLTexture | null;
  framebufferBinding: WebGLFramebuffer | null;
  viewport: [number, number, number, number];
}

/**
 * Compile, link, and validate a program. Throws with the shader/program info
 * log on any failure so the spike fails loudly instead of drawing nothing.
 */
export function compileProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error("WebGL failed to create a program");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "no info log";
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${log}`);
  }
  gl.validateProgram(program);
  if (!gl.getProgramParameter(program, gl.VALIDATE_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "no info log";
    gl.deleteProgram(program);
    throw new Error(`program validation failed: ${log}`);
  }
  return program;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("WebGL failed to create a shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "no info log";
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

/**
 * Per-feature GPU state texture (D4): a square-ish RGBA8 texture with one
 * texel per feature. Channel 0 = visibility (0..255 opacity, 0 hidden),
 * channel 1 = state flags (bit 0 selected, bit 1 hovered), channel 2 =
 * diagnostic severity (0..3), channel 3 = reserved.
 */
export interface FeatureStateTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
  /** CPU copy of the texture contents; write here, then upload. */
  data: Uint8Array;
}

export function createFeatureStateTexture(
  gl: WebGL2RenderingContext,
  featureCount: number,
): FeatureStateTexture {
  const size = Math.max(1, Math.ceil(Math.sqrt(featureCount)));
  const data = new Uint8Array(size * size * 4);
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("WebGL failed to create the feature state texture");
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { texture, width: size, height: size, data };
}

/**
 * Capture exactly the enumerated GL state. The list is the contract: it is
 * everything the scene layer mutates, and nothing more.
 */
export function saveGlState(gl: WebGL2RenderingContext): GlState {
  return {
    depthTest: gl.getParameter(gl.DEPTH_TEST) as boolean,
    depthWriteMask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
    depthFunc: gl.getParameter(gl.DEPTH_FUNC) as number,
    cullFace: gl.getParameter(gl.CULL_FACE) as boolean,
    cullFaceMode: gl.getParameter(gl.CULL_FACE_MODE) as number,
    blend: gl.getParameter(gl.BLEND) as boolean,
    blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB) as number,
    blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB) as number,
    arrayBufferBinding: gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null,
    vertexArrayBinding: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
    currentProgram: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
    activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE) as number,
    textureBinding2d: gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null,
    framebufferBinding: gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
    viewport: gl.getParameter(gl.VIEWPORT) as [number, number, number, number],
  };
}

/** Restore exactly what `saveGlState` captured, in a mirror order. */
export function restoreGlState(gl: WebGL2RenderingContext, state: GlState): void {
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
  gl.cullFace(state.cullFaceMode);
  if (state.blend) {
    gl.enable(gl.BLEND);
  } else {
    gl.disable(gl.BLEND);
  }
  gl.blendFunc(state.blendSrcRgb, state.blendDstRgb);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBufferBinding);
  gl.bindVertexArray(state.vertexArrayBinding);
  gl.useProgram(state.currentProgram);
  gl.activeTexture(state.activeTexture);
  gl.bindTexture(gl.TEXTURE_2D, state.textureBinding2d);
  gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebufferBinding);
  gl.viewport(state.viewport[0], state.viewport[1], state.viewport[2], state.viewport[3]);
}
