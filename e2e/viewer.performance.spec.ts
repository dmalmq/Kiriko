import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
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

function percentileNearestRank(samples: number[], p: number): number {
  if (samples.length === 0) {
    throw new Error("percentileNearestRank: empty samples");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil(p * sorted.length) - 1;
  const clamped = Math.max(0, Math.min(sorted.length - 1, index));
  return sorted[clamped]!;
}

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
    Reflect.set(window, "__kirikoPerfMap", map);
    return true;
  });
  if (!ok) {
    throw new Error("could not locate MapLibre map to zero transitions");
  }
}

const LEVEL_SOURCE_IDS = [
  "indoor-features",
  "indoor-route",
  "indoor-network",
  "indoor-facilities",
] as const;

interface SourceUpdateTiming {
  sourceId: string;
  operation: "setData" | "updateData";
  startMs: number;
  durationMs: number;
}

interface SourceEventTiming {
  type: "dataloading" | "sourcedata";
  sourceId: string;
  atMs: number;
  isSourceLoaded: boolean | null;
}

interface LongTaskTiming {
  startMs: number;
  durationMs: number;
}

interface LevelChangeDiagnostic {
  sample: number;
  label: string;
  elapsedMs: number;
  phases: {
    clickToFirstSourceMs: number | null;
    sourceWorkEndMs: number | null;
    sourceEndToIdleMs: number | null;
    idleToFinalFrameMs: number | null;
  };
  sourceUpdates: SourceUpdateTiming[];
  sourceEvents: SourceEventTiming[];
  render: {
    count: number;
    firstMs: number | null;
    lastMs: number | null;
    idleMs: number | null;
    finalFrameMs: number;
  };
  longTaskObserverSupported: boolean;
  longTasks: LongTaskTiming[];
}

interface LevelChangeEnvironment {
  browserVersion: string;
  webglVendor: string;
  webglRenderer: string;
}

interface LevelChangeControlRun {
  samples: number[];
  environment: LevelChangeEnvironment;
}

interface LevelChangeDiagnosticRun {
  diagnostics: LevelChangeDiagnostic[];
  environment: LevelChangeEnvironment;
  error: string | null;
}

/**
 * Keep the acceptance clock identical to the original gate. In particular,
 * source monkey-patching and PerformanceObserver callbacks must not execute in
 * the 30 control samples: on slower hosted CPUs that instrumentation changes
 * MapLibre's worker/render scheduling enough to become what the test measures.
 */
async function measureLevelChangeElapsed(page: Page, label: string): Promise<number> {
  return await page.evaluate(async (levelLabel) => {
    const container = document.querySelector(".indoor-map");
    if (!(container instanceof HTMLElement)) {
      throw new Error("map container missing");
    }
    delete container.dataset.mapIdle;

    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".floor-stack__btn"),
    ).find((candidate) => candidate.textContent?.trim() === levelLabel);
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
        if (container.dataset.mapIdle !== "true") {
          return;
        }
        observer.disconnect();
        requestAnimationFrame(() => {
          window.clearTimeout(timeout);
          resolve(performance.now() - start);
        });
      });
      observer.observe(container, {
        attributes: true,
        attributeFilter: ["data-map-idle"],
      });
      button.click();
    });
  }, label);
}

/** A separate instrumented probe; never contributes to the gate percentile. */
async function measureLevelChangeDiagnostic(
  page: Page,
  label: string,
  sample: number,
): Promise<LevelChangeDiagnostic> {
  return await page.evaluate(
    async ({ levelLabel, sampleIndex, sourceIds }) => {
      type PerfMapEvent = {
        sourceId?: string;
        isSourceLoaded?: boolean;
      };
      type PerfMap = {
        getSource: (id: string) => unknown;
        on: (type: string, handler: (event?: PerfMapEvent) => void) => void;
        off: (type: string, handler: (event?: PerfMapEvent) => void) => void;
      };
      type PerfSource = {
        setData: (data: unknown) => unknown;
        updateData?: (diff: unknown) => unknown;
      };

      const container = document.querySelector(".indoor-map");
      if (!(container instanceof HTMLElement)) {
        throw new Error("map container missing");
      }
      delete container.dataset.mapIdle;

      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".floor-stack__btn"),
      );
      const button = buttons.find((candidate) => candidate.textContent?.trim() === levelLabel);
      if (!button) {
        throw new Error(`floor button not found: ${levelLabel}`);
      }

      const mapValue = Reflect.get(window, "__kirikoPerfMap");
      if (mapValue == null || typeof mapValue !== "object") {
        throw new Error("performance map handle missing");
      }
      const map = mapValue as PerfMap;
      const knownSources = new Set<string>(sourceIds);
      const sourceUpdates: SourceUpdateTiming[] = [];
      const sourceEvents: SourceEventTiming[] = [];
      const longTasks: LongTaskTiming[] = [];
      const restoreSources: Array<() => void> = [];
      let start: number | null = null;
      let idleMs: number | null = null;
      let firstRenderMs: number | null = null;
      let lastRenderMs: number | null = null;
      let renderCount = 0;

      for (const sourceId of sourceIds) {
        const sourceValue = map.getSource(sourceId);
        if (sourceValue == null || typeof sourceValue !== "object" || !("setData" in sourceValue)) {
          continue;
        }
        const source = sourceValue as PerfSource;
        const originalSetData = source.setData;
        source.setData = function timedSetData(this: PerfSource, data: unknown): unknown {
          const updateStart = performance.now();
          try {
            return originalSetData.call(this, data);
          } finally {
            if (start !== null) {
              sourceUpdates.push({
                sourceId,
                operation: "setData",
                startMs: updateStart - start,
                durationMs: performance.now() - updateStart,
              });
            }
          }
        };
        restoreSources.push(() => {
          source.setData = originalSetData;
        });

        if (typeof source.updateData === "function") {
          const originalUpdateData = source.updateData;
          source.updateData = function timedUpdateData(this: PerfSource, diff: unknown): unknown {
            const updateStart = performance.now();
            try {
              return originalUpdateData.call(this, diff);
            } finally {
              if (start !== null) {
                sourceUpdates.push({
                  sourceId,
                  operation: "updateData",
                  startMs: updateStart - start,
                  durationMs: performance.now() - updateStart,
                });
              }
            }
          };
          restoreSources.push(() => {
            source.updateData = originalUpdateData;
          });
        }
      }

      const recordSourceEvent = (
        type: SourceEventTiming["type"],
        event?: PerfMapEvent,
      ): void => {
        if (start === null || event?.sourceId == null || !knownSources.has(event.sourceId)) {
          return;
        }
        sourceEvents.push({
          type,
          sourceId: event.sourceId,
          atMs: performance.now() - start,
          isSourceLoaded:
            typeof event.isSourceLoaded === "boolean" ? event.isSourceLoaded : null,
        });
      };
      const onDataLoading = (event?: PerfMapEvent): void => {
        recordSourceEvent("dataloading", event);
      };
      const onSourceData = (event?: PerfMapEvent): void => {
        recordSourceEvent("sourcedata", event);
      };
      const onRender = (): void => {
        if (start === null) {
          return;
        }
        const atMs = performance.now() - start;
        firstRenderMs ??= atMs;
        lastRenderMs = atMs;
        renderCount += 1;
      };
      const onIdle = (): void => {
        if (start !== null) {
          idleMs = performance.now() - start;
        }
      };
      map.on("dataloading", onDataLoading);
      map.on("sourcedata", onSourceData);
      map.on("render", onRender);
      map.on("idle", onIdle);

      let longTaskObserver: PerformanceObserver | null = null;
      let longTaskObserverSupported = false;
      const recordLongTasks = (entries: readonly PerformanceEntry[]): void => {
        if (start === null) {
          return;
        }
        for (const entry of entries) {
          if (entry.entryType === "longtask") {
            longTasks.push({
              startMs: entry.startTime - start,
              durationMs: entry.duration,
            });
          }
        }
      };
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          recordLongTasks(list.getEntries());
        });
        longTaskObserver.observe({ type: "longtask", buffered: false });
        longTaskObserverSupported = true;
      } catch {
        // Chromium normally supports longtask; timings remain useful if not.
      }

      return await new Promise<LevelChangeDiagnostic>((resolve, reject) => {
        start = performance.now();
        const timeout = window.setTimeout(() => {
          mutationObserver.disconnect();
          cleanup();
          reject(new Error("level change idle timeout"));
        }, 10_000);

        const cleanup = (): void => {
          window.clearTimeout(timeout);
          map.off("dataloading", onDataLoading);
          map.off("sourcedata", onSourceData);
          map.off("render", onRender);
          map.off("idle", onIdle);
          for (const restore of restoreSources) {
            restore();
          }
          if (longTaskObserver != null) {
            recordLongTasks(longTaskObserver.takeRecords());
            longTaskObserver.disconnect();
          }
        };

        const mutationObserver = new MutationObserver(() => {
          if (container.dataset.mapIdle !== "true") {
            return;
          }
          mutationObserver.disconnect();
          requestAnimationFrame(() => {
            const finalFrameMs = performance.now() - start!;
            cleanup();
            const clickToFirstSourceMs = sourceUpdates[0]?.startMs ?? null;
            const sourceWorkEndMs =
              sourceUpdates.length === 0
                ? null
                : Math.max(...sourceUpdates.map((update) => update.startMs + update.durationMs));
            resolve({
              sample: sampleIndex,
              label: levelLabel,
              elapsedMs: finalFrameMs,
              phases: {
                clickToFirstSourceMs,
                sourceWorkEndMs,
                sourceEndToIdleMs:
                  sourceWorkEndMs === null || idleMs === null ? null : idleMs - sourceWorkEndMs,
                idleToFinalFrameMs: idleMs === null ? null : finalFrameMs - idleMs,
              },
              sourceUpdates,
              sourceEvents,
              render: {
                count: renderCount,
                firstMs: firstRenderMs,
                lastMs: lastRenderMs,
                idleMs,
                finalFrameMs,
              },
              longTaskObserverSupported,
              longTasks,
            });
          });
        });
        mutationObserver.observe(container, {
          attributes: true,
          attributeFilter: ["data-map-idle"],
        });
        button.click();
      });
    },
    { levelLabel: label, sampleIndex: sample, sourceIds: LEVEL_SOURCE_IDS },
  );
}

async function levelChangeEnvironment(page: Page): Promise<LevelChangeEnvironment> {
  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector(".indoor-map canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      return { webglVendor: "unavailable", webglRenderer: "unavailable" };
    }
    try {
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (gl == null) {
        return { webglVendor: "unavailable", webglRenderer: "unavailable" };
      }
      const debug = gl.getExtension("WEBGL_debug_renderer_info") as {
        UNMASKED_VENDOR_WEBGL: number;
        UNMASKED_RENDERER_WEBGL: number;
      } | null;
      const vendor = gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR);
      const webglRenderer = gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
      return {
        webglVendor: typeof vendor === "string" ? vendor : "unknown",
        webglRenderer: typeof webglRenderer === "string" ? webglRenderer : "unknown",
      };
    } catch {
      return { webglVendor: "unavailable", webglRenderer: "unavailable" };
    }
  });
  return {
    browserVersion: page.context().browser()?.version() ?? "unknown",
    ...renderer,
  };
}

const LEVEL_LABELS = [LEVEL_B1_SHORT, LEVEL_1F_SHORT, LEVEL_2F_SHORT, LEVEL_1F_SHORT];

async function prepareLevelChanges(page: Page): Promise<void> {
  // Measure setData + idle, not camera ease (FIT_DURATION_MS = 500).
  await page.emulateMedia({ reducedMotion: "reduce" });
  const zipBuffer = await minimalImdfZipBuffer();
  await page.goto(VIEWER_URL);
  await page.waitForLoadState("load");
  await uploadZip(page, zipBuffer);
  await waitForReadyVenue(page, VENUE_NAME_JA);
  await waitForMapIdle(page);
  await zeroMapLibreTransitions(page);

  // 3 unmeasured warm-ups.
  for (let i = 0; i < 3; i += 1) {
    const label = LEVEL_LABELS[i % LEVEL_LABELS.length]!;
    await floorButton(page, label).click();
    await waitForMapIdle(page);
  }
}

async function safeLevelChangeEnvironment(page: Page): Promise<LevelChangeEnvironment> {
  try {
    return await levelChangeEnvironment(page);
  } catch {
    return {
      browserVersion: page.context().browser()?.version() ?? "unknown",
      webglVendor: "unavailable",
      webglRenderer: "unavailable",
    };
  }
}

async function runLevelChangeControls(
  page: Page,
  interSampleDwellMs = 0,
): Promise<LevelChangeControlRun> {
  await prepareLevelChanges(page);
  const samples: number[] = [];
  for (let i = 0; i < 30; i += 1) {
    const label = LEVEL_LABELS[i % LEVEL_LABELS.length]!;
    samples.push(await measureLevelChangeElapsed(page, label));
    if (interSampleDwellMs > 0 && i < 29) {
      await page.waitForTimeout(interSampleDwellMs);
    }
  }

  // Renderer inspection runs after every control sample and is best-effort, so
  // it cannot perturb or determine the unchanged acceptance result.
  return { samples, environment: await safeLevelChangeEnvironment(page) };
}

async function runLevelChangeDiagnosticProbes(
  page: Page,
  interSampleDwellMs = 0,
): Promise<LevelChangeDiagnosticRun> {
  const diagnostics: LevelChangeDiagnostic[] = [];
  let error: string | null = null;
  try {
    await prepareLevelChanges(page);
    for (let i = 0; i < 30; i += 1) {
      const label = LEVEL_LABELS[i % LEVEL_LABELS.length]!;
      diagnostics.push(await measureLevelChangeDiagnostic(page, label, i + 1));
      if (interSampleDwellMs > 0 && i < 29) {
        await page.waitForTimeout(interSampleDwellMs);
      }
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return {
    diagnostics,
    environment: await safeLevelChangeEnvironment(page),
    error,
  };
}

function logLevelChangeControls(
  run: LevelChangeControlRun,
  prefix = "level-change",
): number {
  const p95 = percentileNearestRank(run.samples, 0.95);
  console.log(
    `${prefix} samples(ms)=${run.samples.map((n) => n.toFixed(1)).join(", ")} P95=${p95.toFixed(1)}`,
  );
  console.log(`${prefix} environment=${JSON.stringify(run.environment)}`);
  return p95;
}

function logLevelChangeDiagnostics(
  run: LevelChangeDiagnosticRun,
  prefix = "level-change",
): void {
  console.log(
    `${prefix} diagnostics=${JSON.stringify({
      environment: run.environment,
      error: run.error,
      slowSamples: run.diagnostics.filter((sample) => sample.elapsedMs > 150),
    })}`,
  );
}

async function writeP95FailureOutcome(p95: number): Promise<void> {
  const outputPath = process.env.KIRIKO_PERF_P95_FAILURE_FILE;
  if (outputPath === undefined || outputPath === "" || p95 <= 150) {
    return;
  }
  await writeFile(
    outputPath,
    `${JSON.stringify({
      kind: "level-change-p95-failure",
      p95,
      budgetMs: 150,
      warmUps: 3,
      samples: 30,
      percentile: "nearest-rank-p95",
      interSampleDwellMs: 0,
    })}\n`,
    "utf8",
  );
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

  test("level-change P95 ≤ 150ms after 3 warm-ups over 30 alternating clicks", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const run = await runLevelChangeControls(page);
    const p95 = logLevelChangeControls(run);
    await testInfo.attach("level-change-controls", {
      body: Buffer.from(JSON.stringify(run, null, 2)),
      contentType: "application/json",
    });
    await writeP95FailureOutcome(p95);
    expect(p95, `level-change P95 ${p95.toFixed(1)}ms exceeds 150ms`).toBeLessThanOrEqual(150);
  });

  test("diagnostic: level-change phase/source probes", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const run = await runLevelChangeDiagnosticProbes(page);
    logLevelChangeDiagnostics(run);
    await testInfo.attach("level-change-diagnostics", {
      body: Buffer.from(JSON.stringify(run, null, 2)),
      contentType: "application/json",
    });
    // Evidence only: private instrumentation failure must never decide the
    // unchanged control result in the separate test above.
  });

  test("diagnostic: level-change with 250ms unmeasured inter-sample dwell", async ({
    page,
  }, testInfo) => {
    test.skip(
      process.env.KIRIKO_PERF_DWELL_DIAGNOSTIC !== "1",
      "run only as the conditional burst-carryover counterfactual",
    );
    test.setTimeout(120_000);
    const controls = await runLevelChangeControls(page, 250);
    const p95 = logLevelChangeControls(controls, "level-change 250ms-dwell diagnostic");
    const diagnostics = await runLevelChangeDiagnosticProbes(page, 250);
    logLevelChangeDiagnostics(diagnostics, "level-change 250ms-dwell diagnostic");
    await testInfo.attach("level-change-250ms-dwell-diagnostics", {
      body: Buffer.from(JSON.stringify({ controls, diagnostics }, null, 2)),
      contentType: "application/json",
    });
    // This counterfactual is evidence only. The no-dwell control jobs retain
    // the unchanged 150ms assertion and are what decide whether the correction
    // is valid; a deliberately conditional diagnostic must not create a
    // second, substitute gate.
    console.log(
      `250ms-dwell counterfactual ${p95 <= 150 ? "meets" : "does not meet"} the unchanged 150ms budget`,
    );
  });

  test("diagnostic: 1s drag keeps ≥30 frames and no longtask > 100ms", async ({ page }) => {
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
