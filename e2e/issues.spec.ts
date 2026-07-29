import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { IssueCollection, ReviewIssue } from "../src/issues/types";
import {
  collectIssueRequests,
  dropZip,
  LEVEL_1F_ID,
  mapContainer,
  minimalImdfZipBuffer,
  openPublishedDataset,
  publishNextVersion,
  publishVenue,
  signIn,
  switchLocale,
  uniqueDatasetName,
  VENUE_NAME_EN,
  waitForIssueStream,
  waitForIssueStreamClose,
  waitForMapIdle,
} from "./helpers";

const ISSUE_BODY = "Check the ticket gate alignment";
const REPLY_BODY = "Verified against the station drawing";
const DUE_DATE = "2099-12-31";

function collectionPath(publicVersionId: string): string {
  return `/api/review/versions/${publicVersionId}/issues`;
}

function streamPath(publicVersionId: string): string {
  return `${collectionPath(publicVersionId)}/events`;
}

async function readCollection(
  request: APIRequestContext,
  publicVersionId: string,
): Promise<IssueCollection> {
  const response = await request.get(collectionPath(publicVersionId));
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<IssueCollection>;
}

async function createIssueThroughApi(
  request: APIRequestContext,
  publicVersionId: string,
  bodyMarkdown: string,
): Promise<ReviewIssue> {
  const response = await request.post(collectionPath(publicVersionId), {
    data: {
      requestId: crypto.randomUUID(),
      bodyMarkdown,
      anchor: {
        levelId: LEVEL_1F_ID,
        longitude: 139.7671,
        latitude: 35.6811,
        featureId: null,
      },
      assigneeId: null,
      dueDate: null,
    },
  });
  expect(response.status(), await response.text()).toBe(200);

  await expect
    .poll(async () => (await readCollection(request, publicVersionId)).issues.length)
    .toBeGreaterThan(0);
  const issue = (await readCollection(request, publicVersionId)).issues.find(
    ({ bodyMarkdown: body }) => body === bodyMarkdown,
  );
  expect(issue).toBeDefined();
  return issue!;
}

function issueCollectionGetCount(requests: readonly string[], publicVersionId: string): number {
  const expected = `GET ${collectionPath(publicVersionId)}`;
  return requests.filter((request) => request === expected).length;
}

async function openIssues(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Issues" });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByRole("region", { name: "Issues" })).toBeVisible();
}

async function prepareIssueAtMapCenter(page: Page, bodyMarkdown: string): Promise<void> {
  await openIssues(page);
  await page.getByRole("button", { name: "New issue" }).click();
  await page.getByRole("button", { name: "Place at map center" }).click();
  await page.getByLabel("Issue body").fill(bodyMarkdown);
}

async function mutateAndWaitForCanonicalGet(
  page: Page,
  publicVersionId: string,
  mutate: () => Promise<void>,
): Promise<void> {
  const canonical = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === collectionPath(publicVersionId) &&
      response.status() === 200,
  );
  await mutate();
  await canonical;
}

async function deleteVenue(request: APIRequestContext, venueId: number): Promise<void> {
  const response = await request.delete(`/api/venues/${venueId}`);
  expect([204, 404]).toContain(response.status());
}

test.describe("version-pinned review issues", () => {
  test("signed-in reviewer completes the issue workflow through the live stack", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await signIn(page);
    const venue = await publishVenue(
      page.request,
      uniqueDatasetName("issue-workflow", testInfo),
    );

    try {
      const { publicVersionId } = await openPublishedDataset(page, venue.slug);
      await waitForIssueStream(page, publicVersionId);
      await openIssues(page);
      await page.getByRole("button", { name: "New issue" }).click();
      await switchLocale(page, "ja");
      await expect(page.getByRole("button", { name: "地図の中心に配置" })).toBeVisible();
      await switchLocale(page, "en");
      await page.getByRole("button", { name: "Place at map center" }).click();
      await page.getByLabel("Issue body").fill(ISSUE_BODY);
      await page.getByLabel("Assignee").selectOption({ label: "e2e" });
      await page.getByLabel("Due date").fill(DUE_DATE);

      await mutateAndWaitForCanonicalGet(page, publicVersionId, async () => {
        await page.getByRole("button", { name: "Post issue" }).click();
      });

      await expect(page.locator(".issue-pin")).toHaveCount(1);
      await expect(page.locator(".issue-pin")).toHaveAccessibleName(
        /Issue #1.*Check the ticket gate alignment.*Open/,
      );
      await switchLocale(page, "ja");
      await expect(page.locator(".issue-pin")).toHaveAccessibleName(
        /課題 #1.*Check the ticket gate alignment.*オープン/,
      );
      await switchLocale(page, "en");
      await page.getByRole("option", { name: /#1 Check the ticket gate alignment/ }).click();
      await expect(page.locator(".issue-detail__body")).toContainText(ISSUE_BODY);
      await expect(page.getByLabel("Status")).toHaveValue("open");
      await expect(page.getByLabel("Assignee")).toHaveValue(/\d+/);
      await expect(page.getByLabel("Due date")).toHaveValue(DUE_DATE);

      await page.getByLabel("Reply").fill(REPLY_BODY);
      await mutateAndWaitForCanonicalGet(page, publicVersionId, async () => {
        await page.getByRole("button", { name: "Reply", exact: true }).click();
      });
      await expect(page.locator(".issue-reply__body")).toContainText(REPLY_BODY);

      await mutateAndWaitForCanonicalGet(page, publicVersionId, async () => {
        await page.getByLabel("Status").selectOption("in_review");
      });
      await expect(page.getByLabel("Status")).toHaveValue("in_review");

      await mutateAndWaitForCanonicalGet(page, publicVersionId, async () => {
        await page.getByLabel("Status").selectOption("closed");
      });
      await expect(page.getByLabel("Status")).toHaveValue("closed");

      await page.getByRole("button", { name: "Back to issues" }).click();
      await page.getByRole("button", { name: "Closed" }).click();
      const closedRow = page.getByRole("option", { name: /#1 Check the ticket gate alignment/ });
      await expect(closedRow).toContainText("Closed");
      await expect(closedRow).toContainText("Dec 31, 2099");
      await closedRow.click();

      await mutateAndWaitForCanonicalGet(page, publicVersionId, async () => {
        await page.getByLabel("Status").selectOption("open");
      });
      await expect(page.getByLabel("Status")).toHaveValue("open");
      await expect(page.locator(".issue-detail__body")).toContainText(ISSUE_BODY);
    } finally {
      await deleteVenue(page.request, venue.venueId);
    }
  });

  test("anonymous observer refetches canonical state after an SSE revision", async ({
    browser,
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await signIn(page);
    const venue = await publishVenue(page.request, uniqueDatasetName("issue-sync", testInfo));
    const observerContext = await browser.newContext({ baseURL: new URL(page.url()).origin });

    try {
      const author = await openPublishedDataset(page, venue.slug);
      await waitForIssueStream(page, author.publicVersionId);

      const observer = await observerContext.newPage();
      const observed = collectIssueRequests(observer);
      try {
        const anonymous = await openPublishedDataset(observer, venue.slug);
        expect(anonymous.publicVersionId).toBe(author.publicVersionId);
        await waitForIssueStream(observer, author.publicVersionId);
        await openIssues(observer);
        await expect(observer.getByText("No active issues")).toBeVisible();
        const baselineGets = issueCollectionGetCount(observed.requests, author.publicVersionId);
        expect(baselineGets).toBeGreaterThanOrEqual(1);

        await prepareIssueAtMapCenter(page, "Observer receives canonical issue");
        const observerRefetch = observer.waitForResponse(
          (response) =>
            response.request().method() === "GET" &&
            new URL(response.url()).pathname === collectionPath(author.publicVersionId) &&
            response.status() === 200,
        );
        await page.getByRole("button", { name: "Post issue" }).click();
        await observerRefetch;

        await expect(
          observer.getByRole("option", { name: /#1 Observer receives canonical issue/ }),
        ).toBeVisible();
        expect(issueCollectionGetCount(observed.requests, author.publicVersionId)).toBeGreaterThan(
          baselineGets,
        );
        expect(observed.requests).toContain(`GET ${streamPath(author.publicVersionId)}`);
      } finally {
        observed.dispose();
      }
    } finally {
      await observerContext.close();
      await deleteVenue(page.request, venue.venueId);
    }
  });

  test("versions and delete-recreate cycles never reuse review identity", async ({
    context,
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await signIn(page);
    const name = uniqueDatasetName("issue-isolation", testInfo);
    const original = await publishVenue(page.request, name);
    let replacementVenueId: number | null = null;
    let originalDeleted = false;

    try {
      const old = await openPublishedDataset(page, original.slug);
      await waitForIssueStream(page, old.publicVersionId);
      const oldIssue = await createIssueThroughApi(
        page.request,
        old.publicVersionId,
        "Pinned to version one",
      );
      await openIssues(page);
      await expect(page.getByRole("option", { name: /#1 Pinned to version one/ })).toBeVisible();

      const second = await publishNextVersion(page.request, original.venueId);
      expect(second.seq).toBe(2);
      const latestPage = await context.newPage();
      const latest = await openPublishedDataset(latestPage, original.slug);
      expect(latest.publicVersionId).not.toBe(old.publicVersionId);
      await openIssues(latestPage);
      await expect(latestPage.getByText("No active issues")).toBeVisible();
      await expect(page.getByRole("option", { name: /#1 Pinned to version one/ })).toBeVisible();

      const reconnect404 = page
        .waitForResponse(
          (response) =>
            new URL(response.url()).pathname === streamPath(old.publicVersionId) &&
            response.status() === 404,
        )
        .then(async (response) => (await response.json()) as { error?: string });
      const deletion = await page.request.delete(`/api/venues/${original.venueId}`);
      expect(deletion.status(), await deletion.text()).toBe(204);
      originalDeleted = true;
      await waitForIssueStreamClose(page, old.publicVersionId);
      const reconnectBody = await reconnect404;
      expect(reconnectBody.error).toBe("not_found");

      const oldCollection = await page.request.get(collectionPath(old.publicVersionId));
      const oldCollectionBody = (await oldCollection.json()) as { error?: string };
      expect(oldCollection.status(), JSON.stringify(oldCollectionBody)).toBe(404);
      expect(oldCollectionBody.error).toBe("not_found");
      const oldMutation = await page.request.patch(`/api/issues/${oldIssue.id}`, {
        data: { type: "status", status: "closed", expectedVersion: oldIssue.rowVersion },
      });
      const oldMutationBody = (await oldMutation.json()) as { error?: string };
      expect(oldMutation.status(), JSON.stringify(oldMutationBody)).toBe(404);
      expect(oldMutationBody.error).toBe("not_found");

      const replacement = await publishVenue(page.request, name);
      replacementVenueId = replacement.venueId;
      expect(replacement.slug).toBe(original.slug);
      expect(replacement.seq).toBe(1);
      const replacementPage = await context.newPage();
      const replacementDataset = await openPublishedDataset(replacementPage, replacement.slug);
      expect(replacementDataset.publicVersionId).not.toBe(old.publicVersionId);
      expect((await readCollection(page.request, replacementDataset.publicVersionId)).issues).toEqual(
        [],
      );
      await createIssueThroughApi(
        page.request,
        replacementDataset.publicVersionId,
        "Replacement identity is writable",
      );

      await expect(mapContainer(page)).toBeVisible();
      await expect(page.locator(".context-bar__name")).toHaveText(VENUE_NAME_EN);
    } finally {
      if (!originalDeleted) {
        await deleteVenue(page.request, original.venueId);
      }
      if (replacementVenueId !== null) {
        await deleteVenue(page.request, replacementVenueId);
      }
    }
  });

  test("embed datasets and local replacements start no new issue work", async ({
    context,
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await signIn(page);
    const venue = await publishVenue(page.request, uniqueDatasetName("issue-provenance", testInfo));

    try {
      const embedPage = await context.newPage();
      const embedRequests = collectIssueRequests(embedPage);
      try {
        await embedPage.goto(`/?dataset=${venue.slug}&embed=1&lang=en`);
        await waitForMapIdle(embedPage);
        await expect(mapContainer(embedPage)).toBeVisible();
        expect(embedRequests.requests).toEqual([]);
        await expect(embedPage.getByRole("button", { name: "Issues" })).toHaveCount(0);
      } finally {
        embedRequests.dispose();
      }

      const requests = collectIssueRequests(page);
      try {
        const { publicVersionId } = await openPublishedDataset(page, venue.slug);
        await waitForIssueStream(page, publicVersionId);
        const baseline = [...requests.requests];
        const bytes = await minimalImdfZipBuffer();
        await dropZip(page, bytes);
        await waitForIssueStreamClose(page, publicVersionId);
        await expect(page.getByRole("button", { name: "Issues" })).toHaveCount(0);
        expect(requests.requests).toEqual(baseline);
      } finally {
        requests.dispose();
      }
    } finally {
      await deleteVenue(page.request, venue.venueId);
    }
  });
});
