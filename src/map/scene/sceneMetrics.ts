/**
 * Performance-timeline names for the scene's two load spans, so the browser
 * harness reads measured values rather than inferring them from wall clocks
 * around unrelated work.
 *
 * Decode is the span a reviewer waits through: fetch, the worker's compile of
 * §9 into the render document, and building typed views over the payload. Upload
 * is the layer creating its GPU resources, reported through `SceneLayerStats`
 * because it happens inside `onAdd` where no promise boundary exists.
 *
 * Budgets (#26 section 4): decode ≤ 1,200 ms, upload ≤ 200 ms.
 */

export const SCENE_DECODE_START = "kiriko-scene-decode-start";
export const SCENE_DECODE_MEASURE = "kiriko-scene-decode";

/** #26 section 4's load budgets, in milliseconds. */
export const SCENE_DECODE_BUDGET_MS = 1_200;
export const SCENE_UPLOAD_BUDGET_MS = 200;
