import { expect, test, type Request } from "@playwright/test";
import {
  AMENITY_JA,
  clickBelowMarker,
  collectIssueRequests,
  corruptZipBuffer,
  dropZip,
  expectDetailsContain,
  expectWarningCodes,
  floorButton,
  KIOSK_ID,
  KIOSK_MARKER_JA,
  LEVEL_1F_JA,
  LEVEL_1F_SHORT,
  LEVEL_2F_JA,
  LEVEL_2F_SHORT,
  LEVEL_B1_JA,
  LEVEL_B1_SHORT,
  mapCanvas,
  mapContainer,
  minimalImdfZipBuffer,
  markerByLabel,
  OCCUPANT_ALT_JA,
  OCCUPANT_EN,
  OCCUPANT_HOURS,
  OCCUPANT_ID,
  OCCUPANT_JA,
  searchAndSelect,
  selectLevel,
  switchLocale,
  uploadMinimalImdf,
  UNIT_STAIRS_EN,
  uploadZip,
  VENUE_NAME_JA,
  VIEWER_URL,
  waitForMapIdle,
  waitForReadyVenue,
  WARNING_CODES,
} from "./helpers";

test.describe("local IMDF ZIP viewer journey", () => {
  test("local upload → map → level → search → selection → details → warnings → compact → recovery", async ({
    page,
  }) => {
    const issueRequests = collectIssueRequests(page);
    // No external network and no dataset fetch: after the static app load
    // event, the only allowed requests are same-origin build-emitted app assets
    // (Noto Sans JP woff2 unicode-range subsets fetched as CJK glyphs render,
    // and the staged facility marker-icon PNGs the map registers on load). A
    // dataset fetch would target `/v/...` and is still caught.
    const networkRequests: string[] = [];
    const onRequest = (request: Request): void => {
      const url = request.url();
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return;
      }
      if (
        url.startsWith("http://127.0.0.1:4173/assets/") &&
        (url.endsWith(".woff2") || url.endsWith(".png"))
      ) {
        return;
      }
      networkRequests.push(url);
    };

    await page.goto(VIEWER_URL);
    await page.waitForLoadState("load");
    page.on("request", onRequest);

    // Upload synthetic IMDF ZIP.
    await uploadMinimalImdf(page);
    await waitForReadyVenue(page, VENUE_NAME_JA);

    // Map canvas + idle + context-bar venue/level.
    await expect(mapCanvas(page)).toBeVisible();
    await expect(mapContainer(page)).toHaveAttribute("data-map-idle", "true");
    await expect(page.locator(".context-bar__name")).toHaveText(VENUE_NAME_JA);
    await expect(page.locator(".context-bar__level")).toHaveText(LEVEL_1F_JA);

    // Initial level has amenity + kiosk + occupant markers.
    await expect(markerByLabel(page, AMENITY_JA)).toBeVisible();
    await expect(markerByLabel(page, KIOSK_MARKER_JA)).toBeVisible();
    await expect(markerByLabel(page, OCCUPANT_JA)).toBeVisible();
    await expect(floorButton(page, LEVEL_1F_SHORT)).toHaveAttribute("aria-pressed", "true");

    // Switch to B1 then 2F; assert pressed state + idle + markers when present.
    await selectLevel(page, LEVEL_B1_SHORT);
    await expect(page.locator(".context-bar__level")).toHaveText(LEVEL_B1_JA);
    // B1: stairs + restroom bubbles, machine-room + staff-room pills.
    await expect(mapContainer(page)).toHaveAttribute("data-map-idle", "true");
    await expect(page.locator(".indoor-marker")).toHaveCount(4);

    await selectLevel(page, LEVEL_2F_SHORT);
    await expect(page.locator(".context-bar__level")).toHaveText(LEVEL_2F_JA);
    await expect(mapContainer(page)).toHaveAttribute("data-map-idle", "true");
    await expect(page.locator(".indoor-marker")).toHaveCount(1);

    // Return to 1F for search/selection.
    await selectLevel(page, LEVEL_1F_SHORT);
    await expect(page.locator(".context-bar__level")).toHaveText(LEVEL_1F_JA);

    // Japanese search → select occupant → inspector.
    await searchAndSelect(page, "駅ナカ", OCCUPANT_JA);
    await expectDetailsContain(page, [
      OCCUPANT_JA,
      OCCUPANT_ALT_JA,
      OCCUPANT_HOURS,
      OCCUPANT_ID,
      "occupant",
    ]);
    await expectDetailsContain(page, ["別名", "営業時間"]);

    // English search: switch locale → search "Station Shop" → same feature.
    await switchLocale(page, "en");
    await searchAndSelect(page, "Station Shop", OCCUPANT_EN);
    await expectDetailsContain(page, [OCCUPANT_EN, "Test Store", OCCUPANT_ID, OCCUPANT_HOURS]);
    await expectDetailsContain(page, ["Also known as", "Hours"]);

    // Back to Japanese for remaining assertions with known labels.
    await switchLocale(page, "ja");
    await waitForMapIdle(page);

    // Polygonal kiosk click-selection: click slightly below the kiosk marker.
    // Ensure 1F is selected and markers are present.
    await selectLevel(page, LEVEL_1F_SHORT);
    await expect(markerByLabel(page, KIOSK_MARKER_JA)).toBeVisible();
    await clickBelowMarker(page, KIOSK_MARKER_JA);
    await expectDetailsContain(page, ["kiosk", KIOSK_ID, KIOSK_MARKER_JA]);

    // Warnings: rail badge opens the panel with exactly 5 known codes.
    await expectWarningCodes(page, WARNING_CODES);

    // Compact layout at 390×844 (while still ready so level switches work).
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".app")).toHaveClass(/app--compact/);
    // Floating chrome adapts: context bar stays, rail becomes the bottom bar.
    await expect(page.locator(".context-bar")).toBeVisible();
    await expect(page.locator(".icon-rail--bar")).toBeVisible();
    // Sheets are exclusive on compact: the warnings sheet hides the inspector.
    await expect(page.locator(".floating-panel")).toHaveCount(1);
    // Close warnings, then the inspector sheet that takes its place.
    await page.locator(".floating-panel__close").click();
    await page.locator(".floating-panel__close").click();
    await expect(page.locator(".floating-panel")).toHaveCount(0);
    // Floor buttons remain visible and clickable.
    await expect(floorButton(page, LEVEL_1F_SHORT)).toBeVisible();
    await selectLevel(page, LEVEL_B1_SHORT);
    await expect(floorButton(page, LEVEL_B1_SHORT)).toHaveAttribute("aria-pressed", "true");

    // Restore desktop for replacement-error assertions.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator(".app")).not.toHaveClass(/app--compact/);

    // Invalid replacement: corrupt zip keeps the venue + canvas, shows alert.
    await uploadZip(page, corruptZipBuffer(), "corrupt.zip");
    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible({ timeout: 10_000 });
    await expect(alert).toContainText("Choose an Apple IMDF .zip archive.");
    await expect(page.locator(".context-bar__name")).toHaveText(VENUE_NAME_JA);
    await expect(mapCanvas(page)).toBeVisible();
    await expect(mapContainer(page)).toHaveAttribute("data-map-idle", "true");

    // Local ZIP parsing stays in the TypeScript worker and performs no dataset fetch.
    page.off("request", onRequest);
    expect(
      networkRequests,
      `unexpected post-load network requests:\n${networkRequests.join("\n")}`,
    ).toEqual([]);
    expect(issueRequests.requests).toEqual([]);
    issueRequests.dispose();
  });

  test("genuine DataTransfer ZIP drop stays issue-free", async ({ page }) => {
    const issueRequests = collectIssueRequests(page);
    await page.goto(VIEWER_URL);
    await dropZip(page, await minimalImdfZipBuffer());
    await waitForReadyVenue(page, VENUE_NAME_JA);
    await expect(mapCanvas(page)).toBeVisible();
    expect(issueRequests.requests).toEqual([]);
    issueRequests.dispose();
  });

  test("search-selecting the B1 stairs unit switches level and shows details", async ({
    page,
  }) => {
    await page.goto(VIEWER_URL);
    await uploadMinimalImdf(page);
    await waitForReadyVenue(page, VENUE_NAME_JA);

    await switchLocale(page, "en");
    await searchAndSelect(page, "B1 Stairs", UNIT_STAIRS_EN);
    await expectDetailsContain(page, [UNIT_STAIRS_EN]);
    await expect(floorButton(page, LEVEL_B1_SHORT)).toHaveAttribute("aria-pressed", "true");
  });

  test("clicking room pills and transit bubbles selects the feature", async ({
    page,
  }) => {
    await page.goto(VIEWER_URL);
    await uploadMinimalImdf(page);
    await waitForReadyVenue(page, VENUE_NAME_JA);
    await switchLocale(page, "en");

    // Room pill on 1F selects the room.
    await markerByLabel(page, "Waiting Room").click();
    await expectDetailsContain(page, ["Waiting Room", "room"]);
    // Stairs icon bubble on B1 selects the stairs unit.
    await selectLevel(page, LEVEL_B1_SHORT);
    await markerByLabel(page, UNIT_STAIRS_EN).click();
    await expectDetailsContain(page, [UNIT_STAIRS_EN, "stairs"]);

    // Restroom icon bubble selects the restroom unit.
    await markerByLabel(page, "B1 Restroom").click();
    await expectDetailsContain(page, ["B1 Restroom", "restroom.female"]);
  });

  test("layers panel hides marker labels and warnings rail shows a count badge", async ({
    page,
  }) => {
    await page.goto(VIEWER_URL);
    await uploadMinimalImdf(page);
    await waitForReadyVenue(page, VENUE_NAME_JA);
    await switchLocale(page, "en");

    await expect(markerByLabel(page, "Station Shop")).toBeVisible();

    // Open Layers, toggle Labels off → DOM markers disappear.
    await page.locator('.icon-rail__btn[aria-label="Layers"]').click();
    await page.getByRole("button", { name: "Labels: shown" }).click();
    await expect(page.locator(".indoor-marker")).toHaveCount(0);

    // Toggle back on → markers return.
    await page.getByRole("button", { name: "Labels: hidden" }).click();
    await expect(markerByLabel(page, "Station Shop")).toBeVisible();

    // Warnings rail button carries the loader warning count.
    const warningsToggle = page.locator('.icon-rail__btn[aria-label="Warnings"]');
    await expect(warningsToggle).toContainText(String(WARNING_CODES.length));
  });
});
