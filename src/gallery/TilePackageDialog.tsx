import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { LocaleCode } from "../imdf/types";
import { api, TileApiError } from "./api";
import { tileErrorMessage, tileGateMessage, type TileActivationGate } from "./tileGates";
import type {
  FloorRegistration,
  RegistrationProfileInput,
  TileLevelRegistration,
  TilePackageListEntry,
} from "./tileTypes";

/**
 * The producer surface for the 3D Tiles path (#80).
 *
 * Three phases, because the contract has three acts: upload a package, measure
 * it against the venue's own geometry, and activate it. Only the middle one is a
 * loop — gates name subjects, and a producer answers with a vertical offset, a
 * widened band, or a contextual classification, then measures again.
 *
 * Nothing here judges a package. Every number shown is the core's, printed beside
 * the band it is measured against; every gate's sentence comes from
 * `tileGates.ts`. This module decides only what to show and what to send.
 */

const ui = {
  title: { ja: "3D タイル", en: "3D Tiles" },
  hint: {
    ja: "3D Tiles パッケージを取り込み、会場自身の形状に対して位置合わせを測り、有効化します。",
    en: "Ingest a 3D Tiles package, measure it against the venue's own geometry, and activate it.",
  },
  choose: { ja: "3D タイルパッケージを選択", en: "Choose a 3D Tiles package" },
  uploading: { ja: "アップロード中", en: "Uploading" },
  loading: { ja: "読み込み中…", en: "Loading…" },
  accepted: { ja: "取り込みました", en: "Accepted" },
  rootTileset: { ja: "ルートタイルセット", en: "Root tileset" },
  assetVersions: { ja: "アセットバージョン", en: "Asset versions" },
  extensions: { ja: "拡張", en: "Extensions" },
  members: { ja: "メンバー", en: "Members" },
  reused: { ja: "既に保管済み", en: "already stored" },
  size: { ja: "サイズ", en: "Size" },
  ignored: {
    ja: "参照されていない項目（保存されません）",
    en: "Entries the package never references (not stored)",
  },
  measure: { ja: "位置合わせを測定", en: "Measure registration" },
  measureAgain: { ja: "もう一度測定", en: "Measure again" },
  measuring: { ja: "測定中…", en: "Measuring…" },
  venueWide: { ja: "会場全体", en: "Venue-wide" },
  samples: { ja: "サンプル", en: "Samples" },
  floorsTable: { ja: "フロア", en: "Floors" },
  levelsTable: { ja: "レベル", en: "Levels" },
  canonicalFloor: { ja: "会場のフロア", en: "Venue floor" },
  sampled: { ja: "サンプル", en: "Sampled" },
  carvedOut: { ja: "除外", en: "Carved out" },
  medianShift: { ja: "一方向のずれ", en: "Median shift" },
  clusters: { ja: "まとまったずれ", en: "Coherent clusters" },
  level: { ja: "レベル", en: "Level" },
  resolvedPlane: { ja: "形状から求めた床面", en: "Resolved plane" },
  metadataElevation: { ja: "メタデータの標高", en: "Metadata elevation" },
  difference: { ja: "差", en: "Difference" },
  triangles: { ja: "三角形", en: "Triangles" },
  unmapped: {
    ja: "対応するフロアがないレベル",
    en: "Levels no venue floor corresponds to",
  },
  levers: { ja: "プロファイル", en: "Profile" },
  verticalOffset: { ja: "垂直オフセット（m）", en: "Vertical offset (m)" },
  verticalOffsetHint: {
    ja: "タイルの床面に加えてから対応付けます。推測はしません。",
    en: "Added to tile planes before matching. Never inferred.",
  },
  bandFor: { ja: (id: string) => `${id} の p90 許容値（m）`, en: (id: string) => `p90 band for ${id} (m)` },
  contextFor: { ja: (id: string) => `${id} をコンテキストとして扱う`, en: (id: string) => `Treat ${id} as context` },
  blocked: { ja: "有効化できません", en: "Activation is blocked" },
  activate: { ja: "有効化", en: "Activate" },
  activating: { ja: "有効化中…", en: "Activating…" },
  activated: { ja: "有効化しました", en: "Activated" },
  serving: { ja: "公開中のバージョンが使用中", en: "A published version serves this" },
  discard: { ja: "破棄", en: "Discard" },
  close: { ja: "閉じる", en: "Close" },
  cancel: { ja: "キャンセル", en: "Cancel" },
} as const;

/** Bytes as a producer reads them: a 172 MiB package is not 179,945,088. */
function formatBytes(bytes: number, locale: LocaleCode): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1
    ? `${mib.toLocaleString(locale === "ja" ? "ja-JP" : "en-US", { maximumFractionDigits: 1 })} MiB`
    : `${bytes.toLocaleString(locale === "ja" ? "ja-JP" : "en-US")} B`;
}

const metres = (value: number): string => value.toFixed(2);

/**
 * A listed package plus what only a fresh upload knows: how many of its members
 * the blob store already held. The list route reports a member count, not which
 * bytes were new, because after the fact nothing distinguishes them.
 */
type PackageView = TilePackageListEntry & { reusedMembers?: number };

type Phase =
  | { step: "loading" }
  | { step: "choose" }
  | { step: "uploading"; fraction: number }
  | { step: "package"; entry: PackageView }
  | { step: "measuring"; entry: PackageView }
  | { step: "activating"; entry: PackageView }
  | { step: "activated" };

export interface TilePackageDialogProps {
  locale: LocaleCode;
  venueId: number;
  venueName: string;
  onClose: () => void;
  /** Activation published a version, so the gallery's data is stale. */
  onActivated: () => void;
}

export function TilePackageDialog({
  locale,
  venueId,
  venueName,
  onClose,
  onActivated,
}: TilePackageDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [phase, setPhase] = useState<Phase>({ step: "loading" });
  const [failure, setFailure] = useState<string | null>(null);
  const [gates, setGates] = useState<TileActivationGate[]>([]);
  // The levers, held as typed text: a half-entered "-" or "0." is not a number
  // yet, and coercing while the producer types would fight the input.
  const [offsetText, setOffsetText] = useState("");
  const [bandText, setBandText] = useState<Record<string, string>>({});
  const [contextual, setContextual] = useState<string[]>([]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.open = true;
    }
  }, []);

  const busy =
    phase.step === "uploading" || phase.step === "measuring" || phase.step === "activating";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      if (!busy) onClose();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [busy, onClose]);

  // The venue's existing packages, so a reload resumes rather than re-uploading.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const packages = await api.listTilePackages(venueId);
        if (cancelled) return;
        const newest = packages[0];
        if (newest === undefined) {
          setPhase({ step: "choose" });
          return;
        }
        setGates(newest.evaluation?.gates ?? []);
        setOffsetText(
          newest.evaluation === null
            ? ""
            : String(newest.evaluation.report.appliedVerticalOffsetM),
        );
        setPhase({ step: "package", entry: newest });
      } catch (error) {
        if (cancelled) return;
        setFailure(tileErrorMessage(error instanceof TileApiError ? error.code : "", locale));
        setPhase({ step: "choose" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [venueId, locale]);

  const profile = useMemo((): RegistrationProfileInput => {
    const built: RegistrationProfileInput = {};
    const offset = Number.parseFloat(offsetText);
    if (offsetText.trim() !== "" && Number.isFinite(offset)) {
      built.verticalOffsetM = offset;
    }
    const bands: Record<string, number> = {};
    for (const [canonicalId, text] of Object.entries(bandText)) {
      const band = Number.parseFloat(text);
      if (text.trim() !== "" && Number.isFinite(band)) {
        bands[canonicalId] = band;
      }
    }
    if (Object.keys(bands).length > 0) {
      built.floorP90MaxM = bands;
    }
    return built;
  }, [offsetText, bandText]);

  const measure = useCallback(
    async (entry: TilePackageListEntry) => {
      setFailure(null);
      setPhase({ step: "measuring", entry });
      try {
        const result = await api.evaluateTilePackage(venueId, entry.packageId, {
          capabilityProfile: "webgl2-mrt-float",
          ...(contextual.length > 0 ? { contextualSourceObjects: contextual } : {}),
          ...(Object.keys(profile).length > 0 ? { profile } : {}),
        });
        setGates(result.gates);
        setPhase({
          step: "package",
          entry: {
            ...entry,
            evaluation: {
              state: "evaluated",
              // A fresh measurement is by definition against the current version.
              current: true,
              capabilityProfile: "webgl2-mrt-float",
              profileId: result.report.profileId,
              profileVersion: result.report.profileVersion,
              report: result.report,
              gates: result.gates,
              evaluatedAt: new Date().toISOString(),
              activatedAt: null,
            },
          },
        });
      } catch (error) {
        setFailure(tileErrorMessage(error instanceof TileApiError ? error.code : "", locale));
        setPhase({ step: "package", entry });
      }
    },
    [venueId, locale, contextual, profile],
  );

  // Every phase past the upload carries the package; `activated` is the one that
  // does not, and it has nothing left to show about it.
  const entry = "entry" in phase ? phase.entry : null;
  const evaluation = entry?.evaluation ?? null;
  const report = evaluation?.report ?? null;
  const canActivate =
    phase.step === "package"
    && evaluation !== null
    && evaluation.current
    && evaluation.state !== "activated"
    && gates.length === 0
    && entry?.serving === false;

  return (
    <dialog
      ref={dialogRef}
      className="gdb-dialog tile-dialog"
      aria-labelledby={headingId}
      onClick={(event) => {
        if (event.target === dialogRef.current && !busy) onClose();
      }}
    >
      <div className="gdb-dialog__form">
        <h2 id={headingId} className="gdb-dialog__title">
          {ui.title[locale]}
        </h2>
        <section className="gdb-dialog__section">
          <p className="gdb-dialog__summary">{venueName}</p>
          <p className="gdb-dialog__summary">{ui.hint[locale]}</p>

          {phase.step === "loading" ? <p className="gdb-dialog__summary">{ui.loading[locale]}</p> : null}

          {phase.step === "choose" || phase.step === "uploading" ? (
            <label className="gdb-dialog__btn tile-dialog__choose">
              {phase.step === "uploading"
                ? `${ui.uploading[locale]} ${Math.round(phase.fraction * 100)}%`
                : ui.choose[locale]}
              <input
                type="file"
                accept=".zip,.3tz"
                style={{ display: "none" }}
                aria-label={ui.choose[locale]}
                disabled={phase.step === "uploading"}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  setFailure(null);
                  setPhase({ step: "uploading", fraction: 0 });
                  void (async () => {
                    try {
                      const record = await api.uploadTilePackage(venueId, file, (fraction) => {
                        setPhase({ step: "uploading", fraction });
                      });
                      setGates([]);
                      setPhase({
                        step: "package",
                        entry: {
                          packageId: record.packageId,
                          sourceHash: record.sourceHash,
                          rootTileset: record.rootTileset,
                          assetVersions: record.assetVersions,
                          extensions: record.extensions,
                          ignored: record.ignored,
                          totalBytes: record.totalBytes,
                          memberCount: record.members.length,
                          reusedMembers: record.members.filter((member) => member.reused).length,
                          createdAt: new Date().toISOString(),
                          evaluation: null,
                          serving: false,
                        },
                      });
                    } catch (error) {
                      setFailure(
                        tileErrorMessage(error instanceof TileApiError ? error.code : "", locale),
                      );
                      setPhase({ step: "choose" });
                    }
                  })();
                }}
              />
            </label>
          ) : null}

          {phase.step === "package" || phase.step === "measuring" || phase.step === "activating" ? (
            <AcceptedRecord entry={phase.entry} locale={locale} />
          ) : null}

          {phase.step === "activated" ? (
            <p className="gdb-dialog__summary tile-dialog__activated">{ui.activated[locale]}</p>
          ) : null}

          {report !== null ? (
            <>
              <table
                className="gdb-dialog__table tile-dialog__venue-wide"
                aria-label={ui.venueWide[locale]}
              >
                <thead>
                  <tr>
                    <th>{ui.samples[locale]}</th>
                    <th>p50</th>
                    <th>p90</th>
                    <th>max</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      {report.venueWide.samples.toLocaleString(
                        locale === "ja" ? "ja-JP" : "en-US",
                      )}
                    </td>
                    <td>{metres(report.venueWide.p50M)}</td>
                    <td>{metres(report.venueWide.p90M)}</td>
                    <td>{metres(report.venueWide.maxM)}</td>
                  </tr>
                </tbody>
              </table>
              <FloorTable
                floors={report.floors}
                locale={locale}
                bandText={bandText}
                onBandChange={(canonicalId, value) => {
                  setBandText((current) => ({ ...current, [canonicalId]: value }));
                }}
              />
              <LevelTable levels={report.levels} locale={locale} />
              {report.unmappedLevels.length > 0 ? (
                <p className="gdb-dialog__summary tile-dialog__unmapped">
                  {ui.unmapped[locale]}: {report.unmappedLevels.join(", ")}
                </p>
              ) : null}
            </>
          ) : null}

          {evaluation !== null && !evaluation.current ? (
            <div className="gdb-dialog__error" role="alert">
              <p>{tileErrorMessage("evaluation_stale", locale)}</p>
            </div>
          ) : null}

          {entry?.serving === true ? (
            <p className="gdb-dialog__summary tile-dialog__serving">{ui.serving[locale]}</p>
          ) : null}

          {gates.length > 0 ? (
            <div className="gdb-dialog__error tile-dialog__gates" role="alert">
              <p>{ui.blocked[locale]}</p>
              <ul>
                {gates.map((gate) => (
                  <li key={`${gate.code}:${gate.subject}`}>{tileGateMessage(gate, locale)}</li>
                ))}
              </ul>
              {gates
                .filter((gate) => gate.code === "unclassifiedOpaqueContent")
                .map((gate) => (
                  <label key={gate.subject} className="tile-dialog__context">
                    <input
                      type="checkbox"
                      aria-label={ui.contextFor[locale](gate.subject)}
                      checked={contextual.includes(gate.subject)}
                      onChange={(event) => {
                        setContextual((current) =>
                          event.target.checked
                            ? [...current, gate.subject]
                            : current.filter((id) => id !== gate.subject),
                        );
                      }}
                    />
                    {ui.contextFor[locale](gate.subject)}
                  </label>
                ))}
            </div>
          ) : null}

          {report !== null ? (
            <div className="tile-dialog__levers">
              <p className="gdb-dialog__summary">{ui.levers[locale]}</p>
              <label className="gdb-dialog__field">
                {ui.verticalOffset[locale]}
                <input
                  className="gdb-dialog__input"
                  type="text"
                  inputMode="decimal"
                  aria-label={ui.verticalOffset[locale]}
                  value={offsetText}
                  onChange={(event) => setOffsetText(event.target.value)}
                />
              </label>
              <p className="gdb-dialog__summary">{ui.verticalOffsetHint[locale]}</p>
            </div>
          ) : null}

          {failure !== null ? (
            <div className="gdb-dialog__error" role="alert">
              <p>{failure}</p>
            </div>
          ) : null}

          <div className="gdb-dialog__actions">
            <button type="button" className="gdb-dialog__btn" onClick={onClose} disabled={busy}>
              {busy ? ui.cancel[locale] : ui.close[locale]}
            </button>
            {phase.step === "package" || phase.step === "measuring" ? (
              <button
                type="button"
                className="gdb-dialog__btn"
                disabled={busy}
                onClick={() => {
                  void measure(phase.entry);
                }}
              >
                {phase.step === "measuring"
                  ? ui.measuring[locale]
                  : phase.entry.evaluation === null
                    ? ui.measure[locale]
                    : ui.measureAgain[locale]}
              </button>
            ) : null}
            {phase.step === "package" || phase.step === "activating" ? (
              <button
                type="button"
                className="gdb-dialog__btn gdb-dialog__btn--primary"
                disabled={!canActivate}
                onClick={() => {
                  const entry = phase.entry;
                  setFailure(null);
                  setPhase({ step: "activating", entry });
                  void (async () => {
                    try {
                      const submitted = await api.activateTilePackage(venueId, entry.packageId);
                      const job = await api.waitForJob(submitted.jobId);
                      if (job.status !== "done") {
                        setFailure(tileErrorMessage("", locale));
                        setPhase({ step: "package", entry });
                        return;
                      }
                      setPhase({ step: "activated" });
                      onActivated();
                    } catch (error) {
                      if (error instanceof TileApiError) {
                        setGates(error.gates);
                        setFailure(tileErrorMessage(error.code, locale));
                      } else {
                        setFailure(tileErrorMessage("", locale));
                      }
                      setPhase({ step: "package", entry });
                    }
                  })();
                }}
              >
                {phase.step === "activating" ? ui.activating[locale] : ui.activate[locale]}
              </button>
            ) : null}
          </div>
        </section>
      </div>
    </dialog>
  );
}

function AcceptedRecord({ entry, locale }: { entry: PackageView; locale: LocaleCode }) {
  return (
    <div className="tile-dialog__record">
      <p className="gdb-dialog__summary">
        {ui.rootTileset[locale]}: <strong>{entry.rootTileset}</strong>
      </p>
      <p className="gdb-dialog__summary">
        {ui.members[locale]}: {entry.memberCount} · {ui.size[locale]}:{" "}
        {formatBytes(entry.totalBytes, locale)}
        {/* Dedup is a real producer signal on a second upload: members the store
            already held cost nothing and were not re-sent to disk. */}
        {entry.reusedMembers !== undefined && entry.reusedMembers > 0
          ? ` · ${entry.reusedMembers} ${ui.reused[locale]}`
          : ""}
      </p>
      {entry.assetVersions.length > 0 ? (
        <p className="gdb-dialog__summary">
          {ui.assetVersions[locale]}: {entry.assetVersions.join(", ")}
        </p>
      ) : null}
      {entry.extensions.length > 0 ? (
        <p className="gdb-dialog__summary">
          {ui.extensions[locale]}: {entry.extensions.join(", ")}
        </p>
      ) : null}
      {entry.ignored.length > 0 ? (
        <p className="gdb-dialog__summary tile-dialog__ignored">
          {ui.ignored[locale]}: {entry.ignored.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function FloorTable({
  floors,
  locale,
  bandText,
  onBandChange,
}: {
  floors: FloorRegistration[];
  locale: LocaleCode;
  bandText: Record<string, string>;
  onBandChange: (canonicalId: string, value: string) => void;
}) {
  if (floors.length === 0) return null;
  return (
    <table className="gdb-dialog__table" aria-label={ui.floorsTable[locale]}>
      <thead>
        <tr>
          <th>{ui.canonicalFloor[locale]}</th>
          <th>{ui.sampled[locale]}</th>
          <th>{ui.carvedOut[locale]}</th>
          <th>p50</th>
          <th>p90</th>
          <th>max</th>
          <th>{ui.medianShift[locale]}</th>
          <th>{ui.clusters[locale]}</th>
          <th>p90 band</th>
        </tr>
      </thead>
      <tbody>
        {floors.map((floor) => (
          <tr key={floor.canonicalLevelId}>
            <td>{floor.canonicalLevelId}</td>
            <td>{floor.sampled}</td>
            <td>{floor.carvedOut}</td>
            <td>{metres(floor.stats.p50M)}</td>
            <td>{metres(floor.stats.p90M)}</td>
            <td>{metres(floor.stats.maxM)}</td>
            <td>{metres(floor.medianShiftM)}</td>
            <td>{floor.coherentClusters.length}</td>
            <td>
              <input
                className="gdb-dialog__input tile-dialog__band"
                type="text"
                inputMode="decimal"
                aria-label={ui.bandFor[locale](floor.canonicalLevelId)}
                value={bandText[floor.canonicalLevelId] ?? ""}
                onChange={(event) => onBandChange(floor.canonicalLevelId, event.target.value)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LevelTable({ levels, locale }: { levels: TileLevelRegistration[]; locale: LocaleCode }) {
  if (levels.length === 0) return null;
  return (
    <table className="gdb-dialog__table" aria-label={ui.levelsTable[locale]}>
      <thead>
        <tr>
          <th>{ui.level[locale]}</th>
          <th>{ui.resolvedPlane[locale]}</th>
          <th>{ui.metadataElevation[locale]}</th>
          <th>{ui.difference[locale]}</th>
          <th>{ui.triangles[locale]}</th>
        </tr>
      </thead>
      <tbody>
        {levels.map((level) => (
          <tr key={level.compositeId}>
            <td>{level.levelName}</td>
            <td>{level.resolvedPlaneM === null ? "—" : metres(level.resolvedPlaneM)}</td>
            <td>{metres(level.metadataElevationM)}</td>
            {/* The disagreement is provenance, not an error: the mesh is what
                renders, and #31 measured 3.02 m of it at KITTE. */}
            <td>{level.metadataDifferenceM === null ? "—" : metres(level.metadataDifferenceM)}</td>
            <td>{level.surfaceTriangles}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
