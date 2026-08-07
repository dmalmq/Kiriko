/**
 * The capability floor, the universal 2D fallback, and context-loss recovery in
 * a real browser (#62).
 *
 * The assertions that matter here are about what survives: a device that cannot
 * render 3D still gets a working venue, and a source swap never costs the
 * reviewer their floor, their selection, or their route.
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  LEVEL_2F_SHORT,
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

async function sceneAttached(page: Page): Promise<boolean> {
  return page.evaluate(() => Reflect.get(window, "__kirikoScene") !== undefined);
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
 * Deny one capability the floor requires, before any application code runs.
 * `EXT_color_buffer_float` is the pick path's requirement, and denying it is
 * how a device without the floor is simulated honestly — the probe runs its
 * real checks against a context that genuinely lacks the extension.
 */
async function denyFloatColorBuffer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const prototype = WebGL2RenderingContext.prototype as unknown as {
      getExtension: (name: string) => unknown;
    };
    const original = prototype.getExtension;
    prototype.getExtension = function patched(this: WebGL2RenderingContext, name: string) {
      return name === "EXT_color_buffer_float" ? null : original.call(this, name);
    };
  });
}

/**
 * Capture the loss extension while the context is alive. A lost context answers
 * `getExtension` with `null`, so fetching it after the loss could never restore
 * anything — the harness has to hold the handle across the gap.
 */
async function armContextLoss(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".indoor-map canvas");
    const gl = canvas?.getContext("webgl2") ?? null;
    Reflect.set(window, "__loseContext", gl?.getExtension("WEBGL_lose_context") ?? null);
  });
}

test.describe("3D capability and fallback", () => {
  test.setTimeout(120_000);

  test("a device without the capability floor gets a working 2D venue", async ({
    page,
  }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "cap-unmet");
    try {
      await denyFloatColorBuffer(page);
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await waitForMapIdle(page);

      // No layer is created — there is no partial-3D tier.
      expect(await sceneAttached(page)).toBe(false);

      // The badge says what is rendering, and the notice says why, in prose a
      // reviewer can act on rather than naming a GL extension.
      await expect(page.locator(".scene-source__provenance")).toHaveText(
        "Universal 2D fallback",
      );
      const notice = page.locator(".scene-notice");
      await expect(notice).toBeVisible();
      await expect(notice).toContainText("3D is unavailable on this device");
      await expect(notice).not.toContainText("WebGL");
      // Retrying a device that cannot render 3D is not offered.
      await expect(page.locator(".scene-notice__retry")).toHaveCount(0);

      // And the venue works: floors switch, features select.
      await floorButton(page, LEVEL_2F_SHORT).click();
      await waitForMapIdle(page);
      await expect(floorButton(page, LEVEL_2F_SHORT)).toHaveAttribute("aria-pressed", "true");
      await searchAndSelect(page, "Station Shop", OCCUPANT_EN);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("the badge names the generated source while 3D renders", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "cap-badge");
    try {
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await waitForMapIdle(page);
      await waitForScene(page);

      await expect(page.locator(".scene-source__badge")).toHaveText("Generated 3D");
      await expect(page.locator(".scene-source__provenance")).toContainText(
        "evidence-backed approximation",
      );
      // Nothing fell back, so there is no notice.
      await expect(page.locator(".scene-notice")).toHaveCount(0);
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("switching to 2D keeps the floor and the selection, and can be undone", async ({
    page,
  }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "cap-switch");
    try {
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await waitForMapIdle(page);
      await waitForScene(page);

      // Establish state worth losing: a selection, and whatever floor it put
      // the viewer on (selecting a feature moves the floor to its own).
      await searchAndSelect(page, "Station Shop", OCCUPANT_EN);
      const inspector = page.locator(".inspector, .feature-inspector").first();
      await expect(inspector).toBeVisible();
      const pressedFloor = page.locator('.floor-stack__btn[aria-pressed="true"]');
      const floorBefore = await pressedFloor.textContent();
      expect(floorBefore).not.toBeNull();

      // The reviewer chooses 2D.
      await page.locator(".scene-source__switch").click();
      await expect.poll(async () => sceneAttached(page), { timeout: 10_000 }).toBe(false);

      // Floor and selection survived the swap: the source changed, the state did
      // not, because the state never lived in the renderer.
      await expect(pressedFloor).toHaveText(floorBefore!);
      await expect(inspector).toBeVisible();
      await expect(page.locator(".scene-source__provenance")).toHaveText(
        "Universal 2D fallback",
      );

      // And 3D is offered back, because this device can render it.
      const retry = page.locator(".scene-notice__retry");
      await expect(retry).toBeVisible();
      await retry.click();
      await waitForScene(page);
      await expect(page.locator(".scene-source__badge")).toHaveText("Generated 3D");
      await expect(pressedFloor).toHaveText(floorBefore!);
      await expect(inspector).toBeVisible();
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("a lost context recovers to the same view", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "cap-context");
    try {
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await waitForMapIdle(page);
      await waitForScene(page);

      await floorButton(page, LEVEL_2F_SHORT).click();
      await waitForMapIdle(page);
      const before = await page.evaluate(() => {
        const handle = Reflect.get(window, "__kirikoScene") as {
          activeLevelIndex: () => number;
          sourceHash: string;
        };
        return { level: handle.activeLevelIndex(), hash: handle.sourceHash };
      });

      await armContextLoss(page);
      // Lose the context the way a driver reset would.
      await page.evaluate(() => {
        (Reflect.get(window, "__loseContext") as { loseContext: () => void } | null)?.loseContext();
      });

      // The layer steps down rather than drawing against a dead context.
      await expect.poll(async () => sceneAttached(page), { timeout: 10_000 }).toBe(false);

      // While 3D is down the reviewer is told, and offered a way back.
      await expect(page.locator(".scene-source__provenance")).toHaveText(
        "Universal 2D fallback",
      );
      await expect(page.locator(".scene-notice")).toContainText(
        "3D rendering was interrupted",
      );

      // Restore, as the browser does when the driver comes back.
      await page.evaluate(() => {
        (Reflect.get(window, "__loseContext") as { restoreContext: () => void } | null)
          ?.restoreContext();
      });

      // Recovery re-establishes the scene on the same floor.
      await page.waitForFunction(
        () => Reflect.get(window, "__kirikoScene") !== undefined,
        undefined,
        { timeout: 30_000 },
      );
      await waitForMapIdle(page);
      const after = await page.evaluate(() => {
        const handle = Reflect.get(window, "__kirikoScene") as {
          activeLevelIndex: () => number;
          sourceHash: string;
        };
        return { level: handle.activeLevelIndex(), hash: handle.sourceHash };
      });
      expect(after).toEqual(before);
      await expect(floorButton(page, LEVEL_2F_SHORT)).toHaveAttribute("aria-pressed", "true");
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("shows the badge and notice in Japanese", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "cap-ja");
    try {
      await denyFloatColorBuffer(page);
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=ja&scene=1`);
      await waitForMapIdle(page);

      await expect(page.locator(".scene-source__provenance")).toHaveText("共通2D表示");
      await expect(page.locator(".scene-notice")).toContainText("3D表示を利用できません");
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("replaces the source with no veil under reduced motion", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "cap-motion");
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en&scene=1`);
      await waitForMapIdle(page);
      await waitForScene(page);

      // Reduced motion produces the same states in the same order with no
      // interpolation and no source veil (#32): the source is replaced at once.
      await page.locator(".scene-source__switch").click();
      await expect.poll(async () => sceneAttached(page), { timeout: 10_000 }).toBe(false);
      await expect(page.locator(".scene-veil")).toHaveCount(0);
      await expect(page.locator(".scene-source__provenance")).toHaveText(
        "Universal 2D fallback",
      );
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });

  test("adds no chrome at all to a venue opened without 3D", async ({ page }, testInfo) => {
    const { slug, venueId } = await publishScene(page, testInfo, "cap-absent");
    try {
      await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en`);
      await waitForMapIdle(page);

      // A 2D-only session is not a fallback and must not be labelled as one.
      await expect(page.locator(".scene-source")).toHaveCount(0);
      await expect(page.locator(".scene-notice")).toHaveCount(0);
      await expect(mapCanvas(page)).toBeVisible();
    } finally {
      await page.request.delete(`/api/venues/${venueId}`);
    }
  });
});
