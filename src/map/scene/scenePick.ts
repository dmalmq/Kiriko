/**
 * Picking semantics: the feature-id colour codec the GPU pass writes and reads,
 * and the precedence rule between a graph object and a scene surface.
 *
 * The codec's one subtlety is the sentinel. A cleared pick target reads back
 * all-zero, so an index is stored shifted by one: nothing can be both "feature
 * 0" and "no hit", which is the off-by-one that would silently attribute every
 * miss to the first primitive in the scene.
 */

import type { SemanticRoleName } from "./sceneFormat";

/** Indices addressable by the 24-bit colour encoding, after the shift. */
export const MAX_PICKABLE_FEATURES = 0xff_ff_ff - 1;

/** One scene surface under the pointer, as the GPU pass reports it. */
export interface PickCandidate {
  kind: "surface";
  /** Index into the scene's features — the handle the renderer holds. */
  featureIndex: number;
  /**
   * The canonical venue feature this surface represents, or `null` when the
   * source object maps to none. `null` never becomes a canonical identity: an
   * unassociated object stays inspectable but cannot impersonate a feature.
   */
  canonicalFeatureId: string | null;
  levelId: string;
  sourceObjectId: string;
  /**
   * The picked surface's semantic role. `Context` is contextual mass — a level's
   * floor plate, unclassified volume — and is never a selection target: in 2D a
   * click on bare floor clears the selection, and it must mean the same thing
   * here.
   */
  role: SemanticRoleName;
  /** Venue-local metres under the pointer, read from the position target. */
  localPoint: readonly [number, number, number];
  /** The picked feature's own vertical extent, metres — the pick-identity check. */
  featureMinZ: number;
  featureMaxZ: number;
}

/**
 * Pack a feature index into an RGBA8 colour, shifted so that all-zero stays
 * the no-hit sentinel.
 */
export function encodeFeatureId(index: number): [number, number, number, number] {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PICKABLE_FEATURES) {
    throw new Error(`scene: ${index} is outside the pickable feature range`);
  }
  const shifted = index + 1;
  return [shifted & 0xff, (shifted >> 8) & 0xff, (shifted >> 16) & 0xff, 255];
}

/** Unpack a feature index from a pick readback; `-1` when nothing was hit. */
export function decodeFeatureId(rgba: Uint8Array): number {
  const red = rgba[0] ?? 0;
  const green = rgba[1] ?? 0;
  const blue = rgba[2] ?? 0;
  if (red === 0 && green === 0 && blue === 0) {
    return -1;
  }
  return (red | (green << 8) | (blue << 16)) - 1;
}
