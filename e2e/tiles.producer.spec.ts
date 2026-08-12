/**
 * The producer's path from a 3D Tiles archive to a venue that renders it (#80).
 *
 * Everything under this heading was reachable only by `curl` before: ingestion,
 * registration, the gates, and activation. The assertions no unit test can make
 * are that the real multipart upload reaches the real validator, that the numbers
 * on screen are the Rust core's own, and that a gate a producer clears with the
 * vertical-offset lever ends in a version the viewer actually draws from tiles.
 *
 * The loop is the point. The package is built 4 m above the fixture venue's own
 * B1 plane, so the first measurement cannot map it — and the remedy is the datum
 * decision #74 refuses to infer.
 */
import { expect, test, type Page } from "@playwright/test";
import { buildTilePackageZip, FIXTURE_B1_PLANE_M } from "../tests/fixtures/buildTilePackageZip";
import {
  minimalImdfZipBuffer,
  publishVenue,
  signIn,
  switchLocale,
  uniqueDatasetName,
  waitForMapIdle,
} from "./helpers";

const LEVEL_B1 = "b1000001-0000-4000-8000-0000000000b1";

/**
 * A floor plane no venue level sits near, so the first measurement cannot map it.
 * A small offset would not do: the fixture venue has floors at several heights,
 * and a package a few metres out maps to *a* floor — wrongly, and with no gate to
 * catch it. That is the hazard #74's refusal to infer a datum exists to prevent.
 */
const UNPLACEABLE_PLANE_M = 50;

async function openTilesDialog(page: Page, venueName: string): Promise<void> {
  // The gallery opens in Japanese; every assertion below reads English copy.
  await switchLocale(page, "en");
  const card = page.locator(".dataset-card", { hasText: venueName });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "3D Tiles" }).click();
  await expect(page.getByRole("heading", { name: "3D Tiles" })).toBeVisible();
}

async function uploadPackage(page: Page, planeM: number): Promise<void> {
  await page.setInputFiles('input[aria-label="Choose a 3D Tiles package"]', {
    name: "tiles.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(await buildTilePackageZip(planeM)),
  });
}

test.describe("tile producer surface", () => {
  test("carries a package from upload to a venue rendering it", async ({ page }, testInfo) => {
    // Ingestion, two Rust registration runs, and a publish job.
    test.setTimeout(180_000);
    const name = uniqueDatasetName("tiles-producer", testInfo);
    await page.goto("/");
    await signIn(page);
    const venue = await publishVenue(page.request, name, await minimalImdfZipBuffer());
    try {
      await page.reload();
      await openTilesDialog(page, name);

      // 1. Ingestion: the real archive through the real validator.
      await uploadPackage(page, UNPLACEABLE_PLANE_M);
      await expect(page.getByText("tileset.json")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Measure registration" })).toBeEnabled();

      // 2. The first measurement cannot map a floor 4 m off the venue's own.
      await page.getByRole("button", { name: "Measure registration" }).click();
      const mapping = page.getByRole("table", { name: "Level to floor mapping" });
      await expect(mapping).toBeVisible({ timeout: 30_000 });
      // The plane came from the tile surfaces, not from the metadata (#31), and
      // no venue floor sits near it, so the mapping column says so.
      await expect(mapping.getByText("50.00", { exact: true }).first()).toBeVisible();
      await expect(mapping.getByText("none")).toBeVisible();
      await expect(page.getByText("Activation is blocked")).toBeVisible();
      await expect(page.getByRole("button", { name: "Activate" })).toBeDisabled();

      // 3. The producer supplies the datum, reads it back, and measures again.
      const offset = page.getByLabel("Vertical offset (m)");
      await offset.fill(String(FIXTURE_B1_PLANE_M - UNPLACEABLE_PLANE_M));
      await page.getByRole("button", { name: "Measure again" }).click();

      // 4. Gates clear, and the venue's own canonical floor is now mapped.
      const floors = page.getByRole("table", { name: "Floors" });
      await expect(floors.getByText(LEVEL_B1)).toBeVisible({ timeout: 30_000 });
      // Gates pass, and activation is still refused: no gate can establish that
      // each level sits on the right floor, so a person says so.
      await expect(page.getByRole("button", { name: "Activate" })).toBeDisabled();
      await expect(mapping.getByText(LEVEL_B1)).toBeVisible();
      await page.getByLabel(/I have checked the floor/).check();
      await expect(page.getByRole("button", { name: "Activate" })).toBeEnabled();

      // 5. Activation publishes a version.
      await page.getByRole("button", { name: "Activate" }).click();
      await expect(page.getByText("Activated")).toBeVisible({ timeout: 60_000 });
      await page.getByRole("button", { name: "Close" }).click();

      // 6. The gallery distinguishes rendering a package from holding one.
      const card = page.locator(".dataset-card", { hasText: name });
      await expect(card.getByText("3D Tiles live")).toBeVisible({ timeout: 30_000 });

      // 7. And the viewer draws from the package rather than the generated scene
      //    — the whole point of the path, through the entry point that now exists.
      await card.getByRole("button", { name: "Open in 3D" }).click();
      await waitForMapIdle(page);
      await expect(page.locator(".scene-source__badge")).toHaveText("3D Tiles", {
        timeout: 30_000,
      });
    } finally {
      await page.request.delete(`/api/venues/${venue.venueId}`);
    }
  });

  test("resumes a package the venue already holds after a reload", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    // The reason the list route exists: a producer who reloads must not have to
    // re-send the archive to see its measurements again.
    const name = uniqueDatasetName("tiles-resume", testInfo);
    await page.goto("/");
    await signIn(page);
    const venue = await publishVenue(page.request, name, await minimalImdfZipBuffer());
    try {
      await page.reload();
      await openTilesDialog(page, name);
      await uploadPackage(page, FIXTURE_B1_PLANE_M);
      await expect(page.getByText("tileset.json")).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Measure registration" }).click();
      await expect(page.getByRole("table", { name: "Floors" })).toBeVisible({ timeout: 30_000 });

      await page.reload();
      await openTilesDialog(page, name);

      // The stored evaluation came back, so the flow resumes at its verdict —
      // including the confirmation, which a reload deliberately does not keep: it
      // is an assertion about a table this session has not shown yet.
      await expect(page.getByRole("table", { name: "Floors" })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Measure again" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Activate" })).toBeDisabled();
      await page.getByLabel(/I have checked the floor/).check();
      await expect(page.getByRole("button", { name: "Activate" })).toBeEnabled();
    } finally {
      await page.request.delete(`/api/venues/${venue.venueId}`);
    }
  });

  test("says what to publish first when the venue has no version", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    // Registration measures against the venue's own canonical data. There is
    // none, so the dialog states the precondition instead of offering a retry.
    await page.goto("/");
    await signIn(page);
    const created = await page.request.post("/api/venues", {
      data: { name: uniqueDatasetName("tiles-empty", testInfo) },
    });
    expect(created.status()).toBe(201);
    const venueId = (await created.json()).venue.id as number;
    try {
      await page.reload();
      await switchLocale(page, "en");
      const card = page.locator(".dataset-card").first();
      await card.getByRole("button", { name: "3D Tiles" }).click();
      await uploadPackage(page, UNPLACEABLE_PLANE_M);
      await expect(page.getByText("tileset.json")).toBeVisible({ timeout: 30_000 });

      await page.getByRole("button", { name: "Measure registration" }).click();

      await expect(page.getByText(/Publish IMDF or GDB first/)).toBeVisible({ timeout: 30_000 });
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });
});
