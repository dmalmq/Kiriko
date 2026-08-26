import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KirikoMark } from "../components/icons";
import type { GdbInspectResponse, GdbMappingPlan, NetworkInspectResponse, FacilitiesInspectResponse } from "../gdb/types";
import type { LocaleCode } from "../imdf/types";
import { probeSceneCapability } from "../map/scene/sceneCapability";
import { api, gdbErrorMessage, viewerHref, type ApiUser, type GdbError, type VenueSummary } from "./api";
import { AddDataDialog } from "./AddDataDialog";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal";
import { ConfirmRegenerateModal } from "./ConfirmRegenerateModal";
import { DatasetCard } from "./DatasetCard";
import { GdbImportDialog } from "./GdbImportDialog";
import { SignInModal } from "./SignInModal";
import { TilePackageDialog } from "./TilePackageDialog";
import { UploadModal, type UploadModalTarget } from "./UploadModal";

const ui = {
  datasets: { ja: "データセット", en: "Datasets" },
  filter: { ja: "データセットを検索…", en: "Filter datasets…" },
  openLocal: { ja: "ローカルデータを開く", en: "Open local data" },
  empty: { ja: "データセットがありません", en: "No datasets yet" },
  emptyHint: {
    ja: "IMDF ZIP をアップロードして最初のデータセットを公開しましょう。",
    en: "Upload an IMDF ZIP to publish your first dataset.",
  },
  signOut: { ja: "サインアウト", en: "Sign out" },
  loadError: { ja: "読み込みに失敗しました", en: "Could not load datasets" },
  importGdb: { ja: "Geodatabase を取り込む", en: "Import Geodatabase" },
  inspecting: { ja: "検査中…", en: "Inspecting…" },
  generatingRouting: { ja: "経路を生成中…", en: "Generating routing…" },
  estimatingRoutingDuration: {
    ja: "所要時間を見積もっています…",
    en: "Estimating duration…",
  },
  estimatingRoutingDurationA11y: {
    ja: "所要時間を見積もっています",
    en: "Estimating duration",
  },
  routingRemainingSeconds: {
    ja: (seconds: number) => `残り約${seconds}秒`,
    en: (seconds: number) => `About ${seconds} ${seconds === 1 ? "second" : "seconds"} remaining`,
  },
  routingOverdue: {
    ja: "通常より時間がかかっています — サーバーで処理を続けています。",
    en: "Taking longer than usual — still processing.",
  },
  routingGenerated: { ja: "経路を生成しました", en: "Routing generated" },
  exportingNetwork: { ja: "ネットワークを書き出し中…", en: "Exporting network…" },
  networkExported: { ja: "ネットワークを書き出しました", en: "Network exported" },
  processingContinues: {
    ja: "処理はサーバーで続いています。しばらくしてから一覧を更新してください。",
    en: "Processing is still running on the server. Refresh the list again shortly.",
  },
  checkStatus: { ja: "状況を確認", en: "Check status" },
  regenerateRouting: { ja: "経路を再生成", en: "Regenerate routing" },
  generatingScene: { ja: "3Dを再生成中…", en: "Regenerating 3D…" },
  sceneGenerated: { ja: "3Dを再生成しました", en: "3D regenerated" },
  noGraphToExport: {
    ja: "書き出せる経路ネットワークがありません。先に生成してください。",
    en: "No routing network to export — generate one first.",
  },
  publishedWithSkips: {
    ja: (n: number, sample: string) =>
      `公開しました（${n} レイヤーをスキップ: 例 ${sample}）`,
    en: (n: number, sample: string) =>
      `Published with ${n} layer(s) skipped (e.g. ${sample}).`,
  },
} as const;

/** Watch a generate-network job at least 5 minutes, or the server estimate plus 60s. */
export function generateWaitTimeoutMs(estimatedDurationSeconds: number | null | undefined): number {
  const estimateMs =
    typeof estimatedDurationSeconds === "number" && estimatedDurationSeconds > 0
      ? estimatedDurationSeconds * 1000
      : 0;
  return Math.max(300_000, estimateMs + 60_000);
}

function navigateTo(href: string): void {
  const event = new CustomEvent("kiriko:navigate", { cancelable: true, detail: { href } });
  if (window.dispatchEvent(event)) {
    window.location.assign(href);
  }
}

type GalleryState =
  | { phase: "loading" }
  | { phase: "signed-out" }
  | { phase: "ready"; user: ApiUser; venues: VenueSummary[] }
  | { phase: "error" };

type GdbTarget =
  | { mode: "create" }
  | { mode: "version"; venueId: number; venueName: string }
  | { mode: "edit-mapping"; venueId: number; venueName: string };

interface AcceptedJob {
  jobId: string;
}

interface AcceptedGdbJob extends AcceptedJob {
  createdVenueId: number | null;
  excludedLayers: { layer: string; reason: string }[];
}

type GdbFlow =
  | { phase: "idle" }
  | { phase: "inspecting"; target: GdbTarget }
  | {
      phase: "review";
      target: GdbTarget;
      data: GdbInspectResponse;
      network: NetworkInspectResponse | null;
      facilities: FacilitiesInspectResponse | null;
      busy: boolean;
      accepted: AcceptedGdbJob | null;
      error: GdbError | null;
    }
  | { phase: "error"; message: string; target: GdbTarget };

type AddDataFlow =
  | { phase: "idle" }
  | {
      phase: "open";
      venueId: number;
      venueName: string;
      network: NetworkInspectResponse | null;
      facilities: FacilitiesInspectResponse | null;
      busy: boolean;
      accepted: AcceptedJob | null;
      error: GdbError | null;
    };

interface RoutingProgressState {
  venueId: number;
  venueName: string;
  startedAtMs: number;
  estimatedDurationSeconds: number | null;
  timedOut: boolean;
}

type TopLevelOwner = "gdb" | "add-data" | "routing" | "scene";

export function GalleryPage() {
  const [locale, setLocale] = useState<LocaleCode>("ja");
  // Probed once: a device below the floor is not offered a 3D link that would
  // land it back in 2D with an apology. Hidden, not disabled — a disabled
  // control still advertises a feature this machine cannot run.
  const scene3dOffered = useMemo(() => probeSceneCapability().supported, []);
  const [state, setState] = useState<GalleryState>({ phase: "loading" });
  const [filter, setFilter] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<UploadModalTarget | null>(null);
  const [deleting, setDeleting] = useState<VenueSummary | null>(null);
  const [regenerating, setRegenerating] = useState<VenueSummary | null>(null);
  const [regeneratingScene, setRegeneratingScene] = useState<VenueSummary | null>(null);
  const [tilesVenue, setTilesVenue] = useState<VenueSummary | null>(null);
  const [gdbFlow, setGdbFlow] = useState<GdbFlow>({ phase: "idle" });
  const [gdbNotice, setGdbNotice] = useState<string | null>(null);
  const [addData, setAddData] = useState<AddDataFlow>({ phase: "idle" });
  const [generatingId, setGeneratingId] = useState<number | null>(null);
  const [routingJob, setRoutingJob] = useState<{ venueId: number; jobId: string } | null>(null);
  const [routingProgress, setRoutingProgress] = useState<RoutingProgressState | null>(null);
  const [routingClockMs, setRoutingClockMs] = useState(() => Date.now());
  const [generatingSceneId, setGeneratingSceneId] = useState<number | null>(null);
  const [sceneJob, setSceneJob] = useState<{ venueId: number; jobId: string } | null>(null);
  const [sceneProgress, setSceneProgress] = useState<RoutingProgressState | null>(null);
  const gdbInputRef = useRef<HTMLInputElement>(null);
  const gdbTargetRef = useRef<GdbTarget>({ mode: "create" });
  const aliveRef = useRef(true);
  const reloadGenerationRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const gdbGenerationRef = useRef(0);
  const gdbNetworkGenerationRef = useRef(0);
  const gdbFacilitiesGenerationRef = useRef(0);
  const gdbPublishGenerationRef = useRef(0);
  const addDataGenerationRef = useRef(0);
  const addDataNetworkGenerationRef = useRef(0);
  const addDataFacilitiesGenerationRef = useRef(0);
  const addDataPublishGenerationRef = useRef(0);
  const routingGenerationRef = useRef(0);
  const sceneGenerationRef = useRef(0);
  const exportGenerationRef = useRef(0);
  const noticeGenerationRef = useRef(0);
  const acceptedOwner: TopLevelOwner | null =
    gdbFlow.phase === "review" && gdbFlow.accepted !== null
      ? "gdb"
      : addData.phase === "open" && addData.accepted !== null
        ? "add-data"
        : routingJob !== null || generatingId !== null
          ? "routing"
          : sceneJob !== null || generatingSceneId !== null
            ? "scene"
            : null;

  const invalidateGdbRequests = () => {
    gdbGenerationRef.current += 1;
    gdbNetworkGenerationRef.current += 1;
    gdbFacilitiesGenerationRef.current += 1;
    gdbPublishGenerationRef.current += 1;
  };
  const invalidateAddDataRequests = () => {
    addDataGenerationRef.current += 1;
    addDataNetworkGenerationRef.current += 1;
    addDataFacilitiesGenerationRef.current += 1;
    addDataPublishGenerationRef.current += 1;
  };
  const clearAsyncUi = () => {
    setGdbFlow({ phase: "idle" });
    setAddData({ phase: "idle" });
    setGeneratingId(null);
    setRoutingJob(null);
    setGeneratingSceneId(null);
    setSceneJob(null);
    setGdbNotice(null);
    setRoutingProgress(null);
    setSceneProgress(null);
    gdbTargetRef.current = { mode: "create" };
    if (gdbInputRef.current) gdbInputRef.current.value = "";
  };
  const invalidateAsyncWork = () => {
    invalidateGdbRequests();
    invalidateAddDataRequests();
    routingGenerationRef.current += 1;
    sceneGenerationRef.current += 1;
    exportGenerationRef.current += 1;
    noticeGenerationRef.current += 1;
  };
  const beginTopLevelActivity = (owner?: TopLevelOwner): boolean => {
    if (acceptedOwner !== null && owner !== acceptedOwner) {
      return false;
    }
    // Top-level UI activity must not cancel authoritative reload/session results.
    invalidateAsyncWork();
    if (owner !== "gdb") {
      setGdbFlow({ phase: "idle" });
      gdbTargetRef.current = { mode: "create" };
      if (gdbInputRef.current) gdbInputRef.current.value = "";
    }
    if (owner !== "add-data") {
      setAddData({ phase: "idle" });
    }
    setGeneratingId(null);
    setGeneratingSceneId(null);
    if (owner !== "routing") {
      setRoutingJob(null);
    }
    if (owner !== "scene") {
      setSceneJob(null);
    }
    setGdbNotice(null);
    return true;
  };

  const reload = useCallback(async () => {
    const generation = ++reloadGenerationRef.current;
    try {
      const user = await api.me();
      if (!aliveRef.current || generation !== reloadGenerationRef.current) return;
      if (user === null) {
        sessionGenerationRef.current += 1;
        invalidateAsyncWork();
        clearAsyncUi();
        setState({ phase: "signed-out" });
        return;
      }
      const venues = await api.listVenues();
      if (!aliveRef.current || generation !== reloadGenerationRef.current) return;
      setState({ phase: "ready", user, venues });
    } catch {
      if (!aliveRef.current || generation !== reloadGenerationRef.current) return;
      setState((current) => (current.phase === "ready" ? current : { phase: "error" }));
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      sessionGenerationRef.current += 1;
      reloadGenerationRef.current += 1;
      invalidateAsyncWork();
    };
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (routingProgress === null && sceneProgress === null) return;
    const timer = window.setInterval(() => {
      setRoutingClockMs(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [routingProgress, sceneProgress]);

  const openCreateUpload = () => {
    if (acceptedOwner !== null) return;
    setUploadTarget(null);
    setUploadOpen(true);
  };

  const openVenue = (venue: VenueSummary) => {
    navigateTo(viewerHref(venue.slug, venue.latest?.publicVersionId ?? null, locale));
  };

  const openVenue3d = (venue: VenueSummary) => {
    navigateTo(
      viewerHref(venue.slug, venue.latest?.publicVersionId ?? null, locale, { scene: true }),
    );
  };

  const openReview = (venue: VenueSummary) => {
    navigateTo(viewerHref(venue.slug, venue.latest?.publicVersionId ?? null, locale, { review: true }));
  };

  const openVersionUpload = (venue: VenueSummary) => {
    if (acceptedOwner !== null) return;
    setUploadTarget({
      venueId: venue.id,
      venueName: venue.name,
      slug: venue.slug,
    });
    setUploadOpen(true);
  };

  const closeUpload = () => {
    setUploadOpen(false);
    setUploadTarget(null);
  };

  const startGdbImport = (target: GdbTarget = { mode: "create" }) => {
    if (!beginTopLevelActivity()) return;
    gdbTargetRef.current = target;
    gdbInputRef.current?.click();
  };

  const startEditMapping = (venue: VenueSummary) => {
    if (!beginTopLevelActivity()) return;
    const generation = gdbGenerationRef.current;
    const target: GdbTarget = { mode: "edit-mapping", venueId: venue.id, venueName: venue.name };
    setGdbFlow({ phase: "inspecting", target });
    void (async () => {
      try {
        const mapping = await api.getGdbMapping(venue.id);
        if (!aliveRef.current || generation !== gdbGenerationRef.current) return;
        setGdbFlow({
          phase: "review",
          target,
          data: {
            blobHash: mapping.blobHash,
            inspection: mapping.inspection,
            suggestedPlan: mapping.plan,
          },
          accepted: null,
          network: null,
          facilities: null,
          busy: false,
          error: null,
        });
      } catch (err) {
        if (!aliveRef.current || generation !== gdbGenerationRef.current) return;
        setGdbFlow({ phase: "error", target, message: gdbErrorMessage(err as GdbError, locale) });
      }
    })();
  };

  const onGdbFile = (file: File | undefined) => {
    if (!file) return;
    const target = gdbTargetRef.current;
    if (!beginTopLevelActivity()) return;
    const generation = gdbGenerationRef.current;
    setGdbFlow({ phase: "inspecting", target });
    void (async () => {
      try {
        const data = await api.inspectGdb(file);
        if (!aliveRef.current || generation !== gdbGenerationRef.current) return;
        let suggestedPlan = data.suggestedPlan;
        if (target.mode === "version") {
          suggestedPlan = { ...suggestedPlan, venueName: target.venueName };
        }
        setGdbFlow({
          phase: "review",
          target,
          accepted: null,
          data: { ...data, suggestedPlan },
          network: null,
          facilities: null,
          busy: false,
          error: null,
        });
      } catch (err) {
        if (!aliveRef.current || generation !== gdbGenerationRef.current) return;
        setGdbFlow({
          phase: "error",
          target,
          message: gdbErrorMessage(err as GdbError, locale),
        });
      }
    })();
  };

  const onGdbNetworkFile = (file: File) => {
    if (gdbFlow.phase !== "review") return;
    const flowGeneration = gdbGenerationRef.current;
    const requestGeneration = ++gdbNetworkGenerationRef.current;
    void (async () => {
      try {
        const network = await api.inspectGdbNetwork(file);
        setGdbFlow((current) =>
          aliveRef.current &&
          flowGeneration === gdbGenerationRef.current &&
          requestGeneration === gdbNetworkGenerationRef.current &&
          current.phase === "review"
            ? { ...current, network, error: null }
            : current,
        );
      } catch (err) {
        setGdbFlow((current) =>
          aliveRef.current &&
          flowGeneration === gdbGenerationRef.current &&
          requestGeneration === gdbNetworkGenerationRef.current &&
          current.phase === "review"
            ? { ...current, error: err as GdbError }
            : current,
        );
      }
    })();
  };

  const onGdbFacilityFile = (file: File) => {
    if (gdbFlow.phase !== "review") return;
    const flowGeneration = gdbGenerationRef.current;
    const requestGeneration = ++gdbFacilitiesGenerationRef.current;
    void (async () => {
      try {
        const facilities = await api.inspectGdbFacilities(file);
        setGdbFlow((current) =>
          aliveRef.current &&
          flowGeneration === gdbGenerationRef.current &&
          requestGeneration === gdbFacilitiesGenerationRef.current &&
          current.phase === "review"
            ? { ...current, facilities, error: null }
            : current,
        );
      } catch (err) {
        setGdbFlow((current) =>
          aliveRef.current &&
          flowGeneration === gdbGenerationRef.current &&
          requestGeneration === gdbFacilitiesGenerationRef.current &&
          current.phase === "review"
            ? { ...current, error: err as GdbError }
            : current,
        );
      }
    })();
  };

  const publishGdbPlan = (plan: GdbMappingPlan) => {
    if (gdbFlow.phase !== "review") return;
    const data = gdbFlow.data;
    const target = gdbFlow.target;
    const network = gdbFlow.network;
    const facilities = gdbFlow.facilities;
    let accepted = gdbFlow.accepted;
    beginTopLevelActivity("gdb");
    const flowGeneration = gdbGenerationRef.current;
    const publishGeneration = gdbPublishGenerationRef.current;
    const sessionGeneration = sessionGenerationRef.current;
    const isCurrent = () =>
      aliveRef.current &&
      flowGeneration === gdbGenerationRef.current &&
      publishGeneration === gdbPublishGenerationRef.current;
    setGdbFlow({ phase: "review", target, data, network, facilities, busy: true, accepted, error: null });
    void (async () => {
      let createdVenueId: number | null = null;
      try {
        if (accepted === null) {
          let venueId: number;
          if (target.mode === "version" || target.mode === "edit-mapping") {
            venueId = target.venueId;
          } else {
            const venue = await api.createVenue(plan.venueName.trim());
            createdVenueId = venue.id;
            venueId = venue.id;
            if (!isCurrent()) {
              await api.deleteVenue(createdVenueId).catch(() => {});
              return;
            }
          }
          const published = await api.publishGdb(
            venueId,
            data.blobHash,
            plan,
            network?.networkBlobHash ?? null,
            facilities?.facilitiesBlobHash ?? null,
          );
          const acceptedCreatedVenueId = createdVenueId;
          createdVenueId = null;
          accepted = {
            jobId: published.jobId,
            excludedLayers: published.excludedLayers ?? [],
            createdVenueId: acceptedCreatedVenueId,
          };
          if (isCurrent()) {
            setGdbFlow({ phase: "review", target, data, network, facilities, busy: true, accepted, error: null });
          }
        }
        if (!aliveRef.current) return;
        const job = await api.waitForJob(accepted.jobId);
        if (!aliveRef.current) return;
        if (job.status === "error" && accepted.createdVenueId !== null) {
          await api.deleteVenue(accepted.createdVenueId).catch(() => {});
          accepted = { ...accepted, createdVenueId: null };
        }
        if (sessionGeneration !== sessionGenerationRef.current) return;
        if (job.status === "done") {
          if (isCurrent()) {
            const skipped = accepted.excludedLayers;
            if (skipped.length > 0) {
              const sample = skipped[0]!.layer;
              setGdbNotice(ui.publishedWithSkips[locale](skipped.length, sample));
            } else {
              setGdbNotice(null);
            }
            setGdbFlow({ phase: "idle" });
            if (gdbInputRef.current) gdbInputRef.current.value = "";
            gdbTargetRef.current = { mode: "create" };
          }
          await reload();
        } else if (job.status === "timeout") {
          if (isCurrent()) {
            setGdbFlow({ phase: "review", target, data, network, facilities, busy: false, accepted, error: null });
            setGdbNotice(ui.processingContinues[locale]);
          }
        } else {
          if (accepted.createdVenueId !== null) {
            await api.deleteVenue(accepted.createdVenueId).catch(() => {});
          }
          if (isCurrent()) {
            setGdbFlow({
              phase: "review",
              target,
              data,
              network,
              facilities,
              busy: false,
              accepted: null,
              error: { code: "gdb_conversion_failed", message: job.error },
            });
          }
          await reload();
        }
      } catch (err) {
        if (createdVenueId !== null) {
          try {
            await api.deleteVenue(createdVenueId);
          } catch {
            /* best effort */
          }
        }
        if (!isCurrent()) return;
        if (accepted !== null) {
          setGdbFlow({ phase: "review", target, data, network, facilities, busy: false, accepted, error: null });
          setGdbNotice(ui.processingContinues[locale]);
          return;
        }
        setGdbFlow({
          phase: "review",
          target,
          data,
          network,
          facilities,
          busy: false,
          accepted: null,
          error: err as GdbError,
        });
      }
    })();
  };

  const cancelGdbImport = () => {
    if (gdbFlow.phase === "review" && (gdbFlow.busy || gdbFlow.accepted !== null)) return;
    invalidateGdbRequests();
    setGdbFlow({ phase: "idle" });
    gdbTargetRef.current = { mode: "create" };
    if (gdbInputRef.current) gdbInputRef.current.value = "";
  };

  const openAddData = (venue: VenueSummary) => {
    if (!beginTopLevelActivity()) return;
    setAddData({
      phase: "open",
      venueId: venue.id,
      accepted: null,
      venueName: venue.name,
      network: null,
      facilities: null,
      busy: false,
      error: null,
    });
  };

  const onAddDataNetwork = (file: File) => {
    const flowGeneration = addDataGenerationRef.current;
    const requestGeneration = ++addDataNetworkGenerationRef.current;
    void (async () => {
      try {
        const network = await api.inspectGdbNetwork(file);
        setAddData((c) =>
          aliveRef.current &&
          flowGeneration === addDataGenerationRef.current &&
          requestGeneration === addDataNetworkGenerationRef.current &&
          c.phase === "open"
            ? { ...c, network, error: null }
            : c,
        );
      } catch (err) {
        setAddData((c) =>
          aliveRef.current &&
          flowGeneration === addDataGenerationRef.current &&
          requestGeneration === addDataNetworkGenerationRef.current &&
          c.phase === "open"
            ? { ...c, error: err as GdbError }
            : c,
        );
      }
    })();
  };

  const onAddDataFacilities = (file: File) => {
    const flowGeneration = addDataGenerationRef.current;
    const requestGeneration = ++addDataFacilitiesGenerationRef.current;
    void (async () => {
      try {
        const facilities = await api.inspectGdbFacilities(file);
        setAddData((c) =>
          aliveRef.current &&
          flowGeneration === addDataGenerationRef.current &&
          requestGeneration === addDataFacilitiesGenerationRef.current &&
          c.phase === "open"
            ? { ...c, facilities, error: null }
            : c,
        );
      } catch (err) {
        setAddData((c) =>
          aliveRef.current &&
          flowGeneration === addDataGenerationRef.current &&
          requestGeneration === addDataFacilitiesGenerationRef.current &&
          c.phase === "open"
            ? { ...c, error: err as GdbError }
            : c,
        );
      }
    })();
  };

  const submitAddData = () => {
    if (addData.phase !== "open") return;
    const { venueId, network, facilities } = addData;
    let accepted = addData.accepted;
    if (accepted === null && network === null && facilities === null) return;
    if (!beginTopLevelActivity("add-data")) return;
    const flowGeneration = addDataGenerationRef.current;
    const publishGeneration = addDataPublishGenerationRef.current;
    const sessionGeneration = sessionGenerationRef.current;
    const isCurrent = () =>
      aliveRef.current &&
      flowGeneration === addDataGenerationRef.current &&
      publishGeneration === addDataPublishGenerationRef.current;
    setAddData({ ...addData, busy: true, accepted, error: null });
    void (async () => {
      try {
        if (accepted === null) {
          const res = await api.augmentGdb(venueId, {
            ...(network ? { networkBlobHash: network.networkBlobHash } : {}),
            ...(facilities ? { facilitiesBlobHash: facilities.facilitiesBlobHash } : {}),
          });
          accepted = { jobId: res.jobId };
          if (isCurrent()) {
            setAddData((c) => (c.phase === "open" ? { ...c, busy: true, accepted, error: null } : c));
          }
        }
        if (!aliveRef.current || sessionGeneration !== sessionGenerationRef.current) return;
        const job = await api.waitForJob(accepted.jobId);
        if (!aliveRef.current || sessionGeneration !== sessionGenerationRef.current) return;
        if (job.status === "done") {
          if (isCurrent()) {
            setAddData({ phase: "idle" });
          }
          await reload();
        } else if (job.status === "timeout") {
          if (isCurrent()) {
            setAddData((c) => (c.phase === "open" ? { ...c, busy: false, accepted, error: null } : c));
            setGdbNotice(ui.processingContinues[locale]);
          }
        } else {
          if (isCurrent()) {
            setAddData((c) =>
              c.phase === "open"
                ? { ...c, busy: false, accepted: null, error: { code: "gdb_conversion_failed", message: job.error } }
                : c,
            );
          }
          await reload();
        }
      } catch (err) {
        if (!isCurrent()) return;
        if (accepted !== null) {
          setAddData((c) => (c.phase === "open" ? { ...c, busy: false, accepted, error: null } : c));
          setGdbNotice(ui.processingContinues[locale]);
          return;
        }
        setAddData((c) => (c.phase === "open" ? { ...c, busy: false, accepted: null, error: err as GdbError } : c));
      }
    })();
  };

  const cancelAddData = () => {
    if (addData.phase === "open" && (addData.busy || addData.accepted !== null)) return;
    invalidateAddDataRequests();
    setAddData({ phase: "idle" });
  };

  const generateRouting = (venue: VenueSummary) => {
    if (generatingId !== null) return;
    if (routingJob !== null && routingJob.venueId !== venue.id) return;
    if (acceptedOwner !== null && acceptedOwner !== "routing") return;
    let accepted = routingJob?.venueId === venue.id ? routingJob : null;
    let estimate =
      routingProgress?.venueId === venue.id ? routingProgress.estimatedDurationSeconds : null;
    if (!beginTopLevelActivity("routing")) return;
    const generation = routingGenerationRef.current;
    const noticeGeneration = noticeGenerationRef.current;
    const sessionGeneration = sessionGenerationRef.current;
    setGeneratingId(venue.id);
    setRoutingClockMs(Date.now());
    setRoutingProgress((current) =>
      current?.venueId === venue.id
        ? { ...current, timedOut: false }
        : {
            venueId: venue.id,
            venueName: venue.name,
            startedAtMs: Date.now(),
            estimatedDurationSeconds: null,
            timedOut: false,
          },
    );
    setGdbNotice(accepted === null ? ui.generatingRouting[locale] : ui.processingContinues[locale]);
    void (async () => {
      try {
        if (accepted === null) {
          const res = await api.generateNetwork(venue.id);
          accepted = { venueId: venue.id, jobId: res.jobId };
          estimate = res.estimatedDurationSeconds;
          if (!aliveRef.current || sessionGeneration !== sessionGenerationRef.current) return;
          if (generation === routingGenerationRef.current) {
            setRoutingJob(accepted);
            setRoutingProgress((current) =>
              current?.venueId === venue.id
                ? { ...current, estimatedDurationSeconds: res.estimatedDurationSeconds }
                : current,
            );
          }
        }
        if (!aliveRef.current || sessionGeneration !== sessionGenerationRef.current) return;
        const job = await api.waitForJob(accepted.jobId, {
          timeoutMs: generateWaitTimeoutMs(estimate),
        });
        if (!aliveRef.current || sessionGeneration !== sessionGenerationRef.current) return;
        const canTouchNotice = noticeGeneration === noticeGenerationRef.current && generation === routingGenerationRef.current;
        if (job.status === "done") {
          if (canTouchNotice) {
            setRoutingJob(null);
            setRoutingProgress(null);
            setGdbNotice(ui.routingGenerated[locale]);
          }
          await reload();
        } else if (job.status === "timeout") {
          if (canTouchNotice) {
            setRoutingJob(accepted);
            setRoutingProgress((current) =>
              current?.venueId === venue.id
                ? { ...current, timedOut: true }
                : current,
            );
            setGdbNotice(ui.processingContinues[locale]);
          }
        } else {
          if (canTouchNotice) {
            setRoutingJob(null);
            setRoutingProgress(null);
            setGdbNotice(gdbErrorMessage({ code: "gdb_conversion_failed", message: job.error }, locale));
          }
          await reload();
        }
      } catch (err) {
        if (
          aliveRef.current &&
          generation === routingGenerationRef.current &&
          noticeGeneration === noticeGenerationRef.current
        ) {
          if (accepted !== null) {
            setRoutingJob(accepted);
            setRoutingProgress((current) =>
              current?.venueId === venue.id
                ? { ...current, timedOut: true }
                : current,
            );
            setGdbNotice(ui.processingContinues[locale]);
          } else {
            setRoutingProgress(null);
            setGdbNotice(gdbErrorMessage(err as GdbError, locale));
          }
        }
      } finally {
        if (aliveRef.current && generation === routingGenerationRef.current) {
          setGeneratingId(null);
        }
      }
    })();
  };

  const generateScene = (venue: VenueSummary) => {
    if (generatingSceneId !== null) return;
    if (sceneJob !== null && sceneJob.venueId !== venue.id) return;
    if (acceptedOwner !== null && acceptedOwner !== "scene") return;
    let accepted = sceneJob?.venueId === venue.id ? sceneJob : null;
    let estimate =
      sceneProgress?.venueId === venue.id ? sceneProgress.estimatedDurationSeconds : null;
    if (!beginTopLevelActivity("scene")) return;
    const generation = sceneGenerationRef.current;
    const noticeGeneration = noticeGenerationRef.current;
    const sessionGeneration = sessionGenerationRef.current;
    setGeneratingSceneId(venue.id);
    setRoutingClockMs(Date.now());
    setSceneProgress((current) =>
      current?.venueId === venue.id
        ? { ...current, timedOut: false }
        : {
            venueId: venue.id,
            venueName: venue.name,
            startedAtMs: Date.now(),
            estimatedDurationSeconds: null,
            timedOut: false,
          },
    );
    setGdbNotice(accepted === null ? ui.generatingScene[locale] : ui.processingContinues[locale]);
    void (async () => {
      try {
        if (accepted === null) {
          const res = await api.regenerateScene(venue.id);
          accepted = { venueId: venue.id, jobId: res.jobId };
          estimate = res.estimatedDurationSeconds;
          if (!aliveRef.current || sessionGeneration !== sessionGenerationRef.current) return;
          if (generation === sceneGenerationRef.current) {
            setSceneJob(accepted);
            setSceneProgress((current) =>
              current?.venueId === venue.id
                ? { ...current, estimatedDurationSeconds: res.estimatedDurationSeconds }
                : current,
            );
          }
        }
        if (!aliveRef.current || sessionGeneration !== sessionGenerationRef.current) return;
        const job = await api.waitForJob(accepted.jobId, {
          timeoutMs: generateWaitTimeoutMs(estimate),
        });
        if (!aliveRef.current || sessionGeneration !== sessionGenerationRef.current) return;
        const canTouchNotice = noticeGeneration === noticeGenerationRef.current && generation === sceneGenerationRef.current;
        if (job.status === "done") {
          if (canTouchNotice) {
            setSceneJob(null);
            setSceneProgress(null);
            setGdbNotice(ui.sceneGenerated[locale]);
          }
          await reload();
        } else if (job.status === "timeout") {
          if (canTouchNotice) {
            setSceneJob(accepted);
            setSceneProgress((current) =>
              current?.venueId === venue.id
                ? { ...current, timedOut: true }
                : current,
            );
            setGdbNotice(ui.processingContinues[locale]);
          }
        } else {
          if (canTouchNotice) {
            setSceneJob(null);
            setSceneProgress(null);
            setGdbNotice(gdbErrorMessage({ code: "gdb_conversion_failed", message: job.error }, locale));
          }
          await reload();
        }
      } catch (err) {
        if (
          aliveRef.current &&
          generation === sceneGenerationRef.current &&
          noticeGeneration === noticeGenerationRef.current
        ) {
          if (accepted !== null) {
            setSceneJob(accepted);
            setSceneProgress((current) =>
              current?.venueId === venue.id
                ? { ...current, timedOut: true }
                : current,
            );
            setGdbNotice(ui.processingContinues[locale]);
          } else {
            setSceneProgress(null);
            setGdbNotice(gdbErrorMessage(err as GdbError, locale));
          }
        }
      } finally {
        if (aliveRef.current && generation === sceneGenerationRef.current) {
          setGeneratingSceneId(null);
        }
      }
    })();
  };

  const exportNetwork = (venue: VenueSummary) => {
    if (!beginTopLevelActivity()) return;
    const generation = exportGenerationRef.current;
    const noticeGeneration = noticeGenerationRef.current;
    setGdbNotice(ui.exportingNetwork[locale]);
    void (async () => {
      try {
        const { blob, filename } = await api.exportNetwork(venue.id);
        if (
          !aliveRef.current ||
          generation !== exportGenerationRef.current ||
          noticeGeneration !== noticeGenerationRef.current
        ) {
          return;
        }
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        setGdbNotice(ui.networkExported[locale]);
      } catch (err) {
        if (
          !aliveRef.current ||
          generation !== exportGenerationRef.current ||
          noticeGeneration !== noticeGenerationRef.current
        ) {
          return;
        }
        const errObject = err !== null && typeof err === "object" ? err : null;
        const code =
          errObject !== null && "code" in errObject && typeof errObject.code === "string"
            ? errObject.code
            : errObject !== null && "error" in errObject && typeof errObject.error === "string"
              ? errObject.error
              : undefined;
        setGdbNotice(
          code === "no_graph"
            ? ui.noGraphToExport[locale]
            : gdbErrorMessage(err as GdbError, locale),
        );
      }
    })();
  };

  const header = (
    <header className="gallery-header">
      <div className="gallery-header__brand">
        <KirikoMark className="gallery-header__mark" />
        <span className="gallery-header__wordmark">Kiriko</span>
      </div>
      <div className="gallery-header__actions">
        {state.phase === "ready" ? (
          <>
            <span className="chip">{state.user.username}</span>
            <button
              type="button"
              className="chip"
              onClick={() => {
                sessionGenerationRef.current += 1;
                reloadGenerationRef.current += 1;
                invalidateAsyncWork();
                clearAsyncUi();
                void api.logout().then(reload);
              }}
            >
              {ui.signOut[locale]}
            </button>
          </>
        ) : null}
        <div className="locale-chips" role="group" aria-label="Language">
          <button
            type="button"
            className={locale === "ja" ? "chip chip--selected" : "chip"}
            aria-pressed={locale === "ja"}
            onClick={() => {
              setLocale("ja");
            }}
          >
            日本語
          </button>
          <button
            type="button"
            className={locale === "en" ? "chip chip--selected" : "chip"}
            aria-pressed={locale === "en"}
            onClick={() => {
              setLocale("en");
            }}
          >
            EN
          </button>
        </div>
      </div>
    </header>
  );

  if (state.phase === "loading") {
    return <div className="gallery">{header}</div>;
  }
  if (state.phase === "signed-out") {
    return (
      <div className="gallery">
        {header}
        <SignInModal
          locale={locale}
          onSignedIn={() => {
            void reload();
          }}
        />
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="gallery">
        {header}
        <p className="gallery__error" role="alert">
          {ui.loadError[locale]}
        </p>
      </div>
    );
  }

  const visible = state.venues.filter((venue) => {
    const q = filter.trim().toLowerCase();
    return q === "" || venue.name.toLowerCase().includes(q) || venue.slug.includes(q);
  });
  const routingEstimateSeconds = routingProgress?.estimatedDurationSeconds ?? null;
  const routingTimedOut = routingProgress?.timedOut ?? false;
  const routingElapsedSeconds =
    routingProgress === null
      ? 0
      : Math.max(0, Math.floor((routingClockMs - routingProgress.startedAtMs) / 1_000));
  const routingOverdue =
    routingEstimateSeconds !== null && routingElapsedSeconds >= routingEstimateSeconds;
  const routingRemainingSeconds =
    routingEstimateSeconds === null
      ? null
      : Math.max(0, routingEstimateSeconds - routingElapsedSeconds);
  const routingProgressPercent =
    routingEstimateSeconds === null
      ? null
      : routingOverdue
        ? 90
        : Math.min(90, Math.round((routingElapsedSeconds / routingEstimateSeconds) * 100));
  const routingProgressText = routingOverdue
    ? ui.routingOverdue[locale]
    : routingTimedOut
      ? ui.processingContinues[locale]
      : routingRemainingSeconds === null
        ? ui.estimatingRoutingDurationA11y[locale]
        : ui.routingRemainingSeconds[locale](routingRemainingSeconds);

  return (
    <div className="gallery">
      {header}
      <main className="gallery__main">
        <div className="gallery__title-row">
          <h1 className="gallery__title">{ui.datasets[locale]}</h1>
          <div className="kiriko-input gallery__filter">
            <input
              type="search"
              role="searchbox"
              value={filter}
              placeholder={ui.filter[locale]}
              aria-label={ui.filter[locale]}
              onChange={(event) => {
                setFilter(event.target.value);
              }}
            />
          </div>
          <button type="button" className="btn-primary gallery__upload-btn" onClick={openCreateUpload}>
            {ui.openLocal[locale]}
          </button>
          <button type="button" className="chip" onClick={() => startGdbImport({ mode: "create" })}>
            {ui.importGdb[locale]}
          </button>
          <input
            ref={gdbInputRef}
            type="file"
            accept=".zip,.gdb.zip"
            style={{ display: "none" }}
            onChange={(e) => {
              onGdbFile(e.target.files?.[0]);
            }}
          />
        </div>
        {visible.length === 0 ? (
          <div className="gallery__empty">
            <h2>{ui.empty[locale]}</h2>
            <p>{ui.emptyHint[locale]}</p>
          </div>
        ) : (
          <div className="gallery__grid">
            {visible.map((venue) => (
              <DatasetCard
                key={venue.id}
                venue={venue}
                locale={locale}
                actionsDisabled={acceptedOwner !== null}
                onOpen={() => {
                  openVenue(venue);
                }}
                {...(scene3dOffered && venue.latest?.status === "published"
                  ? {
                      onView3d: () => {
                        openVenue3d(venue);
                      },
                    }
                  : {})}
                onManageTiles={() => {
                  if (acceptedOwner !== null) return;
                  setTilesVenue(venue);
                }}
                onDelete={() => {
                  if (acceptedOwner !== null) return;
                  setDeleting(venue);
                }}
                onUploadImdf={() => {
                  openVersionUpload(venue);
                }}
                onImportGdb={() => {
                  startGdbImport({
                    mode: "version",
                    venueId: venue.id,
                    venueName: venue.name,
                  });
                }}
                onAddData={() => {
                  openAddData(venue);
                }}
                {...(venue.editableMapping
                  ? {
                      onEditMapping: () => {
                        startEditMapping(venue);
                      },
                    }
                  : {})}
                onGenerateRouting={() => {
                  if (routingJob?.venueId === venue.id) {
                    generateRouting(venue);
                    return;
                  }
                  if (venue.hasNetwork) {
                    setRegenerating(venue);
                    return;
                  }
                  generateRouting(venue);
                }}
                {...(routingJob?.venueId === venue.id
                  ? { generateRoutingLabel: ui.checkStatus[locale] }
                  : venue.hasNetwork
                    ? { generateRoutingLabel: ui.regenerateRouting[locale] }
                    : {})}
                {...(venue.latest?.status === "published"
                  ? {
                      onRegenerateScene: () => {
                        if (sceneJob?.venueId === venue.id) {
                          generateScene(venue);
                          return;
                        }
                        setRegeneratingScene(venue);
                      },
                      ...(sceneJob?.venueId === venue.id || generatingSceneId === venue.id
                        ? { regenerateSceneLabel: ui.checkStatus[locale] }
                        : {}),
                    }
                  : {})}
                {...(venue.hasGraph === true
                  ? {
                      onExportNetwork: () => {
                        exportNetwork(venue);
                      },
                      onReviewNetwork: () => {
                        openReview(venue);
                      },
                    }
                  : {})}
              />
            ))}
          </div>
        )}
      </main>
      {uploadOpen ? (
        <UploadModal
          locale={locale}
          {...(uploadTarget !== null ? { target: uploadTarget } : {})}
          onClose={closeUpload}
          onPublished={() => {
            void reload();
          }}
        />
      ) : null}
      {tilesVenue !== null ? (
        <TilePackageDialog
          locale={locale}
          venueId={tilesVenue.id}
          venueName={tilesVenue.name}
          onClose={() => {
            setTilesVenue(null);
          }}
          onActivated={() => {
            // Activation published a version, so the card's chip, its latest
            // version, and its stats are all stale.
            void reload();
          }}
        />
      ) : null}
      {regenerating !== null ? (
        <ConfirmRegenerateModal
          locale={locale}
          venueName={regenerating.name}
          onCancel={() => {
            setRegenerating(null);
          }}
          onConfirm={() => {
            const venue = regenerating;
            setRegenerating(null);
            generateRouting(venue);
          }}
        />
      ) : null}
      {regeneratingScene !== null ? (
        <ConfirmRegenerateModal
          locale={locale}
          venueName={regeneratingScene.name}
          kind="scene"
          tilesActive={regeneratingScene.tiles?.activeOnLatest === true}
          onCancel={() => {
            setRegeneratingScene(null);
          }}
          onConfirm={() => {
            const venue = regeneratingScene;
            setRegeneratingScene(null);
            generateScene(venue);
          }}
        />
      ) : null}
      {deleting !== null ? (
        <ConfirmDeleteModal
          locale={locale}
          venueName={deleting.name}
          onCancel={() => {
            setDeleting(null);
          }}
          onConfirm={() => {
            void api
              .deleteVenue(deleting.id)
              .catch(() => {
                // Deletion failed (network/server); reload below re-syncs the list.
              })
              .then(() => {
                setDeleting(null);
                return reload();
              });
          }}
        />
      ) : null}
      {gdbFlow.phase === "inspecting" ? <div className="gallery-toast">{ui.inspecting[locale]}</div> : null}
      {gdbFlow.phase === "error" ? <div className="gallery-toast gallery-toast--error">{gdbFlow.message}</div> : null}
      {routingProgress !== null ? (
        <div className="gallery-toast gallery-progress">
          <div className="gallery-progress__heading" role="status">
            <strong>{ui.generatingRouting[locale]}</strong>
            <span>{routingProgress.venueName}</span>
          </div>
          <div
            className="progress-track gallery-progress__track"
            role="progressbar"
            aria-label={ui.generatingRouting[locale]}
            aria-valuemin={routingProgressPercent === null ? undefined : 0}
            aria-valuemax={routingProgressPercent === null ? undefined : 100}
            aria-valuenow={routingProgressPercent ?? undefined}
            aria-valuetext={routingProgressText}
          >
            <div
              className={
                routingProgressPercent === null
                  ? "progress-fill gallery-progress__fill gallery-progress__fill--indeterminate"
                  : "progress-fill gallery-progress__fill"
              }
              {...(routingProgressPercent === null
                ? {}
                : { style: { width: `${routingProgressPercent}%` } })}
            />
          </div>
          <span className="gallery-progress__estimate" aria-hidden="true">
            {routingOverdue
              ? ui.routingOverdue[locale]
              : routingTimedOut
                ? ui.processingContinues[locale]
                : routingRemainingSeconds === null
                  ? ui.estimatingRoutingDuration[locale]
                  : ui.routingRemainingSeconds[locale](routingRemainingSeconds)}
          </span>
        </div>
      ) : gdbNotice !== null ? (
        <div className="gallery-toast" role="status">{gdbNotice}</div>
      ) : null}
      {gdbFlow.phase === "review" ? (
        <GdbImportDialog
          inspection={gdbFlow.data.inspection}
          initialPlan={gdbFlow.data.suggestedPlan}
          locale={locale}
          busy={gdbFlow.busy}
          error={gdbFlow.error}
          network={gdbFlow.network}
          onAddNetwork={onGdbNetworkFile}
          facilities={gdbFlow.facilities}
          onAddFacilities={onGdbFacilityFile}
          venueNameLocked={gdbFlow.target.mode !== "create"}
          cancelDisabled={gdbFlow.busy || gdbFlow.accepted !== null}
          actionLabel={gdbFlow.accepted !== null ? ui.checkStatus[locale] : undefined}
          canSubmit={gdbFlow.accepted !== null ? true : undefined}
          onImport={publishGdbPlan}
          onCancel={cancelGdbImport}
        />
      ) : null}
      {addData.phase === "open" ? (
        <AddDataDialog
          locale={locale}
          venueName={addData.venueName}
          network={addData.network}
          facilities={addData.facilities}
          busy={addData.busy}
          error={addData.error}
          onAddNetwork={onAddDataNetwork}
          onAddFacilities={onAddDataFacilities}
          cancelLocked={addData.busy || addData.accepted !== null}
          actionLabel={addData.accepted !== null ? ui.checkStatus[locale] : undefined}
          canSubmit={addData.accepted !== null ? true : undefined}
          onImport={submitAddData}
          onCancel={cancelAddData}
        />
      ) : null}
    </div>
  );
}
