/**
 * A real 3D Tiles package archive: a root tileset plus one GLB whose walkable
 * floor covers the minimal IMDF fixture's B1 corridor.
 *
 * Shared between the server suite and the browser suite so both drive the same
 * bytes. Two builders would drift into describing two different "valid
 * packages", which is exactly what an ingestion test must not permit.
 *
 * `planeM` is the height of the floor geometry *and* the elevation its metadata
 * claims. The fixture venue's own B1 plane is −4 m, so a package built at 0
 * registers only once a producer supplies `verticalOffsetM: -4` — the datum
 * decision #74 refuses to infer.
 */
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { tilesetFixture } from "./tileFixtures";
import { corridorPackageGlb, rootTransform } from "./tileRegistration";

/** The fixture venue's own B1 floor plane, in metres. */
export const FIXTURE_B1_PLANE_M = -4;

export async function buildTilePackageZip(planeM = 0, inset = 0): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0 });
  await writer.add(
    "tileset.json",
    new Uint8ArrayReader(tilesetFixture("content/model.glb", rootTransform())),
  );
  await writer.add("content/model.glb", new Uint8ArrayReader(corridorPackageGlb(inset, planeM)));
  return writer.close();
}
