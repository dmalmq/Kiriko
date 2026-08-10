import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { ContextBar } from "../components/ContextBar";
import { FloatingPanel } from "../components/FloatingPanel";
import { FloorStack } from "../components/FloorStack";
import { IconRail, type RailPanelId } from "../components/IconRail";
import { KirikoMark } from "../components/icons";
import { ImdfDropzone } from "../components/ImdfDropzone";
import { InspectorPanel, resolveSelectedFeature } from "../components/InspectorPanel";
import { LayersPanel } from "../components/LayersPanel";
import { SearchPanel } from "../components/SearchPanel";
import { ViewerErrorNotice } from "../components/ViewerNotice";
import { WarningsPanel } from "../components/WarningsPanel";
import { loadKirikoBundle } from "../bundle/loadKirikoBundle";
import { routeKirikoBundle } from "../bundle/routeKirikoBundle";
import { loadKirikoScene } from "../bundle/loadKirikoScene";
import { readScene, type SceneView } from "../map/scene/sceneFormat";
import { probeSceneCapability } from "../map/scene/sceneCapability";
import { SCENE_DECODE_MEASURE, SCENE_DECODE_START } from "../map/scene/sceneMetrics";
import {
  canRetry3d,
  fallbackNotice,
  initialSceneSource,
  reduceSceneSource,
  sourceProvenance,
  type SceneSourceEvent,
} from "../map/scene/sceneSource";
import type { FacilityDto, RouteEndpoint, RouteResultDto } from "../bundle/wasm";
import { loadNetworkOverlay } from "../bundle/loadNetworkOverlay";
import {
  networkConnectivity,
  serializeNetwork,
  type ParsedNetwork,
} from "../map/networkFeatures";
import {
  createNetworkEditorState,
  hasNetworkChanges,
  networkEditorReducer,
  networkSaveProblem,
  summarizeNetworkChanges,
  type NetworkEditorAction,
  type NetworkMapPick,
  type NetworkEditorState,
} from "../map/networkEditor";
import { NetworkEditorToolbar } from "../components/NetworkEditorToolbar";
import { NetworkInspectorPanel } from "../components/NetworkInspectorPanel";
import { ZoomCluster } from "../components/ZoomCluster";
import { SignInModal } from "../gallery/SignInModal";
import { VenueLoadError } from "../errors/VenueLoadError";
import { fetchImdfFile, fileNameFromSrc } from "../imdf/fetchImdfArchive";
import { loadImdfArchive } from "../imdf/loadImdfArchive";
import { localizedLabel } from "../imdf/localize";
import type { LoadedVenue, SearchResult } from "../imdf/types";
import { issueApi } from "../issues/api";
import { IssuesPanel } from "../issues/IssuesPanel";
import { countActiveIssues } from "../issues/IssueQueue";
import type { ReviewerSummary } from "../issues/types";
import { useIssueSync } from "../issues/useIssueSync";
import {
  IndoorMap,
  type DirectionsMapProps,
  type IndoorMapControls,
  type IssuePlacementAnchor,
  type IssueReviewMapProps,
} from "../map/IndoorMap";
import { defaultLayerVisibility, type MapLayerGroup } from "../map/layerGroups";
import { projectPins } from "../map/useIssuePins";
import { levelIdsForOrdinal, ordinalOfLevel } from "../state/floorGroups";
import { searchVenue } from "../search/searchVenue";
import {
  initialViewerState,
  viewerReducer,
  type ReadyVenueState,
  type ViewerState,
} from "../state/viewerReducer";
import { kirikoTheme } from "../theme/presets";
import {
  api,
  datasetBundleUrl,
  datasetSceneUrl,
  gdbErrorMessage,
  viewerHref,
  type ApiUser,
  type GdbError,
} from "../gallery/api";
import { parseViewerParams } from "./viewerParams";

const ui = {
  product: { ja: "Kiriko", en: "Kiriko" },
  localeGroup: { ja: "言語", en: "Language" },
  openZip: { ja: "IMDF ZIP を開く", en: "Open IMDF ZIP" },
  loading: { ja: "読み込み中", en: "Loading" },
  ready: { ja: "会場を読み込みました", en: "Venue loaded" },
  error: { ja: "読み込みエラー", en: "Load error" },
  empty: { ja: "会場が未読み込みです", en: "No venue loaded" },
  searchPanel: { ja: "検索", en: "Search" },
  layersPanel: { ja: "レイヤー", en: "Layers" },
  warningsPanel: { ja: "警告", en: "Warnings" },
  issuesPanel: { ja: "課題", en: "Issues" },
  closePanel: { ja: "パネルを閉じる", en: "Close panel" },
  closeInspector: { ja: "詳細を閉じる", en: "Close details" },
  attribution: { ja: "IMDF venue data © Company", en: "IMDF venue data © Company" },
  openInKiriko: { ja: "Kiriko で開く", en: "Open in Kiriko" },
  directions: { ja: "経路案内", en: "Directions" },
  reviewNetwork: { ja: "ネットワークを確認", en: "Review network" },
  reviewConnected: { ja: "接続率", en: "connected" },
  reviewIslands: { ja: "分割数", en: "islands" },
  reviewFloors: { ja: "接続フロア", en: "floors linked" },
  editNetwork: { ja: "ネットワークを編集", en: "Edit network" },
  saveNetwork: { ja: "ネットワークを保存", en: "Save network" },
  checkNetworkSave: { ja: "状況を確認", en: "Check status" },
  networkSaveContinues: {
    ja: "ネットワーク保存はサーバーで処理中です。しばらくしてから状況を確認してください。",
    en: "Network save is still processing on the server. Check status again shortly.",
  },
  networkSaveCheckFailed: {
    ja: "ネットワーク保存はサーバーで処理中ですが、状況を確認できませんでした。しばらくしてからもう一度確認してください。",
    en: "Network save is still processing, but Kiriko could not check its status. Check status again shortly.",
  },
  directionsPickOrigin: { ja: "地図をタップして出発地を指定", en: "Tap the map to set the origin" },
  directionsPickDestination: { ja: "地図をタップして目的地を指定", en: "Tap the map to set the destination" },
  directionsSearching: { ja: "経路を計算中", en: "Computing the route" },
  directionsNoPath: { ja: "経路が見つかりません", en: "No route found" },
  directionsFailed: { ja: "経路を計算できませんでした", en: "Could not compute the route" },
  directionsClear: { ja: "経路をクリア", en: "Clear route" },
  facilityRouteHere: { ja: "ここへの経路", en: "Route here" },
  facilityClose: { ja: "閉じる", en: "Close" },
  facilityUnnamed: { ja: "施設", en: "Facility" },
  networkCenterPick: { ja: "地図の中心で選択", en: "Pick at map center" },
  networkLoadFailed: { ja: "ネットワークを読み込めませんでした。", en: "Network could not be loaded." },
  networkRetry: { ja: "再試行", en: "Retry" },
  editViewerDenied: {
    ja: "ネットワークデータを編集できるのはメンバーと管理者のみです。",
    en: "Only members and admins can edit network data.",
  },
  sceneRetry3d: { ja: "3D表示を再試行", en: "Retry 3D" },
  sceneUse2d: { ja: "2D表示に切り替え", en: "Switch to 2D" },
  sceneSourceLabel: { ja: "表示ソース", en: "View source" },
  editDesktopOnly: {
    ja: "ネットワーク編集はデスクトップで利用できます。",
    en: "Network editing is available on desktop.",
  },
} as const;

const COMPACT_MQ = "(max-width: 899px)";

function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(COMPACT_MQ).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(COMPACT_MQ);
    const onChange = () => {
      setCompact(mql.matches);
    };
    onChange();
    mql.addEventListener("change", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
    };
  }, []);

  return compact;
}

function themeStyle(): CSSProperties {
  return { fontFamily: kirikoTheme.fontFamily };
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return false;
}

function toVenueLoadError(error: unknown): VenueLoadError {
  if (error instanceof VenueLoadError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "Unknown worker failure";
  return new VenueLoadError("worker_failed", message);
}

function activeVenue(state: ViewerState): ReadyVenueState | null {
  if (state.status === "ready") {
    return {
      fileName: state.fileName,
      loadedVenue: state.loadedVenue,
      selectedLevelId: state.selectedLevelId,
      selectedFeatureId: state.selectedFeatureId,
      searchText: state.searchText,
      searchCategory: state.searchCategory,
    };
  }
  if ((state.status === "loading" || state.status === "error") && state.previous) {
    return state.previous;
  }
  return null;
}

function liveMessage(state: ViewerState): string {
  const locale = state.locale;
  switch (state.status) {
    case "loading":
      return `${ui.loading[locale]}: ${state.fileName}`;
    case "ready":
      return `${ui.ready[locale]}: ${state.fileName}`;
    case "error":
      return ui.error[locale];
    case "empty":
      return ui.empty[locale];
  }
}
type BundleProvenance = {
  datasetId: string;
  version: number;
  /** Permanent 64-hex public version identity; the pin key for every post-load fetch. */
  publicVersionId: string | null;
  /**
   * Server publication sequence. An integrity witness only: pinning uses the
   * public identity, and provenance is pin-safe (see `admittedVersionId`) only
   * when this equals the decoded §1 version. `null` blocks version-scoped surfaces.
   */
  seq: number | null;
  /** Whether the bundle carries a §5 network graph (Directions mode gate). */
  hasGraph: boolean;
  /** Point facilities from §7; empty when absent. */
  facilities: FacilityDto[];
};

interface AcceptedNetworkSave {
  jobId: string;
  publicVersionId: string;
}

interface NetworkSaveState {
  busy: boolean;
  submitting: boolean;
  accepted: AcceptedNetworkSave | null;
  message: string | null;
  error: string | null;
}

const PUBLIC_VERSION_ID = /^[0-9a-f]{64}$/;
const ROUTE_COST_UNITS_PER_METER = 1000;

function parseGdbJobError(raw: string): GdbError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { code: "gdb_conversion_failed", message: raw };
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "code" in parsed) {
    const code = parsed.code;
    if (typeof code === "string") {
      const message = "message" in parsed ? parsed.message : undefined;
      const details = "details" in parsed ? parsed.details : undefined;
      if (details !== null && typeof details === "object" && !Array.isArray(details)) {
        const checkedDetails = details as Record<string, unknown>;
        return {
          code,
          message: typeof message === "string" ? message : raw,
          details: checkedDetails,
        };
      }
      return { code, message: typeof message === "string" ? message : raw };
    }
  }
  return { code: "gdb_conversion_failed", message: raw };
}

function gdbErrorFromUnknown(error: unknown): GdbError {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = error.code;
    if (typeof code === "string") {
      const message = "message" in error ? error.message : undefined;
      return { code, message: typeof message === "string" ? message : code };
    }
  }
  return {
    code: "gdb_conversion_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function navigateTo(href: string): void {
  const event = new CustomEvent("kiriko:navigate", { cancelable: true, detail: { href } });
  if (window.dispatchEvent(event)) {
    window.location.assign(href);
  }
}

type IssueMode =
  | { kind: "hidden" }
  | { kind: "identity_error" }
  | { kind: "ready"; publicVersionId: string };

type ViewerLoadResult = {
  venue: LoadedVenue;
  provenance: BundleProvenance | null;
};

interface LoadAttempt {
  fileName: string;
  loadVenue: (signal: AbortSignal) => Promise<ViewerLoadResult>;
  requestedLevel?: string;
}

type DirectionsStatus = "idle" | "loading" | "error";

interface DirectionsState {
  active: boolean;
  origin: RouteEndpoint | null;
  destination: RouteEndpoint | null;
  route: RouteResultDto | null;
  status: DirectionsStatus;
  /** Destination pre-set by "Route here"; consumed on the next origin tap. */
  pendingDestination: RouteEndpoint | null;
}

const INITIAL_DIRECTIONS: DirectionsState = {
  active: false,
  origin: null,
  destination: null,
  route: null,
  status: "idle",
  pendingDestination: null,
};

export function App() {
  const params = useMemo(() => parseViewerParams(window.location.search), []);
  const embed = params.embed;
  const [state, dispatch] = useReducer(viewerReducer, params, (p) => ({
    ...initialViewerState,
    ...(p.locale !== null ? { locale: p.locale } : {}),
  }));
  const mountedRef = useRef(true);
  const attemptTokenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const retryAttemptRef = useRef<LoadAttempt | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const compact = useCompactLayout();
  const [mapDragActive, setMapDragActive] = useState(false);
  const [activePanel, setActivePanel] = useState<RailPanelId | null>(() =>
    embed ||
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(COMPACT_MQ).matches)
      ? null
      : "search",
  );
  const [layerVisibility, setLayerVisibility] = useState(defaultLayerVisibility);
  const [mapControls, setMapControls] = useState<IndoorMapControls | null>(null);
  // The venue's 3D scene, loaded only when `?scene` opts in. Null keeps the
  // viewer exactly 2D.
  const [scene, setScene] = useState<SceneView | null>(null);
  // The capability floor is probed once per session, before anything is
  // fetched: a device that cannot render 3D must not pay for a scene download.
  const sceneCapability = useMemo(() => probeSceneCapability(), []);
  const reducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
    [],
  );
  const [sourceState, setSourceState] = useState(() =>
    initialSceneSource({
      requested: params.scene,
      capabilitySupported: sceneCapability.supported,
      reducedMotion,
    }),
  );
  const dispatchSource = useCallback(
    (event: SceneSourceEvent) => {
      setSourceState((current) => reduceSceneSource(current, event, { reducedMotion }));
    },
    [reducedMotion],
  );
  // The veil is a brief cover over a source swap, never a crossfade. Clearing
  // it on a timer is what keeps the swap from lingering as a visible state.
  useEffect(() => {
    if (!sourceState.veil) {
      return;
    }
    const timer = window.setTimeout(() => {
      dispatchSource({ type: "veil_finished" });
    }, 160);
    return () => {
      window.clearTimeout(timer);
    };
  }, [sourceState.veil, dispatchSource]);
  const [linkCopied, setLinkCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bundleProvenance, setBundleProvenance] = useState<BundleProvenance | null>(null);
  const [directions, setDirections] = useState<DirectionsState>(INITIAL_DIRECTIONS);
  const [reviewActive, setReviewActive] = useState(false);
  const [reviewNetwork, setReviewNetwork] = useState<ParsedNetwork | null>(null);
  const [networkLoadState, setNetworkLoadState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [networkLoadAttempt, setNetworkLoadAttempt] = useState(0);
  const [editor, setEditor] = useState<NetworkEditorState | null>(null);
  const [discardArmed, setDiscardArmed] = useState(false);
  const dispatchEditor = useCallback((action: NetworkEditorAction) => {
    setEditor((current) => (current === null ? current : networkEditorReducer(current, action)));
  }, []);
  // The published overlay is the immutable baseline; the editor's working copy
  // (when editing) is what renders, reports connectivity, and serializes.
  const editedNetwork = editor?.present ?? reviewNetwork;
  const reviewReport = useMemo(
    () => (editedNetwork ? networkConnectivity(editedNetwork) : null),
    [editedNetwork],
  );
  const [networkSave, setNetworkSave] = useState<NetworkSaveState>({
    busy: false,
    submitting: false,
    accepted: null,
    message: null,
    error: null,
  });
  const networkSaveAttemptRef = useRef(0);
  const networkSaveAbortRef = useRef<AbortController | null>(null);
  const networkSaveLocked = networkSave.busy || networkSave.submitting || networkSave.accepted !== null;
  const networkSaveActionDisabled = networkSave.busy || networkSave.submitting || state.status === "loading";
  const resetNetworkSave = useCallback(() => {
    networkSaveAttemptRef.current += 1;
    networkSaveAbortRef.current?.abort();
    networkSaveAbortRef.current = null;
    setNetworkSave({ busy: false, submitting: false, accepted: null, message: null, error: null });
  }, []);
  const pauseNetworkSavePolling = useCallback(() => {
    networkSaveAttemptRef.current += 1;
    networkSaveAbortRef.current?.abort();
    networkSaveAbortRef.current = null;
    setNetworkSave((current) =>
      current.accepted === null
        ? { busy: false, submitting: current.submitting, accepted: null, message: null, error: null }
        : { busy: false, submitting: false, accepted: current.accepted, message: current.message, error: null },
    );
  }, []);
  const directionsTokenRef = useRef(0);
  // The admitted pin identity is the permanent 64-hex public version id, but
  // only when the loader also confirmed integrity (its seq matched the decoded
  // §1 version). A null identity gates every version-scoped surface: pinned
  // bundle fetches, graph operations, issue auth/SSE/UI, and share/embed links.
  const admittedVersionId =
    bundleProvenance !== null &&
    bundleProvenance.publicVersionId !== null &&
    bundleProvenance.seq !== null
      ? bundleProvenance.publicVersionId
      : null;
  const networkSaveBaseRef = useRef({ dataset: params.dataset, admittedVersionId });
  networkSaveBaseRef.current = { dataset: params.dataset, admittedVersionId };
  const issueMode: IssueMode = params.embed
    ? { kind: "hidden" as const }
    : bundleProvenance === null
      ? { kind: "hidden" as const }
      : admittedVersionId === null
        ? { kind: "identity_error" as const }
        : { kind: "ready" as const, publicVersionId: admittedVersionId };
  const issuePublicVersionId =
    issueMode.kind === "ready" ? issueMode.publicVersionId : null;
  const issueController = useIssueSync(issuePublicVersionId);
  const [authVersionId, setAuthVersionId] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<ApiUser | null>(null);
  const [reviewers, setReviewers] = useState<ReviewerSummary[]>([]);
  const [authError, setAuthError] = useState(false);
  const [authAttempt, setAuthAttempt] = useState(0);
  const [signInOpen, setSignInOpen] = useState(false);
  const authGenerationRef = useRef(0);
  const issuePublicVersionIdRef = useRef(issuePublicVersionId);
  issuePublicVersionIdRef.current = issuePublicVersionId;

  useEffect(() => {
    const generation = authGenerationRef.current + 1;
    authGenerationRef.current = generation;
    setAuthVersionId(issuePublicVersionId);
    setCurrentUser(null);
    setReviewers([]);
    setAuthError(false);
    setSignInOpen(false);

    if (issuePublicVersionId === null) {
      return () => {
        if (authGenerationRef.current === generation) {
          authGenerationRef.current += 1;
        }
      };
    }

    const isCurrent = () =>
      authGenerationRef.current === generation &&
      issuePublicVersionIdRef.current === issuePublicVersionId;
    void api.me().then(
      (user) => {
        if (!isCurrent()) {
          return;
        }
        setCurrentUser(user);
        if (user === null) {
          return;
        }
        void issueApi.listReviewers().then(
          (nextReviewers) => {
            if (isCurrent()) {
              setReviewers(nextReviewers);
            }
          },
          () => {
            if (isCurrent()) {
              setAuthError(true);
            }
          },
        );
      },
      () => {
        if (isCurrent()) {
          setAuthError(true);
        }
      },
    );

    return () => {
      if (authGenerationRef.current === generation) {
        authGenerationRef.current += 1;
      }
    };
  }, [authAttempt, issuePublicVersionId]);

  const issueCurrentUser =
    authVersionId === issuePublicVersionId ? currentUser : null;
  const issueReviewers =
    authVersionId === issuePublicVersionId ? reviewers : [];

  const locale = state.locale;
  const venueState = activeVenue(state);

  // Every post-admission bundle fetch (directions, network overlay) pins to the
  // admitted public identity, never mutable latest. Null when no dataset is
  // loaded or no pin-safe identity was admitted.
  const pinnedBundleUrl = useMemo(() => {
    if (params.dataset === null || admittedVersionId === null) {
      return null;
    }
    return datasetBundleUrl(params.dataset, admittedVersionId);
  }, [params.dataset, admittedVersionId]);

  // Directions mode is gated on the decoded bundle's §5 graph and an admitted
  // pin-safe public identity (bundle loads only — a ZIP import has no graph).
  const directionsAvailable =
    !embed && venueState !== null && bundleProvenance?.hasGraph === true && pinnedBundleUrl !== null;

  // Active floor for network editing: new points land here, and the toolbar
  // names it. A ref keeps the map's onPick callback stable across floor changes.
  const activeLevel =
    venueState?.loadedVenue.levels.find((level) => level.id === venueState.selectedLevelId) ?? null;
  const activeOrdinal =
    venueState !== null
      ? ordinalOfLevel(venueState.loadedVenue.levels, venueState.selectedLevelId) ?? 0
      : 0;
  const activeFloorLabel =
    activeLevel !== null && venueState !== null
      ? localizedLabel(
          activeLevel.shortName,
          locale,
          activeLevel.id,
          venueState.loadedVenue.manifest.language,
        )
      : "";
  const activeOrdinalRef = useRef(activeOrdinal);
  activeOrdinalRef.current = activeOrdinal;
  const changeSummary = editor !== null ? summarizeNetworkChanges(editor) : null;
  const editorDirty = changeSummary !== null && hasNetworkChanges(changeSummary);
  // A status check retries an accepted job; a fresh save needs real, valid
  // changes. Both are blocked while a save is in flight or a venue is loading
  // (networkSaveActionDisabled), mirroring saveNetwork's own guard.
  const networkCheckStatus = networkSave.accepted !== null && !networkSave.busy;
  const networkSaveBlocker =
    editedNetwork !== null ? networkSaveProblem(editedNetwork) : "missing_junction";
  const networkCanSave =
    !networkSaveActionDisabled &&
    (networkCheckStatus ||
      (editorDirty && networkSaveBlocker === null && networkSave.accepted === null));

  const [selectedFacility, setSelectedFacility] = useState<FacilityDto | null>(null);

  // A new venue (or dropping back to no bundle) resets any in-flight picks.
  useEffect(() => {
    directionsTokenRef.current += 1;
    setDirections(INITIAL_DIRECTIONS);
    setSelectedFacility(null);
    setReviewActive(false);
    setReviewNetwork(null);
    setNetworkLoadState("idle");
    setNetworkLoadAttempt(0);
    setEditor(null);
    setDiscardArmed(false);
    resetNetworkSave();
  }, [bundleProvenance, resetNetworkSave]);

  // Network-review overlay: load the generated network on demand the first
  // time review is switched on for this dataset (main-thread wasm export).
  // Tracks explicit load state so Edit can gate on a ready graph and a failure
  // is retryable instead of silent. `networkLoadAttempt` bumps to force a retry.
  useEffect(() => {
    if (!reviewActive || reviewNetwork !== null) {
      return;
    }
    if (pinnedBundleUrl === null) {
      return;
    }
    let cancelled = false;
    setNetworkLoadState("loading");
    void loadNetworkOverlay(pinnedBundleUrl).then(
      (parsed) => {
        if (cancelled) return;
        setReviewNetwork(parsed);
        setNetworkLoadState("ready");
      },
      () => {
        if (!cancelled) setNetworkLoadState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reviewActive, reviewNetwork, pinnedBundleUrl, networkLoadAttempt]);

  // Deep-link `?review=1` from the gallery opens straight into the overlay.
  useEffect(() => {
    if (params.review && !embed && bundleProvenance?.hasGraph === true) {
      setReviewActive(true);
    }
  }, [bundleProvenance, embed]);

  const fireRoute = useCallback(
    (origin: RouteEndpoint, destination: RouteEndpoint) => {
      if (pinnedBundleUrl === null) {
        return;
      }
      const token = directionsTokenRef.current + 1;
      directionsTokenRef.current = token;
      setDirections((current) => ({ ...current, destination, route: null, status: "loading" }));
      void routeKirikoBundle(pinnedBundleUrl, origin, destination).then(
        (route) => {
          if (directionsTokenRef.current === token) {
            setDirections((current) => ({ ...current, route, status: "idle" }));
          }
        },
        () => {
          if (directionsTokenRef.current === token) {
            setDirections((current) => ({ ...current, route: null, status: "error" }));
          }
        },
      );
    },
    [pinnedBundleUrl],
  );

  const onDirectionsPick = useCallback(
    (point: { longitude: number; latitude: number }) => {
      const venue = activeVenue(state);
      if (venue === null) {
        return;
      }
      const ordinal =
        venue.loadedVenue.levels.find((level) => level.id === venue.selectedLevelId)?.ordinal ?? 0;
      const endpoint: RouteEndpoint = { ...point, ordinal };
      if (directions.pendingDestination !== null && directions.origin === null) {
        // "Route here" pre-set the destination; this first tap is the origin.
        const dest = directions.pendingDestination;
        setDirections((current) => ({ ...current, origin: endpoint, pendingDestination: null }));
        fireRoute(endpoint, dest);
        return;
      }
      if (directions.origin === null || directions.destination !== null) {
        // First pick (or a re-pick after a completed route) starts over.
        directionsTokenRef.current += 1;
        setDirections((current) => ({
          ...current,
          origin: endpoint,
          destination: null,
          route: null,
          status: "idle",
        }));
        return;
      }
      fireRoute(directions.origin, endpoint);
    },
    [directions.origin, directions.destination, directions.pendingDestination, fireRoute, state],
  );

  const clearDirections = useCallback(() => {
    directionsTokenRef.current += 1;
    setDirections((current) => ({ ...INITIAL_DIRECTIONS, active: current.active }));
  }, []);

  const toggleDirections = useCallback(() => {
    directionsTokenRef.current += 1;
    setDirections((current) => ({ ...INITIAL_DIRECTIONS, active: !current.active }));
  }, []);

  const toggleReview = useCallback(() => {
    if (!reviewActive) {
      setReviewActive(true);
      return;
    }
    // Turning review off while editing dirty arms the discard confirmation
    // rather than silently dropping edits.
    if (editor !== null && editorDirty) {
      setDiscardArmed(true);
      return;
    }
    setEditor(null);
    setDiscardArmed(false);
    setReviewActive(false);
  }, [reviewActive, editor, editorDirty]);

  const onNetworkPick = useCallback(
    (pick: NetworkMapPick) => {
      dispatchEditor({ type: "pick", pick, activeOrdinal: activeOrdinalRef.current });
    },
    [dispatchEditor],
  );

  const saveNetwork = useCallback(async () => {
    const dataset = params.dataset;
    // The edited graph must be based on the EXACT admitted published version,
    // so a valid admitted public identity is required to save.
    if (editedNetwork === null || dataset === null || admittedVersionId === null || networkSaveActionDisabled) {
      return;
    }
    // A fresh submission needs real, saveable changes; a status check on an
    // already-accepted job bypasses that gate so the user can keep retrying.
    if (
      networkSave.accepted === null &&
      (!editorDirty || networkSaveProblem(editedNetwork) !== null)
    ) {
      return;
    }

    networkSaveAbortRef.current?.abort();
    const controller = new AbortController();
    networkSaveAbortRef.current = controller;
    const token = networkSaveAttemptRef.current + 1;
    networkSaveAttemptRef.current = token;
    const isCurrent = () => token === networkSaveAttemptRef.current && !controller.signal.aborted;
    let accepted = networkSave.accepted;
    setNetworkSave({ busy: true, submitting: accepted === null, accepted, message: null, error: null });

    try {
      if (accepted === null) {
        const { junctions, paths } = serializeNetwork(editedNetwork);
        const response = await api.importNetwork(dataset, admittedVersionId, junctions, paths);
        accepted = { jobId: response.jobId, publicVersionId: response.publicVersionId };
        if (!isCurrent()) {
          const current = networkSaveBaseRef.current;
          if (
            mountedRef.current &&
            current.dataset === dataset &&
            current.admittedVersionId === admittedVersionId &&
            PUBLIC_VERSION_ID.test(response.publicVersionId)
          ) {
            setNetworkSave((state) =>
              state.accepted === null
                ? { busy: false, submitting: false, accepted, message: null, error: null }
                : state,
            );
          }
          return;
        }
        setNetworkSave({ busy: true, submitting: false, accepted, message: null, error: null });
      }

      const job = await api.waitForJob(accepted.jobId, { signal: controller.signal });
      if (!isCurrent()) {
        return;
      }
      if (job.status === "done") {
        setNetworkSave({ busy: false, submitting: false, accepted: null, message: null, error: null });
        navigateTo(viewerHref(dataset, accepted.publicVersionId, locale, true));
        return;
      }
      if (job.status === "timeout") {
        setNetworkSave({
          busy: false,
          submitting: false,
          accepted,
          message: ui.networkSaveContinues[locale],
          error: null,
        });
        return;
      }
      setNetworkSave({
        busy: false,
        submitting: false,
        accepted: null,
        message: null,
        error: gdbErrorMessage(parseGdbJobError(job.error), locale),
      });
    } catch (error) {
      if (!isCurrent() || isAbortError(error)) {
        if (!isAbortError(error) && accepted === null) {
          const current = networkSaveBaseRef.current;
          if (
            mountedRef.current &&
            current.dataset === dataset &&
            current.admittedVersionId === admittedVersionId
          ) {
            setNetworkSave((state) =>
              state.accepted === null
                ? {
                    busy: false,
                    submitting: false,
                    accepted: null,
                    message: null,
                    error: gdbErrorMessage(gdbErrorFromUnknown(error), locale),
                  }
                : state,
            );
          }
        }
        return;
      }
      if (accepted !== null) {
        setNetworkSave({
          busy: false,
          submitting: false,
          accepted,
          message: ui.networkSaveCheckFailed[locale],
          error: null,
        });
        return;
      }
      setNetworkSave({
        busy: false,
        submitting: false,
        accepted: null,
        message: null,
        error: gdbErrorMessage(gdbErrorFromUnknown(error), locale),
      });
    } finally {
      if (token === networkSaveAttemptRef.current) {
        networkSaveAbortRef.current = null;
      }
    }
  }, [
    params.dataset,
    admittedVersionId,
    editedNetwork,
    editorDirty,
    networkSave,
    networkSaveActionDisabled,
    locale,
  ]);

  const routeToFacility = useCallback((facility: FacilityDto) => {
    setSelectedFacility(null);
    if (facility.anchor === null) {
      return;
    }
    const dest: RouteEndpoint = {
      longitude: facility.anchor.lon,
      latitude: facility.anchor.lat,
      ordinal: facility.anchor.ordinal,
    };
    directionsTokenRef.current += 1;
    setDirections({ ...INITIAL_DIRECTIONS, active: true, pendingDestination: dest });
  }, []);

  const directionsMapProps = useMemo<DirectionsMapProps | null>(
    () =>
      directionsAvailable
        ? {
            active: directions.active,
            origin: directions.origin,
            destination: directions.destination,
            route: directions.route,
            onPickPoint: onDirectionsPick,
          }
        : null,
    [directions.active, directions.destination, directions.origin, directions.route, directionsAvailable, onDirectionsPick],
  );

  const searchResults = useMemo(() => {
    if (!venueState) {
      return [] as SearchResult[];
    }
    return searchVenue(venueState.loadedVenue.searchEntries, {
      text: venueState.searchText,
      category: venueState.searchCategory,
      locale,
      levelId: venueState.selectedLevelId,
    });
  }, [venueState, locale]);

  const selectedFeature = useMemo(() => {
    if (!venueState) {
      return null;
    }
    return resolveSelectedFeature(venueState.loadedVenue, venueState.selectedFeatureId);
  }, [venueState]);

  const venueName = useMemo(() => {
    if (!venueState) {
      return null;
    }
    return localizedLabel(
      venueState.loadedVenue.venue.labels,
      locale,
      venueState.loadedVenue.venue.id,
      venueState.loadedVenue.manifest.language,
    );
  }, [venueState, locale]);

  const levelName = useMemo(() => {
    if (!venueState) {
      return null;
    }
    const level = venueState.loadedVenue.levels.find(
      (entry) => entry.id === venueState.selectedLevelId,
    );
    if (!level) {
      return null;
    }
    return localizedLabel(level.label, locale, level.id, venueState.loadedVenue.manifest.language);
  }, [venueState, locale]);

  const selectedFeatureName = useMemo(() => {
    if (!venueState || !selectedFeature) {
      return null;
    }
    return localizedLabel(
      selectedFeature.labels,
      locale,
      selectedFeature.id,
      venueState.loadedVenue.manifest.language,
    );
  }, [venueState, selectedFeature, locale]);

  const [issueCameraRequest, setIssueCameraRequest] =
    useState<IssueReviewMapProps["cameraRequest"]>(null);
  const issueCameraKeyRef = useRef(0);
  const placementCapturedRef = useRef(false);
  const restorePlacementFocusRef = useRef(false);

  const canonicalIssues = issueController.state.collection?.issues ?? [];
  const activeIssueCount = countActiveIssues(canonicalIssues);
  const selectedIssue =
    issueController.state.selectedIssueId === null
      ? null
      : canonicalIssues.find(({ id }) => id === issueController.state.selectedIssueId) ?? null;
  const selectedIssueFeatureId =
    venueState !== null &&
    selectedIssue?.anchor.featureId !== undefined &&
    venueState.loadedVenue.featuresById.has(selectedIssue.anchor.featureId)
      ? selectedIssue.anchor.featureId
      : null;
  const issuePins = useMemo(
    () =>
      issuePublicVersionId === null || venueState === null
        ? []
        : projectPins(
            canonicalIssues,
            levelIdsForOrdinal(
              venueState.loadedVenue.levels,
              ordinalOfLevel(venueState.loadedVenue.levels, venueState.selectedLevelId) ?? NaN,
            ),
            issueController.state.filter,
            issueCurrentUser?.id ?? null,
            locale,
          ),
    [
      canonicalIssues,
      issueController.state.filter,
      issueCurrentUser?.id,
      issuePublicVersionId,
      locale,
      venueState,
    ],
  );

  useEffect(() => {
    setIssueCameraRequest(null);
    placementCapturedRef.current = false;
    restorePlacementFocusRef.current = false;
  }, [issuePublicVersionId]);

  useEffect(() => {
    if (issueMode.kind === "hidden") {
      setActivePanel((current) => (current === "issues" ? null : current));
    }
  }, [issueMode.kind]);

  useEffect(() => {
    if (
      !restorePlacementFocusRef.current ||
      activePanel !== "issues" ||
      issueController.state.placementActive
    ) {
      return;
    }
    const target = document.querySelector<HTMLButtonElement>(
      ".floating-panel--issues .issues-panel__footer .btn-primary",
    );
    if (target !== null) {
      restorePlacementFocusRef.current = false;
      target.focus();
    }
  }, [activePanel, issueController.state.placementActive]);

  const retryIssueAuth = useCallback(() => {
    setAuthAttempt((current) => current + 1);
  }, []);

  const [editDenied, setEditDenied] = useState(false);
  const pendingEditRef = useRef(false);
  const enterEditRef = useRef<(() => void) | null>(null);

  const requestSignIn = useCallback(() => {
    const publicVersionId = issuePublicVersionIdRef.current;
    if (publicVersionId === null) {
      return;
    }
    authGenerationRef.current += 1;
    setCurrentUser(null);
    setAuthVersionId(publicVersionId);
    setReviewers([]);
    setAuthError(false);
    setSignInOpen(true);
  }, []);

  const handleSignedIn = useCallback((user: ApiUser) => {
    const publicVersionId = issuePublicVersionIdRef.current;
    if (publicVersionId === null) {
      setSignInOpen(false);
      return;
    }
    const generation = authGenerationRef.current + 1;
    authGenerationRef.current = generation;
    setAuthVersionId(publicVersionId);
    setCurrentUser(user);
    setReviewers([]);
    setAuthError(false);
    setSignInOpen(false);

    // Resume a network-edit request that opened the sign-in modal.
    if (pendingEditRef.current) {
      pendingEditRef.current = false;
      if (user.role === "viewer") {
        setEditDenied(true);
      } else {
        enterEditRef.current?.();
      }
    }

    void issueApi.listReviewers().then(
      (nextReviewers) => {
        if (
          authGenerationRef.current === generation &&
          issuePublicVersionIdRef.current === publicVersionId
        ) {
          setReviewers(nextReviewers);
        }
      },
      () => {
        if (
          authGenerationRef.current === generation &&
          issuePublicVersionIdRef.current === publicVersionId
        ) {
          setAuthError(true);
        }
      },
    );
  }, []);

  const beginNetworkEdit = useCallback(() => {
    if (reviewNetwork === null || networkLoadState !== "ready") {
      return;
    }
    setEditDenied(false);
    setDirections(INITIAL_DIRECTIONS);
    setSelectedFacility(null);
    dispatch({ type: "select_feature", featureId: null });
    setDiscardArmed(false);
    setEditor(createNetworkEditorState(reviewNetwork));
  }, [reviewNetwork, networkLoadState]);
  enterEditRef.current = beginNetworkEdit;

  const enterNetworkEdit = useCallback(() => {
    const role = currentUser?.role ?? null;
    if (role === null) {
      // Anonymous: open sign-in and resume the edit once authenticated.
      pendingEditRef.current = true;
      requestSignIn();
      return;
    }
    if (role === "viewer") {
      setEditDenied(true);
      return;
    }
    beginNetworkEdit();
  }, [currentUser, requestSignIn, beginNetworkEdit]);

  const requestDiscard = useCallback(() => {
    // Clean exit is immediate; a dirty exit arms the inline confirmation.
    if (editor !== null && editorDirty) {
      setDiscardArmed(true);
    } else {
      setEditor(null);
      setDiscardArmed(false);
    }
  }, [editor, editorDirty]);

  const confirmDiscard = useCallback(() => {
    setEditor(null);
    setDiscardArmed(false);
  }, []);

  const cancelDiscard = useCallback(() => {
    setDiscardArmed(false);
  }, []);

  const startNetworkMove = useCallback(
    (nodeId: number) => {
      dispatchEditor({ type: "start_move", nodeId });
    },
    [dispatchEditor],
  );

  // A change of auth or review state retires any stale edit-denied message.
  useEffect(() => {
    setEditDenied(false);
  }, [currentUser, reviewActive]);

  // Editor keyboard shortcuts, owned by the toolbar interaction (not inputs).
  useEffect(() => {
    if (editor === null) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && (event.key === "z" || event.key === "Z")) {
        event.preventDefault();
        dispatchEditor({ type: event.shiftKey ? "redo" : "undo" });
        return;
      }
      if (mod) {
        return;
      }
      if (event.key === "Escape") {
        if (discardArmed) {
          setDiscardArmed(false);
        } else {
          dispatchEditor({ type: "cancel_pending" });
        }
        return;
      }
      switch (event.key.toLowerCase()) {
        case "s":
          dispatchEditor({ type: "set_tool", tool: "select" });
          break;
        case "p":
          dispatchEditor({ type: "set_tool", tool: "add-junction" });
          break;
        case "c":
          dispatchEditor({ type: "set_tool", tool: "connect" });
          break;
        case "d":
          dispatchEditor({ type: "set_tool", tool: "delete" });
          break;
        case "delete":
        case "backspace":
          dispatchEditor({ type: "delete_selection" });
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor, discardArmed, dispatchEditor]);

  // Warn before unloading the tab with unsaved network edits.
  useEffect(() => {
    if (!editorDirty) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editorDirty]);

  const selectIssueFromQueue = useCallback(
    (issueId: string) => {
      issueController.ui.selectIssue(issueId);
      const issue = issueController.state.collection?.issues.find(({ id }) => id === issueId);
      if (issue === undefined) {
        return;
      }
      dispatch({ type: "select_level", levelId: issue.anchor.levelId });
      issueCameraKeyRef.current += 1;
      setIssueCameraRequest({
        key: issueCameraKeyRef.current,
        levelId: issue.anchor.levelId,
        longitude: issue.anchor.longitude,
        latitude: issue.anchor.latitude,
      });
    },
    [issueController.state.collection, issueController.ui],
  );

  const issuesPanelController = useMemo(
    () => ({
      ...issueController,
      ui: {
        ...issueController.ui,
        selectIssue: selectIssueFromQueue,
      },
    }),
    [issueController, selectIssueFromQueue],
  );

  const selectIssueFromPin = useCallback(
    (issueId: string) => {
      issueController.ui.selectIssue(issueId);
      setActivePanel("issues");
    },
    [issueController.ui],
  );

  const beginIssuePlacement = useCallback(() => {
    placementCapturedRef.current = false;
    restorePlacementFocusRef.current = false;
    dispatch({ type: "select_feature", featureId: null });
    issueController.ui.setPlacement(true);
    if (compact) {
      setActivePanel(null);
    }
  }, [compact, issueController.ui]);

  const cancelIssuePlacement = useCallback(() => {
    placementCapturedRef.current = false;
    restorePlacementFocusRef.current = true;
    issueController.ui.setPlacement(false);
    setActivePanel("issues");
  }, [issueController.ui]);

  const placeIssue = useCallback(
    (anchor: IssuePlacementAnchor) => {
      if (!issueController.state.placementActive || placementCapturedRef.current) {
        return;
      }
      placementCapturedRef.current = true;
      issueController.ui.startDraft({
        levelId: anchor.levelId,
        longitude: anchor.longitude,
        latitude: anchor.latitude,
        ...(anchor.featureId === null ? {} : { featureId: anchor.featureId }),
      });
      issueController.ui.setPlacement(false);
      setActivePanel("issues");
    },
    [issueController.state.placementActive, issueController.ui],
  );

  const issueReview = useMemo<IssueReviewMapProps | null>(
    () =>
      issuePublicVersionId === null || venueState === null
        ? null
        : {
            placementMode: issueController.state.placementActive,
            onPlaceIssue: placeIssue,
            pins: issuePins,
            selectedIssueId: issueController.state.selectedIssueId,
            onSelectIssue: selectIssueFromPin,
            featureId: selectedIssueFeatureId,
            cameraRequest: issueCameraRequest,
          },
    [
      issueCameraRequest,
      issueController.state.placementActive,
      issueController.state.selectedIssueId,
      issuePins,
      issuePublicVersionId,
      placeIssue,
      selectIssueFromPin,
      selectedIssueFeatureId,
      venueState,
    ],
  );

  const runLoad = useCallback(
    (
      fileName: string,
      loadVenue: (signal: AbortSignal) => Promise<ViewerLoadResult>,
      requestedLevel?: string,
    ) => {
      retryAttemptRef.current = {
        fileName,
        loadVenue,
        ...(requestedLevel !== undefined ? { requestedLevel } : {}),
      };
      pauseNetworkSavePolling();
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const token = attemptTokenRef.current + 1;
      attemptTokenRef.current = token;

      dispatch({ type: "load_started", fileName });

      void loadVenue(controller.signal)
        .then((result) => {
          if (token !== attemptTokenRef.current) {
            return;
          }
          retryAttemptRef.current = null;
          setBundleProvenance(result.provenance);
          dispatch({
            type: "load_succeeded",
            fileName,
            venue: result.venue,
            ...(requestedLevel !== undefined ? { requestedLevel } : {}),
          });
        })
        .catch((error: unknown) => {
          if (token !== attemptTokenRef.current) {
            return;
          }
          if (isAbortError(error)) {
            return;
          }
          dispatch({ type: "load_failed", fileName, error: toVenueLoadError(error) });
        })
        .finally(() => {
          if (token === attemptTokenRef.current) {
            abortRef.current = null;
          }
        });
    },
    [pauseNetworkSavePolling],
  );

  const handleFile = useCallback(
    (file: File) => {
      runLoad(file.name, async (signal) => ({
        venue: await loadImdfArchive(file, signal),
        provenance: null,
      }));
    },
    [runLoad],
  );

  const retryLatestLoad = useCallback(() => {
    const attempt = retryAttemptRef.current;
    if (attempt === null) {
      return;
    }
    runLoad(attempt.fileName, attempt.loadVenue, attempt.requestedLevel);
  }, [runLoad]);

  const loadFromParams = useCallback(() => {
    const requestedLevel = params.level ?? undefined;
    if (params.src !== null) {
      const src = params.src;
      runLoad(
        fileNameFromSrc(src),
        async (signal) => {
          const file = await fetchImdfFile(src, signal);
          return {
            venue: await loadImdfArchive(file, signal),
            provenance: null,
          };
        },
        requestedLevel,
      );
      return;
    }
    if (params.dataset !== null) {
      const dataset = params.dataset;
      // Pin the initial fetch to `?version=N` when present; otherwise admit
      // mutable latest and record the exact sequence it returns.
      const bundleUrl = datasetBundleUrl(dataset, params.version ?? undefined);
      runLoad(
        dataset,
        async (signal) => {
          const result = await loadKirikoBundle(bundleUrl, signal);
          return {
            venue: result.venue,
            provenance: {
              ...result.metadata,
              publicVersionId: result.publicVersionId,
              seq: result.seq,
              hasGraph: result.hasGraph,
              facilities: result.facilities,
            },
          };
        },
        requestedLevel,
      );
    }
  }, [runLoad, params]);

  // 3D scene: fetched and compiled off-thread only when `?scene` opts in and a
  // published dataset is being viewed. A venue with no scene resolves absent
  // and the viewer stays 2D.
  // Which 3D source is active is the *result* of this effect, not an input to
  // it: depending on `active` would re-run the load when the ladder settles on
  // tiles and download the document a second time.
  const render3d = params.scene && sourceState.active !== "fallback2d";
  useEffect(() => {
    if (!render3d || params.dataset === null) {
      setScene(null);
      return;
    }
    const dataset = params.dataset;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      // Decode is everything between asking for the scene and holding typed
      // views over it: fetch, the worker's compile, and the reader. Measured
      // here because that is the span a reviewer waits through, and the
      // performance harness asserts it (#26 section 4).
      performance.mark(SCENE_DECODE_START);
      try {
        // The activated package first: it is the top of the ladder, and asking
        // for it is also how the viewer learns whether this version has one —
        // a venue without a package answers 404, which is an absent source
        // rather than a failure.
        const tiles = await loadKirikoScene(
          datasetSceneUrl(dataset, params.version ?? undefined),
          controller.signal,
          "package",
        );
        if (cancelled) {
          return;
        }
        if (tiles !== null) {
          setScene(readScene(tiles));
          performance.measure(SCENE_DECODE_MEASURE, SCENE_DECODE_START);
          dispatchSource({ type: "tiles_ready" });
          return;
        }
        const described = await loadKirikoScene(
          datasetBundleUrl(dataset, params.version ?? undefined),
          controller.signal,
        );
        if (cancelled) {
          return;
        }
        if (described === null) {
          // The bundle carries no renderable scene: nothing failed, there is
          // simply nothing to render, and the venue stays 2D.
          setScene(null);
          dispatchSource({ type: "load_failed" });
          return;
        }
        setScene(readScene(described));
        performance.measure(SCENE_DECODE_MEASURE, SCENE_DECODE_START);
        dispatchSource({ type: "scene_ready" });
      } catch {
        // The 2D venue is already usable; a scene that cannot load must not
        // take it down with it.
        if (!cancelled) {
          setScene(null);
          dispatchSource({ type: "load_failed" });
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [render3d, params.dataset, params.version, dispatchSource]);

  useEffect(() => {
    loadFromParams();
  }, [loadFromParams]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      networkSaveAttemptRef.current += 1;
      networkSaveAbortRef.current?.abort();
      abortRef.current?.abort();
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const openPicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onSelectResult = useCallback(
    (result: SearchResult) => {
      if (result.levelId === null) {
        dispatch({ type: "select_feature", featureId: result.featureId });
      } else {
        dispatch({ type: "select_feature", featureId: result.featureId, levelId: result.levelId });
      }
      // On compact, the sheet covers the map; close it so the selection shows.
      if (compact) {
        setActivePanel(null);
      }
    },
    [compact],
  );

  const onMapSelectFeature = useCallback((featureId: string | null) => {
    dispatch({ type: "select_feature", featureId });
  }, []);

  const onToggleRail = useCallback((panel: RailPanelId) => {
    setActivePanel((current) => (current === panel ? null : panel));
  }, []);

  const onToggleLayer = useCallback((group: MapLayerGroup) => {
    setLayerVisibility((current) => ({ ...current, [group]: !current[group] }));
  }, []);

  const onControls = useCallback((controls: IndoorMapControls | null) => {
    setMapControls(controls);
  }, []);

  const copyViewLink = useCallback(() => {
    const url = new URL(window.location.href);
    if (venueState) {
      url.searchParams.set("level", venueState.selectedLevelId);
    }
    url.searchParams.set("lang", locale);
    // Drop any inbound `version` and re-add only the admitted public identity,
    // so a stale/unpinned load never leaks a wrong version into the shared link.
    url.searchParams.delete("version");
    if (admittedVersionId !== null) {
      url.searchParams.set("version", admittedVersionId);
    }
    void navigator.clipboard
      .writeText(url.toString())
      .then(() => {
        setLinkCopied(true);
        if (copiedTimerRef.current !== null) {
          clearTimeout(copiedTimerRef.current);
        }
        copiedTimerRef.current = setTimeout(() => {
          setLinkCopied(false);
        }, 2000);
      })
      .catch(() => {
        // Clipboard unavailable (permissions, insecure context) — no feedback.
      });
  }, [venueState, locale, admittedVersionId]);

  const onMapDragOver = useCallback((event: DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    setMapDragActive(true);
  }, []);

  const onMapDragLeave = useCallback((event: DragEvent) => {
    event.preventDefault();
    setMapDragActive(false);
  }, []);

  const onMapDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      setMapDragActive(false);
      const file = event.dataTransfer.files[0];
      if (file && file.name.toLowerCase().endsWith(".zip")) {
        handleFile(file);
      }
    },
    [handleFile],
  );

  const localeSwitcher = (
    <div className="locale-chips" role="group" aria-label={ui.localeGroup[locale]}>
      <button
        type="button"
        className={locale === "ja" ? "chip chip--selected" : "chip"}
        aria-pressed={locale === "ja"}
        onClick={() => {
          dispatch({ type: "set_locale", locale: "ja" });
        }}
      >
        日本語
      </button>
      <button
        type="button"
        className={locale === "en" ? "chip chip--selected" : "chip"}
        aria-pressed={locale === "en"}
        onClick={() => {
          dispatch({ type: "set_locale", locale: "en" });
        }}
      >
        EN
      </button>
    </div>
  );

  const warnings = venueState?.loadedVenue.warnings ?? [];
  const showMap = venueState !== null;
  const dragEnabled = showMap && !embed;
  const showEmptyDropzone =
    !embed && (state.status === "empty" || (state.status === "loading" && !state.previous));
  const showEmbedLoading = embed && state.status === "loading" && !state.previous;
  const showErrorBanner = state.status === "error";
  const showReplaceOverlay =
    mapDragActive &&
    !embed &&
    (state.status === "ready" || (state.status === "loading" && Boolean(state.previous)));
  const onRetry = retryAttemptRef.current !== null ? retryLatestLoad : openPicker;
  // The embed "Open in Kiriko" badge links back to the full viewer. For a
  // dataset load it must stay hidden until a pin-safe public identity is
  // admitted, or a slow/failed load would expose a mutable-latest link. A
  // `src` embed carries no server identity, so its badge is always safe.
  const showEmbedBadge =
    embed && !(params.src === null && params.dataset !== null && admittedVersionId === null);

  const viewerUrl = useMemo(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("embed");
    // Drop any inbound `version` and re-add only the admitted public identity.
    url.searchParams.delete("version");
    if (admittedVersionId !== null) {
      url.searchParams.set("version", admittedVersionId);
    }
    return url.toString();
  }, [admittedVersionId]);

  // Compact: sheets are exclusive — an open rail panel hides the inspector
  // sheet (selection and its map highlight persist underneath).
  const inspectorOpen =
    showMap && selectedFeature !== null && !embed && (!compact || activePanel === null);
  const embedInfoOpen = showMap && selectedFeature !== null && embed;

  return (
    <div className={compact ? "app app--compact" : "app"} style={themeStyle()}>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveMessage(state)}
      </div>

      <input
        ref={fileInputRef}
        className="imdf-dropzone__input"
        type="file"
        accept=".zip,application/zip"
        aria-label={ui.openZip[locale]}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            handleFile(file);
          }
          event.target.value = "";
        }}
      />

      <main
        className="map-stage"
        onDragOver={dragEnabled ? onMapDragOver : undefined}
        onDragLeave={dragEnabled ? onMapDragLeave : undefined}
        onDrop={dragEnabled ? onMapDrop : undefined}
      >
        {showMap ? (
          <IndoorMap
            venue={venueState.loadedVenue}
            levelId={venueState.selectedLevelId}
            selectedFeatureId={venueState.selectedFeatureId}
            locale={locale}
            theme={kirikoTheme}
            layerVisibility={layerVisibility}
            onSelectFeature={onMapSelectFeature}
            issueReview={issueReview}
            directions={directionsMapProps}
            onControls={onControls}
            facilities={bundleProvenance?.facilities ?? []}
            onSelectFacility={setSelectedFacility}
            network={reviewActive ? editedNetwork : null}
            scene={sourceState.active === "fallback2d" ? null : scene}
            preserveDrawingBuffer={params.capture}
            onSceneContextLost={() => {
              dispatchSource({ type: "context_lost" });
            }}
            onSceneContextRestored={() => {
              dispatchSource({ type: "context_restored" });
            }}
            onSceneAttachFailed={() => {
              dispatchSource({ type: "load_failed" });
            }}
            networkEditing={
              editor !== null && !networkSaveLocked
                ? {
                    tool: editor.tool,
                    selection: editor.selection,
                    pendingNodeId: editor.pendingNodeId,
                    onPick: onNetworkPick,
                    centerActionLabel: ui.networkCenterPick[locale],
                  }
                : null
            }
          />
        ) : null}

        {showMap && params.scene ? (
          <>
            {/* A quiet source badge plus one provenance line (#32): what is
                rendering, and where its geometry came from. */}
            <div className="scene-source" aria-label={ui.sceneSourceLabel[locale]}>
              <span className="scene-source__badge">
                {sourceProvenance(sourceState).badge[locale]}
              </span>
              <span className="scene-source__provenance">
                {sourceProvenance(sourceState).provenance[locale]}
              </span>
            </div>
            {fallbackNotice(sourceState) !== null ? (
              <div className="scene-notice" role="status">
                <span>{fallbackNotice(sourceState)![locale]}</span>
                {canRetry3d(sourceState) ? (
                  <button
                    type="button"
                    className="scene-notice__retry"
                    onClick={() => {
                      dispatchSource({ type: "retry_requested" });
                    }}
                  >
                    {ui.sceneRetry3d[locale]}
                  </button>
                ) : null}
              </div>
            ) : sourceState.active === "generated" ? (
              <button
                type="button"
                className="scene-notice__retry scene-source__switch"
                onClick={() => {
                  dispatchSource({ type: "user_chose_2d" });
                }}
              >
                {ui.sceneUse2d[locale]}
              </button>
            ) : null}
            {/* The swap veil: a brief canvas-coloured cover, never a crossfade
                between two independently fitted sources. */}
            {sourceState.veil ? <div className="scene-veil" aria-hidden="true" /> : null}
          </>
        ) : null}

        {selectedFacility !== null ? (
          <div className="facility-popup" role="dialog" aria-label={selectedFacility.name || ui.facilityUnnamed[locale]}>
            <div className="facility-popup__body">
              <p className="facility-popup__name">
                {selectedFacility.name || ui.facilityUnnamed[locale]}
              </p>
              <div className="facility-popup__actions">
                {directionsAvailable && selectedFacility.anchor !== null ? (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => {
                      routeToFacility(selectedFacility);
                    }}
                  >
                    {ui.facilityRouteHere[locale]}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setSelectedFacility(null);
                  }}
                >
                  {ui.facilityClose[locale]}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {!embed ? (
          <>
            <ContextBar
              venueName={venueName ?? ui.product[locale]}
              levelName={levelName}
              locale={locale}
            />

            <div className="top-actions">
              <button type="button" className="btn-ghost top-actions__open" onClick={openPicker}>
                {ui.openZip[locale]}
              </button>
              {localeSwitcher}
            </div>

            {showMap ? (
              <IconRail
                locale={locale}
                activePanel={activePanel}
                warningCount={warnings.length}
                issuesVisible={issueMode.kind !== "hidden"}
                issueCount={activeIssueCount}
                onToggle={onToggleRail}
                variant={compact ? "bar" : "rail"}
              />
            ) : null}

            {showMap && activePanel === "search" ? (
              <FloatingPanel
                title={ui.searchPanel[locale]}
                closeLabel={ui.closePanel[locale]}
                onClose={() => {
                  setActivePanel(null);
                }}
                className="floating-panel--left"
              >
                <SearchPanel
                  locale={locale}
                  searchText={venueState.searchText}
                  searchCategory={venueState.searchCategory}
                  results={searchResults}
                  selectedFeatureId={venueState.selectedFeatureId}
                  onSearchText={(text) => {
                    dispatch({ type: "set_search_text", text });
                  }}
                  onSearchCategory={(category) => {
                    dispatch({ type: "set_search_category", category });
                  }}
                  onSelectResult={onSelectResult}
                />
              </FloatingPanel>
            ) : null}

            {showMap && activePanel === "layers" ? (
              <FloatingPanel
                title={ui.layersPanel[locale]}
                closeLabel={ui.closePanel[locale]}
                onClose={() => {
                  setActivePanel(null);
                }}
                className="floating-panel--left"
              >
                <LayersPanel locale={locale} visibility={layerVisibility} onToggle={onToggleLayer} />
              </FloatingPanel>
            ) : null}

            {showMap && activePanel === "issues" && issueMode.kind !== "hidden" ? (
              <FloatingPanel
                title={ui.issuesPanel[locale]}
                closeLabel={ui.closePanel[locale]}
                onClose={() => {
                  setActivePanel(null);
                }}
                className="floating-panel--left floating-panel--issues"
              >
                <IssuesPanel
                  locale={locale}
                  controller={issuesPanelController}
                  currentUser={issueCurrentUser}
                  reviewers={issueReviewers}
                  identityError={issueMode.kind === "identity_error"}
                  authError={authError}
                  onRetryAuth={retryIssueAuth}
                  onRequestSignIn={requestSignIn}
                  onBeginPlacement={beginIssuePlacement}
                  onCancelPlacement={cancelIssuePlacement}
                />
              </FloatingPanel>
            ) : null}

            {showMap && activePanel === "warnings" ? (
              <FloatingPanel
                title={ui.warningsPanel[locale]}
                closeLabel={ui.closePanel[locale]}
                onClose={() => {
                  setActivePanel(null);
                }}
                className="floating-panel--left"
              >
                <WarningsPanel warnings={warnings} locale={locale} />
              </FloatingPanel>
            ) : null}

            {inspectorOpen && selectedFeature !== null ? (
              <FloatingPanel
                title={selectedFeatureName ?? selectedFeature.id}
                closeLabel={ui.closeInspector[locale]}
                onClose={() => {
                  onMapSelectFeature(null);
                }}
                className="floating-panel--inspector"
              >
                <InspectorPanel
                  feature={selectedFeature}
                  levels={venueState.loadedVenue.levels}
                  locale={locale}
                  manifestLanguage={venueState.loadedVenue.manifest.language}
                  {...(params.src !== null
                    ? { onCopyLink: copyViewLink, copied: linkCopied }
                    : {})}
                />
              </FloatingPanel>
            ) : null}
          </>
        ) : null}

        {embed && embedInfoOpen && selectedFeature !== null ? (
          <div className="embed-info">
            <p className="embed-info__title">{selectedFeatureName ?? selectedFeature.id}</p>
            <p className="embed-info__meta">
              {[selectedFeature.featureType, levelName]
                .filter((part): part is string => part !== null && part !== "")
                .join(" · ")}
            </p>
          </div>
        ) : null}

        {showMap ? (
          <>
            {directionsAvailable && editor === null ? (
              <div className="directions-bar">
                <button
                  type="button"
                  className={directions.active ? "chip chip--selected" : "chip"}
                  aria-pressed={directions.active}
                  onClick={toggleDirections}
                >
                  {ui.directions[locale]}
                </button>
                <button
                  type="button"
                  className={reviewActive ? "chip chip--selected" : "chip"}
                  aria-pressed={reviewActive}
                  onClick={toggleReview}
                >
                  {ui.reviewNetwork[locale]}
                </button>
                {reviewActive && reviewReport ? (
                  <span className="review-report" role="status">
                    {ui.reviewConnected[locale]} {Math.round(reviewReport.largestFraction * 100)}% ·{" "}
                    {reviewReport.components} {ui.reviewIslands[locale]} ·{" "}
                    {reviewReport.floorsInLargest} {ui.reviewFloors[locale]}
                  </span>
                ) : null}
                {reviewActive && editor === null ? (
                  compact ? (
                    <span className="network-edit-desktop-only">{ui.editDesktopOnly[locale]}</span>
                  ) : (
                    <button
                      type="button"
                      className="chip"
                      disabled={networkLoadState !== "ready"}
                      onClick={enterNetworkEdit}
                    >
                      {ui.editNetwork[locale]}
                    </button>
                  )
                ) : null}
                {reviewActive && editor === null && networkLoadState === "loading" ? (
                  <span className="directions-bar__status" role="status">
                    {ui.loading[locale]}
                  </span>
                ) : null}
                {reviewActive && editor === null && networkLoadState === "error" ? (
                  <>
                    <span className="directions-bar__status" role="alert">
                      {ui.networkLoadFailed[locale]}
                    </span>
                    <button
                      type="button"
                      className="chip"
                      onClick={() => setNetworkLoadAttempt((n) => n + 1)}
                    >
                      {ui.networkRetry[locale]}
                    </button>
                  </>
                ) : null}
                {reviewActive && editor === null && editDenied ? (
                  <span className="directions-bar__status" role="alert">
                    {ui.editViewerDenied[locale]}
                  </span>
                ) : null}
                {directions.active ? (
                  <>
                    <span className="directions-bar__status">
                      {directions.status === "loading"
                        ? ui.directionsSearching[locale]
                        : directions.status === "error"
                          ? ui.directionsFailed[locale]
                          : directions.destination !== null && directions.route === null
                            ? ui.directionsNoPath[locale]
                            : directions.route !== null
                              ? `${Math.round(directions.route.totalWeight / ROUTE_COST_UNITS_PER_METER)} m`
                              : directions.origin === null
                                ? ui.directionsPickOrigin[locale]
                                : ui.directionsPickDestination[locale]}
                    </span>
                    {directions.origin !== null ? (
                      <button type="button" className="chip" onClick={clearDirections}>
                        {ui.directionsClear[locale]}
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
            {editor !== null ? (
              <NetworkEditorToolbar
                locale={locale}
                tool={editor.tool}
                summary={summarizeNetworkChanges(editor)}
                activeFloorLabel={activeFloorLabel}
                notice={editor.notice}
                saveProblem={networkSaveProblem(editor.present)}
                canUndo={editor.past.length > 0}
                canRedo={editor.future.length > 0}
                locked={networkSaveLocked}
                canSave={networkCanSave}
                checkStatus={networkCheckStatus}
                saveMessage={networkSave.message}
                saveError={networkSave.error}
                discardArmed={discardArmed}
                onSetTool={(tool) => dispatchEditor({ type: "set_tool", tool })}
                onUndo={() => dispatchEditor({ type: "undo" })}
                onRedo={() => dispatchEditor({ type: "redo" })}
                onRequestDiscard={requestDiscard}
                onCancelDiscard={cancelDiscard}
                onConfirmDiscard={confirmDiscard}
                onSave={() => {
                  void saveNetwork();
                }}
              />
            ) : null}
            {editor !== null && editor.selection !== null ? (
              <NetworkInspectorPanel
                network={editor.present}
                selection={editor.selection}
                locale={locale}
                locked={networkSaveLocked}
                onClose={() => dispatchEditor({ type: "clear_selection" })}
                onMove={startNetworkMove}
                onDelete={() => dispatchEditor({ type: "delete_selection" })}
              />
            ) : null}
            <FloorStack
              levels={venueState.loadedVenue.levels}
              selectedLevelId={venueState.selectedLevelId}
              locale={locale}
              manifestLanguage={venueState.loadedVenue.manifest.language}
              onSelect={(levelId) => {
                dispatch({ type: "select_level", levelId });
              }}
            />
            {mapControls !== null ? (
              <ZoomCluster
                locale={locale}
                onZoomIn={mapControls.zoomIn}
                onZoomOut={mapControls.zoomOut}
                onRecenter={mapControls.fitLevel}
              />
            ) : null}
            <p className="map-attribution">{ui.attribution[locale]}</p>
          </>
        ) : null}

        {showEmbedBadge ? (
          <a className="kiriko-badge" href={viewerUrl} target="_blank" rel="noreferrer">
            <KirikoMark size={14} />
            <span>
              Kiriko <span aria-hidden="true">↗</span>
            </span>
            <span className="sr-only">{ui.openInKiriko[locale]}</span>
          </a>
        ) : null}

        {showMap && state.status === "loading" && state.previous ? (
          <div className="map-stage__loading" role="status">
            <span className="imdf-dropzone__spinner" aria-hidden="true" />
            <span>
              {ui.loading[locale]}: {state.fileName}
            </span>
          </div>
        ) : null}

        {showReplaceOverlay ? (
          <ImdfDropzone
            locale={locale}
            status={state.status === "loading" ? "loading" : "ready"}
            {...(state.status === "loading" ? { fileName: state.fileName } : {})}
            variant="overlay"
            onFile={handleFile}
            onOpenPicker={openPicker}
          />
        ) : null}

        {showEmptyDropzone ? (
          <ImdfDropzone
            locale={locale}
            status={state.status === "loading" ? "loading" : "empty"}
            {...(state.status === "loading" ? { fileName: state.fileName } : {})}
            variant="empty"
            onFile={handleFile}
            onOpenPicker={openPicker}
          />
        ) : null}

        {showEmbedLoading ? (
          <div className="map-stage__loading" role="status">
            <span className="imdf-dropzone__spinner" aria-hidden="true" />
            <span>
              {ui.loading[locale]}: {state.status === "loading" ? state.fileName : ""}
            </span>
          </div>
        ) : null}

        {showErrorBanner ? (
          <div className="map-stage__error">
            <ViewerErrorNotice error={state.error} locale={locale} onRetry={onRetry} />
          </div>
        ) : null}
      </main>
      {signInOpen ? (
        <SignInModal
          locale={locale}
          onCancel={() => {
            setSignInOpen(false);
          }}
          onSignedIn={handleSignedIn}
        />
      ) : null}
    </div>
  );
}
