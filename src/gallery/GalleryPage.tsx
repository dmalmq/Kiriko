import { useCallback, useEffect, useRef, useState } from "react";
import { KirikoMark } from "../components/icons";
import type { GdbInspectResponse, GdbMappingPlan, NetworkInspectResponse, FacilitiesInspectResponse } from "../gdb/types";
import type { LocaleCode } from "../imdf/types";
import { api, gdbErrorMessage, viewerHref, type ApiUser, type GdbError, type VenueSummary } from "./api";
import { AddDataDialog } from "./AddDataDialog";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal";
import { DatasetCard } from "./DatasetCard";
import { GdbImportDialog } from "./GdbImportDialog";
import { SignInModal } from "./SignInModal";
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
  routingGenerated: { ja: "経路を生成しました", en: "Routing generated" },
  exportingNetwork: { ja: "ネットワークを書き出し中…", en: "Exporting network…" },
  networkExported: { ja: "ネットワークを書き出しました", en: "Network exported" },
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

type GalleryState =
  | { phase: "loading" }
  | { phase: "signed-out" }
  | { phase: "ready"; user: ApiUser; venues: VenueSummary[] }
  | { phase: "error" };

type GdbTarget =
  | { mode: "create" }
  | { mode: "version"; venueId: number; venueName: string }
  | { mode: "edit-mapping"; venueId: number; venueName: string };

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
      error: GdbError | null;
    };

export function GalleryPage() {
  const [locale, setLocale] = useState<LocaleCode>("ja");
  const [state, setState] = useState<GalleryState>({ phase: "loading" });
  const [filter, setFilter] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<UploadModalTarget | null>(null);
  const [deleting, setDeleting] = useState<VenueSummary | null>(null);
  const [gdbFlow, setGdbFlow] = useState<GdbFlow>({ phase: "idle" });
  const [gdbNotice, setGdbNotice] = useState<string | null>(null);
  const [addData, setAddData] = useState<AddDataFlow>({ phase: "idle" });
  const [generatingId, setGeneratingId] = useState<number | null>(null);
  const gdbInputRef = useRef<HTMLInputElement>(null);
  const gdbTargetRef = useRef<GdbTarget>({ mode: "create" });

  const reload = useCallback(async () => {
    try {
      const user = await api.me();
      if (user === null) {
        setState({ phase: "signed-out" });
        return;
      }
      setState({ phase: "ready", user, venues: await api.listVenues() });
    } catch {
      setState({ phase: "error" });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openVenue = (venue: VenueSummary) => {
    window.location.assign(viewerHref(venue.slug, venue.latest?.publicVersionId ?? null, locale));
  };

  const openReview = (venue: VenueSummary) => {
    window.location.assign(viewerHref(venue.slug, venue.latest?.publicVersionId ?? null, locale, true));
  };

  const openCreateUpload = () => {
    setUploadTarget(null);
    setUploadOpen(true);
  };

  const openVersionUpload = (venue: VenueSummary) => {
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
    setGdbNotice(null);
    gdbTargetRef.current = target;
    gdbInputRef.current?.click();
  };

  const startEditMapping = (venue: VenueSummary) => {
    setGdbNotice(null);
    const target: GdbTarget = { mode: "edit-mapping", venueId: venue.id, venueName: venue.name };
    setGdbFlow({ phase: "inspecting", target });
    void (async () => {
      try {
        const mapping = await api.getGdbMapping(venue.id);
        setGdbFlow({
          phase: "review",
          target,
          data: {
            blobHash: mapping.blobHash,
            inspection: mapping.inspection,
            suggestedPlan: mapping.plan,
          },
          network: null,
          facilities: null,
          busy: false,
          error: null,
        });
      } catch (err) {
        setGdbFlow({ phase: "error", target, message: gdbErrorMessage(err as GdbError, locale) });
      }
    })();
  };

  const onGdbFile = (file: File | undefined) => {
    if (!file) return;
    const target = gdbTargetRef.current;
    setGdbNotice(null);
    setGdbFlow({ phase: "inspecting", target });
    void (async () => {
      try {
        const data = await api.inspectGdb(file);
        let suggestedPlan = data.suggestedPlan;
        if (target.mode === "version") {
          suggestedPlan = { ...suggestedPlan, venueName: target.venueName };
        }
        setGdbFlow({
          phase: "review",
          target,
          data: { ...data, suggestedPlan },
          network: null,
          facilities: null,
          busy: false,
          error: null,
        });
      } catch (err) {
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
    void (async () => {
      try {
        const network = await api.inspectGdbNetwork(file);
        setGdbFlow((current) =>
          current.phase === "review" ? { ...current, network, error: null } : current,
        );
      } catch (err) {
        setGdbFlow((current) =>
          current.phase === "review" ? { ...current, error: err as GdbError } : current,
        );
      }
    })();
  };

  const onGdbFacilityFile = (file: File) => {
    if (gdbFlow.phase !== "review") return;
    void (async () => {
      try {
        const facilities = await api.inspectGdbFacilities(file);
        setGdbFlow((current) =>
          current.phase === "review" ? { ...current, facilities, error: null } : current,
        );
      } catch (err) {
        setGdbFlow((current) =>
          current.phase === "review" ? { ...current, error: err as GdbError } : current,
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
    setGdbFlow({ phase: "review", target, data, network, facilities, busy: true, error: null });
    void (async () => {
      let createdVenueId: number | null = null;
      try {
        let venueId: number;
        if (target.mode === "version" || target.mode === "edit-mapping") {
          venueId = target.venueId;
        } else {
          const venue = await api.createVenue(plan.venueName.trim());
          createdVenueId = venue.id;
          venueId = venue.id;
        }
        const published = await api.publishGdb(venueId, data.blobHash, plan, network?.networkBlobHash ?? null, facilities?.facilitiesBlobHash ?? null);
        const job = await api.waitForJob(published.jobId);
        if (job.status === "done") {
          const skipped = published.excludedLayers ?? [];
          if (skipped.length > 0) {
            const sample = skipped[0]!.layer;
            setGdbNotice(ui.publishedWithSkips[locale](skipped.length, sample));
          } else {
            setGdbNotice(null);
          }
          setGdbFlow({ phase: "idle" });
          if (gdbInputRef.current) gdbInputRef.current.value = "";
          gdbTargetRef.current = { mode: "create" };
          await reload();
        } else {
          setGdbFlow({
            phase: "review",
            target,
            data,
            network,
            facilities,
            busy: false,
            error: { code: "gdb_conversion_failed", message: job.error },
          });
        }
      } catch (err) {
        // Orphan cleanup only for venues we just created in this attempt.
        if (createdVenueId !== null) {
          try {
            await api.deleteVenue(createdVenueId);
          } catch {
            /* best effort */
          }
        }
        setGdbFlow({
          phase: "review",
          target,
          data,
          network,
          facilities,
          busy: false,
          error: err as GdbError,
        });
      }
    })();
  };

  const cancelGdbImport = () => {
    setGdbFlow({ phase: "idle" });
    gdbTargetRef.current = { mode: "create" };
    if (gdbInputRef.current) gdbInputRef.current.value = "";
  };

  const openAddData = (venue: VenueSummary) => {
    setGdbNotice(null);
    setAddData({
      phase: "open",
      venueId: venue.id,
      venueName: venue.name,
      network: null,
      facilities: null,
      busy: false,
      error: null,
    });
  };

  const onAddDataNetwork = (file: File) => {
    void (async () => {
      try {
        const network = await api.inspectGdbNetwork(file);
        setAddData((c) => (c.phase === "open" ? { ...c, network, error: null } : c));
      } catch (err) {
        setAddData((c) => (c.phase === "open" ? { ...c, error: err as GdbError } : c));
      }
    })();
  };

  const onAddDataFacilities = (file: File) => {
    void (async () => {
      try {
        const facilities = await api.inspectGdbFacilities(file);
        setAddData((c) => (c.phase === "open" ? { ...c, facilities, error: null } : c));
      } catch (err) {
        setAddData((c) => (c.phase === "open" ? { ...c, error: err as GdbError } : c));
      }
    })();
  };

  const submitAddData = () => {
    if (addData.phase !== "open") return;
    const { venueId, network, facilities } = addData;
    if (network === null && facilities === null) return;
    setAddData({ ...addData, busy: true, error: null });
    void (async () => {
      try {
        const res = await api.augmentGdb(venueId, {
          ...(network ? { networkBlobHash: network.networkBlobHash } : {}),
          ...(facilities ? { facilitiesBlobHash: facilities.facilitiesBlobHash } : {}),
        });
        const job = await api.waitForJob(res.jobId);
        if (job.status === "done") {
          setAddData({ phase: "idle" });
          await reload();
        } else {
          setAddData((c) =>
            c.phase === "open"
              ? { ...c, busy: false, error: { code: "gdb_conversion_failed", message: job.error } }
              : c,
          );
        }
      } catch (err) {
        setAddData((c) => (c.phase === "open" ? { ...c, busy: false, error: err as GdbError } : c));
      }
    })();
  };

  const cancelAddData = () => {
    setAddData({ phase: "idle" });
  };

  const generateRouting = (venue: VenueSummary) => {
    if (generatingId !== null) return;
    setGeneratingId(venue.id);
    setGdbNotice(ui.generatingRouting[locale]);
    void (async () => {
      try {
        const res = await api.generateNetwork(venue.id);
        const job = await api.waitForJob(res.jobId);
        if (job.status === "done") {
          setGdbNotice(ui.routingGenerated[locale]);
          await reload();
        } else {
          setGdbNotice(gdbErrorMessage({ code: "gdb_conversion_failed", message: job.error }, locale));
        }
      } catch (err) {
        setGdbNotice(gdbErrorMessage(err as GdbError, locale));
      } finally {
        setGeneratingId(null);
      }
    })();
  };

  const exportNetwork = (venue: VenueSummary) => {
    setGdbNotice(ui.exportingNetwork[locale]);
    void (async () => {
      try {
        const { blob, filename } = await api.exportNetwork(venue.id);
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
        const code =
          (err as { code?: string; error?: string }).code ??
          (err as { error?: string }).error;
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
                onOpen={() => {
                  openVenue(venue);
                }}
                onDelete={() => {
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
                {...(venue.hasNetwork === false
                  ? {
                      onGenerateRouting: () => {
                        generateRouting(venue);
                      },
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
      {gdbNotice !== null ? (
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
          onImport={submitAddData}
          onCancel={cancelAddData}
        />
      ) : null}
    </div>
  );
}
