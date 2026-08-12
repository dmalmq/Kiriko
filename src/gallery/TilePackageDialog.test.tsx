import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TilePackageDialog } from "./TilePackageDialog";
import type * as ApiModule from "./api";
import { TileApiError } from "./api";
import type {
  TileEvaluationResult,
  TilePackageAccepted,
  TilePackageListEntry,
  TileRegistrationReport,
} from "./tileTypes";

const listTilePackages = vi.fn<(venueId: number) => Promise<TilePackageListEntry[]>>();
const uploadTilePackage =
  vi.fn<
    (venueId: number, file: File, onProgress: (fraction: number) => void) => Promise<TilePackageAccepted>
  >();
const evaluateTilePackage =
  vi.fn<(venueId: number, packageId: number, body: unknown) => Promise<TileEvaluationResult>>();
const activateTilePackage =
  vi.fn<
    (
      venueId: number,
      packageId: number,
      mappingConfirmed: boolean,
    ) => Promise<{ jobId: string; versionId: number; seq: number }>
  >();
const discardTilePackage = vi.fn<(venueId: number, packageId: number) => Promise<void>>();
const waitForJob = vi.fn<(jobId: string) => Promise<{ status: string; message?: string }>>();

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof ApiModule>("./api");
  return {
    ...actual,
    api: {
      listTilePackages: (venueId: number) => listTilePackages(venueId),
      uploadTilePackage: (venueId: number, file: File, onProgress: (fraction: number) => void) =>
        uploadTilePackage(venueId, file, onProgress),
      evaluateTilePackage: (venueId: number, packageId: number, body: unknown) =>
        evaluateTilePackage(venueId, packageId, body),
      activateTilePackage: (venueId: number, packageId: number, mappingConfirmed: boolean) =>
        activateTilePackage(venueId, packageId, mappingConfirmed),
      discardTilePackage: (venueId: number, packageId: number) =>
        discardTilePackage(venueId, packageId),
      waitForJob: (jobId: string) => waitForJob(jobId),
    },
  };
});

const LEVEL_B1 = "b1000001-0000-4000-8000-0000000000b1";

function report(overrides: Partial<TileRegistrationReport> = {}): TileRegistrationReport {
  return {
    profileId: "default",
    profileVersion: 1,
    appliedVerticalOffsetM: 0,
    venueWide: { samples: 1920, p50M: 0.23, p90M: 0.501, maxM: 5.23 },
    floors: [
      {
        canonicalLevelId: LEVEL_B1,
        compositeSourceLevels: ["asset#doc#link#B1#-30"],
        sampled: 600,
        carvedOut: 12,
        stats: { samples: 600, p50M: 0.23, p90M: 0.501, maxM: 5.23 },
        medianOffsetM: [0.18, -0.07],
        medianShiftM: 0.194,
        coherentClusters: [],
      },
    ],
    levels: [
      {
        compositeId: "asset#doc#link#B1#-30",
        sourceDocument: "JRTokyoSta_B1",
        sourceLinkName: "B1F",
        levelKey: "B1",
        levelName: "B1F Yaesu",
        quantizedElevationDm: -30,
        metadataElevationM: -3.0,
        resolvedPlaneM: -6.02,
        metadataDifferenceM: 3.02,
        surfaceTriangles: 4211,
        sourceObjectIds: ["obj-1"],
        opaqueSourceObjectIds: ["obj-9"],
        mappedCanonicalLevelId: LEVEL_B1,
        mappedFloorPlaneM: -6.0,
      },
    ],
    unmappedLevels: [],
    ambiguousLevels: [],
    ...overrides,
  };
}

function accepted(): TilePackageAccepted {
  return {
    packageId: 7,
    sourceHash: "a".repeat(64),
    rootTileset: "tileset.json",
    assetVersions: ["1.1"],
    extensions: ["EXT_structural_metadata"],
    ignored: ["notes.txt"],
    totalBytes: 179_945_088,
    members: [
      { path: "tileset.json", hash: "b".repeat(64), byteSize: 512, contentType: "application/json", kind: "tileset", reused: false },
      { path: "content.glb", hash: "c".repeat(64), byteSize: 179_944_576, contentType: "model/gltf-binary", kind: "content", reused: true },
    ],
  };
}

function listed(overrides: Partial<TilePackageListEntry> = {}): TilePackageListEntry {
  return {
    packageId: 7,
    sourceHash: "a".repeat(64),
    rootTileset: "tileset.json",
    assetVersions: ["1.1"],
    extensions: [],
    ignored: [],
    totalBytes: 179_945_088,
    memberCount: 2,
    createdAt: "2026-08-10 04:58:10",
    evaluation: null,
    serving: false,
    ...overrides,
  };
}

function open(locale: "ja" | "en" = "en") {
  return render(
    <TilePackageDialog
      locale={locale}
      venueId={3}
      venueName="Tokyo Station"
      onClose={() => {}}
      onActivated={() => {}}
    />,
  );
}

beforeEach(() => {
  listTilePackages.mockResolvedValue([]);
  uploadTilePackage.mockResolvedValue(accepted());
  evaluateTilePackage.mockResolvedValue({
    state: "evaluated",
    report: report(),
    floorMappings: [[LEVEL_B1, ["asset#doc#link#B1#-30"]]],
    gates: [],
  });
  activateTilePackage.mockResolvedValue({ jobId: "job-1", versionId: 12, seq: 3 });
  waitForJob.mockResolvedValue({ status: "done" });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function uploadAPackage(): Promise<void> {
  const user = userEvent.setup();
  const input = screen.getByLabelText("Choose a 3D Tiles package");
  await user.upload(input, new File(["tiles"], "tiles.zip", { type: "application/zip" }));
  await waitFor(() => expect(uploadTilePackage).toHaveBeenCalled());
}

describe("TilePackageDialog", () => {
  it("asks for a package when the venue has none", async () => {
    open();

    await waitFor(() => expect(listTilePackages).toHaveBeenCalledWith(3));
    expect(screen.getByLabelText("Choose a 3D Tiles package")).toBeTruthy();
  });

  it("reports what ingestion accepted, including entries it ignored", async () => {
    // An ignored entry is usually an export mistake, so naming it is the point:
    // the graph never references it and it was never stored.
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());

    await uploadAPackage();

    await waitFor(() => expect(screen.getByText("tileset.json")).toBeTruthy());
    expect(screen.getByText(/notes\.txt/)).toBeTruthy();
    expect(screen.getByText(/EXT_structural_metadata/)).toBeTruthy();
    // 172 MiB, in the unit a producer recognises rather than raw bytes.
    expect(screen.getByText(/171\.6 MiB|179,945,088/)).toBeTruthy();
  });

  it("resumes a package the venue already holds, without a re-upload", async () => {
    // The whole reason the list route exists: a reload must not orphan 172 MiB.
    listTilePackages.mockResolvedValue([
      listed({
        evaluation: {
          state: "evaluated",
          current: true,
          capabilityProfile: "webgl2-mrt-float",
          profileId: "default",
          profileVersion: 1,
          report: report(),
          gates: [],
          evaluatedAt: "2026-08-10 05:00:00",
          activatedAt: null,
        },
      }),
    ]);

    open();

    await waitFor(() => expect(screen.getByRole("button", { name: "Activate" })).toBeTruthy());
    expect(uploadTilePackage).not.toHaveBeenCalled();
  });

  it("will not activate until the producer confirms the floor mapping", async () => {
    // The gates cannot establish the mapping: a stack a storey out measures small
    // residuals against the wrong floor. So a passing evaluation is necessary and
    // not sufficient, and the confirmation is the missing piece.
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Measure registration" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Activate" })).toBeTruthy());

    expect(screen.getByRole("button", { name: "Activate" })).toHaveProperty("disabled", true);
    await user.click(screen.getByLabelText(/I have checked the floor/));
    expect(screen.getByRole("button", { name: "Activate" })).toHaveProperty("disabled", false);
  });

  it("withdraws a confirmation when the mapping is measured again", async () => {
    // A confirmation is about one mapping table. Re-measuring with a different
    // offset produces a different one, and carrying the tick across would mean
    // the producer had confirmed a table they never saw.
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Measure registration" }));
    await waitFor(() => expect(screen.getByLabelText(/I have checked the floor/)).toBeTruthy());
    await user.click(screen.getByLabelText(/I have checked the floor/));
    expect(screen.getByRole("button", { name: "Activate" })).toHaveProperty("disabled", false);

    await user.click(screen.getByRole("button", { name: "Measure again" }));

    await waitFor(() => expect(evaluateTilePackage).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText(/I have checked the floor/)).toHaveProperty("checked", false);
    expect(screen.getByRole("button", { name: "Activate" })).toHaveProperty("disabled", true);
  });

  it("shows each level beside the floor it mapped to and the gap between them", async () => {
    // The join a producer would otherwise make across two tables, and the one
    // geometry cannot make for them.
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Measure registration" }));

    const mapping = await waitFor(() =>
      screen.getByRole("table", { name: "Level to floor mapping" }),
    );
    // The level's own plane, the floor's own plane, and what separates them.
    expect(within(mapping).getByText("-6.02")).toBeTruthy();
    expect(within(mapping).getByText("-6.00")).toBeTruthy();
    expect(within(mapping).getByText(LEVEL_B1)).toBeTruthy();
    expect(within(mapping).getByText("0.02")).toBeTruthy();
  });

  it("measures the gap against the plane the offset placed, not the raw one", async () => {
    // Otherwise the offset itself prints as a discrepancy — a −54 m gap beside a
    // floor the level lands exactly on — and the column a producer is here to
    // read becomes the one they learn to ignore.
    evaluateTilePackage.mockResolvedValue({
      state: "evaluated",
      report: report({
        appliedVerticalOffsetM: -54,
        levels: [
          {
            ...report().levels[0]!,
            resolvedPlaneM: 50,
            mappedCanonicalLevelId: LEVEL_B1,
            mappedFloorPlaneM: -4,
          },
        ],
      }),
      floorMappings: [],
      gates: [],
    });
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Measure registration" }));

    const mapping = await waitFor(() =>
      screen.getByRole("table", { name: "Level to floor mapping" }),
    );
    // -4 − (50 + −54) = 0: the level lands on the floor it was matched to.
    expect(within(mapping).getByText("0.00")).toBeTruthy();
    expect(within(mapping).queryByText("-54.00")).toBeNull();
  });

  it("prints the venue-wide residuals and each floor's own numbers", async () => {
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Measure registration" }));

    const venueWide = await waitFor(() => screen.getByRole("table", { name: "Venue-wide" }));
    expect(within(venueWide).getByText("1,920")).toBeTruthy();
    const floors = screen.getByRole("table", { name: "Floors" });
    expect(within(floors).getByText("0.50")).toBeTruthy();
    expect(within(floors).getByText("0.19")).toBeTruthy();
    expect(within(floors).getByText(LEVEL_B1)).toBeTruthy();
  });

  it("shows a level's resolved plane beside the elevation its metadata claimed", async () => {
    // #31's finding, in front of the person who exported it: the mesh says
    // -6.02 m where the metadata says -3.00 m, and the mesh is what renders.
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Measure registration" }));

    const levels = await waitFor(() =>
      screen.getByRole("table", { name: "Level to floor mapping" }),
    );
    expect(within(levels).getByText("-6.02")).toBeTruthy();
    expect(within(levels).getByText("-3.00")).toBeTruthy();
    expect(within(levels).getByText("3.02")).toBeTruthy();
  });

  it("blocks activation on a gate and says what the gate measured", async () => {
    evaluateTilePackage.mockResolvedValue({
      state: "evaluated",
      report: report(),
      floorMappings: [],
      gates: [{ code: "registrationOutOfBand", subject: LEVEL_B1, measured: 0.92, band: 0.5 }],
    });
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Measure registration" }));

    await waitFor(() =>
      expect(screen.getByText(/further from the venue geometry/)).toBeTruthy(),
    );
    expect(screen.getByText(/0\.92 m against 0\.50 m/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Activate" })).toHaveProperty("disabled", true);
  });

  it("sends the vertical offset the producer typed when measuring again", async () => {
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Measure registration" }));
    await waitFor(() => expect(screen.getByLabelText("Vertical offset (m)")).toBeTruthy());

    await user.clear(screen.getByLabelText("Vertical offset (m)"));
    await user.type(screen.getByLabelText("Vertical offset (m)"), "-3.02");
    await user.click(screen.getByRole("button", { name: "Measure again" }));

    await waitFor(() => expect(evaluateTilePackage).toHaveBeenCalledTimes(2));
    const body = evaluateTilePackage.mock.calls[1]?.[2] as { profile?: { verticalOffsetM?: number } };
    expect(body.profile?.verticalOffsetM).toBe(-3.02);
  });

  it("sends a widened band only for the floor whose band was edited", async () => {
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Measure registration" }));
    const band = await waitFor(() => screen.getByLabelText(`p90 band for ${LEVEL_B1} (m)`));

    await user.clear(band);
    await user.type(band, "0.95");
    await user.click(screen.getByRole("button", { name: "Measure again" }));

    await waitFor(() => expect(evaluateTilePackage).toHaveBeenCalledTimes(2));
    const body = evaluateTilePackage.mock.calls[1]?.[2] as {
      profile?: { floorP90MaxM?: Record<string, number> };
    };
    expect(body.profile?.floorP90MaxM).toEqual({ [LEVEL_B1]: 0.95 });
  });

  it("classifies an opaque object as context when the producer says so", async () => {
    evaluateTilePackage.mockResolvedValue({
      state: "evaluated",
      report: report(),
      floorMappings: [],
      gates: [{ code: "unclassifiedOpaqueContent", subject: "obj-9", measured: null, band: null }],
    });
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Measure registration" }));
    const checkbox = await waitFor(() => screen.getByLabelText("Treat obj-9 as context"));

    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Measure again" }));

    await waitFor(() => expect(evaluateTilePackage).toHaveBeenCalledTimes(2));
    const body = evaluateTilePackage.mock.calls[1]?.[2] as { contextualSourceObjects?: string[] };
    expect(body.contextualSourceObjects).toEqual(["obj-9"]);
  });

  it("activates a gate-passing package and waits for the version it publishes", async () => {
    const onActivated = vi.fn();
    render(
      <TilePackageDialog
        locale="en"
        venueId={3}
        venueName="Tokyo Station"
        onClose={() => {}}
        onActivated={onActivated}
      />,
    );
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Measure registration" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Activate" })).toBeTruthy());
    await user.click(screen.getByLabelText(/I have checked the floor/));

    await user.click(screen.getByRole("button", { name: "Activate" }));

    await waitFor(() => expect(activateTilePackage).toHaveBeenCalledWith(3, 7, true));
    await waitFor(() => expect(waitForJob).toHaveBeenCalledWith("job-1"));
    await waitFor(() => expect(onActivated).toHaveBeenCalled());
  });

  it("renders the gates a blocked activation reports, not a bare failure", async () => {
    activateTilePackage.mockRejectedValue(
      new TileApiError(409, "activation_blocked", [
        { code: "levelNotMapped", subject: "asset#doc#link#3F#120", measured: null, band: null },
      ]),
    );
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Measure registration" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Activate" })).toBeTruthy());
    await user.click(screen.getByLabelText(/I have checked the floor/));

    await user.click(screen.getByRole("button", { name: "Activate" }));

    await waitFor(() =>
      expect(screen.getByText(/No venue floor corresponds to this level/)).toBeTruthy(),
    );
  });

  it("never prints an unmeasured registration as a clean one", async () => {
    // Zero samples renders as a row of 0.00 m, which reads exactly like perfect
    // agreement. Nothing mapped, so nothing was measured, and the gate says why.
    evaluateTilePackage.mockResolvedValue({
      state: "evaluated",
      report: report({
        venueWide: null,
        floors: [],
        unmappedLevels: ["asset#doc#link#B1#-30"],
      }),
      floorMappings: [],
      gates: [
        { code: "levelNotMapped", subject: "asset#doc#link#B1#-30", measured: null, band: null },
      ],
    });
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Measure registration" }));

    await waitFor(() =>
      expect(screen.getByText(/No floor was mapped, so no residuals/)).toBeTruthy(),
    );
    expect(screen.queryByRole("table", { name: "Venue-wide" })).toBeNull();
    // The gate already names the level in a sentence that says what to do, so
    // the bare id list above it would be the same fact in two voices.
    expect(screen.queryByText(/^Levels no venue floor corresponds to/)).toBeNull();
  });

  it("confirms the offset the profile actually applied", async () => {
    evaluateTilePackage.mockResolvedValue({
      state: "evaluated",
      report: report({ appliedVerticalOffsetM: -54 }),
      floorMappings: [],
      gates: [],
    });
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Measure registration" }));

    await waitFor(() =>
      expect(screen.getByText(/Applied vertical offset: -54\.00 m/)).toBeTruthy(),
    );
  });

  it("explains an unpublished venue instead of offering a retry", async () => {
    // Registration measures against the venue's own canonical geometry, and
    // there is none yet. Retrying cannot change that.
    evaluateTilePackage.mockRejectedValue(new TileApiError(409, "no_published_version"));
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Measure registration" }));

    await waitFor(() =>
      expect(screen.getByText(/Publish IMDF or GDB first/)).toBeTruthy(),
    );
  });

  it("refuses to activate a stale evaluation and says to measure again", async () => {
    listTilePackages.mockResolvedValue([
      listed({
        evaluation: {
          state: "evaluated",
          current: false,
          capabilityProfile: "webgl2-mrt-float",
          profileId: "default",
          profileVersion: 1,
          report: report(),
          gates: [],
          evaluatedAt: "2026-08-10 05:00:00",
          activatedAt: null,
        },
      }),
    ]);

    open();

    await waitFor(() => expect(screen.getByText(/venue has published since/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Activate" })).toHaveProperty("disabled", true);
  });

  it("names every unmapped level rather than quietly dropping it", async () => {
    evaluateTilePackage.mockResolvedValue({
      state: "evaluated",
      report: report({ unmappedLevels: ["asset#doc#link#3F#120"] }),
      floorMappings: [],
      gates: [],
    });
    open();
    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    await uploadAPackage();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Measure registration" }));

    await waitFor(() => expect(screen.getByText(/asset#doc#link#3F#120/)).toBeTruthy());
  });

  it("labels the flow in Japanese", async () => {
    open("ja");

    await waitFor(() => expect(listTilePackages).toHaveBeenCalled());
    expect(screen.getByLabelText("3D タイルパッケージを選択")).toBeTruthy();
  });
});
