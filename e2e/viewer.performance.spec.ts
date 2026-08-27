import { expect, test, type Page } from "@playwright/test";
import {
  LEVEL_CHANGE_CI_MEDIAN_MS,
  LEVEL_CHANGE_CI_P95_MS,
  percentileNearestRank,
} from "../tests/performanceStats";
import {
  floorButton,
  LEVEL_1F_SHORT,
  LEVEL_2F_SHORT,
  LEVEL_B1_SHORT,
  mapCanvas,
  minimalImdfZipBuffer,
  OCCUPANT_JA,
  uploadZip,
  VENUE_NAME_JA,
  VIEWER_URL,
  waitForMapIdle,
  waitForReadyVenue,
} from "./helpers";

async function measureUploadToIdle(page: Page, zipBuffer: Buffer): Promise<number> {
  await page.goto(VIEWER_URL);
  await page.waitForLoadState("load");

  // Stamp the start time in the page just before the file input change.
  await page.evaluate(() => {
    Reflect.set(window, "__imdfPerfStart", performance.now());
  });

  await uploadZip(page, zipBuffer);
  await waitForReadyVenue(page, VENUE_NAME_JA);
  await expect(floorButton(page, LEVEL_1F_SHORT)).toBeVisible();
  await waitForMapIdle(page);

  const elapsed = await page.evaluate(() => {
    const start = Reflect.get(window, "__imdfPerfStart");
    if (typeof start !== "number") {
      return -1;
    }
    return performance.now() - start;
  });
  if (elapsed < 0) {
    throw new Error("missing performance start mark");
  }
  return elapsed;
}

/**
 * MapLibre's default style transition is 300ms and keeps the map non-idle for
 * the full duration after setData. Zero it for repaint-budget samples so we
 * measure setData + render, not paint-property crossfades. Locates the Map
 * instance via the React fiber hook that IndoorMap stores in mapRef.
 */
async function zeroMapLibreTransitions(page: Page): Promise<void> {
  const ok = await page.evaluate(() => {
    const container = document.querySelector(".indoor-map");
    if (!(container instanceof HTMLElement)) {
      return false;
    }
    let fiberKey = "";
    for (const key of Object.getOwnPropertyNames(container)) {
      if (key.startsWith("__reactFiber")) {
        fiberKey = key;
        break;
      }
    }
    if (fiberKey === "") {
      return false;
    }

    type Fiber = {
      memoizedState?: { memoizedState?: unknown; next?: Fiber["memoizedState"] } | null;
      return?: Fiber | null;
    };

    const host = (container as unknown as Record<string, Fiber | undefined>)[fiberKey];
    if (!host) {
      return false;
    }

    let map: {
      style: { stylesheet: { transition?: { duration: number; delay: number } } };
      _fadeDuration?: number;
    } | null = null;

    let fiber: Fiber | null | undefined = host;
    for (let depth = 0; fiber && depth < 20 && map == null; depth += 1) {
      let hook = fiber.memoizedState;
      let hi = 0;
      while (hook && hi < 50 && map == null) {
        const state = hook.memoizedState;
        if (state && typeof state === "object" && state !== null && "current" in state) {
          const current = (state as { current: unknown }).current;
          if (
            current &&
            typeof current === "object" &&
            current !== null &&
            "fitBounds" in current &&
            "getSource" in current
          ) {
            map = current as unknown as {
              style: { stylesheet: { transition?: { duration: number; delay: number } } };
              _fadeDuration?: number;
            };
          }
        }
        hook = hook.next ?? null;
        hi += 1;
      }
      fiber = fiber.return;
    }

    if (map == null) {
      return false;
    }
    map.style.stylesheet.transition = { duration: 0, delay: 0 };
    map._fadeDuration = 0;
    return true;
  });
  if (!ok) {
    throw new Error("could not locate MapLibre map to zero transitions");
  }
}


test.describe("viewer performance", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "performance samples are Chromium-only");

  test("upload → ready+idle P95 ≤ 3000ms over 10 fresh loads", async ({ page }) => {
    test.setTimeout(180_000);
    const zipBuffer = await minimalImdfZipBuffer();
    const samples: number[] = [];

    for (let i = 0; i < 10; i += 1) {
      const ms = await measureUploadToIdle(page, zipBuffer);
      samples.push(ms);
      await page.goto("about:blank");
    }

    const p95 = percentileNearestRank(samples, 0.95);
    console.log(
      `upload→idle samples(ms)=${samples.map((n) => n.toFixed(1)).join(", ")} P95=${p95.toFixed(1)}`,
    );
    expect(p95, `upload→idle P95 ${p95.toFixed(1)}ms exceeds 3000ms`).toBeLessThanOrEqual(3000);
  });

  test("level-change median ≤ 120ms and P95 ≤ 180ms after 3 warm-ups over 30 alternating clicks", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // Measure setData + idle, not camera ease (FIT_DURATION_MS = 500).
    await page.emulateMedia({ reducedMotion: "reduce" });
    const zipBuffer = await minimalImdfZipBuffer();
    await page.goto(VIEWER_URL);
    await page.waitForLoadState("load");
    await uploadZip(page, zipBuffer);
    await waitForReadyVenue(page, VENUE_NAME_JA);
    await waitForMapIdle(page);
    await zeroMapLibreTransitions(page);
    const labels = [LEVEL_B1_SHORT, LEVEL_1F_SHORT, LEVEL_2F_SHORT, LEVEL_1F_SHORT];
    // 3 unmeasured warm-ups.
    for (let i = 0; i < 3; i += 1) {
      const label = labels[i % labels.length]!;
      await floorButton(page, label).click();
      await waitForMapIdle(page);
    }

    const samples: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const label = labels[i % labels.length]!;
      const ms = await page.evaluate(async (levelLabel) => {
        const container = document.querySelector(".indoor-map");
        if (!(container instanceof HTMLElement)) {
          throw new Error("map container missing");
        }
        delete container.dataset.mapIdle;

        const buttons = Array.from(
          document.querySelectorAll<HTMLButtonElement>(".floor-stack__btn"),
        );
        const button = buttons.find((b) => b.textContent?.trim() === levelLabel);
        if (!button) {
          throw new Error(`floor button not found: ${levelLabel}`);
        }

        return await new Promise<number>((resolve, reject) => {
          const start = performance.now();
          const timeout = window.setTimeout(() => {
            observer.disconnect();
            reject(new Error("level change idle timeout"));
          }, 10_000);

          const observer = new MutationObserver(() => {
            if (container.dataset.mapIdle === "true") {
              observer.disconnect();
              // MapLibre emits idle from its render loop only after the map has
              // no pending transitions or requested tiles. Waiting for another
              // animation frame adds one display-refresh interval to every
              // sample, making this map-work budget depend on runner refresh
              // cadence rather than level-change latency.
              window.clearTimeout(timeout);
              resolve(performance.now() - start);
            }
          });
          observer.observe(container, {
            attributes: true,
            attributeFilter: ["data-map-idle"],
          });
          button.click();
        });
      }, label);
      samples.push(ms);
      // Let leftover GeoJSON work and minor GC land between samples, not
      // inside the next click→idle window. Not part of the measured budget.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
    }

    const median = percentileNearestRank(samples, 0.5);
    const p95 = percentileNearestRank(samples, 0.95);
    console.log(
      `level-change samples(ms)=${samples.map((n) => n.toFixed(1)).join(", ")} median=${median.toFixed(1)} P95=${p95.toFixed(1)}`,
    );
    expect(
      median,
      `level-change median ${median.toFixed(1)}ms exceeds ${LEVEL_CHANGE_CI_MEDIAN_MS}ms`,
    ).toBeLessThanOrEqual(LEVEL_CHANGE_CI_MEDIAN_MS);
    expect(
      p95,
      `level-change P95 ${p95.toFixed(1)}ms exceeds ${LEVEL_CHANGE_CI_P95_MS}ms`,
    ).toBeLessThanOrEqual(LEVEL_CHANGE_CI_P95_MS);
  });

  test("1s drag keeps ≥30 frames and no longtask > 100ms", async ({ page }) => {
    test.setTimeout(60_000);
    const zipBuffer = await minimalImdfZipBuffer();
    await page.goto(VIEWER_URL);
    await page.waitForLoadState("load");
    await uploadZip(page, zipBuffer);
    await waitForReadyVenue(page, VENUE_NAME_JA);
    await waitForMapIdle(page);

    // Seed search results so detail selection is meaningful during the drag.
    await page.locator("#viewer-search-input").fill("駅");
    await expect(
      page.locator(".list-row", { hasText: OCCUPANT_JA }),
    ).toBeVisible({ timeout: 5_000 });

    const canvas = mapCanvas(page);
    const box = await canvas.boundingBox();
    if (box == null) {
      throw new Error("map canvas has no bounding box");
    }

    // Install frame counter + longtask observer before the drag window.
    await page.evaluate(() => {
      const state = {
        frames: 0,
        longTasks: [] as number[],
        running: true,
      };
      Reflect.set(window, "__imdfDragPerf", state);

      const tick = (): void => {
        if (!state.running) {
          return;
        }
        state.frames += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === "longtask" && entry.duration > 0) {
              state.longTasks.push(entry.duration);
            }
          }
        });
        observer.observe({ entryTypes: ["longtask"] });
        Reflect.set(window, "__imdfLongTaskObserver", observer);
      } catch {
        // longtask may be unavailable; frames still asserted.
      }
    });

    const startX = box.x + box.width * 0.4;
    const startY = box.y + box.height * 0.5;
    const endX = box.x + box.width * 0.7;
    const endY = box.y + box.height * 0.5;

    // Kick off alternating search/detail updates every 100ms for 1s.
    const churn = page.evaluate(async () => {
      const input = document.querySelector<HTMLInputElement>("#viewer-search-input");
      if (!input) {
        throw new Error("search input missing");
      }
      const results = () =>
        Array.from(document.querySelectorAll<HTMLButtonElement>(".list-row"));

      const texts = ["駅", "トイレ", "キオスク", "ショップ", "駅ナカ"];
      for (let i = 0; i < 10; i += 1) {
        const text = texts[i % texts.length]!;
        const descriptor = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        );
        const setter = descriptor?.set;
        if (setter) {
          setter.call(input, text);
        } else {
          input.value = text;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        await new Promise<void>((r) => {
          requestAnimationFrame(() => r());
        });
        const first = results()[0];
        if (first) {
          first.click();
        }
        await new Promise<void>((r) => {
          window.setTimeout(() => r(), 100);
        });
      }
    });

    // Concurrent 1s mouse drag over the canvas.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    const steps = 20;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const x = startX + (endX - startX) * t;
      const y = startY + (endY - startY) * t;
      await page.mouse.move(x, y, { steps: 1 });
      await page.waitForTimeout(50);
    }
    await page.mouse.up();
    await churn;

    const result = await page.evaluate(() => {
      const stateRaw = Reflect.get(window, "__imdfDragPerf");
      let frames = 0;
      let longTasks: number[] = [];
      if (stateRaw && typeof stateRaw === "object") {
        Reflect.set(stateRaw, "running", false);
        if ("frames" in stateRaw && typeof stateRaw.frames === "number") {
          frames = stateRaw.frames;
        }
        if ("longTasks" in stateRaw && Array.isArray(stateRaw.longTasks)) {
          longTasks = stateRaw.longTasks.filter((d: unknown): d is number => typeof d === "number");
        }
      }
      const observer = Reflect.get(window, "__imdfLongTaskObserver");
      if (observer && typeof observer === "object" && "disconnect" in observer) {
        const disconnect = Reflect.get(observer, "disconnect");
        if (typeof disconnect === "function") {
          disconnect.call(observer);
        }
      }
      return { frames, longTasks };
    });

    console.log(
      `drag frames=${result.frames} longtasks=${JSON.stringify(result.longTasks)}`,
    );
    expect(
      result.frames,
      `expected ≥30 animation frames, got ${result.frames}`,
    ).toBeGreaterThanOrEqual(30);
    const over = result.longTasks.filter((d) => d > 100);
    expect(over, `longtasks > 100ms: ${over.join(", ")}`).toEqual([]);
  });
});
