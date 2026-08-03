import { expect, test } from "@playwright/test";
import {
  mapCanvas,
  mapContainer,
  uploadMinimalImdf,
  VENUE_NAME_JA,
  VIEWER_URL,
  waitForReadyVenue,
} from "./helpers";

test.describe("map readiness", () => {
  test("WebGL-backed fixture render reaches MapLibre idle", async ({ page }) => {
    await page.goto(VIEWER_URL);

    const hasWebGl = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      return canvas.getContext("webgl2") !== null || canvas.getContext("webgl") !== null;
    });
    expect(hasWebGl, "the browser must provide a WebGL context for MapLibre").toBe(true);

    await uploadMinimalImdf(page);
    await waitForReadyVenue(page, VENUE_NAME_JA);

    await expect(mapCanvas(page)).toBeVisible();
    await expect(mapContainer(page)).toHaveAttribute("data-map-idle", "true");
  });
});
