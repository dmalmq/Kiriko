import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VenueSummary } from "./api";

const me = vi.fn();
const listVenues = vi.fn();
const inspectGdb = vi.fn();
const inspectGdbNetwork = vi.fn();
const inspectGdbFacilities = vi.fn();
const createVenue = vi.fn();
const publishGdb = vi.fn();
const augmentGdb = vi.fn();
const getGdbMapping = vi.fn();
const waitForJob = vi.fn();
const deleteVenue = vi.fn();
const generateNetwork = vi.fn();
const exportNetwork = vi.fn();
const logout = vi.fn();
const login = vi.fn();
const viewerHrefSpy = vi.fn();
const PUBLIC_ID = "a".repeat(64);
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      me: () => me(),
      listVenues: () => listVenues(),
      inspectGdb: (...args: unknown[]) => inspectGdb(...args),
      inspectGdbNetwork: (...args: unknown[]) => inspectGdbNetwork(...args),
      inspectGdbFacilities: (...args: unknown[]) => inspectGdbFacilities(...args),
      createVenue: (...args: unknown[]) => createVenue(...args),
      publishGdb: (...args: unknown[]) => publishGdb(...args),
      augmentGdb: (...args: unknown[]) => augmentGdb(...args),
      getGdbMapping: (...args: unknown[]) => getGdbMapping(...args),
      waitForJob: (...args: unknown[]) => waitForJob(...args),
      deleteVenue: (...args: unknown[]) => deleteVenue(...args),
      generateNetwork: (...args: unknown[]) => generateNetwork(...args),
      exportNetwork: (...args: unknown[]) => exportNetwork(...args),
      logout: () => logout(),
      login: (...args: unknown[]) => login(...args),
    },
    viewerHref: (...args: unknown[]) => viewerHrefSpy(...args),
  };
});

import { GalleryPage } from "./GalleryPage";

const VENUE: VenueSummary = {
  id: 1,
  slug: "tokyo-station",
  name: "東京駅構内図",
  createdAt: "2026-07-17 00:00:00",
  latest: {
    seq: 2,
    publicVersionId: PUBLIC_ID,
    status: "published",
    stats: { levels: 4, features: 3204 },
    createdAt: "2026-07-17 00:00:00",
  },
};

const gdbInspection = {
  sourceName: "Station.gdb",
  databases: [{ id: "gdb-1", name: "Station.gdb" }],
  layers: [{
    key: { databaseId: "gdb-1", layerName: "Station_1_Floor" },
    databaseName: "Station.gdb", featureCount: 3, geometryFamily: "polygon",
    fields: [{ name: "id", type: "String" }],
  }],
  warnings: [],
};
const gdbPlan = {
  venueName: "Station",
  buildings: [{ id: "b1", name: "Station" }],
  layers: [{
    key: { databaseId: "gdb-1", layerName: "Station_1_Floor" },
    included: true, targetType: "level", buildingId: "b1",
    levelRule: { kind: "layer-name" }, idField: "id",
    ordinalField: null, shortNameField: null, nameField: null, categoryField: null,
  }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}


afterEach(() => {
  vi.resetAllMocks();
});

describe("GalleryPage", () => {
  it("renders dataset cards with stats for a signed-in user", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([VENUE]);
    render(<GalleryPage />);

    await waitFor(() => {
      expect(screen.getByText("東京駅構内図")).toBeTruthy();
    });
    expect(screen.getByText(/4/)).toBeTruthy();
    expect(screen.getByText(/3,204|3204/)).toBeTruthy();
    expect(screen.getByText("tokyo-station")).toBeTruthy();
  });

  it("wires Open to the pinned viewer link with the current locale", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([VENUE]);
    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("東京駅構内図")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "開く" }));
    expect(viewerHrefSpy).toHaveBeenCalledWith("tokyo-station", PUBLIC_ID, "ja");
  });

  it("wires Review network to the pinned review link with the current locale", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([{ ...VENUE, hasGraph: true }]);
    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("東京駅構内図")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));

    await user.click(screen.getByRole("button", { name: "Review network" }));
    expect(viewerHrefSpy).toHaveBeenCalledWith("tokyo-station", PUBLIC_ID, "en", true);
  });

  it("opens IMDF version upload for the selected venue", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([
      {
        ...VENUE,
        id: 42,
        slug: "existing-station",
        name: "Existing Station",
      },
    ]);
    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Existing Station")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));

    await user.click(screen.getByRole("button", { name: "Upload IMDF" }));

    expect(
      screen.getByRole("dialog", { name: "Upload IMDF version" }),
    ).toBeTruthy();
    const nameInput = screen.getByLabelText("Dataset name") as HTMLInputElement;
    expect(nameInput.value).toBe("Existing Station");
    expect(nameInput.readOnly || nameInput.disabled).toBe(true);
  });

  it("filters cards by name", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([
      VENUE,
      { ...VENUE, id: 2, slug: "shibuya", name: "Shibuya Station" },
    ]);
    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => {
      expect(screen.getByText("Shibuya Station")).toBeTruthy();
    });

    await user.type(screen.getByRole("searchbox"), "shibuya");
    expect(screen.queryByText("東京駅構内図")).toBeNull();
    expect(screen.getByText("Shibuya Station")).toBeTruthy();
  });

  it("shows the empty state when there are no datasets", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([]);
    render(<GalleryPage />);
    await waitFor(() => {
      expect(screen.getByText("データセットがありません")).toBeTruthy();
    });
  });

  it("imports a geodatabase: inspect, review, publish, reload", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([]);
    inspectGdb.mockResolvedValue({ blobHash: "a".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });
    createVenue.mockResolvedValue({ id: 9, slug: "station", name: "Station", createdAt: "" });
    publishGdb.mockResolvedValue({
      jobId: "j",
      versionId: 1,
      seq: 1,
      excludedLayers: [{ layer: "Bad_Layer", reason: "empty or geometry-less layer" }],
    });
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("データセットがありません")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "Station.gdb.zip", { type: "application/zip" });
    await user.upload(input, file);

    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(publishGdb).toHaveBeenCalledTimes(1));
    expect(createVenue).toHaveBeenCalledWith("Station");
    expect(publishGdb).toHaveBeenCalledWith(9, "a".repeat(64), expect.objectContaining({ venueName: "Station" }), null, null);
    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/skipped|スキップ/),
    );
  });

  it("imports a geodatabase as a new version of an existing venue", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([
      {
        id: 42,
        slug: "existing-station",
        name: "Existing Station",
        createdAt: "2026-07-20 00:00:00",
        latest: {
          seq: 1,
          publicVersionId: PUBLIC_ID,
          status: "published",
          stats: { levels: 2, features: 9 },
          createdAt: "2026-07-20 00:00:00",
        },
      },
    ]);
    inspectGdb.mockResolvedValue({
      blobHash: "b".repeat(64),
      inspection: gdbInspection,
      suggestedPlan: { ...gdbPlan, venueName: "FromArchive" },
    });
    publishGdb.mockResolvedValue({
      jobId: "j2",
      versionId: 2,
      seq: 2,
      excludedLayers: [],
    });
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Existing Station")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Import GDB" }));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "Station.gdb.zip", {
      type: "application/zip",
    });
    await user.upload(input, file);

    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    // Venue name locked to existing venue
    const nameInput = screen.getByLabelText(/venue name/i) as HTMLInputElement;
    expect(nameInput.value).toBe("Existing Station");
    expect(nameInput.readOnly || nameInput.disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(publishGdb).toHaveBeenCalledTimes(1));
    expect(createVenue).not.toHaveBeenCalled();
    expect(publishGdb).toHaveBeenCalledWith(
      42,
      "b".repeat(64),
      expect.objectContaining({ venueName: "Existing Station" }),
      null,
      null,
    );
    expect(deleteVenue).not.toHaveBeenCalled();
    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
  });

  it("attaches an optional routing network before publishing", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([]);
    inspectGdb.mockResolvedValue({ blobHash: "a".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });
    inspectGdbNetwork.mockResolvedValue({
      networkBlobHash: "n".repeat(64),
      nodeCount: 120,
      edgeCount: 340,
      floors: ["1F", "2F"],
    });
    createVenue.mockResolvedValue({ id: 9, slug: "station", name: "Station", createdAt: "" });
    publishGdb.mockResolvedValue({ jobId: "j", versionId: 1, seq: 1, excludedLayers: [] });
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("データセットがありません")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([1, 2, 3])], "Station.gdb.zip", { type: "application/zip" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    // No network attached yet: no summary, publish would pass null.
    expect(screen.queryByText(/routing network: \d+ nodes/i)).toBeNull();

    const networkInput = screen.getByLabelText(/add routing network/i);
    await user.upload(networkInput, new File([new Uint8Array([4, 5])], "net.gdb.zip", { type: "application/zip" }));
    await waitFor(() =>
      expect(screen.getByText("Routing network: 120 nodes, 340 paths, 2 floors")).toBeTruthy(),
    );

    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(publishGdb).toHaveBeenCalledTimes(1));
    expect(inspectGdbNetwork).toHaveBeenCalledTimes(1);
    expect(publishGdb).toHaveBeenCalledWith(
      9,
      "a".repeat(64),
      expect.objectContaining({ venueName: "Station" }),
      "n".repeat(64),
      null,
    );
    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
  });

  it("attaches optional point facilities before publishing", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([]);
    inspectGdb.mockResolvedValue({ blobHash: "a".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });
    inspectGdbFacilities.mockResolvedValue({
      facilitiesBlobHash: "f".repeat(64),
      facilityCount: 2426,
      floors: ["B1", "F1"],
    });
    createVenue.mockResolvedValue({ id: 9, slug: "station", name: "Station", createdAt: "" });
    publishGdb.mockResolvedValue({ jobId: "j", versionId: 1, seq: 1, excludedLayers: [] });
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("データセットがありません")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([1, 2, 3])], "Station.gdb.zip", { type: "application/zip" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    expect(screen.queryByText(/facilities: \d+ places/i)).toBeNull();

    const facInput = screen.getByLabelText(/add point facilities/i);
    await user.upload(facInput, new File([new Uint8Array([6, 7])], "fac.gdb.zip", { type: "application/zip" }));
    await waitFor(() =>
      expect(screen.getByText("Facilities: 2426 places, 2 floors")).toBeTruthy(),
    );

    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(publishGdb).toHaveBeenCalledTimes(1));
    expect(inspectGdbFacilities).toHaveBeenCalledTimes(1);
    expect(publishGdb).toHaveBeenCalledWith(
      9,
      "a".repeat(64),
      expect.objectContaining({ venueName: "Station" }),
      null,
      "f".repeat(64),
    );
  });

  it("does not delete an existing venue when version publish fails", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([
      {
        id: 42,
        slug: "existing-station",
        name: "Existing Station",
        createdAt: "2026-07-20 00:00:00",
        latest: null,
      },
    ]);
    inspectGdb.mockResolvedValue({
      blobHash: "c".repeat(64),
      inspection: gdbInspection,
      suggestedPlan: gdbPlan,
    });
    publishGdb.mockRejectedValue({
      code: "gdb_conversion_failed",
      message: "nope",
    });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Existing Station")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Import GDB" }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(
      input,
      new File([new Uint8Array([1])], "x.gdb.zip", { type: "application/zip" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(publishGdb).toHaveBeenCalled());
    expect(deleteVenue).not.toHaveBeenCalled();
    expect(createVenue).not.toHaveBeenCalled();
  });
});

describe("GalleryPage add routing/facilities", () => {
  it("augments the selected dataset with a network archive without creating a venue", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([
      {
        id: 42,
        slug: "existing-station",
        name: "Existing Station",
        createdAt: "2026-07-20 00:00:00",
        latest: {
          seq: 1,
          publicVersionId: PUBLIC_ID,
          status: "published",
          stats: { levels: 2, features: 9 },
          createdAt: "2026-07-20 00:00:00",
        },
      },
    ]);
    inspectGdbNetwork.mockResolvedValue({
      networkBlobHash: "n".repeat(64),
      nodeCount: 120,
      edgeCount: 340,
      floors: ["1F", "2F"],
    });
    augmentGdb.mockResolvedValue({ jobId: "j", versionId: 2, seq: 2 });
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Existing Station")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Add routing / facilities" }));

    await user.upload(
      screen.getByLabelText("Add routing network"),
      new File([new Uint8Array([1, 2])], "net.gdb.zip", { type: "application/zip" }),
    );
    await waitFor(() => expect(screen.getByText(/120 nodes/)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(augmentGdb).toHaveBeenCalledTimes(1));
    expect(augmentGdb).toHaveBeenCalledWith(42, { networkBlobHash: "n".repeat(64) });
    expect(createVenue).not.toHaveBeenCalled();
    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
  });
});

describe("GalleryPage edit mapping", () => {
  it("re-opens the seeded mapping dialog and republishes without creating a venue", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([
      {
        id: 42,
        slug: "existing-station",
        name: "Existing Station",
        createdAt: "2026-07-20 00:00:00",
        latest: {
          seq: 1,
          publicVersionId: PUBLIC_ID,
          status: "published",
          stats: { levels: 2, features: 9 },
          createdAt: "2026-07-20 00:00:00",
        },
        editableMapping: true,
      },
    ]);
    getGdbMapping.mockResolvedValue({
      blobHash: "b".repeat(64),
      inspection: gdbInspection,
      plan: { ...gdbPlan, venueName: "Existing Station" },
    });
    publishGdb.mockResolvedValue({ jobId: "j", versionId: 2, seq: 2, excludedLayers: [] });
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Existing Station")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Edit mapping" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    const nameInput = screen.getByLabelText(/venue name/i) as HTMLInputElement;
    expect(nameInput.value).toBe("Existing Station");
    expect(nameInput.readOnly || nameInput.disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(publishGdb).toHaveBeenCalledTimes(1));
    expect(getGdbMapping).toHaveBeenCalledWith(42);
    expect(publishGdb).toHaveBeenCalledWith(
      42,
      "b".repeat(64),
      expect.objectContaining({ venueName: "Existing Station" }),
      null,
      null,
    );
    expect(createVenue).not.toHaveBeenCalled();
  });
});

describe("GalleryPage generate routing", () => {
  it("shows Generate routing on a venue-only dataset and calls generateNetwork on click", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([
      {
        id: 42,
        slug: "venue-only",
        name: "Venue Only",
        createdAt: "2026-07-20 00:00:00",
        latest: {
          seq: 1,
          publicVersionId: PUBLIC_ID,
          status: "published",
          stats: { levels: 2, features: 9 },
          createdAt: "2026-07-20 00:00:00",
        },
        hasNetwork: false,
      },
    ]);
    generateNetwork.mockResolvedValue({ jobId: "j", versionId: 2, seq: 2 });
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue Only")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Generate routing" }));

    await waitFor(() => expect(generateNetwork).toHaveBeenCalledTimes(1));
    expect(generateNetwork).toHaveBeenCalledWith(42);
    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
  });

  it("hides Generate routing on a dataset that already has a real network", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([
      {
        id: 43,
        slug: "with-network",
        name: "With Network",
        createdAt: "2026-07-20 00:00:00",
        latest: {
          seq: 1,
          publicVersionId: PUBLIC_ID,
          status: "published",
          stats: { levels: 2, features: 9 },
          createdAt: "2026-07-20 00:00:00",
        },
        hasNetwork: true,
      },
    ]);
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("With Network")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Generate routing" })).toBeNull();
    expect(screen.queryByRole("button", { name: "経路を生成" })).toBeNull();
  });
});

describe("GalleryPage export network", () => {
  it("shows Export network on a dataset with a graph and downloads on click", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([
      {
        id: 51,
        slug: "generated-station",
        name: "Generated Station",
        createdAt: "2026-07-20 00:00:00",
        latest: {
          seq: 2,
          publicVersionId: PUBLIC_ID,
          status: "published",
          stats: { levels: 3, features: 12 },
          createdAt: "2026-07-20 00:00:00",
        },
        hasGraph: true,
      },
    ]);
    exportNetwork.mockResolvedValue({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/zip" }),
      filename: "generated-station-network.gdb.zip",
    });
    const createObjectURL = vi.fn(() => "blob:mock");
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Generated Station")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Export network" }));

    await waitFor(() => expect(exportNetwork).toHaveBeenCalledTimes(1));
    expect(exportNetwork).toHaveBeenCalledWith(51);
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  });

  it("hides Export network on a dataset without a graph", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([
      {
        id: 52,
        slug: "plain-station",
        name: "Plain Station",
        createdAt: "2026-07-20 00:00:00",
        latest: {
          seq: 1,
          publicVersionId: PUBLIC_ID,
          status: "published",
          stats: { levels: 1, features: 3 },
          createdAt: "2026-07-20 00:00:00",
        },
        hasGraph: false,
      },
    ]);
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Plain Station")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Export network" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ネットワークを書き出し" })).toBeNull();
  });
});

describe("GalleryPage async GDB flow isolation", () => {
  it("uses the reopened primary GDB inspect result instead of a stale earlier upload", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([]);
    const firstInspect = deferred<{ blobHash: string; inspection: typeof gdbInspection; suggestedPlan: typeof gdbPlan }>();
    const secondInspect = deferred<{ blobHash: string; inspection: typeof gdbInspection; suggestedPlan: typeof gdbPlan }>();
    inspectGdb.mockReturnValueOnce(firstInspect.promise).mockReturnValueOnce(secondInspect.promise);
    createVenue.mockResolvedValue({ id: 9, slug: "station", name: "Station", createdAt: "" });
    publishGdb.mockResolvedValue({ jobId: "j", versionId: 1, seq: 1, excludedLayers: [] });
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("データセットがありません")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([1])], "old.gdb.zip", { type: "application/zip" }));
    await user.click(screen.getByRole("button", { name: "Import Geodatabase" }));
    await user.upload(input, new File([new Uint8Array([2])], "new.gdb.zip", { type: "application/zip" }));

    await act(async () => {
      secondInspect.resolve({ blobHash: "b".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });
      await secondInspect.promise;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    await act(async () => {
      firstInspect.resolve({ blobHash: "a".repeat(64), inspection: gdbInspection, suggestedPlan: { ...gdbPlan, venueName: "Old" } });
      await firstInspect.promise;
    });

    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(publishGdb).toHaveBeenCalledTimes(1));
    expect(publishGdb).toHaveBeenCalledWith(
      9,
      "b".repeat(64),
      expect.objectContaining({ venueName: "Station" }),
      null,
      null,
    );
  });

  it("does not attach venue A routing inspect results after opening add-data for venue B", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([
      { ...VENUE, id: 1, slug: "venue-a", name: "Venue A" },
      { ...VENUE, id: 2, slug: "venue-b", name: "Venue B" },
    ]);
    const venueANetwork = deferred<{ networkBlobHash: string; nodeCount: number; edgeCount: number; floors: string[] }>();
    const venueBNetwork = deferred<{ networkBlobHash: string; nodeCount: number; edgeCount: number; floors: string[] }>();
    inspectGdbNetwork.mockReturnValueOnce(venueANetwork.promise).mockReturnValueOnce(venueBNetwork.promise);
    augmentGdb.mockResolvedValue({ jobId: "j", versionId: 2, seq: 2 });
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue A")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));

    const addButtons = screen.getAllByRole("button", { name: "Add routing / facilities" });
    await user.click(addButtons[0]!);
    await user.upload(
      screen.getByLabelText("Add routing network"),
      new File([new Uint8Array([1])], "a-net.gdb.zip", { type: "application/zip" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(addButtons[1]!);

    await act(async () => {
      venueANetwork.resolve({ networkBlobHash: "a".repeat(64), nodeCount: 111, edgeCount: 222, floors: ["1F"] });
      await venueANetwork.promise;
    });
    const dialog = screen.getByRole("dialog", { name: "Add routing / facilities" });
    expect(within(dialog).getByText("Venue B")).toBeTruthy();
    expect(within(dialog).queryByText(/111 nodes/)).toBeNull();
    expect((within(dialog).getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);

    await user.upload(
      within(dialog).getByLabelText("Add routing network"),
      new File([new Uint8Array([2])], "b-net.gdb.zip", { type: "application/zip" }),
    );
    await act(async () => {
      venueBNetwork.resolve({ networkBlobHash: "b".repeat(64), nodeCount: 333, edgeCount: 444, floors: ["2F"] });
      await venueBNetwork.promise;
    });
    await waitFor(() => expect(within(dialog).getByText(/333 nodes/)).toBeTruthy());
    await user.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(augmentGdb).toHaveBeenCalledTimes(1));
    expect(augmentGdb).toHaveBeenCalledWith(2, { networkBlobHash: "b".repeat(64) });
  });

  it("ignores facilities inspect completion after add-data is reset", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([{ ...VENUE, id: 42, slug: "venue", name: "Venue" }]);
    const facilitiesInspect = deferred<{ facilitiesBlobHash: string; facilityCount: number; floors: string[] }>();
    inspectGdbFacilities.mockReturnValue(facilitiesInspect.promise);

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Add routing / facilities" }));
    await user.upload(
      screen.getByLabelText("Add point facilities"),
      new File([new Uint8Array([1])], "fac.gdb.zip", { type: "application/zip" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await act(async () => {
      facilitiesInspect.resolve({ facilitiesBlobHash: "f".repeat(64), facilityCount: 2426, floors: ["B1"] });
      await facilitiesInspect.promise;
    });

    expect(screen.queryByRole("dialog", { name: "Add routing / facilities" })).toBeNull();
    expect(screen.queryByText(/2426 places/)).toBeNull();
  });

  it("keeps old publish completion from closing or reloading a newer GDB flow", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([]);
    inspectGdb
      .mockResolvedValueOnce({ blobHash: "a".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan })
      .mockResolvedValueOnce({ blobHash: "b".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });
    createVenue.mockResolvedValue({ id: 9, slug: "station", name: "Station", createdAt: "" });
    publishGdb.mockResolvedValue({ jobId: "old", versionId: 1, seq: 1, excludedLayers: [] });
    const oldJob = deferred<{ status: "done" }>();
    waitForJob.mockReturnValue(oldJob.promise);

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("データセットがありません")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([1])], "old.gdb.zip", { type: "application/zip" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(waitForJob).toHaveBeenCalledWith("old"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Import Geodatabase" }));
    await user.upload(input, new File([new Uint8Array([2])], "new.gdb.zip", { type: "application/zip" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());

    await act(async () => {
      oldJob.resolve({ status: "done" });
      await oldJob.promise;
    });

    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps old augment completion from resetting a newer GDB import flow", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([{ ...VENUE, id: 42, slug: "venue", name: "Venue" }]);
    inspectGdbNetwork.mockResolvedValue({ networkBlobHash: "n".repeat(64), nodeCount: 120, edgeCount: 340, floors: ["1F"] });
    augmentGdb.mockResolvedValue({ jobId: "augment", versionId: 2, seq: 2 });
    const augmentJob = deferred<{ status: "done" }>();
    waitForJob.mockReturnValue(augmentJob.promise);
    const newInspect = deferred<{ blobHash: string; inspection: typeof gdbInspection; suggestedPlan: typeof gdbPlan }>();
    inspectGdb.mockReturnValue(newInspect.promise);

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Add routing / facilities" }));
    await user.upload(
      screen.getByLabelText("Add routing network"),
      new File([new Uint8Array([1])], "net.gdb.zip", { type: "application/zip" }),
    );
    await waitFor(() => expect(screen.getByText(/120 nodes/)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(waitForJob).toHaveBeenCalledWith("augment"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Import Geodatabase" }));
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File([new Uint8Array([2])], "new.gdb.zip", { type: "application/zip" }),
    );
    await act(async () => {
      newInspect.resolve({ blobHash: "b".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });
      await newInspect.promise;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());

    await act(async () => {
      augmentJob.resolve({ status: "done" });
      await augmentJob.promise;
    });

    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
  });

  it("invalidates in-flight routing generation on sign-out", async () => {
    me.mockResolvedValueOnce({ id: 1, username: "daniel", role: "admin" }).mockResolvedValueOnce(null);
    listVenues.mockResolvedValue([{ ...VENUE, id: 42, slug: "venue", name: "Venue", hasNetwork: false }]);
    logout.mockResolvedValue(undefined);
    const generation = deferred<{ jobId: string; versionId: number; seq: number }>();
    generateNetwork.mockReturnValue(generation.promise);
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Generate routing" }));
    await waitFor(() => expect(generateNetwork).toHaveBeenCalledWith(42));
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Sign in to Kiriko" })).toBeTruthy());

    await act(async () => {
      generation.resolve({ jobId: "route", versionId: 2, seq: 2 });
      await generation.promise;
    });

    expect(waitForJob).not.toHaveBeenCalled();
    expect(listVenues).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("invalidates in-flight routing generation on unmount", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([{ ...VENUE, id: 42, slug: "venue", name: "Venue", hasNetwork: false }]);
    const generation = deferred<{ jobId: string; versionId: number; seq: number }>();
    generateNetwork.mockReturnValue(generation.promise);
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    const { unmount } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Generate routing" }));
    await waitFor(() => expect(generateNetwork).toHaveBeenCalledWith(42));

    unmount();
    await act(async () => {
      generation.resolve({ jobId: "route", versionId: 2, seq: 2 });
      await generation.promise;
    });

    expect(waitForJob).not.toHaveBeenCalled();
  });

  it("applies only the latest out-of-order routing inspect in a GDB review", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([]);
    inspectGdb.mockResolvedValue({ blobHash: "a".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });
    const firstNetwork = deferred<{ networkBlobHash: string; nodeCount: number; edgeCount: number; floors: string[] }>();
    const secondNetwork = deferred<{ networkBlobHash: string; nodeCount: number; edgeCount: number; floors: string[] }>();
    inspectGdbNetwork.mockReturnValueOnce(firstNetwork.promise).mockReturnValueOnce(secondNetwork.promise);
    createVenue.mockResolvedValue({ id: 9, slug: "station", name: "Station", createdAt: "" });
    publishGdb.mockResolvedValue({ jobId: "j", versionId: 1, seq: 1, excludedLayers: [] });
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("データセットがありません")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File([new Uint8Array([1])], "venue.gdb.zip", { type: "application/zip" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    await user.upload(
      screen.getByLabelText("Add routing network"),
      new File([new Uint8Array([2])], "old-net.gdb.zip", { type: "application/zip" }),
    );
    await user.upload(
      screen.getByLabelText("Add routing network"),
      new File([new Uint8Array([3])], "new-net.gdb.zip", { type: "application/zip" }),
    );

    await act(async () => {
      secondNetwork.resolve({ networkBlobHash: "b".repeat(64), nodeCount: 200, edgeCount: 300, floors: ["1F", "2F"] });
      await secondNetwork.promise;
    });
    await waitFor(() => expect(screen.getByText("Routing network: 200 nodes, 300 paths, 2 floors")).toBeTruthy());
    await act(async () => {
      firstNetwork.reject({ code: "gdb_network_extraction_failed", message: "old failed" });
      try {
        await firstNetwork.promise;
      } catch {
        // expected in the mocked stale request
      }
    });

    expect(screen.getByText("Routing network: 200 nodes, 300 paths, 2 floors")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(publishGdb).toHaveBeenCalledTimes(1));
    expect(publishGdb).toHaveBeenCalledWith(
      9,
      "a".repeat(64),
      expect.objectContaining({ venueName: "Station" }),
      "b".repeat(64),
      null,
    );
  });
});

describe("GalleryPage async lifecycle blockers", () => {
  it("reaches ready when mounted under React StrictMode", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([VENUE]);

    render(
      <StrictMode>
        <GalleryPage />
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByText("東京駅構内図")).toBeTruthy());
  });

  it("does not reopen a stale GDB dialog after signing out and signing back in", async () => {
    me
      .mockResolvedValue({ id: 1, username: "daniel", role: "admin" })
      .mockResolvedValueOnce({ id: 1, username: "daniel", role: "admin" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...VENUE, name: "After Sign In" }]);
    logout.mockResolvedValue(undefined);
    login.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    inspectGdb.mockResolvedValue({ blobHash: "a".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("データセットがありません")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File([new Uint8Array([1])], "venue.gdb.zip", { type: "application/zip" }),
    );
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Review GDB layer mappings" })).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Sign in to Kiriko" })).toBeTruthy());
    await user.type(screen.getByLabelText("Username"), "daniel");
    await user.type(screen.getByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByText("After Sign In")).toBeTruthy());
    expect(screen.queryByRole("dialog", { name: "Review GDB layer mappings" })).toBeNull();
  });

  it("resets an in-flight Generate routing action across sign-out and sign-in", async () => {
    const venue = { ...VENUE, id: 42, slug: "venue", name: "Venue", hasNetwork: false };
    me
      .mockResolvedValue({ id: 1, username: "daniel", role: "admin" })
      .mockResolvedValueOnce({ id: 1, username: "daniel", role: "admin" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([venue]).mockResolvedValueOnce([venue]).mockResolvedValueOnce([venue]);
    logout.mockResolvedValue(undefined);
    login.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    const oldGeneration = deferred<{ jobId: string; versionId: number; seq: number }>();
    generateNetwork
      .mockReturnValueOnce(oldGeneration.promise)
      .mockResolvedValueOnce({ jobId: "new-route", versionId: 3, seq: 3 });
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Generate routing" }));
    await waitFor(() => expect(generateNetwork).toHaveBeenCalledWith(42));
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Sign in to Kiriko" })).toBeTruthy());
    await user.type(screen.getByLabelText("Username"), "daniel");
    await user.type(screen.getByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Generate routing" }));
    await waitFor(() => expect(generateNetwork).toHaveBeenCalledTimes(2));
    await act(async () => {
      oldGeneration.resolve({ jobId: "old-route", versionId: 2, seq: 2 });
      await oldGeneration.promise;
    });
    expect(waitForJob).not.toHaveBeenCalledWith("old-route");
  });

  it("keeps a stale success reload rejection from replacing a newer GDB flow", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    const staleReload = deferred<VenueSummary[]>();
    listVenues.mockResolvedValueOnce([]).mockReturnValueOnce(staleReload.promise);
    inspectGdb
      .mockResolvedValueOnce({ blobHash: "a".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan })
      .mockResolvedValueOnce({ blobHash: "b".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });
    createVenue.mockResolvedValue({ id: 9, slug: "station", name: "Station", createdAt: "" });
    publishGdb.mockResolvedValue({ jobId: "j", versionId: 1, seq: 1, excludedLayers: [] });
    waitForJob.mockResolvedValue({ status: "done" });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("データセットがありません")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([1])], "first.gdb.zip", { type: "application/zip" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Import Geodatabase" }));
    await user.upload(input, new File([new Uint8Array([2])], "second.gdb.zip", { type: "application/zip" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());

    await act(async () => {
      staleReload.reject(new Error("stale reload"));
      try {
        await staleReload.promise;
      } catch {
        // expected in the mocked stale reload
      }
    });

    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
    expect(screen.queryByText("Could not load datasets")).toBeNull();
  });

  it("keeps stale Generate routing completion from overwriting a newer export notice", async () => {
    const venue = { ...VENUE, id: 42, slug: "venue", name: "Venue", hasNetwork: false, hasGraph: true };
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([venue]);
    const generation = deferred<{ jobId: string; versionId: number; seq: number }>();
    generateNetwork.mockReturnValue(generation.promise);
    waitForJob.mockResolvedValue({ status: "done" });
    exportNetwork.mockResolvedValue({
      blob: new Blob([new Uint8Array([1])], { type: "application/zip" }),
      filename: "network.gdb.zip",
    });
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Generate routing" }));
    await user.click(screen.getByRole("button", { name: "Export network" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Network exported"));

    await act(async () => {
      generation.resolve({ jobId: "route", versionId: 2, seq: 2 });
      await generation.promise;
    });

    expect(screen.getByRole("status").textContent).toBe("Network exported");
    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
  });

  it("keeps stale export completion from downloading or overwriting a newer Generate routing notice", async () => {
    const venue = { ...VENUE, id: 42, slug: "venue", name: "Venue", hasNetwork: false, hasGraph: true };
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([venue]);
    const exported = deferred<{ blob: Blob; filename: string }>();
    const generation = deferred<{ jobId: string; versionId: number; seq: number }>();
    exportNetwork.mockReturnValue(exported.promise);
    generateNetwork.mockReturnValue(generation.promise);
    waitForJob.mockResolvedValue({ status: "done" });
    const createObjectURL = vi.fn(() => "blob:mock");
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Export network" }));
    await user.click(screen.getByRole("button", { name: "Generate routing" }));
    expect(screen.getByRole("status").textContent).toBe("Generating routing…");

    await act(async () => {
      exported.resolve({
        blob: new Blob([new Uint8Array([1])], { type: "application/zip" }),
        filename: "network.gdb.zip",
      });
      await exported.promise;
    });

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Generating routing…");
    await act(async () => {
      generation.resolve({ jobId: "route", versionId: 2, seq: 2 });
      await generation.promise;
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Routing generated"));
  });

  it("keeps stale Generate routing completion from overwriting a newer GDB import", async () => {
    const venue = { ...VENUE, id: 42, slug: "venue", name: "Venue", hasNetwork: false };
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([venue]);
    const generation = deferred<{ jobId: string; versionId: number; seq: number }>();
    generateNetwork.mockReturnValue(generation.promise);
    waitForJob.mockResolvedValue({ status: "done" });
    inspectGdb.mockResolvedValue({ blobHash: "b".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Generate routing" }));
    await user.click(screen.getByRole("button", { name: "Import Geodatabase" }));
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File([new Uint8Array([1])], "venue.gdb.zip", { type: "application/zip" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());

    await act(async () => {
      generation.resolve({ jobId: "route", versionId: 2, seq: 2 });
      await generation.promise;
    });

    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
  });

  it("keeps stale GDB publish reload rejection from replacing a newer export", async () => {
    const venue = { ...VENUE, id: 42, slug: "venue", name: "Venue", hasGraph: true };
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    const staleReload = deferred<VenueSummary[]>();
    listVenues.mockResolvedValueOnce([venue]).mockReturnValueOnce(staleReload.promise);
    inspectGdb.mockResolvedValue({ blobHash: "b".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });
    createVenue.mockResolvedValue({ id: 9, slug: "station", name: "Station", createdAt: "" });
    publishGdb.mockResolvedValue({ jobId: "publish", versionId: 1, seq: 1, excludedLayers: [] });
    waitForJob.mockResolvedValue({ status: "done" });
    exportNetwork.mockResolvedValue({
      blob: new Blob([new Uint8Array([1])], { type: "application/zip" }),
      filename: "network.gdb.zip",
    });
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File([new Uint8Array([1])], "venue.gdb.zip", { type: "application/zip" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Export network" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Network exported"));

    await act(async () => {
      staleReload.reject(new Error("stale reload"));
      try {
        await staleReload.promise;
      } catch {
        // expected in the mocked stale reload
      }
    });

    expect(screen.getByRole("status").textContent).toBe("Network exported");
    expect(screen.queryByText("Could not load datasets")).toBeNull();
  });

  it("closes Add Data and ignores its stale inspect when Generate routing starts", async () => {
    const venue = { ...VENUE, id: 42, slug: "venue", name: "Venue", hasNetwork: false };
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([venue]);
    const addDataNetwork = deferred<{ networkBlobHash: string; nodeCount: number; edgeCount: number; floors: string[] }>();
    inspectGdbNetwork.mockReturnValue(addDataNetwork.promise);
    const generation = deferred<{ jobId: string; versionId: number; seq: number }>();
    generateNetwork.mockReturnValue(generation.promise);

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Add routing / facilities" }));
    await user.upload(
      screen.getByLabelText("Add routing network"),
      new File([new Uint8Array([1])], "net.gdb.zip", { type: "application/zip" }),
    );
    await user.click(screen.getByRole("button", { name: "Generate routing" }));

    expect(screen.queryByRole("dialog", { name: "Add routing / facilities" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Generating routing…");
    await act(async () => {
      addDataNetwork.resolve({ networkBlobHash: "n".repeat(64), nodeCount: 120, edgeCount: 340, floors: ["1F"] });
      await addDataNetwork.promise;
    });
    expect(screen.queryByText(/120 nodes/)).toBeNull();
  });

  it("keeps stale export completion from downloading after Add Data opens", async () => {
    const venue = { ...VENUE, id: 42, slug: "venue", name: "Venue", hasGraph: true };
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([venue]);
    const exported = deferred<{ blob: Blob; filename: string }>();
    exportNetwork.mockReturnValue(exported.promise);
    const createObjectURL = vi.fn(() => "blob:mock");
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Export network" }));
    await user.click(screen.getByRole("button", { name: "Add routing / facilities" }));
    expect(screen.getByRole("dialog", { name: "Add routing / facilities" })).toBeTruthy();

    await act(async () => {
      exported.resolve({
        blob: new Blob([new Uint8Array([1])], { type: "application/zip" }),
        filename: "network.gdb.zip",
      });
      await exported.promise;
    });

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Add routing / facilities" })).toBeTruthy();
  });

  it("session-expiry reload invalidates a pending export before it can download", async () => {
    const venue = { ...VENUE, id: 42, slug: "venue", name: "Venue", hasGraph: true };
    me
      .mockResolvedValueOnce({ id: 1, username: "daniel", role: "admin" })
      .mockResolvedValueOnce(null);
    listVenues.mockResolvedValue([venue]);
    deleteVenue.mockResolvedValue(undefined);
    const exported = deferred<{ blob: Blob; filename: string }>();
    exportNetwork.mockReturnValue(exported.promise);
    const createObjectURL = vi.fn(() => "blob:mock");
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Export network" }));
    await user.click(screen.getByRole("button", { name: "Delete: Venue" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Delete dataset" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Sign in to Kiriko" })).toBeTruthy());

    await act(async () => {
      exported.resolve({
        blob: new Blob([new Uint8Array([1])], { type: "application/zip" }),
        filename: "network.gdb.zip",
      });
      await exported.promise;
    });

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Sign in to Kiriko" })).toBeTruthy();
  });

  it("keeps an authoritative session-expiry reload while a GDB flow starts", async () => {
    const venue = { ...VENUE, id: 42, slug: "venue", name: "Venue" };
    const expiringMe = deferred<null>();
    me.mockResolvedValueOnce({ id: 1, username: "daniel", role: "admin" }).mockReturnValueOnce(expiringMe.promise);
    listVenues.mockResolvedValue([venue]);
    deleteVenue.mockResolvedValue(undefined);
    inspectGdb.mockResolvedValue({ blobHash: "b".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Delete: Venue" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Delete dataset" })).getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Import Geodatabase" }));
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File([new Uint8Array([1])], "venue.gdb.zip", { type: "application/zip" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());

    await act(async () => {
      expiringMe.resolve(null);
      await expiringMe.promise;
    });

    expect(screen.getByRole("dialog", { name: "Sign in to Kiriko" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Review GDB layer mappings" })).toBeNull();
  });

  it("applies an authoritative reload success without closing an active GDB flow", async () => {
    const venue = { ...VENUE, id: 42, slug: "venue", name: "Venue" };
    const updated = { ...VENUE, id: 43, slug: "updated", name: "Updated Venue" };
    const reloadedVenues = deferred<VenueSummary[]>();
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValueOnce([venue]).mockReturnValueOnce(reloadedVenues.promise);
    deleteVenue.mockResolvedValue(undefined);
    inspectGdb.mockResolvedValue({ blobHash: "b".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Delete: Venue" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Delete dataset" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Import Geodatabase" }));
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File([new Uint8Array([1])], "venue.gdb.zip", { type: "application/zip" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());

    await act(async () => {
      reloadedVenues.resolve([updated]);
      await reloadedVenues.promise;
    });

    expect(screen.getByText("Updated Venue")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
  });

  it("keeps a background reload rejection non-fatal on a ready page", async () => {
    const venue = { ...VENUE, id: 42, slug: "venue", name: "Venue" };
    const reloadedVenues = deferred<VenueSummary[]>();
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValueOnce([venue]).mockReturnValueOnce(reloadedVenues.promise);
    deleteVenue.mockResolvedValue(undefined);

    const user = userEvent.setup();
    render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Delete: Venue" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Delete dataset" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));

    await act(async () => {
      reloadedVenues.reject(new Error("background reload"));
      try {
        await reloadedVenues.promise;
      } catch {
        // expected in the mocked background reload
      }
    });

    expect(screen.getByText("Venue")).toBeTruthy();
    expect(screen.queryByText("Could not load datasets")).toBeNull();
  });

  it("refreshes after an old publish job finishes without touching a newer GDB flow", async () => {
    const refreshed = { ...VENUE, id: 43, slug: "refreshed", name: "Refreshed Venue" };
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValueOnce([]).mockResolvedValue([refreshed]);
    inspectGdb
      .mockResolvedValueOnce({ blobHash: "a".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan })
      .mockResolvedValueOnce({ blobHash: "b".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });
    createVenue.mockResolvedValue({ id: 9, slug: "station", name: "Station", createdAt: "" });
    publishGdb.mockResolvedValue({ jobId: "old-publish", versionId: 1, seq: 1, excludedLayers: [] });
    const oldJob = deferred<{ status: "done" }>();
    waitForJob.mockReturnValue(oldJob.promise);

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("データセットがありません")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([1])], "old.gdb.zip", { type: "application/zip" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(waitForJob).toHaveBeenCalledWith("old-publish"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Import Geodatabase" }));
    await user.upload(input, new File([new Uint8Array([2])], "new.gdb.zip", { type: "application/zip" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());

    await act(async () => {
      oldJob.resolve({ status: "done" });
      await oldJob.promise;
    });

    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Refreshed Venue")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("refreshes after an old generate job finishes without touching a newer GDB flow", async () => {
    const venue = { ...VENUE, id: 42, slug: "venue", name: "Venue", hasNetwork: false };
    const refreshed = { ...venue, name: "Generated Fresh" };
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValueOnce([venue]).mockResolvedValue([refreshed]);
    generateNetwork.mockResolvedValue({ jobId: "old-generate", versionId: 2, seq: 2 });
    const oldJob = deferred<{ status: "done" }>();
    waitForJob.mockReturnValue(oldJob.promise);
    inspectGdb.mockResolvedValue({ blobHash: "b".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Generate routing" }));
    await waitFor(() => expect(waitForJob).toHaveBeenCalledWith("old-generate"));
    await user.click(screen.getByRole("button", { name: "Import Geodatabase" }));
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File([new Uint8Array([1])], "venue.gdb.zip", { type: "application/zip" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());

    await act(async () => {
      oldJob.resolve({ status: "done" });
      await oldJob.promise;
    });

    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Generated Fresh")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("refreshes after an old augment job error without overwriting a newer GDB flow", async () => {
    const venue = { ...VENUE, id: 42, slug: "venue", name: "Venue" };
    const refreshed = { ...venue, name: "Augment Reconciled" };
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValueOnce([venue]).mockResolvedValue([refreshed]);
    inspectGdbNetwork.mockResolvedValue({ networkBlobHash: "n".repeat(64), nodeCount: 120, edgeCount: 340, floors: ["1F"] });
    augmentGdb.mockResolvedValue({ jobId: "old-augment", versionId: 2, seq: 2 });
    const oldJob = deferred<{ status: "error"; error: string }>();
    waitForJob.mockReturnValue(oldJob.promise);
    inspectGdb.mockResolvedValue({ blobHash: "b".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("Venue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Add routing / facilities" }));
    await user.upload(screen.getByLabelText("Add routing network"), new File([new Uint8Array([1])], "net.gdb.zip", { type: "application/zip" }));
    await waitFor(() => expect(screen.getByText(/120 nodes/)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(waitForJob).toHaveBeenCalledWith("old-augment"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Import Geodatabase" }));
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File([new Uint8Array([2])], "venue.gdb.zip", { type: "application/zip" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());

    await act(async () => {
      oldJob.resolve({ status: "error", error: "failed" });
      await oldJob.promise;
    });

    await waitFor(() => expect(listVenues).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Augment Reconciled")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not orphan-clean a create-mode venue after publish returns a job id and polling rejects", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([]);
    inspectGdb.mockResolvedValue({ blobHash: "a".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });
    createVenue.mockResolvedValue({ id: 9, slug: "station", name: "Station", createdAt: "" });
    publishGdb.mockResolvedValue({ jobId: "accepted", versionId: 1, seq: 1, excludedLayers: [] });
    const acceptedJob = deferred<never>();
    waitForJob.mockReturnValue(acceptedJob.promise);

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("データセットがありません")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File([new Uint8Array([1])], "venue.gdb.zip", { type: "application/zip" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(waitForJob).toHaveBeenCalledWith("accepted"));

    await act(async () => {
      acceptedJob.reject({ code: "gdb_conversion_failed", message: "poll failed" });
      try {
        await acceptedJob.promise;
      } catch {
        // expected in the mocked polling failure
      }
    });

    expect(deleteVenue).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });

  it("still orphan-cleans a create-mode venue when publish fails before accepting a job", async () => {
    me.mockResolvedValue({ id: 1, username: "daniel", role: "admin" });
    listVenues.mockResolvedValue([]);
    inspectGdb.mockResolvedValue({ blobHash: "a".repeat(64), inspection: gdbInspection, suggestedPlan: gdbPlan });
    createVenue.mockResolvedValue({ id: 9, slug: "station", name: "Station", createdAt: "" });
    publishGdb.mockRejectedValue({ code: "gdb_conversion_failed", message: "publish failed" });

    const user = userEvent.setup();
    const { container } = render(<GalleryPage />);
    await waitFor(() => expect(screen.getByText("データセットがありません")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File([new Uint8Array([1])], "venue.gdb.zip", { type: "application/zip" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(deleteVenue).toHaveBeenCalledWith(9));
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
