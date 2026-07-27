/**
 * Graph-bearing browser acceptance against the real stack: Fastify + SQLite +
 * blob/job lifecycle, the native Rust addon (IMDF compile + network synthesis),
 * WASM KVB decode/route/export, and MapLibre interaction. No route or network
 * mocks — every graph number comes from real compilation and real WASM.
 *
 * Flow:
 *   1. Sign in and publish the graph-bearing IMDF fixture.
 *   2. Generate routing (synthesizes a §5 graph from the venue geometry).
 *   3. Open the public-id-pinned viewer; compute a route from two map taps.
 *   4. Open Network Review; assert connectivity stats render from the real
 *      WASM network export.
 *   5. Enter Network Edit, add a point at map center with the real toolbar,
 *      verify undo/redo affordances, then save the changed graph. The
 *      client POSTs the edited network to the real import-network endpoint and
 *      navigates to the newly published immutable public version.
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import {
  mapCanvas,
  minimalImdfZipBuffer,
  publishVenue,
  signIn,
  switchLocale,
  uniqueDatasetName,
  VENUE_NAME_EN,
  waitForMapIdle,
  waitForReadyVenue,
} from "./helpers";

const PUBLIC_VERSION_ID = /^[0-9a-f]{64}$/;

interface SavedNetwork {
  junctions: number;
  paths: number;
  publicVersionId: string;
}

/** Feature count of a GeoJSON FeatureCollection string. */
function featureCount(geojson: unknown): number {
  if (typeof geojson !== "string") return 0;
  const parsed = JSON.parse(geojson) as { features?: unknown[] };
  return Array.isArray(parsed.features) ? parsed.features.length : 0;
}

/** The connectivity summary the review overlay renders (real WASM export). */
async function reviewReportText(page: Page): Promise<string> {
  const report = page.locator(".review-report");
  await expect(report).toBeVisible({ timeout: 30_000 });
  return (await report.textContent())?.trim() ?? "";
}

/**
 * Enable Directions and compute a route from two taps on the MapLibre canvas.
 * The taps carry raw lon/lat; snapping and routing run inside WASM, so a
 * finite distance in the directions status bar proves the real router ran.
 */
async function computeRoute(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Directions" }).click();
  const status = page.locator(".directions-bar__status");
  await expect(status).toHaveText("Tap the map to set the origin");

  const box = await mapCanvas(page).boundingBox();
  if (box === null) throw new Error("map canvas has no bounding box");
  const cy = box.y + box.height * 0.62;
  await page.mouse.click(box.x + box.width * 0.4, cy);
  await expect(status).toHaveText("Tap the map to set the destination");
  await page.mouse.click(box.x + box.width * 0.62, cy);
  // Real WASM route: the bar shows the rounded metre distance, not an error.
  await expect(status).toHaveText(/^\d+\s*m$/, { timeout: 30_000 });

  // Leave Directions so subsequent map taps reach the network edit handler.
  await page.getByRole("button", { name: "Directions" }).click();
}

/**
 * Open Network Review (idempotent) and wait for the overlay's connectivity
 * summary, which only renders once the real network overlay has decoded.
 */
async function openReview(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Review network" });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
  }
  await expect(page.locator(".review-report")).toBeVisible({ timeout: 30_000 });
}


/**
 * Click Save as new version, capturing both the serialized graph the client
 * POSTs and the pinned public version id the server returns. Then wait for the
 * app to navigate to that pinned, review-mode version once publication completes.
 */
async function saveNetwork(page: Page): Promise<SavedNetwork> {
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/gdb/import-network" &&
      response.request().method() === "POST",
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "Save as new version" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);

  const request: Request = response.request();
  const payload = request.postDataJSON() as { junctions?: unknown; paths?: unknown };
  const body = (await response.json()) as { publicVersionId?: unknown };
  const publicVersionId = typeof body.publicVersionId === "string" ? body.publicVersionId : "";
  expect(publicVersionId).toMatch(PUBLIC_VERSION_ID);

  await page.waitForURL((url) => url.href.includes(`version=${publicVersionId}`), {
    timeout: 90_000,
  });
  await waitForReadyVenue(page, VENUE_NAME_EN);
  return {
    junctions: featureCount(payload.junctions),
    paths: featureCount(payload.paths),
    publicVersionId,
  };
}

test.describe("graph-bearing network review + edit", () => {
  test("routes, reviews, edits, and republishes through the real stack", async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);

    await page.goto("/");
    await signIn(page);
    await switchLocale(page, "en");

    const venue = await publishVenue(
      page.request,
      uniqueDatasetName("graph-review", testInfo),
      await minimalImdfZipBuffer(),
    );

    try {
      // Generate routing from the gallery and wait for the toast.
      await page.reload();
      await switchLocale(page, "en");
      const card = page.locator(".dataset-card").filter({
        has: page.locator(".dataset-card__slug", { hasText: venue.slug }),
      });
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Generate routing" }).click();
      await expect(page.locator(".gallery-toast", { hasText: "Routing generated" })).toBeVisible({
        timeout: 90_000,
      });

      // Open the public-id-pinned viewer for the synthesized version.
      await card.getByRole("button", { name: "Open", exact: true }).click();
      await waitForReadyVenue(page, VENUE_NAME_EN);
      await expect(page).toHaveURL(new RegExp(`version=${PUBLIC_VERSION_ID.source.slice(1, -1)}`));

      // Directions must be offered by a graph-bearing bundle, and routing runs.
      await expect(page.getByRole("button", { name: "Directions" })).toBeVisible();
      await computeRoute(page);

      // Network Review renders real connectivity stats.
      await openReview(page);
      const baselineReport = await reviewReportText(page);
      expect(baselineReport).toMatch(/connected\s+\d+%/);
      expect(baselineReport).toMatch(/\d+\s+islands/);

      // Edit pass: add one point through the real toolbar and pointer path.
      // Undo/redo prove the editor history is wired in the browser; saving then
      // exercises the full round-trip — edited graph serialized, published as a
      // NEW immutable version, and reopened.
      await page.getByRole("button", { name: "Edit network" }).click();
      await expect(page.getByRole("button", { name: "Directions" })).toBeHidden();
      await page.getByRole("button", { name: "Add point" }).click();
      const editBox = await mapCanvas(page).boundingBox();
      if (editBox === null) throw new Error("map canvas has no bounding box");
      await page.mouse.click(editBox.x + editBox.width * 0.08, editBox.y + editBox.height * 0.88);
      await expect(page.locator(".network-editor-toolbar__summary")).toContainText("1 point added");

      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.locator(".network-editor-toolbar__summary")).toHaveText("No changes yet");
      await expect(page.getByRole("button", { name: "Save as new version" })).toBeDisabled();
      await page.getByRole("button", { name: "Redo" }).click();
      await expect(page.locator(".network-editor-toolbar__summary")).toContainText("1 point added");

      const edited = await saveNetwork(page);
      expect(edited.junctions).toBeGreaterThan(0);
      expect(edited.paths).toBeGreaterThan(0);

      // Reopened pinned version: connectivity renders from the real overlay,
      // is stable across reads, and the edited graph is still routable.
      await openReview(page);
      const reopened = await reviewReportText(page);
      expect(reopened).toMatch(/connected\s+\d+%/);
      const reopenedAgain = await reviewReportText(page);
      expect(reopenedAgain).toBe(reopened);

      await waitForMapIdle(page);
      await computeRoute(page);
    } finally {
      const response = await page.request.delete(`/api/venues/${venue.venueId}`);
      expect([204, 404]).toContain(response.status());
    }
  });
});
