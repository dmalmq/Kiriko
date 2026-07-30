import { expect, test, type Page } from "@playwright/test";
import {
  openPublishedDataset,
  publishVenue,
  signIn,
  switchLocale,
  uniqueDatasetName,
  waitForIssueStream,
} from "./helpers";

// 6×4 PNG fixture generated with sharp — generated raster, never a real screenshot.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAYAAAAECAIAAAAiZtkUAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMwTpuJhhjIFQIAORgcsbZz268AAAAASUVORK5CYII=";

function collectionPath(publicVersionId: string): string {
  return `/api/review/versions/${publicVersionId}/issues`;
}

async function openIssues(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Issues" });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByRole("region", { name: "Issues" })).toBeVisible();
}

async function pastePng(page: Page, label: string): Promise<void> {
  const handled = await page.getByLabel(label).evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "paste.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });

    // Firefox discards clipboardData passed to ClipboardEvent's constructor.
    // Preserve the native DataTransfer so the real paste handler sees its file.
    if (event.clipboardData?.files.length !== 1) {
      Object.defineProperty(event, "clipboardData", { value: transfer });
    }
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, TINY_PNG_BASE64);
  expect(handled).toBe(true);
}

async function pickerPng(page: Page): Promise<void> {
  const bytes = Buffer.from(TINY_PNG_BASE64, "base64");
  await page.locator('.issue-markdown-editor input[type="file"]').first().setInputFiles({
    name: "picker.png",
    mimeType: "image/png",
    buffer: bytes,
  });
}

async function deleteVenue(request: Page["request"], venueId: number): Promise<void> {
  const response = await request.delete(`/api/venues/${venueId}`);
  expect([204, 404]).toContain(response.status());
}

test.describe("issue image attachments", () => {
  test("picker upload, post, lightbox, reply paste, observer refresh, and deletion revocation", async ({
    browser,
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await signIn(page);
    const venue = await publishVenue(page.request, uniqueDatasetName("issue-attach", testInfo));
    const observerContext = await browser.newContext({ baseURL: new URL(page.url()).origin });

    try {
      const { publicVersionId } = await openPublishedDataset(page, venue.slug);
      await waitForIssueStream(page, publicVersionId);
      await openIssues(page);
      await page.getByRole("button", { name: "New issue" }).click();
      await page.getByRole("button", { name: "Place at map center" }).click();
      await page.getByLabel("Issue body").fill("Gate photo below ");

      // File picker path: progress card, then the token replaces the
      // placeholder and the alt editor appears. Hold the upload response so
      // the transient placeholder cannot disappear before the assertion.
      let releasePickerUpload!: () => void;
      const pickerUploadReleased = new Promise<void>((resolve) => {
        releasePickerUpload = resolve;
      });
      await page.route("**/api/review/versions/*/issue-attachments", async (route) => {
        await pickerUploadReleased;
        await route.continue();
      }, { times: 1 });
      await pickerPng(page);
      await expect(page.getByLabel("Issue body")).toHaveValue(/pending:/);
      releasePickerUpload();
      await expect(page.getByLabel("Issue body")).toHaveValue(/attachment:[0-9a-f-]{36}/, {
        timeout: 15_000,
      });
      await page.getByLabel("Alt text").fill("Ticket gate");

      // Preview parity before posting: the staged image renders from a blob.
      await page.getByRole("tab", { name: "Preview" }).click();
      await expect(
        page.getByTestId("issue-markdown-preview").locator("img"),
      ).toHaveAttribute("src", /^blob:/);
      await page.getByRole("tab", { name: "Write" }).click();

      const canonicalPost = page.waitForResponse(
        (response) =>
          response.request().method() === "GET"
          && new URL(response.url()).pathname === collectionPath(publicVersionId)
          && response.status() === 200,
      );
      await page.getByRole("button", { name: "Post issue" }).click();
      await canonicalPost;

      await page.getByRole("option", { name: /#1 Gate photo below/ }).click();
      const thumbnail = page.locator(".issue-detail__body .issue-image img");
      await expect(thumbnail).toHaveAttribute("src", /\/api\/issue-attachments\/[0-9a-f-]{36}\/thumbnail/);
      await expect(thumbnail).toHaveAttribute("alt", "Ticket gate");
      const thumbnailSrc = await thumbnail.getAttribute("src");
      const attachmentId = /issue-attachments\/([0-9a-f-]{36})\//.exec(thumbnailSrc ?? "")?.[1] ?? "";

      // Accessible lightbox over the normalized original.
      await page.getByRole("button", { name: "Enlarge image: Ticket gate" }).click();
      const lightbox = page.getByRole("dialog", { name: "Ticket gate" });
      await expect(lightbox.locator(".issue-lightbox__image")).toHaveAttribute(
        "src",
        `/api/issue-attachments/${attachmentId}/content`,
      );
      await expect(page.getByRole("button", { name: "Close", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Ticket gate" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Enlarge image: Ticket gate" })).toBeFocused();

      // Clipboard paste path in the reply composer.
      await page.getByLabel("Reply").fill("Same spot today ");
      await pastePng(page, "Reply");
      await expect(page.getByLabel("Reply")).toHaveValue(/attachment:[0-9a-f-]{36}/, {
        timeout: 15_000,
      });
      const canonicalReply = page.waitForResponse(
        (response) =>
          response.request().method() === "GET"
          && new URL(response.url()).pathname === collectionPath(publicVersionId)
          && response.status() === 200,
      );
      await page.getByRole("button", { name: "Reply", exact: true }).click();
      await canonicalReply;
      await expect(page.locator(".issue-reply__body .issue-image img")).toHaveAttribute(
        "src",
        /\/api\/issue-attachments\/[0-9a-f-]{36}\/thumbnail/,
      );

      // Anonymous observer receives the images after the SSE refetch and can
      // read the media publicly.
      const observer = await observerContext.newPage();
      try {
        await openPublishedDataset(observer, venue.slug);
        await waitForIssueStream(observer, publicVersionId);
        await openIssues(observer);
        await observer.getByRole("option", { name: /#1 Gate photo below/ }).click();
        await expect(observer.locator(".issue-detail__body .issue-image img")).toHaveAttribute(
          "src",
          /\/api\/issue-attachments\/[0-9a-f-]{36}\/thumbnail/,
        );
        const publicRead = await observer.request.get(
          `/api/issue-attachments/${attachmentId}/content`,
        );
        expect(publicRead.status()).toBe(200);
        expect(publicRead.headers()["x-content-type-options"]).toBe("nosniff");
      } finally {
        await observer.close();
      }

      // Deleting the issue revokes its media immediately.
      const canonicalDelete = page.waitForResponse(
        (response) =>
          response.request().method() === "GET"
          && new URL(response.url()).pathname === collectionPath(publicVersionId)
          && response.status() === 200,
      );
      await page.getByRole("button", { name: "Delete issue" }).click();
      await canonicalDelete;
      const revoked = await page.request.get(`/api/issue-attachments/${attachmentId}/content`);
      expect(revoked.status()).toBe(404);
    } finally {
      await observerContext.close();
      await deleteVenue(page.request, venue.venueId);
    }
  });

  test("toolbar, tabs, and uploads stay usable at 390px in Japanese", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 760 });
    await page.goto("/");
    await signIn(page);
    const venue = await publishVenue(page.request, uniqueDatasetName("issue-attach-jp", testInfo));

    try {
      const { publicVersionId } = await openPublishedDataset(page, venue.slug);
      await waitForIssueStream(page, publicVersionId);
      await openIssues(page);
      await switchLocale(page, "ja");
      await page.getByRole("button", { name: "新しい課題" }).click();
      await page.getByRole("button", { name: "地図の中心に配置" }).click();

      // Keyboard-only formatting: bold around a Japanese selection.
      const body = page.getByLabel("課題の本文");
      await body.fill("改札が壊れている");
      await body.evaluate((element) => {
        (element as HTMLTextAreaElement).setSelectionRange(0, 2);
      });
      await page.getByRole("button", { name: "太字" }).click();
      await expect(body).toHaveValue("**改札**が壊れている");

      await pastePng(page, "課題の本文");
      await expect(body).toHaveValue(/attachment:[0-9a-f-]{36}/, { timeout: 15_000 });
      await expect(page.getByLabel("代替テキスト")).toBeVisible();

      const canonical = page.waitForResponse(
        (response) =>
          response.request().method() === "GET"
          && new URL(response.url()).pathname === collectionPath(publicVersionId)
          && response.status() === 200,
      );
      await page.getByRole("button", { name: "課題を投稿" }).click();
      await canonical;
      await expect(page.getByRole("option", { name: /#1/ })).toBeVisible();
    } finally {
      await deleteVenue(page.request, venue.venueId);
    }
  });

  test("embed mode makes no attachment or issue requests", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.goto("/");
    await signIn(page);
    const venue = await publishVenue(page.request, uniqueDatasetName("issue-attach-embed", testInfo));
    try {
      const requests: string[] = [];
      page.on("request", (request) => {
        requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
      });
      await page.goto(`/?dataset=${encodeURIComponent(venue.slug)}&embed=1&lang=en`);
      await page.waitForLoadState("networkidle");
      expect(
        requests.filter(
          (url) => url.includes("/api/") && (url.includes("issue") || url.includes("review")),
        ),
      ).toEqual([]);
    } finally {
      await deleteVenue(page.request, venue.venueId);
    }
  });
});
