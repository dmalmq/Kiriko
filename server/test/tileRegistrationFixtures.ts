/**
 * The venue-side half of the registration fixtures (#74): a level's own floor
 * plane, read out of a compiled bundle.
 *
 * This one needs the native addon, which is why it is not in `tests/fixtures/`
 * with the package builders — the browser suite builds packages but never
 * decodes a bundle, and pulling the addon into that project would buy nothing.
 */
import { sceneProjection } from "@kiriko/node";

/**
 * A level's own floor plane in the frame tile heights arrive in: the §8
 * record's scene Z with the frame's normalisation undone.
 */
export async function venuePlaneFromBundle(bundle: Buffer, levelId: string): Promise<number> {
  const response = await sceneProjection(bundle);
  if (response.ok !== true || response.projectionJson === undefined) {
    throw new Error("the bundle has no scene projection");
  }
  const projection = JSON.parse(response.projectionJson) as {
    frame: { verticalNormalisationOffsetMm: number };
    levels: { levelId: string; resolvedSceneZMm: number }[];
  };
  const level = projection.levels.find((entry) => entry.levelId === levelId);
  if (level === undefined) {
    throw new Error(`the bundle has no level ${levelId}`);
  }
  // `sceneZ = source − offset`, so recovering the source plane adds it back.
  return (level.resolvedSceneZMm + projection.frame.verticalNormalisationOffsetMm) / 1000;
}
