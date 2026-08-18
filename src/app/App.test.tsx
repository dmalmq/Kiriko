import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndoorMapProps } from "../map/IndoorMap";
import type * as FetchImdfArchiveModule from "../imdf/fetchImdfArchive";
import type * as GalleryApiModule from "../gallery/api";
import type * as IssueApiModule from "../issues/api";
import type {
  LoadedVenue,
  SearchEntry,
  ViewerFeature,
  ViewerLevel,
  ViewerWarning,
} from "../imdf/types";
import { VenueLoadError, venueLoadErrorCopy } from "../errors/VenueLoadError";
import type { KirikoBundleLoadResult } from "../bundle/loadKirikoBundle";
import type { ApiUser } from "../gallery/api";
import { api } from "../gallery/api";
import { IssueApiError } from "../issues/api";
import type {
  CreateIssueInput,
  IssueCollection,
  ReviewIssue,
  ReviewerSummary,
} from "../issues/types";
import type { SceneCapabilityReport } from "../map/scene/sceneCapability";


const LEVEL_2F: ViewerLevel = {
  id: "b1000003-0000-4000-8000-00000000002f",
  ordinal: 1,
  label: { ja: "2F", en: "2F" },
  shortName: { ja: "2F", en: "2F" },
};

const LEVEL_1F: ViewerLevel = {
  id: "b1000002-0000-4000-8000-00000000001f",
  ordinal: 0,
  label: { ja: "1F", en: "1F" },
  shortName: { ja: "1F", en: "1F" },
};

const LEVELS: ViewerLevel[] = [LEVEL_2F, LEVEL_1F];

const VENUE_FEATURE: ViewerFeature = {
  id: "a1000001-0000-4000-8000-000000000001",
  featureType: "venue",
  levelId: null,
  geometry: null,
  center: [139.767, 35.681],
  labels: { ja: "テスト駅", en: "Test Station" },
  altLabels: {},
  category: null,
  accessibility: [],
  restriction: null,
  sourceProperties: {},
};

const SHOP_FEATURE: ViewerFeature = {
  id: "a1000008-0000-4000-8000-0000000000c1",
  featureType: "occupant",
  levelId: LEVEL_1F.id,
  geometry: { type: "Point", coordinates: [139.7671, 35.6811] },
  center: [139.7671, 35.6811],
  labels: { ja: "駅ナカショップ", en: "Station Shop" },
  altLabels: { ja: "テストストア", en: "Test Store" },
  category: "shopping",
  accessibility: [],
  restriction: null,
  sourceProperties: { hours: "Mo-Fr 10:00-20:00" },
};

const NULL_LEVEL_AMENITY: ViewerFeature = {
  id: "e1000001-0000-4000-8000-0000000000a1",
  featureType: "amenity",
  levelId: null,
  geometry: { type: "Point", coordinates: [139.7672, 35.6812] },
  center: [139.7672, 35.6812],
  labels: { ja: "トイレ", en: "Restroom" },
  altLabels: {},
  category: "restroom",
  accessibility: ["wheelchair"],
  restriction: null,
  sourceProperties: {},
};

const NULL_CENTER_FEATURE: ViewerFeature = {
  id: "a1000009-0000-4000-8000-0000000000c2",
  featureType: "occupant",
  levelId: null,
  geometry: null,
  center: null,
  labels: { en: "Dangling Shop" },
  altLabels: {},
  category: "shopping",
  accessibility: [],
  restriction: null,
  sourceProperties: {},
};

function entryFor(feature: ViewerFeature): SearchEntry {
  const labels = Object.values(feature.labels);
  const altLabels = Object.values(feature.altLabels);
  return {
    featureId: feature.id,
    featureType: feature.featureType,
    levelId: feature.levelId,
    category: feature.category,
    labels: feature.labels,
    altLabels: feature.altLabels,
    normalizedLabels: labels.map((value) => value.normalize("NFKC").toLowerCase().trim()),
    normalizedAltLabels: altLabels.map((value) => value.normalize("NFKC").toLowerCase().trim()),
    normalizedCategory: (feature.category ?? "").normalize("NFKC").toLowerCase().trim(),
  };
}

const WARNINGS: ViewerWarning[] = [
  {
    code: "missing_locale",
    message: "Feature lacks English label",
    featureId: "c1000002-0000-4000-8000-0000000000b2",
  },
];

function buildMinimalVenue(overrides?: Partial<LoadedVenue>): LoadedVenue {
  const featuresById = new Map<string, ViewerFeature>([
    [VENUE_FEATURE.id, VENUE_FEATURE],
    [SHOP_FEATURE.id, SHOP_FEATURE],
    [NULL_LEVEL_AMENITY.id, NULL_LEVEL_AMENITY],
    [NULL_CENTER_FEATURE.id, NULL_CENTER_FEATURE],
  ]);
  const emptyCollection: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  return {
    manifest: { version: "1.0.0", language: "ja-JP" },
    venue: VENUE_FEATURE,
    levels: LEVELS,
    featuresById,
    renderFeaturesByLevel: new Map([
      [LEVEL_1F.id, emptyCollection],
      [LEVEL_2F.id, emptyCollection],
    ]),
    searchEntries: [entryFor(SHOP_FEATURE), entryFor(NULL_LEVEL_AMENITY), entryFor(NULL_CENTER_FEATURE)],
    boundsByLevel: new Map([
      [LEVEL_1F.id, [139.766, 35.68, 139.768, 35.682]],
      [LEVEL_2F.id, [139.766, 35.68, 139.768, 35.682]],
    ]),
    warnings: WARNINGS,
    ...overrides,
  };
}

const PUBLIC_VERSION_ID = "a".repeat(64);
const DEFAULT_SEQ = 42;

function bundleLoadResult(
  venue = buildMinimalVenue(),
  publicVersionId: string | null = PUBLIC_VERSION_ID,
  hasGraph = false,
  hasFacilities = false,
  facilities: KirikoBundleLoadResult["facilities"] = [],
  seq: number | null = DEFAULT_SEQ,
): KirikoBundleLoadResult {
  return {
    venue,
    metadata: { datasetId: "default/tokyo-station", version: 7 },
    publicVersionId,
    seq,
    hasGraph,
    hasFacilities,
    facilities,
    networkQa: null,
  };
}


const loadImdfArchiveMock = vi.fn();

vi.mock("../imdf/loadImdfArchive", () => ({
  loadImdfArchive: (...args: unknown[]) => loadImdfArchiveMock(...args),
}));

const loadKirikoBundleMock = vi.fn();
const loadNetworkOverlayMock = vi.fn();

vi.mock("../bundle/loadKirikoBundle", () => ({
  loadKirikoBundle: (...args: unknown[]) => loadKirikoBundleMock(...args),
}));

vi.mock("../bundle/loadNetworkOverlay", () => ({
  loadNetworkOverlay: (...args: unknown[]) => loadNetworkOverlayMock(...args),
}));

const loadKirikoSceneMock = vi.fn();
const readSceneMock = vi.fn((described: { meta: string }) => ({ testId: described.meta }));
const probeSceneCapabilityMock = vi.fn<() => SceneCapabilityReport>(() => ({
  supported: false,
  missing: ["webgl2"],
}));

vi.mock("../bundle/loadKirikoScene", () => ({
  loadKirikoScene: (...args: unknown[]) => loadKirikoSceneMock(...args),
}));

vi.mock("../map/scene/sceneFormat", () => ({
  readScene: (...args: [{ meta: string }]) => readSceneMock(...args),
}));

vi.mock("../map/scene/sceneCapability", () => ({
  probeSceneCapability: () => probeSceneCapabilityMock(),
}));

const routeKirikoBundleMock = vi.fn();

vi.mock("../bundle/routeKirikoBundle", () => ({
  routeKirikoBundle: (...args: unknown[]) => routeKirikoBundleMock(...args),
}));

const walkableChordMock = vi.fn(() => true);
const proposeNetworkPathsMock = vi.fn();

vi.mock("../bundle/wasm", () => ({
  initKirikoWasm: async () => undefined,
  walkableChord: (...args: unknown[]) => walkableChordMock(...args),
  proposeNetworkPaths: (...args: unknown[]) => proposeNetworkPathsMock(...args),
}));

const fetchImdfFileMock = vi.fn();

vi.mock("../imdf/fetchImdfArchive", async (importOriginal) => {
  const actual = await importOriginal<typeof FetchImdfArchiveModule>();
  return {
    fileNameFromSrc: actual.fileNameFromSrc,
    fetchImdfFile: (...args: unknown[]) => fetchImdfFileMock(...args),
  };
});

const meMock = vi.fn<() => Promise<ApiUser | null>>();
const loginMock = vi.fn<(username: string, password: string) => Promise<ApiUser>>();
const getIssuesMock = vi.fn<(publicId: string, signal: AbortSignal) => Promise<IssueCollection>>();
const listReviewersMock = vi.fn<() => Promise<ReviewerSummary[]>>();
const createIssueMock = vi.fn<(publicId: string, input: CreateIssueInput) => Promise<{
  revision: number;
  resourceId: string;
}>>();
const createReplyMock = vi.fn();
const patchIssueMock = vi.fn();
const patchReplyMock = vi.fn();
const deleteIssueMock = vi.fn();
const deleteReplyMock = vi.fn();

vi.mock("../gallery/api", async (importOriginal) => {
  const actual = await importOriginal<typeof GalleryApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      me: () => meMock(),
      login: (username: string, password: string) => loginMock(username, password),
    },
  };
});

vi.mock("../issues/api", async (importOriginal) => {
  const actual = await importOriginal<typeof IssueApiModule>();
  return {
    ...actual,
    issueApi: {
      ...actual.issueApi,
      getIssues: (publicId: string, signal: AbortSignal) => getIssuesMock(publicId, signal),
      listReviewers: () => listReviewersMock(),
      createIssue: (publicId: string, input: CreateIssueInput) =>
        createIssueMock(publicId, input),
      createReply: (...args: unknown[]) => createReplyMock(...args),
      patchIssue: (...args: unknown[]) => patchIssueMock(...args),
      patchReply: (...args: unknown[]) => patchReplyMock(...args),
      deleteIssue: (...args: unknown[]) => deleteIssueMock(...args),
      deleteReply: (...args: unknown[]) => deleteReplyMock(...args),
    },
  };
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, EventListener[]>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: "open" | "error" | "revision", revision?: number): void {
    const event =
      type === "revision"
        ? new MessageEvent<string>("revision", { data: JSON.stringify({ revision }) })
        : new Event(type);
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function resetIssueMocks(): void {
  meMock.mockReset().mockResolvedValue(null);
  loginMock.mockReset().mockResolvedValue({ id: 1, username: "daniel", role: "member" });
  getIssuesMock.mockReset().mockResolvedValue({ revision: 0, issues: [] });
  listReviewersMock.mockReset().mockResolvedValue([]);
  createIssueMock.mockReset().mockResolvedValue({ revision: 1, resourceId: "created-issue" });
  createReplyMock.mockReset().mockResolvedValue({ revision: 1, resourceId: "created-reply" });
  patchIssueMock.mockReset().mockResolvedValue({ revision: 1, resourceId: "issue-1" });
  patchReplyMock.mockReset().mockResolvedValue({ revision: 1, resourceId: "reply-1" });
  deleteIssueMock.mockReset().mockResolvedValue({ revision: 1, resourceId: "issue-1" });
  deleteReplyMock.mockReset().mockResolvedValue({ revision: 1, resourceId: "reply-1" });
  FakeEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
}

function makeIssue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    id: "issue-1",
    pinNumber: 1,
    rowVersion: 1,
    bodyMarkdown: "Check this location",
    anchor: {
      levelId: LEVEL_1F.id,
      longitude: 139.7671,
      latitude: 35.6811,
      featureId: SHOP_FEATURE.id,
    },
    status: "open",
    author: { id: 2, username: "reviewer" },
    assignee: null,
    dueDate: null,
    createdAt: "2026-07-18T10:00:00Z",
    updatedAt: "2026-07-18T10:00:00Z",
    deletedAt: null,
    replies: [],
    ...overrides,
  } as ReviewIssue;
}

function issueCollection(issues: ReviewIssue[], revision = 1): IssueCollection {
  return { revision, issues };
}

vi.mock("../map/IndoorMap", () => ({
  IndoorMap: function IndoorMapStub(props: IndoorMapProps) {
    const identityRef = useRef({ n: 1 });
    const firstPin = props.issueReview?.pins[0];
    const placementAnchor = {
      levelId: props.levelId,
      longitude: 139.7671,
      latitude: 35.6811,
      featureId: SHOP_FEATURE.id,
    };
    return (
      <div
        data-testid="indoor-map-stub"
        data-level-id={props.levelId}
        data-selected-feature-id={props.selectedFeatureId ?? ""}
        data-locale={props.locale}
        data-theme-id={props.theme.id}
        data-identity={identityRef.current.n}
        data-issue-pins={props.issueReview?.pins.map(({ id }) => id).join(",") ?? ""}
        data-issue-selected={props.issueReview?.selectedIssueId ?? ""}
        data-issue-feature={props.issueReview?.featureId ?? ""}
        data-issue-placement={String(props.issueReview?.placementMode === true)}
        data-camera-key={props.issueReview?.cameraRequest?.key ?? ""}
        data-camera-level={props.issueReview?.cameraRequest?.levelId ?? ""}
        data-camera-longitude={props.issueReview?.cameraRequest?.longitude ?? ""}
        data-camera-latitude={props.issueReview?.cameraRequest?.latitude ?? ""}
        data-directions-present={String(props.directions != null)}
        data-directions-active={String(props.directions?.active === true)}
        data-directions-origin={
          props.directions?.origin != null ? JSON.stringify(props.directions.origin) : ""
        }
        data-directions-destination={
          props.directions?.destination != null ? JSON.stringify(props.directions.destination) : ""
        }
        data-directions-route={
          props.directions?.route != null ? JSON.stringify(props.directions.route.segments) : ""
        }
        data-network-present={String(props.network != null)}
        data-network-path-count={String(props.network?.paths.length ?? 0)}
        data-network-editing={String(props.networkEditing != null)}
        data-network-tool={props.networkEditing?.tool ?? ""}
        data-network-selection={props.networkEditing?.selection?.kind ?? ""}
        data-scene-id={
          (props.scene as unknown as { testId?: string } | null)?.testId ?? ""
        }
      >
        <button
          type="button"
          onClick={() => {
            props.directions?.onPickPoint({ longitude: 139.7671, latitude: 35.6811 });
          }}
        >
          Tap map for directions
        </button>
        <button
          type="button"
          onClick={() => {
            props.onSelectFeature(SHOP_FEATURE.id);
          }}
        >
          Select shop from map
        </button>
        <button
          type="button"
          onClick={() => {
            props.onSelectFeature(null);
          }}
        >
          Clear map selection
        </button>
        {firstPin !== undefined && props.issueReview !== null ? (
          <button
            type="button"
            onClick={() => {
              props.issueReview?.onSelectIssue(firstPin.id);
            }}
          >
            Select first issue pin
          </button>
        ) : null}
        {props.issueReview?.placementMode === true ? (
          <>
            <button
              type="button"
              onClick={() => {
                props.issueReview?.onPlaceIssue(placementAnchor);
              }}
            >
              Place issue on feature
            </button>
            <button
              type="button"
              onClick={() => {
                props.issueReview?.onPlaceIssue(placementAnchor);
                props.issueReview?.onPlaceIssue(placementAnchor);
              }}
            >
              Place issue twice
            </button>
            <button
              type="button"
              onClick={() => {
                props.issueReview?.onPlaceIssue({
                  ...placementAnchor,
                  longitude: 139.765,
                  latitude: 35.68,
                  featureId: null,
                });
              }}
            >
              Place issue at map center
            </button>
          </>
        ) : null}
        {props.scene !== null ? (
          <button type="button" onClick={props.onSceneAttachFailed}>
            Fail scene attach
          </button>
        ) : null}
        {(props.network?.junctions ?? []).map((j) => {
          const id = j.properties.NODEID;
          if (typeof id !== "number") return null;
          return (
            <button
              key={`net-pick-${id}`}
              type="button"
              data-testid={`net-pick-${id}`}
              onClick={() => props.networkEditing?.onPick({ kind: "junction", nodeId: id })}
            >
              {`pick ${id}`}
            </button>
          );
        })}
        {props.networkEditing != null ? (
          <button
            type="button"
            data-testid="net-map-pick"
            onClick={() =>
              props.networkEditing?.onPick({ kind: "map", longitude: 139.702, latitude: 35.681 })
            }
          >
            net map pick
          </button>
        ) : null}
      </div>
    );
  },
}));

// Import after mocks so App sees the stubs.
import { App } from "./App";

function zipFile(name = "venue.zip"): File {
  return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name, {
    type: "application/zip",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  // Executor form required: tsconfig lib predates Promise.withResolvers.
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function collectNavigationEvents() {
  const hrefs: string[] = [];
  const onNavigate = (event: Event) => {
    if (event instanceof CustomEvent && typeof event.detail.href === "string") {
      hrefs.push(event.detail.href);
    }
    event.preventDefault();
  };
  window.addEventListener("kiriko:navigate", onNavigate);
  return {
    hrefs,
    stop: () => {
      window.removeEventListener("kiriko:navigate", onNavigate);
    },
  };
}

async function uploadViaHiddenInput(file: File): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).toBeTruthy();
  await userEvent.upload(input!, file);
}

async function renderDataset(
  publicVersionId: string | null = PUBLIC_VERSION_ID,
  venue: LoadedVenue = buildMinimalVenue(),
  hasGraph = false,
  seq: number | null = DEFAULT_SEQ,
) {
  loadKirikoBundleMock.mockResolvedValue(
    bundleLoadResult(venue, publicVersionId, hasGraph, false, [], seq),
  );
  window.history.replaceState(null, "", "/?dataset=tokyo-station&lang=en");
  const result = render(<App />);
  await waitFor(() => {
    expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
  });
  return result;
}

describe("App scene fallback", () => {
  beforeEach(() => {
    loadKirikoBundleMock.mockReset().mockResolvedValue(bundleLoadResult());
    loadKirikoSceneMock.mockReset();
    readSceneMock.mockClear();
    probeSceneCapabilityMock.mockReset().mockReturnValue({ supported: true, missing: [] });
    resetIssueMocks();
    window.history.replaceState(
      null,
      "",
      "/?dataset=tokyo-station&lang=en&scene=1",
    );
  });

  afterEach(() => {
    probeSceneCapabilityMock.mockReset().mockReturnValue({
      supported: false,
      missing: ["webgl2"],
    });
    window.history.replaceState(null, "", "/");
  });

  it("loads and mounts generated geometry when an activated tile scene cannot attach", async () => {
    loadKirikoSceneMock.mockImplementation(
      (_src: string, _signal: AbortSignal, source: "generated" | "package" = "generated") =>
        Promise.resolve({ meta: source, payload: new Uint8Array() }),
    );

    render(<App />);

    await screen.findByText("3D Tiles");
    expect(screen.getByTestId("indoor-map-stub").getAttribute("data-scene-id")).toBe(
      "package",
    );

    fireEvent.click(screen.getByRole("button", { name: "Fail scene attach" }));

    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub").getAttribute("data-scene-id")).toBe(
        "generated",
      );
    });
    expect(loadKirikoSceneMock.mock.calls.map((call) => call[2])).toEqual([
      "package",
      "generated",
    ]);
    expect(screen.getByText("Generated 3D")).toBeTruthy();
  });
});

describe("App", () => {
  beforeEach(() => {
    loadImdfArchiveMock.mockReset();
    loadKirikoBundleMock.mockReset();
    fetchImdfFileMock.mockReset();
    resetIssueMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reaches the Open IMDF ZIP control by Tab and triggers the hidden file input click", async () => {
    const user = userEvent.setup();
    render(<App />);

    const openButtons = screen.getAllByRole("button", { name: "IMDF ZIP を開く" });
    const openBtn = openButtons[0]!;
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeTruthy();
    const clickSpy = vi.spyOn(fileInput!, "click");

    openBtn.focus();
    expect(document.activeElement).toBe(openBtn);

    await user.keyboard("{Enter}");
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("announces loading then ready via aria-live and shows the venue", async () => {
    const venue = buildMinimalVenue();
    let resolveLoad: ((value: LoadedVenue) => void) | undefined;
    loadImdfArchiveMock.mockImplementation(
      () =>
        new Promise<LoadedVenue>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    render(<App />);
    const live = document.querySelector("[aria-live='polite']");
    expect(live).toBeTruthy();
    expect(live?.textContent).toContain("会場が未読み込みです");

    await uploadViaHiddenInput(zipFile("demo.zip"));

    await waitFor(() => {
      expect(live?.textContent).toContain("読み込み中");
      expect(live?.textContent).toContain("demo.zip");
    });

    resolveLoad?.(venue);

    await waitFor(() => {
      expect(live?.textContent).toContain("会場を読み込みました");
      expect(live?.textContent).toContain("demo.zip");
    });
    expect(screen.getByText("テスト駅")).toBeTruthy();
    expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    expect(loadImdfArchiveMock).toHaveBeenCalledWith(expect.any(File), expect.any(AbortSignal));
    expect(fetchImdfFileMock).not.toHaveBeenCalled();
    expect(loadKirikoBundleMock).not.toHaveBeenCalled();
    expect(getIssuesMock).not.toHaveBeenCalled();
    expect(meMock).not.toHaveBeenCalled();
    expect(listReviewersMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "課題" })).toBeNull();
  });
  it("routes dropped ZIP files only through the local archive loader", async () => {
    loadImdfArchiveMock.mockResolvedValue(buildMinimalVenue());
    render(<App />);
    const dropzone = document.querySelector(".imdf-dropzone");
    expect(dropzone).toBeTruthy();

    fireEvent.drop(dropzone!, {
      dataTransfer: { files: [zipFile("dropped.zip")], types: ["Files"] },
    });

    await waitFor(() => {
      expect(loadImdfArchiveMock).toHaveBeenCalledWith(expect.any(File), expect.any(AbortSignal));
    });
    expect(fetchImdfFileMock).not.toHaveBeenCalled();
    expect(loadKirikoBundleMock).not.toHaveBeenCalled();
    expect(getIssuesMock).not.toHaveBeenCalled();
    expect(meMock).not.toHaveBeenCalled();
    expect(listReviewersMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "課題" })).toBeNull();
  });

  it("shows venueLoadErrorCopy in role=alert and keeps the previous venue when replacement fails", async () => {
    const venue = buildMinimalVenue();
    loadImdfArchiveMock.mockResolvedValueOnce(venue);

    render(<App />);
    await uploadViaHiddenInput(zipFile("good.zip"));
    await waitFor(() => {
      expect(screen.getByText("テスト駅")).toBeTruthy();
    });
    const mapBefore = screen.getByTestId("indoor-map-stub");

    const failure = new VenueLoadError("invalid_archive", "bad zip");
    loadImdfArchiveMock.mockRejectedValueOnce(failure);

    await uploadViaHiddenInput(zipFile("bad.zip"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(venueLoadErrorCopy.invalid_archive);
    // Previous venue name remains visible.
    expect(screen.getByText("テスト駅")).toBeTruthy();
    // Map still present (previous venue retained).
    expect(screen.getByTestId("indoor-map-stub")).toBe(mapBefore);
  });

  it("filters search results, retains level for null levelId, and shows details for null center", async () => {
    const venue = buildMinimalVenue();
    loadImdfArchiveMock.mockResolvedValue(venue);
    const user = userEvent.setup();

    render(<App />);
    await uploadViaHiddenInput(zipFile());
    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });

    // Initial level is ordinal 0 (1F).
    expect(screen.getByTestId("indoor-map-stub").getAttribute("data-level-id")).toBe(LEVEL_1F.id);

    // Switch to 2F first so we can assert null-level selection retains it.
    await user.click(screen.getByRole("button", { name: "2F" }));
    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub").getAttribute("data-level-id")).toBe(LEVEL_2F.id);
    });

    // Switch to English so search result labels match English queries.
    await user.click(screen.getByRole("button", { name: "EN" }));

    const search = screen.getByRole("searchbox");
    await user.clear(search);
    await user.type(search, "Restroom");

    const restroomOption = await screen.findByRole("option", { name: /Restroom/i });
    await user.click(restroomOption);

    // Null levelId retains current level (2F).
    expect(screen.getByTestId("indoor-map-stub").getAttribute("data-level-id")).toBe(LEVEL_2F.id);
    expect(screen.getByTestId("indoor-map-stub").getAttribute("data-selected-feature-id")).toBe(
      NULL_LEVEL_AMENITY.id,
    );

    // Inspector opens as a floating panel titled with the feature name.
    const details = screen.getByRole("region", { name: "Restroom" });
    expect(within(details).getByRole("heading", { name: "Restroom" })).toBeTruthy();
    // Null-center feature still shows details without crash.
    await user.clear(search);
    await user.type(search, "Dangling");
    const dangling = await screen.findByRole("option", { name: /Dangling Shop/i });
    await user.click(dangling);

    expect(screen.getByTestId("indoor-map-stub").getAttribute("data-selected-feature-id")).toBe(
      NULL_CENTER_FEATURE.id,
    );
    expect(
      within(screen.getByRole("region", { name: "Dangling Shop" })).getByRole("heading", {
        name: "Dangling Shop",
      }),
    ).toBeTruthy();
    // Level still retained (null levelId).
    expect(screen.getByTestId("indoor-map-stub").getAttribute("data-level-id")).toBe(LEVEL_2F.id);
  });

  it("switches locale pressed state and updates live labels", async () => {
    const venue = buildMinimalVenue();
    loadImdfArchiveMock.mockResolvedValue(venue);
    const user = userEvent.setup();

    render(<App />);
    await uploadViaHiddenInput(zipFile());
    await waitFor(() => {
      expect(screen.getByText("テスト駅")).toBeTruthy();
    });

    const jaBtn = screen.getByRole("button", { name: "日本語" });
    const enBtn = screen.getByRole("button", { name: "EN" });
    expect(jaBtn.getAttribute("aria-pressed")).toBe("true");
    expect(enBtn.getAttribute("aria-pressed")).toBe("false");

    await user.click(enBtn);
    expect(enBtn.getAttribute("aria-pressed")).toBe("true");
    expect(jaBtn.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Test Station")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open IMDF ZIP" })).toBeTruthy();
  });

  it("exposes loader warnings through the rail toggle and panel", async () => {
    const venue = buildMinimalVenue();
    loadImdfArchiveMock.mockResolvedValue(venue);
    const user = userEvent.setup();

    render(<App />);
    await uploadViaHiddenInput(zipFile());
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "警告" })).toBeTruthy();
    });

    const warningsToggle = screen.getByRole("button", { name: "警告" });
    expect(warningsToggle.textContent).toContain("1");
    await user.click(warningsToggle);
    expect(screen.getByText(/missing_locale/)).toBeTruthy();
    expect(screen.getByText("Feature lacks English label")).toBeTruthy();
  });

  it("selects a feature from the mocked map and shows details", async () => {
    const venue = buildMinimalVenue();
    loadImdfArchiveMock.mockResolvedValue(venue);
    const user = userEvent.setup();

    render(<App />);
    await uploadViaHiddenInput(zipFile());
    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "Select shop from map" }));
    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub").getAttribute("data-selected-feature-id")).toBe(
        SHOP_FEATURE.id,
      );
    });
    const details = screen.getByRole("region", { name: "駅ナカショップ" });
    expect(within(details).getByRole("heading", { name: "駅ナカショップ" })).toBeTruthy();
    expect(within(details).getByText("Mo-Fr 10:00-20:00")).toBeTruthy();
  });
});

describe("App deep links", () => {
  beforeEach(() => {
    loadImdfArchiveMock.mockReset();
    fetchImdfFileMock.mockReset();
    loadKirikoBundleMock.mockReset();
    resetIssueMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("admits a dataset envelope with permanent identity and preserves viewer params in embed mode", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    loadKirikoBundleMock.mockResolvedValue(bundleLoadResult());
    window.history.replaceState(
      null,
      "",
      "/?dataset=tokyo-station&level=2f&embed=1&lang=en",
    );

    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });
    expect(loadKirikoBundleMock).toHaveBeenCalledWith(
      "/v/default/tokyo-station/bundle",
      expect.any(AbortSignal),
    );
    expect(loadKirikoBundleMock).toHaveBeenCalledTimes(1);
    expect(fetchImdfFileMock).not.toHaveBeenCalled();
    expect(loadImdfArchiveMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("indoor-map-stub").getAttribute("data-level-id")).toBe(LEVEL_2F.id);
    expect(screen.getByTestId("indoor-map-stub").getAttribute("data-locale")).toBe("en");
    expect(container.querySelector(".context-bar")).toBeNull();
    expect(container.querySelector(".icon-rail")).toBeNull();
    expect(getIssuesMock).not.toHaveBeenCalled();
    expect(meMock).not.toHaveBeenCalled();
    expect(listReviewersMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("admits a dataset venue when its permanent identity is missing", async () => {
    loadKirikoBundleMock.mockResolvedValue(bundleLoadResult(buildMinimalVenue(), null));
    window.history.replaceState(null, "", "/?dataset=tokyo-station");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("テスト駅")).toBeTruthy();
    });
    expect(loadKirikoBundleMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retries a failed dataset through the same bundle provenance only", async () => {
    const user = userEvent.setup();
    loadKirikoBundleMock.mockRejectedValueOnce(
      new VenueLoadError("bundle_integrity_failed", "bad bundle"),
    );
    window.history.replaceState(null, "", "/?dataset=tokyo-station");
    render(<App />);

    await screen.findByRole("alert");
    loadKirikoBundleMock.mockResolvedValueOnce(bundleLoadResult());
    await user.click(screen.getByRole("button", { name: "再試行" }));

    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });
    expect(loadKirikoBundleMock).toHaveBeenCalledTimes(2);
    expect(loadKirikoBundleMock).toHaveBeenNthCalledWith(
      1,
      "/v/default/tokyo-station/bundle",
      expect.any(AbortSignal),
    );
    expect(loadKirikoBundleMock).toHaveBeenNthCalledWith(
      2,
      "/v/default/tokyo-station/bundle",
      expect.any(AbortSignal),
    );
    expect(fetchImdfFileMock).not.toHaveBeenCalled();
    expect(loadImdfArchiveMock).not.toHaveBeenCalled();
  });

  it("retries a failed local replacement without switching back to dataset provenance", async () => {
    const user = userEvent.setup();
    loadKirikoBundleMock.mockResolvedValueOnce(bundleLoadResult());
    window.history.replaceState(null, "", "/?dataset=tokyo-station");
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("テスト駅")).toBeTruthy();
    });

    loadImdfArchiveMock.mockRejectedValueOnce(
      new VenueLoadError("invalid_archive", "bad local zip"),
    );
    await uploadViaHiddenInput(zipFile("replacement.zip"));
    await screen.findByRole("alert");
    expect(screen.getByText("テスト駅")).toBeTruthy();

    const replacementVenue = buildMinimalVenue({
      venue: {
        ...VENUE_FEATURE,
        labels: { ja: "置換会場", en: "Replacement Venue" },
      },
    });
    loadImdfArchiveMock.mockResolvedValueOnce(replacementVenue);
    await user.click(screen.getByRole("button", { name: "再試行" }));

    await waitFor(() => {
      expect(screen.getByText("置換会場")).toBeTruthy();
    });
    expect(loadImdfArchiveMock).toHaveBeenCalledTimes(2);
    expect(loadKirikoBundleMock).toHaveBeenCalledTimes(1);
    expect(fetchImdfFileMock).not.toHaveBeenCalled();
  });

  it("clears dataset provenance only after a successful local replacement", async () => {
    loadKirikoBundleMock.mockResolvedValueOnce(bundleLoadResult());
    window.history.replaceState(null, "", "/?dataset=tokyo-station");
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("テスト駅")).toBeTruthy();
    });

    const localVenue = buildMinimalVenue({
      venue: {
        ...VENUE_FEATURE,
        labels: { ja: "ローカル会場", en: "Local Venue" },
      },
    });
    loadImdfArchiveMock.mockResolvedValueOnce(localVenue);
    await uploadViaHiddenInput(zipFile("local.zip"));

    await waitFor(() => {
      expect(screen.getByText("ローカル会場")).toBeTruthy();
    });
    expect(loadKirikoBundleMock).toHaveBeenCalledTimes(1);
    expect(loadImdfArchiveMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a dataset attempt and suppresses its stale venue and provenance", async () => {
    let resolveDataset: ((result: KirikoBundleLoadResult) => void) | undefined;
    let datasetSignal: AbortSignal | undefined;
    loadKirikoBundleMock.mockImplementation(
      (_src: string, signal: AbortSignal) =>
        new Promise<KirikoBundleLoadResult>((resolve) => {
          datasetSignal = signal;
          resolveDataset = resolve;
        }),
    );
    window.history.replaceState(null, "", "/?dataset=tokyo-station");
    render(<App />);
    await waitFor(() => {
      expect(loadKirikoBundleMock).toHaveBeenCalledTimes(1);
    });

    const localVenue = buildMinimalVenue({
      venue: {
        ...VENUE_FEATURE,
        labels: { ja: "ローカル会場", en: "Local Venue" },
      },
    });
    loadImdfArchiveMock.mockResolvedValueOnce(localVenue);
    await uploadViaHiddenInput(zipFile("local.zip"));

    await waitFor(() => {
      expect(screen.getByText("ローカル会場")).toBeTruthy();
    });
    expect(datasetSignal?.aborted).toBe(true);
    resolveDataset?.(bundleLoadResult());
    await waitFor(() => {
      expect(screen.queryByText("テスト駅")).toBeNull();
      expect(screen.getByText("ローカル会場")).toBeTruthy();
    });
  });

  it("gives src precedence over dataset, clears provenance, and preserves embed viewer params", async () => {
    const venue = buildMinimalVenue();
    fetchImdfFileMock.mockResolvedValue(zipFile("minimal.zip"));
    loadImdfArchiveMock.mockResolvedValue(venue);
    window.history.replaceState(
      null,
      "",
      "/?src=/venues/minimal.zip&dataset=ignored-dataset&level=2f&embed=1",
    );

    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });

    expect(fetchImdfFileMock).toHaveBeenCalledWith("/venues/minimal.zip", expect.any(AbortSignal));
    expect(loadKirikoBundleMock).not.toHaveBeenCalled();
    expect(loadImdfArchiveMock).toHaveBeenCalledWith(expect.any(File), expect.any(AbortSignal));
    // Deep-linked level 2f (short_name 2F) instead of the default ordinal-0 1F.
    expect(screen.getByTestId("indoor-map-stub").getAttribute("data-level-id")).toBe(LEVEL_2F.id);
    expect(screen.getByRole("button", { name: "2F" }).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".context-bar")).toBeNull();
    expect(container.querySelector(".icon-rail")).toBeNull();
    expect(container.querySelector(".floating-panel")).toBeNull();
    expect(container.querySelector(".kiriko-badge")).toBeTruthy();
    expect(container.querySelector('input[type="file"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "IMDF ZIP を開く" })).toBeNull();
    expect(getIssuesMock).not.toHaveBeenCalled();
    expect(meMock).not.toHaveBeenCalled();
    expect(listReviewersMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("lang initializes locale and the legacy theme param is ignored", async () => {
    const venue = buildMinimalVenue();
    fetchImdfFileMock.mockResolvedValue(zipFile("minimal.zip"));
    loadImdfArchiveMock.mockResolvedValue(venue);
    window.history.replaceState(
      null,
      "",
      "/?src=/venues/minimal.zip&lang=en&theme=customer-blue",
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });

    const stub = screen.getByTestId("indoor-map-stub");
    expect(stub.getAttribute("data-locale")).toBe("en");
    expect(stub.getAttribute("data-theme-id")).toBe("kiriko");
    expect(getIssuesMock).not.toHaveBeenCalled();
    expect(meMock).not.toHaveBeenCalled();
    expect(listReviewersMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Issues" })).toBeNull();
  });

  it("fetch failure shows fetch_failed copy and retry re-fetches", async () => {
    const user = userEvent.setup();
    fetchImdfFileMock.mockRejectedValueOnce(new VenueLoadError("fetch_failed", "download failed"));
    window.history.replaceState(null, "", "/?src=/venues/minimal.zip&embed=1");

    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(venueLoadErrorCopy.fetch_failed);
    expect(fetchImdfFileMock).toHaveBeenCalledTimes(1);

    const venue = buildMinimalVenue();
    fetchImdfFileMock.mockResolvedValueOnce(zipFile("minimal.zip"));
    loadImdfArchiveMock.mockResolvedValue(venue);

    await user.click(screen.getByRole("button", { name: "再試行" }));

    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });
    expect(fetchImdfFileMock).toHaveBeenCalledTimes(2);
    expect(loadImdfArchiveMock).toHaveBeenCalledTimes(1);
    expect(loadKirikoBundleMock).not.toHaveBeenCalled();
  });

  it("loads the pinned bundle URL when the deep link carries a 64-hex ?version", async () => {
    const pinId = "b".repeat(64);
    loadKirikoBundleMock.mockResolvedValue(bundleLoadResult());
    window.history.replaceState(null, "", `/?dataset=tokyo-station&version=${pinId}&lang=en`);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });
    expect(loadKirikoBundleMock).toHaveBeenCalledWith(
      `/v/default/tokyo-station/bundle@${pinId}`,
      expect.any(AbortSignal),
    );
    expect(loadKirikoBundleMock).toHaveBeenCalledTimes(1);
  });

  it("ignores an invalid (non-64-hex) ?version and admits mutable latest", async () => {
    loadKirikoBundleMock.mockResolvedValue(bundleLoadResult());
    window.history.replaceState(null, "", "/?dataset=tokyo-station&version=5&lang=en");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });
    expect(loadKirikoBundleMock).toHaveBeenCalledWith(
      "/v/default/tokyo-station/bundle",
      expect.any(AbortSignal),
    );
  });

  it("preserves the admitted public version id in the embed Open-in-Kiriko link", async () => {
    loadKirikoBundleMock.mockResolvedValue(
      bundleLoadResult(buildMinimalVenue(), PUBLIC_VERSION_ID, false, false, [], 9),
    );
    window.history.replaceState(null, "", "/?dataset=tokyo-station&embed=1&lang=en");

    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });
    const badge = container.querySelector<HTMLAnchorElement>("a.kiriko-badge");
    expect(badge).toBeTruthy();
    const href = new URL(badge!.href);
    expect(href.searchParams.get("version")).toBe(PUBLIC_VERSION_ID);
    expect(href.searchParams.get("dataset")).toBe("tokyo-station");
    expect(href.searchParams.has("embed")).toBe(false);
  });

  it("hides the embed badge (never a version-stripped mutable link) when the admission is not pin-safe", async () => {
    // Admission succeeds but the header seq disagreed with the decoded version.
    loadKirikoBundleMock.mockResolvedValue(
      bundleLoadResult(buildMinimalVenue(), PUBLIC_VERSION_ID, false, false, [], null),
    );
    window.history.replaceState(null, "", `/?dataset=tokyo-station&version=${"c".repeat(64)}&embed=1&lang=en`);

    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });
    expect(container.querySelector("a.kiriko-badge")).toBeNull();
  });

  it("overrides an inbound version with the admitted public id in the embed link", async () => {
    loadKirikoBundleMock.mockResolvedValue(
      bundleLoadResult(buildMinimalVenue(), PUBLIC_VERSION_ID, false, false, [], 9),
    );
    window.history.replaceState(null, "", `/?dataset=tokyo-station&version=${"c".repeat(64)}&embed=1&lang=en`);

    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });
    const badge = container.querySelector<HTMLAnchorElement>("a.kiriko-badge");
    const href = new URL(badge!.href);
    expect(href.searchParams.get("version")).toBe(PUBLIC_VERSION_ID);
  });

  it("hides the dataset embed badge until admission, then shows it pinned to the public id", async () => {
    let resolveLoad!: (result: KirikoBundleLoadResult) => void;
    loadKirikoBundleMock.mockReturnValue(
      new Promise<KirikoBundleLoadResult>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    window.history.replaceState(null, "", "/?dataset=tokyo-station&embed=1&lang=en");

    const { container } = render(<App />);
    // Before admission the badge must not expose a mutable-latest link.
    await waitFor(() => expect(loadKirikoBundleMock).toHaveBeenCalledTimes(1));
    expect(container.querySelector("a.kiriko-badge")).toBeNull();

    resolveLoad(bundleLoadResult(buildMinimalVenue(), PUBLIC_VERSION_ID, false, false, [], 9));
    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });
    const badge = container.querySelector<HTMLAnchorElement>("a.kiriko-badge");
    expect(badge).toBeTruthy();
    expect(new URL(badge!.href).searchParams.get("version")).toBe(PUBLIC_VERSION_ID);
  });

  it("keeps the dataset embed badge hidden when admission fails", async () => {
    loadKirikoBundleMock.mockRejectedValue(new VenueLoadError("bundle_integrity_failed", "bad bundle"));
    window.history.replaceState(null, "", "/?dataset=tokyo-station&embed=1&lang=en");

    const { container } = render(<App />);
    await screen.findByRole("alert");
    expect(container.querySelector("a.kiriko-badge")).toBeNull();
  });
});

describe("App review issue integration", () => {
  beforeEach(() => {
    loadImdfArchiveMock.mockReset();
    fetchImdfFileMock.mockReset();
    loadKirikoBundleMock.mockReset();
    resetIssueMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("shows an issue-specific identity error without starting issue or auth requests", async () => {
    await renderDataset(null);
    const user = userEvent.setup();

    const issuesToggle = screen.getByRole("button", { name: "Issues" });
    expect(issuesToggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(issuesToggle);

    expect(await screen.findByText("Issues aren't available for this dataset.")).toBeTruthy();
    expect(getIssuesMock).not.toHaveBeenCalled();
    expect(meMock).not.toHaveBeenCalled();
    expect(listReviewersMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(document.querySelector(".map-stage__error")).toBeNull();
  });

  it("treats a seq/body integrity mismatch as an identity error and starts no issue or auth requests", async () => {
    // publicVersionId is well-formed, but the loader admitted no pin-safe seq.
    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), false, null);
    const user = userEvent.setup();

    const issuesToggle = screen.getByRole("button", { name: "Issues" });
    expect(issuesToggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(issuesToggle);

    expect(await screen.findByText("Issues aren't available for this dataset.")).toBeTruthy();
    expect(getIssuesMock).not.toHaveBeenCalled();
    expect(meMock).not.toHaveBeenCalled();
    expect(listReviewersMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("loads public issues, resolves identity once, and counts active roots across floors", async () => {
    const currentUser: ApiUser = { id: 1, username: "daniel", role: "member" };
    const issues = [
      makeIssue(),
      makeIssue({
        id: "issue-2",
        pinNumber: 2,
        bodyMarkdown: "Second floor",
        status: "in_review",
        anchor: {
          levelId: LEVEL_2F.id,
          longitude: 139.768,
          latitude: 35.682,
        },
      }),
      makeIssue({ id: "issue-3", pinNumber: 3, bodyMarkdown: "Closed", status: "closed" }),
    ];
    getIssuesMock.mockResolvedValue(issueCollection(issues));
    meMock.mockResolvedValue(currentUser);
    listReviewersMock.mockResolvedValue([{ id: 1, username: "daniel" }]);

    await renderDataset();

    await waitFor(() => {
      expect(getIssuesMock).toHaveBeenCalledWith(PUBLIC_VERSION_ID, expect.any(AbortSignal));
      expect(meMock).toHaveBeenCalledTimes(1);
      expect(listReviewersMock).toHaveBeenCalledTimes(1);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe(
      `/api/review/versions/${PUBLIC_VERSION_ID}/issues/events`,
    );

    const issuesToggle = screen.getByRole("button", { name: "Issues" });
    expect(issuesToggle.textContent).toContain("2");
    expect(screen.getByTestId("indoor-map-stub").getAttribute("data-issue-pins")).toBe(
      "issue-1",
    );

    await userEvent.click(issuesToggle);
    expect(await screen.findByRole("option", { name: /#1 Check this location/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New issue" })).toBeTruthy();
  });

  it("keeps a signed-out identity in public read-only mode without reviewer lookup", async () => {
    getIssuesMock.mockResolvedValue(issueCollection([makeIssue()]));
    meMock.mockResolvedValue(null);
    await renderDataset();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Issues" }));
    expect(await screen.findByRole("option", { name: /#1 Check this location/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in to create issues" })).toBeTruthy();
    expect(listReviewersMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/verify your account/)).toBeNull();
  });

  it("retains the signed-in actor and public queue when reviewer lookup fails", async () => {
    getIssuesMock.mockResolvedValue(issueCollection([makeIssue()]));
    meMock.mockResolvedValue({ id: 1, username: "daniel", role: "member" });
    listReviewersMock.mockRejectedValueOnce(new Error("reviewers unavailable"));
    await renderDataset();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Issues" }));
    expect(await screen.findByRole("option", { name: /#1 Check this location/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New issue" })).toBeTruthy();
    const authLine = await screen.findByText(/We couldn't verify your account/);
    const authAlert = authLine.closest('[role="alert"]');
    expect(authAlert).toBeTruthy();

    await user.click(within(authAlert as HTMLElement).getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(meMock).toHaveBeenCalledTimes(2);
      expect(listReviewersMock).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(/verify your account/)).toBeNull();
    });
    expect(screen.getByRole("option", { name: /#1 Check this location/ })).toBeTruthy();
  });

  it("keeps public issues usable when auth fails and retries identity explicitly", async () => {
    getIssuesMock.mockResolvedValue(issueCollection([makeIssue()]));
    meMock.mockRejectedValueOnce(new Error("auth unavailable"));
    await renderDataset();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Issues" }));
    expect(await screen.findByRole("option", { name: /#1 Check this location/ })).toBeTruthy();
    const authLine = await screen.findByText(/We couldn't verify your account/);
    const authAlert = authLine.closest('[role="alert"]');
    expect(authAlert).toBeTruthy();
    const retry = within(authAlert as HTMLElement).getByRole("button", { name: "Retry" });

    meMock.mockResolvedValueOnce({ id: 1, username: "daniel", role: "member" });
    listReviewersMock.mockResolvedValueOnce([{ id: 1, username: "daniel" }]);
    await user.click(retry);

    await waitFor(() => {
      expect(meMock).toHaveBeenCalledTimes(2);
      expect(listReviewersMock).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "New issue" })).toBeTruthy();
    });
    expect(screen.getByRole("option", { name: /#1 Check this location/ })).toBeTruthy();
    expect(document.querySelector(".map-stage__error")).toBeNull();
  });

  it("keeps venue alerts separate when the issue collection fails", async () => {
    getIssuesMock.mockRejectedValue(new Error("issues offline"));
    await renderDataset();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Issues" }));
    expect(await screen.findByText("Issues couldn't be loaded.")).toBeTruthy();
    expect(screen.getByText("Test Station")).toBeTruthy();
    expect(document.querySelector(".map-stage__error")).toBeNull();
  });

  it("closes the old issue session on successful local replacement and ignores late auth", async () => {
    let resolveIdentity: ((user: ApiUser | null) => void) | undefined;
    meMock.mockImplementation(
      () =>
        new Promise<ApiUser | null>((resolve) => {
          resolveIdentity = resolve;
        }),
    );
    getIssuesMock.mockResolvedValue(issueCollection([makeIssue()]));
    await renderDataset();
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(getIssuesMock).toHaveBeenCalledTimes(1);
    });
    const source = FakeEventSource.instances[0]!;

    loadImdfArchiveMock.mockResolvedValue(
      buildMinimalVenue({
        venue: { ...VENUE_FEATURE, labels: { en: "Local Venue", ja: "ローカル会場" } },
      }),
    );
    await uploadViaHiddenInput(zipFile("local.zip"));

    await waitFor(() => {
      expect(screen.getByText("Local Venue")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Issues" })).toBeNull();
      expect(source.closed).toBe(true);
    });

    resolveIdentity?.({ id: 1, username: "late-user", role: "admin" });
    await Promise.resolve();
    expect(listReviewersMock).not.toHaveBeenCalled();
  });

  it("retains the prior issue session when a local replacement fails", async () => {
    getIssuesMock.mockResolvedValue(issueCollection([makeIssue()]));
    await renderDataset();
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Issues" }).textContent).toContain("1");
    });
    const source = FakeEventSource.instances[0]!;

    loadImdfArchiveMock.mockRejectedValue(new VenueLoadError("invalid_archive", "bad local"));
    await uploadViaHiddenInput(zipFile("broken.zip"));

    expect(await screen.findByText(venueLoadErrorCopy.invalid_archive)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Issues" }).textContent).toContain("1");
    expect(source.closed).toBe(false);
    expect(getIssuesMock).toHaveBeenCalledTimes(1);
  });

  it("keeps queue filters, pins, selection, floor, camera, and feature highlight synchronized", async () => {
    const issues = [
      makeIssue(),
      makeIssue({
        id: "issue-2",
        pinNumber: 2,
        bodyMarkdown: "Second floor",
        status: "in_review",
        anchor: {
          levelId: LEVEL_2F.id,
          longitude: 140.1,
          latitude: 36.2,
        },
      }),
      makeIssue({
        id: "issue-3",
        pinNumber: 3,
        bodyMarkdown: "Closed first floor",
        status: "closed",
      }),
    ];
    getIssuesMock.mockResolvedValue(issueCollection(issues));
    meMock.mockResolvedValue({ id: 1, username: "daniel", role: "member" });
    await renderDataset();
    const user = userEvent.setup();
    const map = screen.getByTestId("indoor-map-stub");

    await waitFor(() => {
      expect(map.getAttribute("data-issue-pins")).toBe("issue-1");
    });
    await user.click(screen.getByRole("button", { name: "Issues" }));
    await user.click(screen.getByRole("button", { name: "Closed" }));
    expect(map.getAttribute("data-issue-pins")).toBe("issue-3");
    await user.click(screen.getByRole("button", { name: "Active" }));
    expect(map.getAttribute("data-issue-pins")).toBe("issue-1");

    await user.click(screen.getByRole("option", { name: /#2 Second floor/ }));
    await waitFor(() => {
      expect(map.getAttribute("data-level-id")).toBe(LEVEL_2F.id);
      expect(map.getAttribute("data-issue-selected")).toBe("issue-2");
      expect(map.getAttribute("data-camera-key")).toBe("1");
      expect(map.getAttribute("data-camera-level")).toBe(LEVEL_2F.id);
      expect(map.getAttribute("data-camera-longitude")).toBe("140.1");
      expect(map.getAttribute("data-camera-latitude")).toBe("36.2");
    });

    await user.click(screen.getByRole("button", { name: "Back to issues" }));
    await user.click(screen.getByRole("button", { name: "1F" }));
    await waitFor(() => {
      expect(map.getAttribute("data-issue-pins")).toBe("issue-1");
    });
    await user.click(screen.getByRole("button", { name: "Select first issue pin" }));
    await waitFor(() => {
      expect(map.getAttribute("data-issue-selected")).toBe("issue-1");
      expect(map.getAttribute("data-issue-feature")).toBe(SHOP_FEATURE.id);
      expect(screen.getByRole("button", { name: "Back to issues" })).toBeTruthy();
    });
  });

  it("captures feature and map-center placement once and focuses the draft", async () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    const randomUuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
    meMock.mockResolvedValue({ id: 1, username: "daniel", role: "member" });
    await renderDataset();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Issues" }));
    await user.click(await screen.findByRole("button", { name: "New issue" }));
    expect(screen.getByTestId("indoor-map-stub").getAttribute("data-issue-placement")).toBe(
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Place issue twice" }));
    const body = await screen.findByLabelText("Issue body");
    expect(document.activeElement).toBe(body);
    expect(randomUuid).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Remove feature" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const newIssue = await screen.findByRole("button", { name: "New issue" });
    await waitFor(() => {
      expect(document.activeElement).toBe(newIssue);
    });

    await user.click(newIssue);
    await user.click(screen.getByRole("button", { name: "Place issue at map center" }));
    expect(await screen.findByText("139.765, 35.68")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove feature" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Issue body"));
    randomUuid.mockRestore();
  });

  it("clears only a server-rejected stale feature and reuses the draft request on explicit resubmit", async () => {
    const currentUser: ApiUser = { id: 1, username: "daniel", role: "member" };
    const reviewers = [
      { id: 1, username: "daniel" },
      { id: 3, username: "sakura" },
    ];
    meMock.mockResolvedValue(currentUser);
    listReviewersMock.mockResolvedValue(reviewers);
    getIssuesMock
      .mockResolvedValueOnce(issueCollection([], 0))
      .mockResolvedValueOnce(
        issueCollection([makeIssue({ id: "created-issue", author: currentUser })], 1),
      );
    createIssueMock.mockRejectedValueOnce(
      new IssueApiError(400, {
        error: "invalid_anchor",
        message: "feature missing",
        details: [{ field: "anchor.featureId", reason: "unknown feature" }],
      }),
    );
    await renderDataset();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Issues" }));
    await user.click(await screen.findByRole("button", { name: "New issue" }));
    await user.click(screen.getByRole("button", { name: "Place issue on feature" }));
    await user.type(await screen.findByLabelText("Issue body"), "Keep this complete draft");
    await user.selectOptions(screen.getByLabelText("Assignee"), "3");
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-07-31" } });

    await user.click(screen.getByRole("button", { name: "Post issue" }));
    expect(
      await screen.findByText(/That feature is no longer in this version/),
    ).toBeTruthy();
    const firstInput = createIssueMock.mock.calls[0]?.[1];
    expect(firstInput).toBeDefined();
    expect(screen.getByLabelText("Issue body").getAttribute("value")).toBeNull();
    expect((screen.getByLabelText("Issue body") as HTMLTextAreaElement).value).toBe(
      "Keep this complete draft",
    );
    expect((screen.getByLabelText("Assignee") as HTMLSelectElement).value).toBe("3");
    expect((screen.getByLabelText("Due date") as HTMLInputElement).value).toBe("2026-07-31");
    expect(screen.queryByRole("button", { name: "Remove feature" })).toBeNull();
    expect(document.querySelector(".map-stage__error")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Post issue" }));
    await waitFor(() => {
      expect(createIssueMock).toHaveBeenCalledTimes(2);
    });
    const secondInput = createIssueMock.mock.calls[1]?.[1];
    expect(secondInput?.requestId).toBe(firstInput?.requestId);
    expect(secondInput?.bodyMarkdown).toBe(firstInput?.bodyMarkdown);
    expect(secondInput?.assigneeId).toBe(firstInput?.assigneeId);
    expect(secondInput?.dueDate).toBe(firstInput?.dueDate);
    expect(secondInput?.anchor.featureId).toBeNull();
  });

  it("nulls the actor before 401 sign-in, preserves the full draft, and waits for explicit resubmit", async () => {
    const currentUser: ApiUser = { id: 1, username: "daniel", role: "member" };
    const reviewers = [
      { id: 1, username: "daniel" },
      { id: 3, username: "sakura" },
    ];
    meMock.mockResolvedValue(currentUser);
    loginMock.mockResolvedValue(currentUser);
    listReviewersMock.mockResolvedValue(reviewers);
    getIssuesMock
      .mockResolvedValueOnce(issueCollection([], 0))
      .mockResolvedValueOnce(
        issueCollection([makeIssue({ id: "created-issue", author: currentUser })], 1),
      );
    createIssueMock.mockRejectedValueOnce(
      new IssueApiError(401, { error: "unauthorized", message: "session expired" }),
    );
    await renderDataset();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Issues" }));
    await user.click(await screen.findByRole("button", { name: "New issue" }));
    await user.click(screen.getByRole("button", { name: "Place issue on feature" }));
    const body = await screen.findByLabelText("Issue body");
    await user.type(body, "Draft survives authentication");
    await user.selectOptions(screen.getByLabelText("Assignee"), "3");
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-08-01" } });
    await user.click(screen.getByRole("button", { name: "Post issue" }));

    const dialog = await screen.findByRole("dialog", { name: "Sign in to Kiriko" });
    const firstInput = createIssueMock.mock.calls[0]?.[1];
    expect(firstInput).toBeDefined();
    expect(screen.queryByLabelText("Assignee")).toBeNull();
    expect(screen.queryByLabelText("Due date")).toBeNull();
    expect(createIssueMock).toHaveBeenCalledTimes(1);

    await user.type(within(dialog).getByLabelText("Email"), "daniel");
    await user.type(within(dialog).getByLabelText("Password"), "secret");
    await user.click(within(dialog).getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(screen.getByLabelText("Issue body"));
      expect((screen.getByLabelText("Assignee") as HTMLSelectElement).value).toBe("3");
      expect((screen.getByLabelText("Due date") as HTMLInputElement).value).toBe(
        "2026-08-01",
      );
    });
    expect((screen.getByLabelText("Issue body") as HTMLTextAreaElement).value).toBe(
      "Draft survives authentication",
    );
    expect(screen.getByRole("button", { name: "Remove feature" })).toBeTruthy();
    expect(createIssueMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Post issue" }));
    await waitFor(() => {
      expect(createIssueMock).toHaveBeenCalledTimes(2);
    });
    const secondInput = createIssueMock.mock.calls[1]?.[1];
    expect(secondInput).toEqual(firstInput);
    expect(listReviewersMock).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".map-stage__error")).toBeNull();
  });

  it("returns a remotely deleted selection to the queue with a tombstone notice", async () => {
    const live = makeIssue();
    const tombstone = makeIssue({
      bodyMarkdown: null,
      deletedAt: "2026-07-19T10:00:00Z",
      status: "closed",
      rowVersion: 2,
    });
    getIssuesMock
      .mockResolvedValueOnce(issueCollection([live], 1))
      .mockResolvedValueOnce(issueCollection([tombstone], 2));
    await renderDataset();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Issues" }));
    await user.click(await screen.findByRole("option", { name: /#1 Check this location/ }));
    expect(screen.getByRole("button", { name: "Back to issues" })).toBeTruthy();

    act(() => {
      FakeEventSource.instances[0]?.emit("revision", 2);
    });
    expect(await screen.findByText("This issue was deleted.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to issues" })).toBeNull();
    expect(screen.getByText("No active issues")).toBeTruthy();
    expect(document.querySelector(".map-stage__error")).toBeNull();
  });

  it("uses one compact sheet, exposes ARIA state, and restores placement focus", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 899px)",
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      })),
    );
    meMock.mockResolvedValue({ id: 1, username: "daniel", role: "member" });
    await renderDataset();
    const user = userEvent.setup();

    const rail = document.querySelector(".icon-rail");
    expect(rail?.classList.contains("icon-rail--bar")).toBe(true);
    const issuesToggle = screen.getByRole("button", { name: "Issues" });
    expect(issuesToggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(issuesToggle);
    expect(issuesToggle.getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Select shop from map" }));
    expect(document.querySelectorAll(".floating-panel")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Issues" })).toBeTruthy();

    await user.click(await screen.findByRole("button", { name: "New issue" }));
    expect(issuesToggle.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelectorAll(".floating-panel")).toHaveLength(0);
    expect(screen.getByTestId("indoor-map-stub").getAttribute("data-issue-placement")).toBe(
      "true",
    );

    await user.click(issuesToggle);
    await user.click(screen.getByRole("button", { name: "Cancel placement" }));
    const newIssue = await screen.findByRole("button", { name: "New issue" });
    await waitFor(() => {
      expect(document.activeElement).toBe(newIssue);
    });

    await user.click(newIssue);
    await user.click(screen.getByRole("button", { name: "Place issue at map center" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Issue body"));
      expect(screen.getByTestId("indoor-map-stub").getAttribute("data-issue-placement")).toBe(
        "false",
      );
    });
  });
});

describe("App directions mode", () => {
  const ROUTE_SEGMENTS = [
    { ordinal: 0, coordinates: [[139.7671, 35.6811], [139.7674, 35.6813]] },
  ];
  const ROUTE_RESULT = {
    segments: ROUTE_SEGMENTS,
    totalWeight: 55_000,
    originProjected: [139.7671, 35.6811, 0],
    destProjected: [139.7674, 35.6813, 0],
  };

  function mapStub() {
    return screen.getByTestId("indoor-map-stub");
  }

  function editableNetwork() {
    return {
      junctions: [
        { ordinal: 0, geometry: { type: "Point", coordinates: [139.7, 35.68] }, properties: { NODEID: 0, FLOOR: "F1" } },
        // ~7 m from node 0 — inside the 15 m instant-hop gate when walkable.
        { ordinal: 0, geometry: { type: "Point", coordinates: [139.70008, 35.68] }, properties: { NODEID: 1, FLOOR: "F1" } },
        { ordinal: 0, geometry: { type: "Point", coordinates: [139.701, 35.68] }, properties: { NODEID: 2, FLOOR: "F1" } },
      ],
      paths: [],
    };
  }

  beforeEach(() => {
    loadImdfArchiveMock.mockReset();
    loadKirikoBundleMock.mockReset();
    fetchImdfFileMock.mockReset();
    routeKirikoBundleMock.mockReset();
    loadNetworkOverlayMock.mockReset();
    walkableChordMock.mockReset().mockReturnValue(true);
    proposeNetworkPathsMock.mockReset();
    resetIssueMocks();
    // Network editing is a producer action; default these tests to a member so
    // the Edit control is enabled once the overlay loads.
    meMock.mockResolvedValue({ id: 1, username: "daniel", role: "member" });
  });

  // Enter edit and select the Connect tool once the overlay is loaded.
  async function startNetworkEdit(user: UserEvent): Promise<void> {
    await user.click(screen.getByRole("button", { name: "Review network" }));
    await waitFor(() => expect(mapStub().getAttribute("data-network-present")).toBe("true"));
    await user.click(screen.getByRole("button", { name: "Edit network" }));
    await user.click(await screen.findByRole("button", { name: "Connect" }));
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("hides the Directions toggle when the bundle has no graph", async () => {
    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), false);
    expect(screen.queryByRole("button", { name: "Directions" })).toBeNull();
    expect(mapStub().getAttribute("data-directions-present")).toBe("false");
  });

  it("hides the Directions toggle for a ZIP-loaded venue", async () => {
    loadImdfArchiveMock.mockResolvedValue(buildMinimalVenue());
    window.history.replaceState(null, "", "/?lang=en");
    render(<App />);
    await uploadViaHiddenInput(zipFile());
    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Directions" })).toBeNull();
  });

  it("shows the Directions toggle when the bundle carries a §5 graph", async () => {
    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
    expect(screen.getByRole("button", { name: "Directions" })).toBeTruthy();
  });

  it("routes after two taps: worker route called and polyline reaches the map", async () => {
    const user = userEvent.setup();
    routeKirikoBundleMock.mockResolvedValue(ROUTE_RESULT);
    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);

    await user.click(screen.getByRole("button", { name: "Directions" }));
    expect(mapStub().getAttribute("data-directions-active")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
    expect(JSON.parse(mapStub().getAttribute("data-directions-origin")!)).toEqual({
      longitude: 139.7671,
      latitude: 35.6811,
      ordinal: 0,
    });
    expect(routeKirikoBundleMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
    await waitFor(() => {
      expect(routeKirikoBundleMock).toHaveBeenCalledWith(
        `/v/default/tokyo-station/bundle@${PUBLIC_VERSION_ID}`,
        { longitude: 139.7671, latitude: 35.6811, ordinal: 0 },
        { longitude: 139.7671, latitude: 35.6811, ordinal: 0 },
      );
    });

    await waitFor(() => {
      expect(JSON.parse(mapStub().getAttribute("data-directions-route")!)).toEqual(ROUTE_SEGMENTS);
    });
    expect(screen.getByText(/55\s*m/)).toBeTruthy();
  });

  it("hides Wheelchair until Directions is on", async () => {
    const user = userEvent.setup();
    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
    expect(screen.queryByRole("button", { name: "Wheelchair" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Directions" }));
    expect(screen.getByRole("button", { name: "Wheelchair" })).toBeTruthy();
  });

  it("re-routes with accessible:true when Wheelchair is pressed", async () => {
    const user = userEvent.setup();
    routeKirikoBundleMock.mockResolvedValue(ROUTE_RESULT);
    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
    await user.click(screen.getByRole("button", { name: "Directions" }));
    await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
    await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
    await waitFor(() => expect(routeKirikoBundleMock).toHaveBeenCalled());
    routeKirikoBundleMock.mockClear();
    await user.click(screen.getByRole("button", { name: "Wheelchair" }));
    await waitFor(() => {
      expect(routeKirikoBundleMock).toHaveBeenCalled();
      const args = routeKirikoBundleMock.mock.calls[0];
      expect(args[args.length - 1]).toEqual({ accessible: true });
    });
  });

  it("hides Review network when the bundle has no graph", async () => {
    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), false);
    expect(screen.queryByRole("button", { name: "Review network" })).toBeNull();
  });

  it("overlays the generated network per floor when Review network is toggled", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue({
      junctions: [
        { ordinal: 0, geometry: { type: "Point", coordinates: [139.7, 35.68] }, properties: { NODEID: 0, FLOOR: "F1" } },
      ],
      paths: [
        {
          ordinal: 0,
          geometry: { type: "LineString", coordinates: [[139.7, 35.68], [139.701, 35.68]] },
          properties: { FNODEID: 0, TNODEID: 0, FLOOR: "F1" },
        },
      ],
    });
    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
    expect(mapStub().getAttribute("data-network-present")).toBe("false");

    await user.click(screen.getByRole("button", { name: "Review network" }));
    await waitFor(() => {
      expect(loadNetworkOverlayMock).toHaveBeenCalledWith(`/v/default/tokyo-station/bundle@${PUBLIC_VERSION_ID}`);
      expect(mapStub().getAttribute("data-network-present")).toBe("true");
    });
  });

  it("shows network QA findings when Review network is on", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue({
      junctions: [
        { ordinal: 0, geometry: { type: "Point", coordinates: [139.7, 35.68] }, properties: { NODEID: 0, FLOOR: "F1" } },
      ],
      paths: [],
    });
    loadKirikoBundleMock.mockResolvedValue({
      ...bundleLoadResult(buildMinimalVenue(), PUBLIC_VERSION_ID, true),
      networkQa: {
        findings: [{ code: "disconnected_component", severity: 1, featureId: null }],
        stretch: { sampleCount: 4, rhoMax: 1.8 },
      },
    });
    window.history.replaceState(null, "", "/?dataset=tokyo-station&lang=en");
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("indoor-map-stub")).toBeTruthy();
    });
    await user.click(screen.getByRole("button", { name: "Review network" }));
    expect(await screen.findByText("Network has disconnected parts")).toBeTruthy();
    expect(screen.getByText("detour 1.8")).toBeTruthy();
  });

  it("waits for edited-network publication before navigating to the returned public version", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    const accepted = deferred<{ jobId: string; versionId: number; seq: number; publicVersionId: string }>();
    const job = deferred<{ status: "done" }>();
    const importSpy = vi.spyOn(api, "importNetwork").mockReturnValue(accepted.promise);
    const waitSpy = vi.spyOn(api, "waitForJob").mockReturnValue(job.promise);
    const navigation = collectNavigationEvents();
    const newPublicVersionId = "b".repeat(64);
    try {
      await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);

      await startNetworkEdit(user);
      await user.click(await screen.findByTestId("net-pick-0"));
      await user.click(await screen.findByTestId("net-pick-1"));
      await user.click(screen.getByRole("button", { name: "Save as new version" }));

      await waitFor(() => expect(importSpy).toHaveBeenCalledTimes(1));
      const [slug, publicVersionId, junctions, paths] = importSpy.mock.calls[0]!;
      expect(slug).toBe("tokyo-station");
      expect(publicVersionId).toBe(PUBLIC_VERSION_ID);
      expect(JSON.parse(junctions).features).toHaveLength(3);
      expect(JSON.parse(paths).features).toHaveLength(2);
      expect(navigation.hrefs).toEqual([]);

      accepted.resolve({ jobId: "job-new", versionId: 9, seq: 3, publicVersionId: newPublicVersionId });
      await waitFor(() =>
        expect(waitSpy).toHaveBeenCalledWith(
          "job-new",
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      expect(navigation.hrefs).toEqual([]);

      job.resolve({ status: "done" });
      await waitFor(() =>
        expect(navigation.hrefs).toEqual([
          `/?dataset=tokyo-station&lang=en&version=${newPublicVersionId}&review=1`,
        ]),
      );
    } finally {
      navigation.stop();
      importSpy.mockRestore();
      waitSpy.mockRestore();
    }
  });

  it("keeps the edited graph and shows localized structured copy after terminal save failure", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    const importSpy = vi
      .spyOn(api, "importNetwork")
      .mockResolvedValueOnce({ jobId: "job-error", versionId: 9, seq: 3, publicVersionId: "c".repeat(64) })
      .mockResolvedValueOnce({ jobId: "job-retry", versionId: 10, seq: 4, publicVersionId: "d".repeat(64) });
    const waitSpy = vi
      .spyOn(api, "waitForJob")
      .mockResolvedValueOnce({
        status: "error",
        error: JSON.stringify({ code: "no_routable_network", message: "empty graph" }),
      })
      // Executor form required: tsconfig lib predates Promise.withResolvers.
      .mockReturnValue(new Promise<never>(() => {}));
    const navigation = collectNavigationEvents();
    try {
      await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);

      await startNetworkEdit(user);
      await user.click(await screen.findByTestId("net-pick-0"));
      await user.click(await screen.findByTestId("net-pick-1"));
      await user.click(screen.getByRole("button", { name: "Save as new version" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("No routable network");
      const saveButton = screen.getByRole("button", { name: "Save as new version" }) as HTMLButtonElement;
      expect(saveButton.disabled).toBe(false);
      expect(navigation.hrefs).toEqual([]);

      await user.click(saveButton);
      await waitFor(() => expect(importSpy).toHaveBeenCalledTimes(2));
      const [, , retryJunctions, retryPaths] = importSpy.mock.calls[1]!;
      expect(JSON.parse(retryJunctions).features).toHaveLength(3);
      expect(JSON.parse(retryPaths).features).toHaveLength(2);
    } finally {
      navigation.stop();
      importSpy.mockRestore();
      waitSpy.mockRestore();
    }
  });

  it("keeps a timeout as an accepted job and checks it later without resubmitting or editing the pending snapshot", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    const newPublicVersionId = "e".repeat(64);
    const importSpy = vi
      .spyOn(api, "importNetwork")
      .mockResolvedValue({ jobId: "job-timeout", versionId: 9, seq: 3, publicVersionId: newPublicVersionId });
    const waitSpy = vi
      .spyOn(api, "waitForJob")
      .mockResolvedValueOnce({ status: "timeout" })
      .mockResolvedValueOnce({ status: "done" });
    const navigation = collectNavigationEvents();
    try {
      await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);

      await startNetworkEdit(user);
      await user.click(await screen.findByTestId("net-pick-0"));
      await user.click(await screen.findByTestId("net-pick-1"));
      await user.click(screen.getByRole("button", { name: "Save as new version" }));

      await screen.findByRole("button", { name: "Check status" });
      expect(importSpy).toHaveBeenCalledTimes(1);
      expect(waitSpy.mock.calls[0]?.[0]).toBe("job-timeout");
      expect(navigation.hrefs).toEqual([]);
      expect(mapStub().getAttribute("data-network-path-count")).toBe("2");

      await user.click(await screen.findByTestId("net-pick-1"));
      await user.click(await screen.findByTestId("net-pick-2"));
      expect(mapStub().getAttribute("data-network-path-count")).toBe("2");

      await user.click(screen.getByRole("button", { name: "Check status" }));
      await waitFor(() => expect(waitSpy).toHaveBeenCalledTimes(2));
      expect(waitSpy.mock.calls[1]?.[0]).toBe("job-timeout");
      expect(importSpy).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(navigation.hrefs).toEqual([
          `/?dataset=tokyo-station&lang=en&version=${newPublicVersionId}&review=1`,
        ]),
      );
    } finally {
      navigation.stop();
      importSpy.mockRestore();
      waitSpy.mockRestore();
    }
  });

  it("keeps the accepted job after a transient status-check rejection and checks the same job on retry", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    const newPublicVersionId = "1".repeat(64);
    const importSpy = vi
      .spyOn(api, "importNetwork")
      .mockResolvedValue({ jobId: "job-flaky-status", versionId: 9, seq: 3, publicVersionId: newPublicVersionId });
    const waitSpy = vi
      .spyOn(api, "waitForJob")
      .mockRejectedValueOnce(new TypeError("temporary status fetch failure"))
      .mockResolvedValueOnce({ status: "done" });
    const navigation = collectNavigationEvents();
    try {
      await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
      await startNetworkEdit(user);
      await user.click(await screen.findByTestId("net-pick-0"));
      await user.click(await screen.findByTestId("net-pick-1"));
      await user.click(screen.getByRole("button", { name: "Save as new version" }));

      await screen.findByRole("button", { name: "Check status" });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(importSpy).toHaveBeenCalledTimes(1);
      expect(waitSpy.mock.calls[0]?.[0]).toBe("job-flaky-status");

      await user.click(screen.getByRole("button", { name: "Check status" }));
      await waitFor(() => expect(waitSpy).toHaveBeenCalledTimes(2));
      expect(waitSpy.mock.calls[1]?.[0]).toBe("job-flaky-status");
      expect(importSpy).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(navigation.hrefs).toEqual([
          `/?dataset=tokyo-station&lang=en&version=${newPublicVersionId}&review=1`,
        ]),
      );
    } finally {
      navigation.stop();
      importSpy.mockRestore();
      waitSpy.mockRestore();
    }
  });

  it("aborts save polling when a slow replacement starts and ignores the old job done", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    vi.spyOn(api, "importNetwork").mockResolvedValue({
      jobId: "job-slow-replace",
      versionId: 9,
      seq: 3,
      publicVersionId: "2".repeat(64),
    });
    const job = deferred<{ status: "done" }>();
    let signal: AbortSignal | undefined;
    const waitSpy = vi.spyOn(api, "waitForJob").mockImplementation((_jobId, opts) => {
      signal = opts?.signal;
      return job.promise;
    });
    const replacement = deferred<LoadedVenue>();
    const navigation = collectNavigationEvents();
    try {
      await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
      await startNetworkEdit(user);
      await user.click(await screen.findByTestId("net-pick-0"));
      await user.click(await screen.findByTestId("net-pick-1"));
      await user.click(screen.getByRole("button", { name: "Save as new version" }));
      await waitFor(() => expect(waitSpy).toHaveBeenCalledWith("job-slow-replace", expect.anything()));

      loadImdfArchiveMock.mockReturnValueOnce(replacement.promise);
      await uploadViaHiddenInput(zipFile("slow-replacement.zip"));
      await waitFor(() => expect(signal?.aborted).toBe(true));
      await act(async () => {
        job.resolve({ status: "done" });
        await job.promise;
      });

      expect(navigation.hrefs).toEqual([]);
      expect(screen.getByText("Test Station")).toBeTruthy();
    } finally {
      navigation.stop();
      vi.restoreAllMocks();
    }
  });

  it("keeps the accepted save job after a failed replacement and checks it without resubmitting", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    const newPublicVersionId = "3".repeat(64);
    const importSpy = vi.spyOn(api, "importNetwork").mockResolvedValue({
      jobId: "job-failed-replace",
      versionId: 9,
      seq: 3,
      publicVersionId: newPublicVersionId,
    });
    const firstJob = deferred<{ status: "done" }>();
    let signal: AbortSignal | undefined;
    const waitSpy = vi
      .spyOn(api, "waitForJob")
      .mockImplementationOnce((_jobId, opts) => {
        signal = opts?.signal;
        return firstJob.promise;
      })
      .mockResolvedValueOnce({ status: "done" });
    const replacement = deferred<LoadedVenue>();
    const navigation = collectNavigationEvents();
    try {
      await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
      await startNetworkEdit(user);
      await user.click(await screen.findByTestId("net-pick-0"));
      await user.click(await screen.findByTestId("net-pick-1"));
      await user.click(screen.getByRole("button", { name: "Save as new version" }));
      await waitFor(() => expect(waitSpy).toHaveBeenCalledWith("job-failed-replace", expect.anything()));

      loadImdfArchiveMock.mockReturnValueOnce(replacement.promise);
      await uploadViaHiddenInput(zipFile("bad-replacement.zip"));
      await waitFor(() => expect(signal?.aborted).toBe(true));
      const loadingCheckButton = screen.getByRole("button", { name: "Check status" }) as HTMLButtonElement;
      expect(loadingCheckButton.disabled).toBe(true);
      await user.click(loadingCheckButton);
      expect(waitSpy).toHaveBeenCalledTimes(1);
      expect(navigation.hrefs).toEqual([]);
      await act(async () => {
        firstJob.resolve({ status: "done" });
        await firstJob.promise;
        replacement.reject(new VenueLoadError("invalid_archive", "bad local zip"));
        await replacement.promise.catch(() => {});
      });

      expect(navigation.hrefs).toEqual([]);
      expect(await screen.findByRole("alert")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Check status" }));
      await waitFor(() => expect(waitSpy).toHaveBeenCalledTimes(2));
      expect(waitSpy.mock.calls[1]?.[0]).toBe("job-failed-replace");
      expect(importSpy).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(navigation.hrefs).toEqual([
          `/?dataset=tokyo-station&lang=en&version=${newPublicVersionId}&review=1`,
        ]),
      );
    } finally {
      navigation.stop();
      vi.restoreAllMocks();
    }
  });

  it("records a late accepted save after replacement starts and checks it after replacement failure", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    const accepted = deferred<{ jobId: string; versionId: number; seq: number; publicVersionId: string }>();
    const newPublicVersionId = "4".repeat(64);
    const importSpy = vi.spyOn(api, "importNetwork").mockReturnValue(accepted.promise);
    const waitSpy = vi.spyOn(api, "waitForJob").mockResolvedValueOnce({ status: "done" });
    const replacement = deferred<LoadedVenue>();
    const navigation = collectNavigationEvents();
    try {
      await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
      await startNetworkEdit(user);
      await user.click(await screen.findByTestId("net-pick-0"));
      await user.click(await screen.findByTestId("net-pick-1"));
      await user.click(screen.getByRole("button", { name: "Save as new version" }));
      await waitFor(() => expect(importSpy).toHaveBeenCalledTimes(1));

      loadImdfArchiveMock.mockReturnValueOnce(replacement.promise);
      await uploadViaHiddenInput(zipFile("late-accept-fail.zip"));
      accepted.resolve({ jobId: "job-late-accepted", versionId: 9, seq: 3, publicVersionId: newPublicVersionId });
      await accepted.promise;
      expect(waitSpy).not.toHaveBeenCalled();
      expect(navigation.hrefs).toEqual([]);

      await act(async () => {
        replacement.reject(new VenueLoadError("invalid_archive", "bad local zip"));
        await replacement.promise.catch(() => {});
      });
      expect(await screen.findByRole("alert")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Check status" }));
      await waitFor(() => expect(waitSpy).toHaveBeenCalledWith("job-late-accepted", expect.anything()));
      expect(importSpy).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(navigation.hrefs).toEqual([
          `/?dataset=tokyo-station&lang=en&version=${newPublicVersionId}&review=1`,
        ]),
      );
    } finally {
      navigation.stop();
      importSpy.mockRestore();
      waitSpy.mockRestore();
    }
  });

  it("keeps an unresolved save submission locked across failed replacement until its late 202", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    const accepted = deferred<{ jobId: string; versionId: number; seq: number; publicVersionId: string }>();
    const newPublicVersionId = "6".repeat(64);
    const importSpy = vi.spyOn(api, "importNetwork").mockReturnValue(accepted.promise);
    const waitSpy = vi.spyOn(api, "waitForJob").mockResolvedValueOnce({ status: "done" });
    const replacement = deferred<LoadedVenue>();
    const navigation = collectNavigationEvents();
    try {
      await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
      await startNetworkEdit(user);
      await user.click(await screen.findByTestId("net-pick-0"));
      await user.click(await screen.findByTestId("net-pick-1"));
      await user.click(screen.getByRole("button", { name: "Save as new version" }));
      await waitFor(() => expect(importSpy).toHaveBeenCalledTimes(1));

      loadImdfArchiveMock.mockReturnValueOnce(replacement.promise);
      await uploadViaHiddenInput(zipFile("unresolved-submit.zip"));
      await act(async () => {
        replacement.reject(new VenueLoadError("invalid_archive", "bad local zip"));
        await replacement.promise.catch(() => {});
      });
      expect(await screen.findByRole("alert")).toBeTruthy();
      const lockedSave = screen.getByRole("button", { name: "Save as new version" }) as HTMLButtonElement;
      expect(lockedSave.disabled).toBe(true);
      await user.click(lockedSave);
      expect(importSpy).toHaveBeenCalledTimes(1);
      expect(waitSpy).not.toHaveBeenCalled();
      expect(navigation.hrefs).toEqual([]);

      accepted.resolve({ jobId: "job-late-after-failure", versionId: 9, seq: 3, publicVersionId: newPublicVersionId });
      await accepted.promise;
      await user.click(await screen.findByRole("button", { name: "Check status" }));
      await waitFor(() => expect(waitSpy).toHaveBeenCalledWith("job-late-after-failure", expect.anything()));
      expect(importSpy).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(navigation.hrefs).toEqual([
          `/?dataset=tokyo-station&lang=en&version=${newPublicVersionId}&review=1`,
        ]),
      );
    } finally {
      navigation.stop();
      importSpy.mockRestore();
      waitSpy.mockRestore();
    }
  });

  it("drops a late accepted save when replacement succeeds", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    const accepted = deferred<{ jobId: string; versionId: number; seq: number; publicVersionId: string }>();
    const importSpy = vi.spyOn(api, "importNetwork").mockReturnValue(accepted.promise);
    const waitSpy = vi.spyOn(api, "waitForJob").mockResolvedValue({ status: "done" });
    const replacement = deferred<LoadedVenue>();
    const navigation = collectNavigationEvents();
    try {
      await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
      await startNetworkEdit(user);
      await user.click(await screen.findByTestId("net-pick-0"));
      await user.click(await screen.findByTestId("net-pick-1"));
      await user.click(screen.getByRole("button", { name: "Save as new version" }));
      await waitFor(() => expect(importSpy).toHaveBeenCalledTimes(1));

      const localVenue = buildMinimalVenue({
        venue: {
          ...VENUE_FEATURE,
          labels: { ja: "新しい会場", en: "Replacement Venue" },
        },
      });
      loadImdfArchiveMock.mockReturnValueOnce(replacement.promise);
      await uploadViaHiddenInput(zipFile("late-accept-success.zip"));
      accepted.resolve({ jobId: "job-old-late", versionId: 9, seq: 3, publicVersionId: "5".repeat(64) });
      await accepted.promise;
      await act(async () => {
        replacement.resolve(localVenue);
        await replacement.promise;
      });

      await waitFor(() => expect(screen.getByText("Replacement Venue")).toBeTruthy());
      expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
      expect(waitSpy).not.toHaveBeenCalled();
      expect(navigation.hrefs).toEqual([]);
    } finally {
      navigation.stop();
      importSpy.mockRestore();
      waitSpy.mockRestore();
    }
  });

  it("aborts edited-network polling on unmount and suppresses late navigation", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    vi.spyOn(api, "importNetwork").mockResolvedValue({
      jobId: "job-unmount",
      versionId: 9,
      seq: 3,
      publicVersionId: "f".repeat(64),
    });
    const job = deferred<{ status: "done" }>();
    let signal: AbortSignal | undefined;
    const waitSpy = vi.spyOn(api, "waitForJob").mockImplementation((_jobId, opts) => {
      signal = opts?.signal;
      return job.promise;
    });
    const navigation = collectNavigationEvents();
    try {
      const { unmount } = await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
      await startNetworkEdit(user);
      await user.click(await screen.findByTestId("net-pick-0"));
      await user.click(await screen.findByTestId("net-pick-1"));
      await user.click(screen.getByRole("button", { name: "Save as new version" }));
      await waitFor(() => expect(waitSpy).toHaveBeenCalledWith("job-unmount", expect.anything()));

      unmount();
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        job.resolve({ status: "done" });
        await job.promise;
      });
      expect(navigation.hrefs).toEqual([]);
    } finally {
      navigation.stop();
      vi.restoreAllMocks();
    }
  });

  it("aborts edited-network polling when venue provenance is replaced and suppresses late navigation", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    vi.spyOn(api, "importNetwork").mockResolvedValue({
      jobId: "job-replaced",
      versionId: 9,
      seq: 3,
      publicVersionId: "f".repeat(64),
    });
    const job = deferred<{ status: "done" }>();
    let signal: AbortSignal | undefined;
    const waitSpy = vi.spyOn(api, "waitForJob").mockImplementation((_jobId, opts) => {
      signal = opts?.signal;
      return job.promise;
    });
    const navigation = collectNavigationEvents();
    try {
      await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
      await startNetworkEdit(user);
      await user.click(await screen.findByTestId("net-pick-0"));
      await user.click(await screen.findByTestId("net-pick-1"));
      await user.click(screen.getByRole("button", { name: "Save as new version" }));
      await waitFor(() => expect(waitSpy).toHaveBeenCalledWith("job-replaced", expect.anything()));

      const localVenue = buildMinimalVenue({
        venue: {
          ...VENUE_FEATURE,
          labels: { ja: "ローカル会場", en: "Local Venue" },
        },
      });
      loadImdfArchiveMock.mockResolvedValueOnce(localVenue);
      await uploadViaHiddenInput(zipFile("local.zip"));
      await waitFor(() => expect(screen.getByText("Local Venue")).toBeTruthy());
      expect(signal?.aborted).toBe(true);

      await act(async () => {
        job.resolve({ status: "done" });
        await job.promise;
      });
      expect(navigation.hrefs).toEqual([]);
      expect(screen.getByText("Local Venue")).toBeTruthy();
    } finally {
      navigation.stop();
      vi.restoreAllMocks();
    }
  });

  it("shows a no-path message when the worker resolves null", async () => {
    const user = userEvent.setup();
    routeKirikoBundleMock.mockResolvedValue(null);
    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);

    await user.click(screen.getByRole("button", { name: "Directions" }));
    await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
    await user.click(screen.getByRole("button", { name: "Tap map for directions" }));

    await screen.findByText("No route found");
    expect(mapStub().getAttribute("data-directions-route")).toBe("");
  });

  it("clear resets origin, destination, and the route layer data", async () => {
    const user = userEvent.setup();
    routeKirikoBundleMock.mockResolvedValue(ROUTE_RESULT);
    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);

    await user.click(screen.getByRole("button", { name: "Directions" }));
    await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
    await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
    await waitFor(() => {
      expect(mapStub().getAttribute("data-directions-route")).not.toBe("");
    });

    await user.click(screen.getByRole("button", { name: "Clear route" }));
    expect(mapStub().getAttribute("data-directions-origin")).toBe("");
    expect(mapStub().getAttribute("data-directions-destination")).toBe("");
    expect(mapStub().getAttribute("data-directions-route")).toBe("");
  });

  it("toggling Directions off clears the picks and hides the overlay", async () => {
    const user = userEvent.setup();
    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);

    const toggle = screen.getByRole("button", { name: "Directions" });
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
    expect(mapStub().getAttribute("data-directions-origin")).not.toBe("");

    await user.click(toggle);
    expect(mapStub().getAttribute("data-directions-active")).toBe("false");
    expect(mapStub().getAttribute("data-directions-origin")).toBe("");
  });

  it("pins Directions and Review network to the admitted public identity from a latest load", async () => {
    const user = userEvent.setup();
    routeKirikoBundleMock.mockResolvedValue(ROUTE_RESULT);
    loadNetworkOverlayMock.mockResolvedValue({
      junctions: [
        { ordinal: 0, geometry: { type: "Point", coordinates: [139.7, 35.68] }, properties: { NODEID: 0, FLOOR: "F1" } },
      ],
      paths: [],
    });
    // Latest load; the loader admits the pin-safe public identity from the response.
    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true, 9);
    // Initial admission uses mutable latest; the sequence comes from that response.
    expect(loadKirikoBundleMock).toHaveBeenCalledWith(
      "/v/default/tokyo-station/bundle",
      expect.any(AbortSignal),
    );

    await user.click(screen.getByRole("button", { name: "Directions" }));
    await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
    await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
    await waitFor(() => {
      expect(routeKirikoBundleMock).toHaveBeenCalledWith(
        `/v/default/tokyo-station/bundle@${PUBLIC_VERSION_ID}`,
        { longitude: 139.7671, latitude: 35.6811, ordinal: 0 },
        { longitude: 139.7671, latitude: 35.6811, ordinal: 0 },
      );
    });

    await user.click(screen.getByRole("button", { name: "Review network" }));
    await waitFor(() => {
      expect(loadNetworkOverlayMock).toHaveBeenCalledWith(`/v/default/tokyo-station/bundle@${PUBLIC_VERSION_ID}`);
    });
  });

  it("keeps the prior venue and pinned provenance after a failed replacement", async () => {
    const user = userEvent.setup();
    routeKirikoBundleMock.mockResolvedValue(ROUTE_RESULT);
    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true, 9);
    expect(screen.getByText("Test Station")).toBeTruthy();

    // A failed local replacement must not clear the admitted venue or its pinned identity.
    loadImdfArchiveMock.mockRejectedValueOnce(new VenueLoadError("invalid_archive", "bad local zip"));
    await uploadViaHiddenInput(zipFile("replacement.zip"));
    await screen.findByRole("alert");
    expect(screen.getByText("Test Station")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Directions" }));
    await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
    await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
    await waitFor(() => {
      expect(routeKirikoBundleMock).toHaveBeenCalledWith(
        `/v/default/tokyo-station/bundle@${PUBLIC_VERSION_ID}`,
        expect.anything(),
        expect.anything(),
      );
    });
  });

  it("resumes network editing after an anonymous member signs in", async () => {
    const user = userEvent.setup();
    meMock.mockResolvedValue(null);
    loginMock.mockResolvedValue({ id: 2, username: "producer", role: "member" });
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());

    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
    await user.click(screen.getByRole("button", { name: "Review network" }));
    await waitFor(() => expect(mapStub().getAttribute("data-network-present")).toBe("true"));
    await user.click(screen.getByRole("button", { name: "Edit network" }));

    expect(screen.getByRole("dialog", { name: "Sign in to Kiriko" })).toBeTruthy();
    await user.type(screen.getByLabelText("Email"), "producer");
    await user.type(screen.getByLabelText("Password"), "pw");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(mapStub().getAttribute("data-network-editing")).toBe("true"));
    expect(screen.getByRole("button", { name: "Add point" })).toBeTruthy();
    expect(loginMock).toHaveBeenCalledWith("producer", "pw");
  });

  it("denies viewer network edits without entering editor mode", async () => {
    const user = userEvent.setup();
    meMock.mockResolvedValue({ id: 3, username: "viewer", role: "viewer" });
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());

    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
    await user.click(screen.getByRole("button", { name: "Review network" }));
    await waitFor(() => expect(mapStub().getAttribute("data-network-present")).toBe("true"));
    await user.click(screen.getByRole("button", { name: "Edit network" }));

    expect(screen.getByRole("alert").textContent).toContain(
      "Only members and admins can edit network data.",
    );
    expect(mapStub().getAttribute("data-network-editing")).toBe("false");
    expect(screen.queryByRole("button", { name: "Add point" })).toBeNull();
  });

  it("keeps editing disabled after a network load error until retry succeeds", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock
      .mockRejectedValueOnce(new Error("overlay failed"))
      .mockResolvedValueOnce(editableNetwork());

    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
    await user.click(screen.getByRole("button", { name: "Review network" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Network could not be loaded.");
    expect((screen.getByRole("button", { name: "Edit network" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mapStub().getAttribute("data-network-present")).toBe("true"));
    expect((screen.getByRole("button", { name: "Edit network" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides directions while editing and restores them after discarding edits", async () => {
    const user = userEvent.setup();
    routeKirikoBundleMock.mockResolvedValue(ROUTE_RESULT);
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());

    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
    expect(screen.getByRole("button", { name: "Directions" })).toBeTruthy();

    await startNetworkEdit(user);
    expect(screen.queryByRole("button", { name: "Directions" })).toBeNull();
    await user.click(await screen.findByTestId("net-pick-0"));
    await user.click(await screen.findByTestId("net-pick-1"));
    expect(mapStub().getAttribute("data-network-path-count")).toBe("2");

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(mapStub().getAttribute("data-network-path-count")).toBe("0");
    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(mapStub().getAttribute("data-network-path-count")).toBe("2");

    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.getByRole("button", { name: "Directions" })).toBeTruthy();
  });

  it("previews a long connect pair and confirms as one added path", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    proposeNetworkPathsMock.mockReturnValue({
      fromId: 0,
      toId: 2,
      candidates: [
        {
          kind: "shorter",
          coordinates: [
            [139.7, 35.68],
            [139.7005, 35.68],
            [139.701, 35.68],
          ],
          nodeIds: null,
        },
      ],
    });

    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
    await startNetworkEdit(user);
    await user.click(await screen.findByTestId("net-pick-0"));
    await user.click(await screen.findByTestId("net-pick-2"));

    expect(await screen.findByText("Choose a route, or press Escape to cancel.")).toBeTruthy();
    expect(mapStub().getAttribute("data-network-path-count")).toBe("0");
    await user.click(screen.getByRole("button", { name: "Add this path" }));
    await waitFor(() => expect(Number(mapStub().getAttribute("data-network-path-count"))).toBeGreaterThanOrEqual(4));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(mapStub().getAttribute("data-network-path-count")).toBe("0");
  });

  it("does not hop a short chord that is not walkable", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    walkableChordMock.mockReturnValue(false);
    proposeNetworkPathsMock.mockReturnValue({
      fromId: 0,
      toId: 1,
      candidates: [
        {
          kind: "along_network",
          coordinates: [
            [139.7, 35.68],
            [139.70008, 35.68],
          ],
          nodeIds: null,
        },
      ],
    });

    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
    await startNetworkEdit(user);
    await user.click(await screen.findByTestId("net-pick-0"));
    await user.click(await screen.findByTestId("net-pick-1"));

    expect(await screen.findByText("Choose a route, or press Escape to cancel.")).toBeTruthy();
    expect(mapStub().getAttribute("data-network-path-count")).toBe("0");
    expect(proposeNetworkPathsMock).toHaveBeenCalled();
  });

  it("shows no walkable path when propose returns no candidates", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    walkableChordMock.mockReturnValue(false);
    proposeNetworkPathsMock.mockReturnValue({ fromId: 0, toId: 1, candidates: [] });

    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
    await startNetworkEdit(user);
    await user.click(await screen.findByTestId("net-pick-0"));
    await user.click(await screen.findByTestId("net-pick-1"));

    expect(await screen.findByText("No walkable path between these points.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add this path" })).toBeNull();
    expect(mapStub().getAttribute("data-network-path-count")).toBe("0");
  });

  it("shows propose failed when wasm throws", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());
    walkableChordMock.mockReturnValue(false);
    proposeNetworkPathsMock.mockImplementation(() => {
      throw new Error("wasm down");
    });

    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
    await startNetworkEdit(user);
    await user.click(await screen.findByTestId("net-pick-0"));
    await user.click(await screen.findByTestId("net-pick-1"));

    expect(await screen.findByText("Could not calculate a path.")).toBeTruthy();
    expect(mapStub().getAttribute("data-network-path-count")).toBe("0");
  });

  it("rejects an existing direct edge without opening preview", async () => {
    const user = userEvent.setup();
    loadNetworkOverlayMock.mockResolvedValue(editableNetwork());

    await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
    await startNetworkEdit(user);
    await user.click(await screen.findByTestId("net-pick-0"));
    await user.click(await screen.findByTestId("net-pick-1"));
    await waitFor(() => expect(mapStub().getAttribute("data-network-path-count")).toBe("2"));

    await user.click(await screen.findByTestId("net-pick-0"));
    await user.click(await screen.findByTestId("net-pick-1"));
    expect((await screen.findByRole("alert")).textContent).toContain("already connected");
    expect(screen.queryByRole("button", { name: "Add this path" })).toBeNull();
    expect(proposeNetworkPathsMock).not.toHaveBeenCalled();
  });
});
