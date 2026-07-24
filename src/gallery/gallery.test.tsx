import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

afterEach(() => {
  vi.clearAllMocks();
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
