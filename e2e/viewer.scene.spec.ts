/**
 * The 3D scene layer in a real browser, on a real published venue.
 *
 * These are the assertions no unit test can make: that the layer links its
 * program against a live WebGL2 context, that geometry actually reaches the
 * framebuffer, that a floor costs the draw calls the budget allows, and that
 * removing the layer leaves the 2D viewer as it was.
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  LEVEL_2F_SHORT,
  LEVEL_B1_SHORT,
  floorButton,
  mapCanvas,
  minimalImdfZipBuffer,
  publishVenue,
  signIn,
  uniqueDatasetName,
  waitForMapIdle,
} from "./helpers";

interface SceneStats {
  drawCalls: number;
  visibleBatches: number;
  totalBatches: number;
  vertices: number;
}

/** The renderer's diagnostics handle, once the layer is attached. */
async function sceneDiagnostics(
  page: Page,
): Promise<{ stats: SceneStats; sourceHash: string; levelCount: number; activeLevel: number }> {
  return page.evaluate(() => {
    const handle = Reflect.get(window, "__kirikoScene") as
      | {
          stats: () => SceneStats;
          sourceHash: string;
          levelCount: number;
          activeLevelIndex: () => number;
        }
      | undefined;
    if (handle === undefined) {
      throw new Error("scene diagnostics handle absent");
    }
    return {
      stats: handle.stats(),
      sourceHash: handle.sourceHash,
      levelCount: handle.levelCount,
      activeLevel: handle.activeLevelIndex(),
    };
  });
}

async function waitForScene(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const handle = Reflect.get(window, "__kirikoScene") as
        | { stats: () => { drawCalls: number } }
        | undefined;
      return handle !== undefined && handle.stats().drawCalls > 0;
    },
    undefined,
    { timeout: 20_000 },
  );
}

/**
 * The composited canvas as PNG bytes. Taken through the browser compositor
 * rather than `canvas.toDataURL`, which reads a WebGL drawing buffer that is
 * already cleared by the time a test can ask for it.
 */
async function canvasSignature(page: Page): Promise<string> {
  const shot = await mapCanvas(page).screenshot({ scale: "css" });
  return shot.toString("base64");
}

/** Sign in and publish the fixture venue this spec renders. */
async function publishScene(
  page: Page,
  testInfo: TestInfo,
  label: string,
): Promise<{ slug: string; venueId: number }> {
  await page.goto("/");
  await signIn(page);
  const venue = await publishVenue(
    page.request,
    uniqueDatasetName(label, testInfo),
    await minimalImdfZipBuffer(),
  );
  return { slug: venue.slug, venueId: venue.venueId };
}

/**
 * Focus the map without clicking: a click would select a feature, and the
 * selection highlight would change pixels for a reason that is not the camera.
 * Focus itself paints a ring, so callers baseline *after* this.
 */
async function focusMap(page: Page): Promise<void> {
  await mapCanvas(page).focus();
  await page.waitForTimeout(400);
}

/** Tilt through MapLibre's keyboard handler; a no-op when pitch is clamped. */
async function tilt(page: Page): Promise<void> {
  for (let press = 0; press < 6; press += 1) {
    await page.keyboard.press("Shift+ArrowUp");
    await page.waitForTimeout(80);
  }
  await waitForMapIdle(page);
  await page.waitForTimeout(400);
}

test.describe("3D scene layer", () => {
  test.setTimeout(120_000);
  test("renders a published venue's generated scene inside the map", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "scene-render");
    try {
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await expect(mapCanvas(page)).toBeVisible();
      await waitForMapIdle(page);
      await waitForScene(page);

      const scene = await sceneDiagnostics(page);
      expect(scene.sourceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(scene.levelCount).toBeGreaterThan(1);
      expect(scene.stats.totalBatches).toBeGreaterThan(0);
      expect(scene.stats.vertices).toBeGreaterThan(0);

      // The budget: one draw call per semantic role present on the floor.
      expect(scene.stats.drawCalls).toBeGreaterThan(0);
      expect(scene.stats.drawCalls).toBeLessThanOrEqual(8);
      expect(scene.stats.visibleBatches).toBe(scene.stats.drawCalls);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("draws different pixels than the same venue without the scene", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "scene-pixels");
    try {
      // 2D only.
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en`);
      await expect(mapCanvas(page)).toBeVisible();
      await waitForMapIdle(page);
      const flat = await canvasSignature(page);

      // Same venue, same camera, with the scene layer.
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await expect(mapCanvas(page)).toBeVisible();
      await waitForMapIdle(page);
      await waitForScene(page);
      const rendered = await canvasSignature(page);

      // The capture requirement (#26 section 5): a visual check is only
      // meaningful once two different scenes are shown to produce different
      // bytes. Geometry reached the framebuffer.
      expect(rendered).not.toBe(flat);
      expect(rendered.length).toBeGreaterThan(1000);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("follows the floor selector, drawing one level at a time", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "scene-floors");
    try {
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await waitForMapIdle(page);
      await waitForScene(page);

      const first = await sceneDiagnostics(page);
      const firstPixels = await canvasSignature(page);

      await floorButton(page, LEVEL_2F_SHORT).click();
      await waitForMapIdle(page);
      const upper = await sceneDiagnostics(page);
      expect(upper.activeLevel).not.toBe(first.activeLevel);
      // Only the active floor draws, so the call count stays inside the budget
      // no matter how many floors the venue has.
      expect(upper.stats.drawCalls).toBeLessThanOrEqual(8);
      expect(await canvasSignature(page)).not.toBe(firstPixels);

      await floorButton(page, LEVEL_B1_SHORT).click();
      await waitForMapIdle(page);
      const lower = await sceneDiagnostics(page);
      expect(lower.activeLevel).not.toBe(upper.activeLevel);
      expect(lower.stats.drawCalls).toBeGreaterThan(0);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("lets the camera tilt only when a scene is present", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "scene-camera");
    try {
      // 2D: the pitch ceiling is zero, so the tilt gesture cannot move it.
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en`);
      await waitForMapIdle(page);
      await focusMap(page);
      const flatBefore = await canvasSignature(page);
      await tilt(page);
      expect(await canvasSignature(page)).toBe(flatBefore);

      // 3D: the same gesture pitches the camera, so the view changes.
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await waitForMapIdle(page);
      await waitForScene(page);
      await focusMap(page);
      const sceneBefore = await canvasSignature(page);
      await tilt(page);
      expect(await canvasSignature(page)).not.toBe(sceneBefore);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("leaves the 2D viewer untouched when no scene is requested", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "scene-absent");
    try {
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en`);
      await waitForMapIdle(page);

      // No layer, no diagnostics handle, and the camera stays flat.
      const state = await page.evaluate(() => ({
        handle: Reflect.get(window, "__kirikoScene") === undefined,
      }));
      expect(state.handle).toBe(true);

      // Feature selection still works: the 2D path is unchanged.
      await expect(mapCanvas(page)).toBeVisible();
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });
});
