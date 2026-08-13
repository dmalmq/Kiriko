import { setTimeout as delay } from "node:timers/promises";
import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
  type Request,
  type TestInfo,
} from "@playwright/test";
import { buildMinimalImdfZip } from "../tests/fixtures/buildMinimalImdfZip";

export const MINIMAL_ZIP_NAME = "minimal-imdf.zip";
export const MINIMAL_ZIP_MIME = "application/zip";

export const VENUE_NAME_JA = "東京駅テスト会場";
export const VENUE_NAME_EN = "Tokyo Station Test Venue";

export const LEVEL_1F_JA = "1階";
export const LEVEL_B1_JA = "地下1階";
export const LEVEL_2F_JA = "2階";
export const LEVEL_1F_EN = "1F";
export const LEVEL_B1_EN = "B1";
export const LEVEL_2F_EN = "2F";

/** FloorStack shows level short names (same in both locales for the fixture). */
export const LEVEL_1F_SHORT = "1F";
export const LEVEL_B1_SHORT = "B1";
export const LEVEL_2F_SHORT = "2F";

export const OCCUPANT_ID = "a1000008-0000-4000-8000-0000000000c1";
export const LEVEL_1F_ID = "b1000002-0000-4000-8000-00000000001f";
export const KIOSK_ID = "f1000001-0000-4000-8000-0000000000f1";
export const KIOSK_MARKER_JA = "案内キオスク";
export const KIOSK_MARKER_EN = "Info Kiosk";
export const OCCUPANT_JA = "駅ナカショップ";
export const OCCUPANT_EN = "Station Shop";
export const OCCUPANT_ALT_JA = "テストストア";
export const OCCUPANT_HOURS = "Mo-Fr 10:00-20:00";
export const AMENITY_JA = "トイレ";
export const AMENITY_EN = "Restroom";
export const UNIT_STAIRS_EN = "B1 Stairs";

export const WARNING_CODES = [
  "missing_display_point",
  "missing_display_point",
  "missing_display_point",
  "unresolved_reference",
  "missing_locale",
] as const;

/** Build the deterministic minimal IMDF ZIP as a Buffer for setInputFiles. */
export async function minimalImdfZipBuffer(): Promise<Buffer> {
  const bytes = await buildMinimalImdfZip();
  return Buffer.from(bytes);
}

/** Non-ZIP bytes that still use a .zip filename so the worker checks magic. */
export function corruptZipBuffer(): Buffer {
  return Buffer.from("not a zip", "utf8");
}

export async function uploadZip(
  page: Page,
  buffer: Buffer,
  fileName = MINIMAL_ZIP_NAME,
): Promise<void> {
  const input = page.locator('input[type="file"][accept*=".zip"]');
  await input.setInputFiles({
    name: fileName,
    mimeType: MINIMAL_ZIP_MIME,
    buffer,
  });
}

export async function uploadMinimalImdf(page: Page): Promise<void> {
  const buffer = await minimalImdfZipBuffer();
  await uploadZip(page, buffer);
}

export function mapContainer(page: Page): Locator {
  return page.locator(".indoor-map");
}

export function mapCanvas(page: Page): Locator {
  return page.locator(".indoor-map canvas").first();
}

export async function waitForMapIdle(page: Page, timeout = 90_000): Promise<void> {
  await expect(mapContainer(page)).toHaveAttribute("data-map-idle", "true", {
    timeout,
  });
}

export async function waitForReadyVenue(page: Page, venueName: string): Promise<void> {
  await expect(page.locator(".context-bar__name")).toHaveText(venueName, {
    timeout: 15_000,
  });
  await waitForMapIdle(page);
}

/** Floor button in the Kiriko FloorStack, addressed by its short label. */
export function floorButton(page: Page, shortLabel: string): Locator {
  return page.locator(".floor-stack__btn", { hasText: new RegExp(`^${shortLabel}$`) });
}

export async function selectLevel(page: Page, shortLabel: string): Promise<void> {
  const button = floorButton(page, shortLabel);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await waitForMapIdle(page);
}

export function markerByLabel(page: Page, label: string): Locator {
  return page.locator(`.indoor-marker[aria-label="${label}"]`);
}

/** Opens the Search panel from the icon rail when it is not already open. */
export async function openSearchPanel(page: Page): Promise<void> {
  const input = page.locator("#viewer-search-input");
  if (await input.isVisible()) {
    return;
  }
  await page.locator('.icon-rail__btn[aria-label="Search"], .icon-rail__btn[aria-label="検索"]').click();
  await expect(input).toBeVisible();
}

export async function searchAndSelect(
  page: Page,
  query: string,
  resultLabel: string,
): Promise<void> {
  await openSearchPanel(page);
  const input = page.locator("#viewer-search-input");
  await input.fill(query);
  const result = page.locator(".list-row", { hasText: resultLabel });
  await expect(result).toBeVisible({ timeout: 5_000 });
  await result.click();
  await waitForMapIdle(page);
}

/** The Inspector floating panel for the selected feature. */
export function detailsSection(page: Page): Locator {
  return page.locator(".floating-panel--inspector");
}

export async function expectDetailsContain(
  page: Page,
  parts: string[],
): Promise<void> {
  const details = detailsSection(page);
  await expect(details).toBeVisible();
  for (const part of parts) {
    await expect(details).toContainText(part);
  }
}

export async function switchLocale(page: Page, locale: "ja" | "en"): Promise<void> {
  const label = locale === "ja" ? "日本語" : "EN";
  const button = page.locator(".locale-chips .chip", { hasText: new RegExp(`^${label}$`) });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

/** Opens the Warnings panel from the icon rail. */
export async function openWarnings(page: Page): Promise<Locator> {
  const toggle = page.locator(
    '.icon-rail__btn[aria-label="Warnings"], .icon-rail__btn[aria-label="警告"]',
  );
  await expect(toggle).toBeVisible();
  const panel = page.locator(".warnings-panel");
  if (!(await panel.isVisible())) {
    await toggle.click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

export async function expectWarningCodes(
  page: Page,
  expected: readonly string[],
): Promise<void> {
  const panel = await openWarnings(page);
  const metas = panel.locator(".warning-row__meta");
  await expect(metas).toHaveCount(expected.length);
  const actual = (await metas.allTextContents()).map((text) => text.split(" · ")[0] ?? text);
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  expect(sortedActual).toEqual(sortedExpected);
}

export const E2E_USER = "e2e";
export const E2E_PASSWORD = "e2e-password";

export async function signIn(page: Page): Promise<void> {
  await page.getByLabel(/Email|メールアドレス/).fill(E2E_USER);
  await page.getByLabel(/Password|パスワード/).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: /Sign in|サインイン/ }).click();
  await expect(page.locator(".gallery__title")).toBeVisible();
}

/** Viewer entry for upload-driven specs (bypasses the gallery). */
export const VIEWER_URL = "/?viewer";

/** Exact published-dataset resource path used by gallery-to-viewer assertions. */
export function datasetBundlePath(slug: string): string {
  return `/v/default/${slug}/bundle`;
}

/** Click slightly below a marker so the hit lands on the polygon under it. */
export async function clickBelowMarker(page: Page, label: string): Promise<void> {
  const marker = markerByLabel(page, label);
  await expect(marker).toBeVisible();
  const box = await marker.boundingBox();
  if (box == null) {
    throw new Error(`Marker "${label}" has no bounding box`);
  }
  // Marker anchor is bottom; polygon sits under the label. Click a few px below
  // the marker box center so queryRenderedFeatures hits the kiosk polygon.
  const x = box.x + box.width / 2;
  const y = box.y + box.height + 8;
  await page.mouse.click(x, y);
  await waitForMapIdle(page);
}

interface PublishJob {
  id: string;
  status: string;
  error: string | null;
  result: unknown;
}

interface StreamState {
  opened: boolean;
  open: boolean;
}

const streamStates = new WeakMap<Page, Map<string, StreamState>>();
const streamTrackingPages = new WeakSet<Page>();

function issueStreamId(request: Request): string | null {
  const pathname = new URL(request.url()).pathname;
  const match = /^\/api\/review\/versions\/([^/]+)\/issues\/events$/.exec(pathname);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

function ensureIssueStreamTracking(page: Page): Map<string, StreamState> {
  let states = streamStates.get(page);
  if (states === undefined) {
    states = new Map();
    streamStates.set(page, states);
  }
  if (streamTrackingPages.has(page)) {
    return states;
  }
  streamTrackingPages.add(page);
  page.on("request", (request) => {
    const publicVersionId = issueStreamId(request);
    if (publicVersionId !== null) {
      states!.set(publicVersionId, { opened: true, open: true });
    }
  });
  const markClosed = (request: Request): void => {
    const publicVersionId = issueStreamId(request);
    if (publicVersionId === null) {
      return;
    }
    const state = states!.get(publicVersionId);
    states!.set(publicVersionId, { opened: state?.opened ?? true, open: false });
  };
  page.on("requestfinished", markClosed);
  page.on("requestfailed", markClosed);
  return states;
}

async function responseJson<T>(response: APIResponse, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok()) {
    throw new Error(`${label} failed (${response.status()}): ${text}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON: ${text}`);
  }
}

async function waitForPublishJob(request: APIRequestContext, jobId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await request.get(`/api/jobs/${encodeURIComponent(jobId)}`);
    const job = await responseJson<PublishJob>(response, `publish job ${jobId}`);
    if (job.status === "done") {
      return;
    }
    if (job.status === "error") {
      throw new Error(
        `publish job ${jobId} failed: ${job.error ?? JSON.stringify(job.result)}`,
      );
    }
    await delay(100);
  }
  throw new Error(`publish job ${jobId} did not finish within 30000ms`);
}

export function uniqueDatasetName(prefix: string, testInfo: TestInfo): string {
  let hash = 2_166_136_261;
  for (const character of testInfo.testId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  const suffix = (hash >>> 0).toString(36);
  return `${prefix}-${testInfo.project.name}-${testInfo.workerIndex}-${suffix}`.slice(0, 120);
}

export async function publishNextVersion(
  request: APIRequestContext,
  venueId: number,
  bytes?: Buffer,
): Promise<{ seq: number }> {
  const buffer = bytes ?? (await minimalImdfZipBuffer());
  const response = await request.post(`/api/venues/${venueId}/versions`, {
    multipart: {
      file: {
        name: MINIMAL_ZIP_NAME,
        mimeType: MINIMAL_ZIP_MIME,
        buffer,
      },
    },
  });
  const body = await responseJson<{ jobId: string; seq: number }>(
    response,
    `publish venue ${venueId}`,
  );
  await waitForPublishJob(request, body.jobId);
  return { seq: body.seq };
}

export async function publishVenue(
  request: APIRequestContext,
  name: string,
  bytes?: Buffer,
): Promise<{ venueId: number; slug: string; seq: number }> {
  const response = await request.post("/api/venues", { data: { name } });
  const body = await responseJson<{ venue: { id: number; slug: string } }>(
    response,
    `create venue "${name}"`,
  );
  try {
    const published = await publishNextVersion(request, body.venue.id, bytes);
    return { venueId: body.venue.id, slug: body.venue.slug, seq: published.seq };
  } catch (error) {
    await request.delete(`/api/venues/${body.venue.id}`);
    throw error;
  }
}

export async function openPublishedDataset(
  page: Page,
  slug: string,
): Promise<{ publicVersionId: string }> {
  ensureIssueStreamTracking(page);
  const bundlePath = datasetBundlePath(slug);
  const bundleResponse = page.waitForResponse(
    (response) => {
      const status = response.status();
      return (
        new URL(response.url()).pathname === bundlePath &&
        (status === 200 || status === 304)
      );
    },
  );
  await page.goto(`/?dataset=${encodeURIComponent(slug)}&lang=en`);
  const response = await bundleResponse;
  const publicVersionId = response.headers()["kiriko-version-id"];
  if (publicVersionId === undefined || !/^[0-9a-f]{64}$/.test(publicVersionId)) {
    throw new Error(
      `bundle ${bundlePath} returned invalid Kiriko-Version-Id: ${String(publicVersionId)}`,
    );
  }
  await waitForReadyVenue(page, VENUE_NAME_EN);
  return { publicVersionId };
}

export function collectIssueRequests(page: Page): {
  requests: string[];
  dispose(): void;
} {
  ensureIssueStreamTracking(page);
  const requests: string[] = [];
  const listener = (request: Request): void => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname.startsWith("/api/review/") ||
      pathname === "/api/reviewers" ||
      pathname.startsWith("/api/issues/") ||
      pathname.startsWith("/api/replies/")
    ) {
      requests.push(`${request.method()} ${pathname}`);
    }
  };
  page.on("request", listener);
  return {
    requests,
    dispose() {
      page.off("request", listener);
    },
  };
}

export async function waitForIssueStream(
  page: Page,
  publicVersionId: string,
): Promise<void> {
  const states = ensureIssueStreamTracking(page);
  await expect
    .poll(() => states.get(publicVersionId)?.open ?? false, { timeout: 15_000 })
    .toBe(true);
}

export async function waitForIssueStreamClose(
  page: Page,
  publicVersionId: string,
): Promise<void> {
  const states = ensureIssueStreamTracking(page);
  await expect
    .poll(() => {
      const state = states.get(publicVersionId);
      return state?.opened === true && state.open === false;
    }, { timeout: 15_000 })
    .toBe(true);
}

export async function dropZip(page: Page, bytes: Buffer): Promise<void> {
  const target = (await page.locator(".imdf-dropzone").isVisible())
    ? ".imdf-dropzone"
    : ".map-stage";
  await page.locator(target).evaluate(
    (element, payload) => {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(
        new File([bytes], "dropped-minimal-imdf.zip", { type: "application/zip" }),
      );
      element.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }),
      );
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
      );
    },
    bytes.toString("base64"),
  );
}
