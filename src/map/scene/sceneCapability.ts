/**
 * The 3D capability floor (#26 section 1).
 *
 * There is one 3D tier and no degraded middle: a device either meets every
 * requirement the renderer depends on, or it gets the universal 2D fallback.
 * The alternative — rendering 3D with picking disabled, say — would ship a view
 * whose affordances silently differ from the one the product describes.
 *
 * The requirements are not a wish list. Each one is load-bearing:
 *
 * - **WebGL2**, because the scene layer's shaders are GLSL ES 3.0 and the
 *   geometry arrives as integer attributes.
 * - **Multiple render targets that link with explicit output locations**,
 *   because the pick pass writes the feature id and the venue-local position
 *   in one pass. Without explicit `layout(location = N)` the program fails to
 *   link on Chromium/ANGLE, which is why the probe links the real thing rather
 *   than trusting a parameter.
 * - **A float colour attachment that actually completes**, because the pick
 *   position is read back as `RGBA32F`. The spike's RGBA8 depth approximation
 *   is evidence, not a product, and is not promoted.
 *
 * Context-loss recovery is the fourth requirement in #26, but it is a property
 * of this code rather than of the device: the viewer wires it, and the browser
 * suite proves a lost context recovers.
 */

/** A device-side requirement that can fail. */
export type CapabilityRequirement =
  | "webgl2"
  | "multiple_render_targets"
  | "color_buffer_float";

/** What a probe found, expressed as facts rather than conclusions. */
export interface CapabilityFacts {
  webgl2: boolean;
  /** `MAX_DRAW_BUFFERS`; the pick pass needs at least two. */
  drawBuffers: number;
  /** A two-output program with explicit locations linked. */
  multiTargetProgramLinks: boolean;
  /** `EXT_color_buffer_float` is present. */
  colorBufferFloat: boolean;
  /** An `RGBA32F` colour attachment reported framebuffer-complete. */
  floatTargetComplete: boolean;
}

export interface SceneCapabilityReport {
  /** Every requirement holds. There is no partial-3D tier. */
  supported: boolean;
  /** Requirements that failed, in a stable order. */
  missing: readonly CapabilityRequirement[];
}

/**
 * Turn probe facts into the offer decision. Pure: the browser gathers facts,
 * this decides, and the tests can exercise every combination without a GPU.
 */
export function evaluateCapability(facts: CapabilityFacts): SceneCapabilityReport {
  if (!facts.webgl2) {
    // Nothing else is knowable without a context, and listing derived failures
    // would misdescribe the device.
    return { supported: false, missing: ["webgl2"] };
  }
  const missing: CapabilityRequirement[] = [];
  if (facts.drawBuffers < 2 || !facts.multiTargetProgramLinks) {
    missing.push("multiple_render_targets");
  }
  if (!facts.colorBufferFloat || !facts.floatTargetComplete) {
    missing.push("color_buffer_float");
  }
  return { supported: missing.length === 0, missing };
}

/**
 * What the reviewer is told. The message describes what they get, never which
 * GL extension was absent: the outcome is the same in every case, and an
 * extension name is not information a reviewer can act on.
 */
export function capabilityNotice(
  missing: readonly CapabilityRequirement[],
): { ja: string; en: string } {
  void missing;
  return {
    ja: "この端末では3D表示を利用できません。2D表示で経路・フロア・選択はそのまま使えます。",
    en: "3D is unavailable on this device. The 2D view keeps routes, floors, and selection exactly as they were.",
  };
}

/** The two-output program the probe links; deliberately the real pattern. */
const PROBE_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

const PROBE_FRAGMENT = `#version 300 es
precision highp float;
layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;
void main() { outA = vec4(1.0); outB = vec4(1.0); }
`;

/**
 * Gather the facts from a real context. Creates and disposes its own throwaway
 * context so the decision can be made before the map — and before the scene —
 * is loaded at all.
 */
export function probeSceneCapability(): SceneCapabilityReport {
  // No document, or no WebGL2 constructor at all: there is nothing to probe, and
  // asking a DOM that cannot answer only produces noise (jsdom logs an
  // unimplemented-method warning for every such call).
  if (typeof document === "undefined" || typeof WebGL2RenderingContext === "undefined") {
    return { supported: false, missing: ["webgl2"] };
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext("webgl2");
  if (gl === null) {
    return evaluateCapability({
      webgl2: false,
      drawBuffers: 0,
      multiTargetProgramLinks: false,
      colorBufferFloat: false,
      floatTargetComplete: false,
    });
  }

  const facts: CapabilityFacts = {
    webgl2: true,
    drawBuffers: (gl.getParameter(gl.MAX_DRAW_BUFFERS) as number | null) ?? 0,
    multiTargetProgramLinks: probeMultiTargetProgram(gl),
    colorBufferFloat: gl.getExtension("EXT_color_buffer_float") !== null,
    floatTargetComplete: false,
  };
  facts.floatTargetComplete = facts.colorBufferFloat && probeFloatTarget(gl);

  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return evaluateCapability(facts);
}

function probeMultiTargetProgram(gl: WebGL2RenderingContext): boolean {
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (vertex === null || fragment === null || program === null) {
    return false;
  }
  try {
    gl.shaderSource(vertex, PROBE_VERTEX);
    gl.compileShader(vertex);
    gl.shaderSource(fragment, PROBE_FRAGMENT);
    gl.compileShader(fragment);
    if (
      !gl.getShaderParameter(vertex, gl.COMPILE_STATUS) ||
      !gl.getShaderParameter(fragment, gl.COMPILE_STATUS)
    ) {
      return false;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    return gl.getProgramParameter(program, gl.LINK_STATUS) === true;
  } finally {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    gl.deleteProgram(program);
  }
}

function probeFloatTarget(gl: WebGL2RenderingContext): boolean {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (texture === null || framebuffer === null) {
    return false;
  }
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
  }
}
