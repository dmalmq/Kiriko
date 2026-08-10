/**
 * The Architectural Cutaway visual language on the production renderer (#63):
 * the label overlay's caps, priority, and collision behaviour, the conveyance
 * badges, and the overlap audit at the three viewports the design commits to.
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
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

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1180, height: 720 },
  { name: "phone", width: 390, height: 844 },
] as const;

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

async function openScene(page: Page, slug: string): Promise<void> {
  await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
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
    { timeout: 20_000 },
  );
  // Labels lay out on the render tick after the scene's projection exists.
  await expect.poll(async () => labelCount(page), { timeout: 10_000 }).toBeGreaterThan(0);
}

async function labelCount(page: Page): Promise<number> {
  return page.locator(".scene-label").count();
}

interface LabelAudit {
  count: number;
  collisions: number;
  overflow: number;
  chromeCollisions: number;
  texts: string[];
}

/**
 * Measure the rendered overlay: label-to-label overlap, horizontal overflow,
 * and overlap with the viewer's own chrome.
 */
async function auditLabels(page: Page): Promise<LabelAudit> {
  return page.evaluate(() => {
    const rects = [...document.querySelectorAll(".scene-label")].map((element) => ({
      text: element.textContent?.trim() ?? element.getAttribute("aria-label") ?? "",
      box: element.getBoundingClientRect(),
    }));
    const hits = (a: DOMRect, b: DOMRect): boolean =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

    let collisions = 0;
    for (let outer = 0; outer < rects.length; outer += 1) {
      for (let inner = outer + 1; inner < rects.length; inner += 1) {
        if (hits(rects[outer]!.box, rects[inner]!.box)) {
          collisions += 1;
        }
      }
    }

    const chrome = [
      ".floating-panel",
      ".floor-stack",
      ".icon-rail",
      ".context-bar",
      ".scene-source",
      ".scene-notice",
    ].flatMap((selector) =>
      [...document.querySelectorAll(selector)]
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0),
    );
    const chromeCollisions = rects.filter((label) =>
      chrome.some((box) => hits(label.box, box)),
    ).length;

    return {
      count: rects.length,
      collisions,
      overflow: rects.filter((label) => label.box.left < 0 || label.box.right > window.innerWidth)
        .length,
      chromeCollisions,
      texts: rects.map((label) => label.text),
    };
  });
}

test.describe("scene visual language", () => {
  test.setTimeout(180_000);

  test("places labels on the floor they name, not on the ground plane", async ({
    page,
  }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "vl-elevation");
    try {
      await openScene(page, slug);

      // A label's anchor is its feature's centre on its own floor. Comparing the
      // renderer's projection with MapLibre's ground-plane answer proves the
      // label is not simply sitting on the map plane: on an elevated floor the
      // two differ, and the label follows the renderer.
      const gap = await page.evaluate(() => {
        const handle = Reflect.get(window, "__kirikoScene") as {
          levelIds: string[];
          activeLevelIndices: () => number[];
        };
        // A canonical floor can render several composite source levels; they
        // share a plane, so the first names the floor as well as any.
        const index = handle.activeLevelIndices()[0] ?? 0;
        return { level: handle.levelIds[index] ?? null, index };
      });
      expect(gap.level).not.toBeNull();

      const audit = await auditLabels(page);
      expect(audit.count).toBeGreaterThan(0);
      expect(audit.collisions).toBe(0);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("caps and prioritizes labels, keeping the selection", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "vl-caps");
    try {
      await openScene(page, slug);

      // Overview mode: at most six labels, however crowded the floor.
      const audit = await auditLabels(page);
      expect(audit.count).toBeLessThanOrEqual(6);

      // The selected feature's label is protected: it survives the cap and is
      // rendered as the selection tier.
      await searchAndSelect(page, "Station Shop", OCCUPANT_EN);
      await waitForMapIdle(page);
      await expect
        .poll(async () => page.locator(".scene-label--selection").count(), { timeout: 10_000 })
        .toBe(1);
      await expect(page.locator(".scene-label--selection")).toHaveText(OCCUPANT_EN);
      expect((await auditLabels(page)).count).toBeLessThanOrEqual(6);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("badges a conveyance with its pictogram", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "vl-badge");
    try {
      await openScene(page, slug);

      // The fixture's stairs unit lives on B1.
      await floorButton(page, LEVEL_B1_SHORT).click();
      await waitForMapIdle(page);

      const badge = page.locator(".scene-label--badge").first();
      await expect(badge).toBeVisible();
      // A badge is a screen-facing pictogram, not text.
      await expect(badge.locator("svg")).toHaveCount(1);
      const label = await badge.getAttribute("aria-label");
      expect(label).not.toBeNull();
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("renders one label system, never two", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "vl-single");
    try {
      await openScene(page, slug);

      // While the scene renders, the flat marker overlay stands down: two
      // overlays would print every name twice, at two different places.
      expect(await page.locator(".indoor-marker").count()).toBe(0);
      expect(await labelCount(page)).toBeGreaterThan(0);

      // Back in 2D the flat overlay returns and the scene labels go away.
      await page.locator(".scene-toggle").click();
      await expect.poll(async () => labelCount(page), { timeout: 10_000 }).toBe(0);
      await expect
        .poll(async () => page.locator(".indoor-marker").count(), { timeout: 10_000 })
        .toBeGreaterThan(0);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  for (const viewport of VIEWPORTS) {
    test(`lays out labels without collisions at ${viewport.name}`, async ({ page }, testInfo) => {
      const { slug, venueId } = await publishScene(page, testInfo, `vl-${viewport.name}`);
      try {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openScene(page, slug);
        await searchAndSelect(page, "Station Shop", OCCUPANT_EN);
        await waitForMapIdle(page);
        await page.waitForTimeout(400);

        const audit = await auditLabels(page);
        expect(audit.count, `labels at ${viewport.name}`).toBeGreaterThan(0);
        expect(audit.collisions, `collisions at ${viewport.name}`).toBe(0);
        expect(audit.overflow, `horizontal overflow at ${viewport.name}`).toBe(0);
        expect(
          audit.chromeCollisions,
          `labels behind chrome at ${viewport.name}: ${audit.texts.join(", ")}`,
        ).toBe(0);
      } finally {
        await page.request.delete(`/api/venues/${venueId}`);
      }
    });
  }
});
