/**
 * The Stage 2 proof's runtime half (#64): the load budgets, the capture
 * requirement, and the visual-correctness criteria that need a real camera at a
 * real zoom (#26 sections 4 and 5).
 *
 * Runs in the single-worker performance project. Timing budgets only mean
 * something when nothing else contends for the CPU or the GPU, and the capture
 * assertions read the drawing buffer, which requires the viewer's `capture`
 * mode.
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  mapCanvas,
  minimalImdfZipBuffer,
  publishVenue,
  signIn,
  uniqueDatasetName,
  waitForMapIdle,
} from "./helpers";

/** #26 section 4. */
const DECODE_BUDGET_MS = 1_200;
const UPLOAD_BUDGET_MS = 200;
const DRAW_CALLS_PER_LEVEL = 8;
const DRAW_CALLS_ALL_LEVELS = 320;

interface SceneHandle {
  stats: {
    drawCalls: number;
    visibleBatches: number;
    totalBatches: number;
    vertices: number;
    lastPickMs: number | null;
    pickCount: number;
    uploadMs: number | null;
  };
  camera: { zoom: number; pitch: number; bearing: number };
  levelIds: string[];
  activeLevels: number[];
}

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

async function sceneHandle(page: Page): Promise<SceneHandle> {
  return page.evaluate(() => {
    const handle = Reflect.get(window, "__kirikoScene") as
      | {
          stats: () => SceneHandle["stats"];
          camera: () => SceneHandle["camera"];
          levelIds: string[];
          activeLevelIndices: () => number[];
        }
      | undefined;
    if (handle === undefined) {
      throw new Error("scene diagnostics handle absent");
    }
    return {
      stats: handle.stats(),
      camera: handle.camera(),
      levelIds: handle.levelIds,
      activeLevels: handle.activeLevelIndices(),
    };
  });
}

async function openScene(page: Page, slug: string, capture: boolean): Promise<void> {
  await page.goto(
    `/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1${capture ? "&capture=1" : ""}`,
  );
  await expect(mapCanvas(page)).toBeVisible();
  await waitForMapIdle(page);
  await page.waitForFunction(
    () => {
      const handle = Reflect.get(window, "__kirikoScene") as
        | { stats: () => { drawCalls: number } }
        | undefined;
      return handle !== undefined && handle.stats().drawCalls > 0;
    },
    undefined,
    { timeout: 30_000 },
  );
}

/**
 * The drawing buffer's own bytes. Unlike a compositor screenshot this proves the
 * renderer produced the pixels, which is the point of the capture requirement —
 * and it only works because `capture` mode preserves the buffer.
 */
async function drawingBufferBytes(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".indoor-map canvas");
    if (canvas === null) {
      throw new Error("map canvas absent");
    }
    return canvas.toDataURL("image/png");
  });
}

/** Push the camera toward a target zoom and pitch through real input. */
async function driveCamera(page: Page, wheelSteps: number, pitchPresses: number): Promise<void> {
  const box = (await mapCanvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < wheelSteps; step += 1) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(120);
  }
  await mapCanvas(page).focus();
  for (let press = 0; press < pitchPresses; press += 1) {
    await page.keyboard.press("Shift+ArrowUp");
    await page.waitForTimeout(90);
  }
  await waitForMapIdle(page);
  await page.waitForTimeout(500);
}

test.describe("scene performance and visual correctness", () => {
  test.setTimeout(180_000);

  test("decodes and uploads a scene inside the load budgets", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "s2-load");
    try {
      await openScene(page, slug, false);

      const decodeMs = await page.evaluate(() => {
        const entries = performance.getEntriesByName("kiriko-scene-decode");
        return entries.length === 0 ? -1 : entries[entries.length - 1]!.duration;
      });
      const { stats } = await sceneHandle(page);

      // Decode: fetch, the worker's compile of §9, and building typed views.
      expect(decodeMs, "decode was never measured").toBeGreaterThan(0);
      expect(decodeMs, `decode ${decodeMs.toFixed(0)}ms`).toBeLessThanOrEqual(DECODE_BUDGET_MS);

      // Upload: programs, buffers, vertex arrays, pick targets.
      expect(stats.uploadMs, "upload was never measured").not.toBeNull();
      expect(
        stats.uploadMs!,
        `upload ${stats.uploadMs!.toFixed(1)}ms`,
      ).toBeLessThanOrEqual(UPLOAD_BUDGET_MS);

      console.log(
        `scene load: decode=${decodeMs.toFixed(0)}ms upload=${stats.uploadMs!.toFixed(1)}ms ` +
          `batches=${stats.totalBatches} vertices=${stats.vertices}`,
      );
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("holds the draw-call budgets per level and across the venue", async ({
    page,
  }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "s2-calls");
    try {
      await openScene(page, slug, false);
      const handle = await sceneHandle(page);

      // Per active level, and for every level the scene carries.
      expect(handle.stats.drawCalls).toBeLessThanOrEqual(DRAW_CALLS_PER_LEVEL);
      expect(handle.stats.totalBatches).toBeLessThanOrEqual(DRAW_CALLS_ALL_LEVELS);
      // Every batch is a merged (level, role) pair, so the venue's batch count
      // is what an all-levels frame would cost.
      expect(handle.stats.visibleBatches).toBe(handle.stats.drawCalls);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("proves the capture path before asserting on any pixels", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "s2-capture");
    try {
      // The capture requirement (#26 section 5): a visual assertion is only
      // meaningful once two different scenes are shown to produce different
      // bytes *through the same path the assertion uses*.
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&capture=1`);
      await expect(mapCanvas(page)).toBeVisible();
      await waitForMapIdle(page);
      const flat = await drawingBufferBytes(page);

      await openScene(page, slug, true);
      const rendered = await drawingBufferBytes(page);

      // Both reads came from the preserved drawing buffer, and they differ, so
      // the buffer is genuinely carrying what the renderer drew.
      expect(flat.length).toBeGreaterThan(1000);
      expect(rendered.length).toBeGreaterThan(1000);
      expect(rendered).not.toBe(flat);

      // A second read with no camera change returns the same bytes: the scene
      // renders deterministically rather than shimmering between frames.
      expect(await drawingBufferBytes(page)).toBe(rendered);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("renders stably at high zoom and pitch", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "s2-stability");
    try {
      await openScene(page, slug, true);
      await driveCamera(page, 10, 12);

      const handle = await sceneHandle(page);
      console.log(
        `stability camera: zoom=${handle.camera.zoom.toFixed(1)} ` +
          `pitch=${handle.camera.pitch.toFixed(1)}`,
      );
      // The criterion is stability at zoom 21 / pitch 55 (#26 section 5); the
      // camera is driven through real input, so this asserts it actually got
      // somewhere demanding before judging what it drew.
      expect(handle.camera.zoom).toBeGreaterThan(17);
      expect(handle.camera.pitch).toBeGreaterThan(40);

      // Two reads at rest, no camera change: identical bytes. Z-fighting and
      // vertex jitter both show up here as a difference.
      const first = await drawingBufferBytes(page);
      await page.waitForTimeout(400);
      expect(await drawingBufferBytes(page)).toBe(first);

      // And the scene is still drawing, not blank: something reached the buffer.
      expect(handle.stats.drawCalls).toBeGreaterThan(0);
      expect(handle.stats.drawCalls).toBeLessThanOrEqual(DRAW_CALLS_PER_LEVEL);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("keeps pick identity at high zoom and pitch", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "s2-pick-identity");
    try {
      await openScene(page, slug, false);
      await driveCamera(page, 8, 10);

      const box = (await mapCanvas(page).boundingBox())!;
      const hit = await page.evaluate(
        ([x, y]) => {
          const handle = Reflect.get(window, "__kirikoScene") as {
            pickAt: (
              px: number,
              py: number,
            ) => {
              levelId: string;
              localPoint: [number, number, number];
              featureMinZ: number;
              featureMaxZ: number;
            } | null;
          };
          return handle.pickAt(x as number, y as number);
        },
        [Math.round(box.width / 2), Math.round(box.height * 0.6)],
      );
      expect(hit, "a surface is under the centre of a pitched view").not.toBeNull();

      // Pick attribution (#26): the id and the position describe the same
      // surface, at a camera where a CPU ray would be least forgiving.
      const handle = await sceneHandle(page);
      expect(hit!.levelId).toBe(handle.levelIds[handle.activeLevels[0] ?? 0]);
      expect(hit!.localPoint[2]).toBeGreaterThanOrEqual(hit!.featureMinZ - 0.05);
      expect(hit!.localPoint[2]).toBeLessThanOrEqual(hit!.featureMaxZ + 0.05);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });
});
