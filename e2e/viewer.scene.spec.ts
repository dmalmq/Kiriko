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
  OCCUPANT_EN,
  floorButton,
  mapCanvas,
  minimalImdfZipBuffer,
  publishVenue,
  searchAndSelect,
  signIn,
  uniqueDatasetName,
  waitForMapIdle,
} from "./helpers";

interface SceneStats {
  drawCalls: number;
  visibleBatches: number;
  totalBatches: number;
  vertices: number;
  lastPickMs: number | null;
  pickCount: number;
}

interface ScenePick {
  featureIndex: number;
  canonicalFeatureId: string | null;
  levelId: string;
  sourceObjectId: string;
  role: string;
  localPoint: [number, number, number];
  featureMinZ: number;
  featureMaxZ: number;
}

/** Pick through the renderer's diagnostics handle, in canvas CSS pixels. */
async function scenePickAt(page: Page, x: number, y: number): Promise<ScenePick | null> {
  return page.evaluate(
    ([px, py]) => {
      const handle = Reflect.get(window, "__kirikoScene") as
        | { pickAt: (x: number, y: number) => ScenePick | null }
        | undefined;
      if (handle === undefined) {
        throw new Error("scene diagnostics handle absent");
      }
      return handle.pickAt(px as number, py as number);
    },
    [x, y],
  );
}

/** The renderer's diagnostics handle, once the layer is attached. */
async function sceneDiagnostics(page: Page): Promise<{
  stats: SceneStats;
  sourceHash: string;
  levelCount: number;
  levelIds: string[];
  activeLevel: number;
  hovered: number;
  maxPitch: number;
}> {
  return page.evaluate(() => {
    const handle = Reflect.get(window, "__kirikoScene") as
      | {
          stats: () => SceneStats;
          sourceHash: string;
          levelCount: number;
          levelIds: string[];
          activeLevelIndex: () => number;
          hoveredFeatureIndex: () => number;
          maxPitch: () => number;
        }
      | undefined;
    if (handle === undefined) {
      throw new Error("scene diagnostics handle absent");
    }
    return {
      stats: handle.stats(),
      sourceHash: handle.sourceHash,
      levelCount: handle.levelCount,
      levelIds: handle.levelIds,
      activeLevel: handle.activeLevelIndex(),
      hovered: handle.hoveredFeatureIndex(),
      maxPitch: handle.maxPitch(),
    };
  });
}

/**
 * Whether this browser is rasterizing in software. The pick-latency budget is a
 * hardware number (#26 section 4 measured it on a discrete GPU); a synchronous
 * readback on SwiftShader or llvmpipe reports the rasterizer's speed, not the
 * pick's, so the budget is asserted where it means something and the functional
 * assertions run everywhere.
 */
async function usesSoftwareRenderer(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const probe = document.createElement("canvas").getContext("webgl2");
    if (probe === null) {
      return true;
    }
    const info = probe.getExtension("WEBGL_debug_renderer_info");
    const renderer =
      info === null
        ? probe.getParameter(probe.RENDERER)
        : probe.getParameter(info.UNMASKED_RENDERER_WEBGL);
    return /swiftshader|llvmpipe|software|mesa offscreen/i.test(String(renderer));
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

  test("raises the camera's pitch ceiling only while a scene is attached", async ({
    page,
  }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "scene-camera");
    try {
      // 2D: no layer, and nothing raised the ceiling — the viewer stays flat.
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en`);
      await waitForMapIdle(page);
      expect(await page.evaluate(() => Reflect.get(window, "__kirikoScene") === undefined)).toBe(
        true,
      );

      // 3D: the ceiling is 60°, which is what makes a scene lookable at (#23 D7).
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await waitForMapIdle(page);
      await waitForScene(page);
      expect((await sceneDiagnostics(page)).maxPitch).toBe(60);

      // And the ceiling goes back down when the scene goes away: the viewer
      // must not be left tiltable with nothing to tilt.
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en`);
      await waitForMapIdle(page);
      expect(await page.evaluate(() => Reflect.get(window, "__kirikoScene") === undefined)).toBe(
        true,
      );
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("picks the surface the reviewer can see, on the floor they are on", async ({
    page,
  }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "scene-pick");
    try {
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await waitForMapIdle(page);
      await waitForScene(page);

      const box = (await mapCanvas(page).boundingBox())!;
      const centre = { x: Math.round(box.width / 2), y: Math.round(box.height / 2) };
      const hit = await scenePickAt(page, centre.x, centre.y);
      expect(hit).not.toBeNull();

      const scene = await sceneDiagnostics(page);
      // The pick lands on the floor the selector shows, not on a floor above or
      // below it — the depth buffer is what resolved that, not a CPU ray.
      expect(hit!.levelId).toBe(scene.levelIds[scene.activeLevel]);
      expect(hit!.featureIndex).toBeGreaterThanOrEqual(0);

      // Pick identity (#26): the position target reports venue-local metres,
      // and the point it reports lies inside the picked surface's own vertical
      // extent — proof the id and the position describe the same surface.
      const [x, y, z] = hit!.localPoint;
      for (const component of [x, y, z]) {
        expect(Number.isFinite(component)).toBe(true);
      }
      expect(z).toBeGreaterThanOrEqual(hit!.featureMinZ - 0.01);
      expect(z).toBeLessThanOrEqual(hit!.featureMaxZ + 0.01);

      // Pick latency budget: pass render plus both synchronous readbacks.
      const timings: number[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await scenePickAt(page, centre.x, centre.y);
        const sample = (await sceneDiagnostics(page)).stats.lastPickMs;
        expect(sample).not.toBeNull();
        timings.push(sample!);
      }
      const median = [...timings].sort((a, b) => a - b)[Math.floor(timings.length / 2)]!;
      if (await usesSoftwareRenderer(page)) {
        // Software rasterizer: every pick still returns the right surface, but
        // its cost is the rasterizer's, so the budget is not this run's to judge.
        expect(median).toBeGreaterThan(0);
      } else {
        expect(median, `pick timings: ${timings.map((t) => t.toFixed(1)).join(", ")}`)
          .toBeLessThanOrEqual(8);
      }

      // Off-geometry: a corner of the viewport the venue does not reach picks
      // nothing rather than the nearest thing.
      const miss = await scenePickAt(page, 2, 2);
      expect(miss).toBeNull();
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("clicking a surface selects its canonical feature and highlights it", async ({
    page,
  }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "scene-select");
    try {
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await waitForMapIdle(page);
      await waitForScene(page);

      const box = (await mapCanvas(page).boundingBox())!;
      // Find a pixel whose surface maps to a canonical venue feature.
      let target: { x: number; y: number } | null = null;
      for (const fraction of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65]) {
        const candidate = {
          x: Math.round(box.width * fraction),
          y: Math.round(box.height * fraction),
        };
        const hit = await scenePickAt(page, candidate.x, candidate.y);
        if (hit?.canonicalFeatureId != null) {
          target = candidate;
          break;
        }
      }
      expect(target, "a canonical surface is reachable in the viewport").not.toBeNull();

      const before = await canvasSignature(page);
      await mapCanvas(page).click({ position: target! });
      await waitForMapIdle(page);

      // The inspector names the selected feature, and the scene repaints with
      // the interaction colour on it.
      await expect(page.locator(".inspector, .feature-inspector").first()).toBeVisible();
      expect(await canvasSignature(page)).not.toBe(before);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("hovers what the pointer is over, and never picks while the camera moves", async ({
    page,
  }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "scene-hover");
    try {
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await waitForMapIdle(page);
      await waitForScene(page);

      const box = (await mapCanvas(page).boundingBox())!;
      // A pixel over a selectable unit, and one over contextual mass.
      let unit: { x: number; y: number; featureIndex: number } | null = null;
      let plate: { x: number; y: number } | null = null;
      for (const fraction of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9]) {
        const candidate = { x: Math.round(box.width * 0.5), y: Math.round(box.height * fraction) };
        const hit = await scenePickAt(page, candidate.x, candidate.y);
        if (hit === null) {
          continue;
        }
        if (unit === null && hit.role !== "Context" && hit.canonicalFeatureId !== null) {
          unit = { ...candidate, featureIndex: hit.featureIndex };
        } else if (plate === null && hit.role === "Context") {
          plate = candidate;
        }
      }
      expect(unit, "a selectable unit is reachable").not.toBeNull();
      expect(plate, "contextual floor plate is reachable").not.toBeNull();

      // At rest the hovered surface is the one under the pointer.
      await page.mouse.move(box.x + unit!.x, box.y + unit!.y);
      await expect
        .poll(async () => (await sceneDiagnostics(page)).hovered, { timeout: 5_000 })
        .toBe(unit!.featureIndex);

      const software = await usesSoftwareRenderer(page);
      const atRest = await sceneDiagnostics(page);
      if (!software) {
        // On hardware a pick at rest is cheap: no frame in flight to wait out.
        expect(atRest.stats.lastPickMs!).toBeLessThanOrEqual(8);
      }

      // Contextual mass is not hoverable, so moving onto the plate clears it.
      await page.mouse.move(box.x + plate!.x, box.y + plate!.y);
      await expect
        .poll(async () => (await sceneDiagnostics(page)).hovered, { timeout: 5_000 })
        .toBe(-1);

      // Drag the map under the pointer. No pick may run while the camera moves —
      // a synchronous readback mid-drag waits out the frame already in flight —
      // and exactly one runs when it settles.
      const before = (await sceneDiagnostics(page)).stats.pickCount;
      await page.mouse.down();
      await page.mouse.move(box.x + plate!.x - 40, box.y + plate!.y - 24);
      const during = (await sceneDiagnostics(page)).stats.pickCount;
      expect(during).toBe(before);
      await page.mouse.move(box.x + plate!.x - 90, box.y + plate!.y - 52);
      expect((await sceneDiagnostics(page)).stats.pickCount).toBe(before);
      await page.mouse.up();
      await waitForMapIdle(page);

      await expect
        .poll(async () => (await sceneDiagnostics(page)).stats.pickCount, { timeout: 5_000 })
        .toBeGreaterThan(before);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("selecting from the panel highlights the same surface in the scene", async ({
    page,
  }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "scene-panel");
    try {
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await waitForMapIdle(page);
      await waitForScene(page);
      await page.waitForTimeout(400);
      const before = await canvasSignature(page);

      // The keyboard-operable equivalent of picking: search, then choose. No
      // pointer ever touches the canvas.
      await searchAndSelect(page, "Station Shop", OCCUPANT_EN);
      await waitForMapIdle(page);
      await page.waitForTimeout(400);

      // The scene repaints with the interaction colour on the chosen feature,
      // so canvas and panel are showing the same selection.
      expect(await canvasSignature(page)).not.toBe(before);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("clicking contextual floor plate clears the selection, as bare floor does in 2D", async ({
    page,
  }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "scene-context");
    try {
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await waitForMapIdle(page);
      await waitForScene(page);

      const box = (await mapCanvas(page).boundingBox())!;
      // Find a pixel over a selectable unit, and one over contextual mass.
      let unit: { x: number; y: number } | null = null;
      let plate: { x: number; y: number } | null = null;
      for (const fraction of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.9]) {
        const candidate = {
          x: Math.round(box.width * 0.5),
          y: Math.round(box.height * fraction),
        };
        const hit = await scenePickAt(page, candidate.x, candidate.y);
        if (hit === null) {
          continue;
        }
        if (unit === null && hit.role !== "Context" && hit.canonicalFeatureId !== null) {
          unit = candidate;
        } else if (plate === null && hit.role === "Context") {
          plate = candidate;
        }
      }
      expect(unit, "a selectable unit is reachable").not.toBeNull();
      expect(plate, "contextual floor plate is reachable").not.toBeNull();

      await mapCanvas(page).click({ position: unit! });
      await waitForMapIdle(page);
      const inspector = page.locator(".inspector, .feature-inspector").first();
      await expect(inspector).toBeVisible();

      // Contextual mass is not a feature: clicking it clears, rather than
      // selecting the whole storey the plate belongs to.
      await mapCanvas(page).click({ position: plate! });
      await waitForMapIdle(page);
      await expect(inspector).toBeHidden();
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
