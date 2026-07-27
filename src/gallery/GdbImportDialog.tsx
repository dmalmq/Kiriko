import { useEffect, useMemo, useRef, useState } from "react";
import { gdbErrorMessage, type GdbError } from "./api";
import type { LocaleCode } from "../imdf/types";
import {
  collectBlockingIssues,
  gdbTargetTypesForGeometry,
} from "../gdb/planValidation";
import {
  gdbLayerKeyString,
  type GdbInspection,
  type GdbLayerDescriptor,
  type GdbLayerPlan,
  type GdbLevelRule,
  type GdbMappingPlan,
  type GdbTargetType,
  type NetworkInspectResponse,
  type FacilitiesInspectResponse,
} from "../gdb/types";

/** Client-side page size for the layer review table. */
const ROWS_PER_PAGE = 100;

type RuleKind = GdbLevelRule["kind"] | "none";

const ui = {
  title: { ja: "GDB レイヤーの割り当てを確認", en: "Review GDB layer mappings" },
  venueName: { ja: "会場名", en: "Venue name" },
  buildings: { ja: "建物", en: "Buildings" },
  includeBuilding: { ja: "取り込む", en: "Include" },
  buildingNamePlaceholder: { ja: "建物名", en: "Building name" },
  addBuilding: { ja: "建物を追加", en: "Add building" },
  deleteBuilding: { ja: "削除", en: "Delete" },
  layers: { ja: "レイヤー", en: "Layers" },
  filter: { ja: "レイヤーを絞り込み", en: "Filter layers" },
  prev: { ja: "前へ", en: "Previous" },
  next: { ja: "次へ", en: "Next" },
  colInclude: { ja: "取込", en: "Include" },
  colLayer: { ja: "データベース / レイヤー", en: "Database / layer" },
  colFeatures: { ja: "地物 / 形状", en: "Features / geometry" },
  colType: { ja: "対象種別", en: "Target type" },
  colBuilding: { ja: "建物", en: "Building" },
  colLevelRule: { ja: "レベル規則", en: "Level rule" },
  colId: { ja: "ID 項目", en: "ID field" },
  colOrdinal: { ja: "序数項目", en: "Ordinal field" },
  colShortName: { ja: "略称項目", en: "Short-name field" },
  colName: { ja: "名称項目", en: "Name field" },
  colCategory: { ja: "分類項目", en: "Category field" },
  none: { ja: "(なし)", en: "(none)" },
  ruleSourceReference: { ja: "参照項目", en: "Source reference" },
  ruleProperty: { ja: "フロア属性", en: "Floor property" },
  ruleLayerName: { ja: "レイヤー名", en: "Layer name" },
  ruleFixed: { ja: "固定", en: "Fixed" },
  fixedLabel: { ja: "ラベル", en: "Label" },
  fixedOrdinal: { ja: "序数", en: "Ordinal" },
  summary: { ja: "概要", en: "Summary" },
  warnings: { ja: "検査の警告", en: "Inspection warnings" },
  blocking: { ja: "解決が必要な項目", en: "Blocking issues" },
  cancel: { ja: "キャンセル", en: "Cancel" },
  import: { ja: "取り込む", en: "Import" },
  addNetwork: { ja: "ルーティングネットワークを追加", en: "Add routing network" },
  addFacilities: { ja: "地点施設を追加", en: "Add point facilities" },
} as const;

const summaryText = {
  ja: (layers: number, features: number) => `取込対象: ${layers} レイヤー / ${features} 地物`,
  en: (layers: number, features: number) => `Including ${layers} layers, ${features} features`,
};

const pageText = {
  ja: (page: number, total: number) => `${page} / ${total} ページ`,
  en: (page: number, total: number) => `Page ${page} of ${total}`,
};

export const routingSummaryText = {
  ja: (nodes: number, paths: number, floors: number) =>
    `ルーティングネットワーク: ${nodes} ノード、${paths} パス、${floors} フロア`,
  en: (nodes: number, paths: number, floors: number) =>
    `Routing network: ${nodes} nodes, ${paths} paths, ${floors} floors`,
};

export const facilitiesSummaryText = {
  ja: (places: number, floors: number) => `施設: ${places} 件、${floors} フロア`,
  en: (places: number, floors: number) => `Facilities: ${places} places, ${floors} floors`,
};


/**
 * Localized reason phrases for a `gdb_conversion_failed`/`gdb_too_large` that
 * blames one layer. The internal `reason` strings buildGdbVenue throws are
 * collapsed to a small set of user-facing categories.
 */
const conversionReasonText = {
  floor: {
    ja: "をフロアに割り当てできませんでした",
    en: "could not be matched to a floor",
  },
  geometry: {
    ja: "の形状が対象種別と一致しません",
    en: "has a geometry type that does not match its target",
  },
  ordinal: {
    ja: "のフロア番号を解決できませんでした",
    en: "has no resolvable floor number",
  },
  empty: {
    ja: "に使用可能な形状がありません",
    en: "has no usable geometry",
  },
  duplicateId: {
    ja: "のフロア ID が重複しています",
    en: "has a duplicate floor id",
  },
  building: {
    ja: "に建物が割り当てられていません",
    en: "has no building assigned",
  },
  tooLarge: {
    ja: "の変換結果が処理上限を超えました",
    en: "produced output beyond the processing limit",
  },
  generic: {
    ja: "を変換できませんでした",
    en: "could not be converted",
  },
} as const;

const conversionReasonCategory: Record<string, keyof typeof conversionReasonText> = {
  "unresolved source-reference level": "floor",
  "unresolved feature floor": "floor",
  "row without building": "building",
  "unknown building id": "building",
  "incompatible feature geometry": "geometry",
  "incompatible level geometry": "geometry",
  "incompatible GeometryCollection member family": "geometry",
  "unresolved level ordinal": "ordinal",
  "empty or geometry-less level layer": "empty",
  "empty or geometry-less layer": "empty",
  "ambiguous duplicate raw level id": "duplicateId",
};

const conversionLayerText = {
  ja: (layer: string, phrase: string) => `レイヤー「${layer}」${phrase}`,
  en: (layer: string, phrase: string) => `Layer "${layer}" ${phrase}`,
};

const conversionAdviceText = {
  ja: (layer: string, phrase: string) =>
    `${conversionLayerText.ja(layer, phrase)}。取込対象から外すか割り当てを変更して再度取り込んでください。`,
  en: (layer: string, phrase: string) =>
    `${conversionLayerText.en(layer, phrase)}. Exclude it or adjust its mapping, then import again.`,
};

const conversionListHeader = {
  ja: (count: number) =>
    `${count} 個のレイヤーを変換できませんでした。取込対象から外すか割り当てを変更して再度取り込んでください:`,
  en: (count: number) =>
    `${count} layer${count === 1 ? "" : "s"} could not be converted. Exclude or fix them, then import again:`,
};

/** Resolve the localized reason phrase for a conversion/too-large failure. */
function conversionReasonPhrase(
  reason: string | null,
  tooLarge: boolean,
  locale: LocaleCode,
): string {
  let category: keyof typeof conversionReasonText = "generic";
  if (tooLarge) {
    category = "tooLarge";
  } else if (reason !== null && reason in conversionReasonCategory) {
    category = conversionReasonCategory[reason]!;
  }
  return conversionReasonText[category][locale];
}

/**
 * Build a localized, actionable line naming the single layer a conversion
 * failure blames, or null when the error carries no layer identity. The
 * worker's raw `detail` (e.g. a GDAL message) is appended when present. Used for
 * worker-export failures and as a fallback when no `failures` list is attached.
 */
export function conversionErrorDetail(error: GdbError, locale: LocaleCode): string | null {
  if (error.code !== "gdb_conversion_failed" && error.code !== "gdb_too_large") return null;
  const details = error.details;
  if (!details) return null;
  const layer = typeof details.layer === "string" && details.layer.length > 0 ? details.layer : null;
  if (layer === null) return null;
  const reason = typeof details.reason === "string" ? details.reason : null;
  const phrase = conversionReasonPhrase(reason, error.code === "gdb_too_large", locale);
  let message = conversionAdviceText[locale](layer, phrase);
  const detail =
    typeof details.detail === "string" && details.detail.length > 0 ? details.detail : null;
  if (detail !== null) {
    message += locale === "ja" ? `（${detail}）` : ` (${detail})`;
  }
  return message;
}

/**
 * Parse the `details.failures` list buildGdbVenue enrichment attaches into
 * localized per-layer lines, or null when the error carries no such list. Each
 * item names one layer that must be excluded or fixed before import.
 */
export function conversionFailureList(
  error: GdbError,
  locale: LocaleCode,
): { layer: string; text: string }[] | null {
  if (error.code !== "gdb_conversion_failed") return null;
  const raw = error.details?.failures;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: { layer: string; text: string }[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const record: Record<string, unknown> = entry;
    const layer =
      typeof record.layer === "string" && record.layer.length > 0 ? record.layer : null;
    if (layer === null) continue;
    const reason = typeof record.reason === "string" ? record.reason : null;
    items.push({ layer, text: conversionLayerText[locale](layer, conversionReasonPhrase(reason, false, locale)) });
  }
  return items.length > 0 ? items : null;
}

export interface GdbImportDialogProps {
  inspection: GdbInspection;
  initialPlan: GdbMappingPlan;
  locale: LocaleCode;
  busy: boolean;
  error: GdbError | null;
  /** When true, venue name is shown but not editable (existing-venue version import). */
  venueNameLocked?: boolean;
  /** Optional routing network attached to this import; summarized when present. */
  network?: NetworkInspectResponse | null;
  /** When provided, an "Add routing network" file picker is shown. */
  onAddNetwork?: (file: File) => void;
  /** Optional point facilities attached to this import; summarized when present. */
  facilities?: FacilitiesInspectResponse | null;
  /** When provided, an "Add point facilities" file picker is shown. */
  onAddFacilities?: (file: File) => void;
  onImport: (plan: GdbMappingPlan) => void;
  onCancel: () => void;
}


/**
 * Drop buildings that no included layer assigns. Excluded zero-feature rows may
 * still carry a buildingId for review, but conversion must never receive a
 * declared building with no included assignment.
 */
function pruneUnusedBuildings(plan: GdbMappingPlan): GdbMappingPlan {
  const layers = plan.layers.map((layer) => ({
    ...layer,
    buildingId: layer.buildingId === "" ? null : layer.buildingId,
  }));
  const used = new Set(
    layers
      .filter((layer) => layer.included && layer.buildingId !== null)
      .map((layer) => layer.buildingId as string),
  );
  const buildings = plan.buildings.every((building) => used.has(building.id))
    ? plan.buildings
    : plan.buildings.filter((building) => used.has(building.id));
  return { ...plan, layers, buildings };
}

export function GdbImportDialog({
  inspection,
  initialPlan,
  locale,
  busy,
  error,
  venueNameLocked = false,
  network = null,
  onAddNetwork,
  facilities = null,
  onAddFacilities,
  onImport,
  onCancel,
}: GdbImportDialogProps) {
  // The dialog owns the edited plan so a retryable conversion error (a changed
  // `error` prop) never resets manual choices.
  const [plan, setPlan] = useState<GdbMappingPlan>(initialPlan);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const venueInputRef = useRef<HTMLInputElement>(null);
  const headingId = "gdb-import-dialog-title";

  const descriptorByKey = useMemo(() => {
    const map = new Map<string, GdbLayerDescriptor>();
    for (const descriptor of inspection.layers) {
      map.set(gdbLayerKeyString(descriptor.key), descriptor);
    }
    return map;
  }, [inspection]);

  // Open modally and focus the venue name. App owns post-close focus (map /
  // remounted GDB control / Retry) because the pre-inspect invoker is often
  // already unmounted — or still mounted in a menu and would steal focus from
  // the intended target if we restored it here.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog) {
      if (typeof dialog.showModal === "function") {
        if (!dialog.open) dialog.showModal();
      } else {
        dialog.open = true;
      }
    }
    venueInputRef.current?.focus();
  }, []);

  // Escape on a modal dialog fires a native `cancel` event; route it to
  // onCancel and let React own the close so edits survive a retry.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onCancel();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onCancel]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return plan.layers;
    return plan.layers.filter((row) => {
      const descriptor = descriptorByKey.get(gdbLayerKeyString(row.key));
      return (
        row.key.layerName.toLowerCase().includes(needle) ||
        (descriptor?.databaseName.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [filter, plan.layers, descriptorByKey]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / ROWS_PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * ROWS_PER_PAGE, safePage * ROWS_PER_PAGE + ROWS_PER_PAGE);

  const issues = collectBlockingIssues(plan, descriptorByKey, locale);
  const includedRows = plan.layers.filter((l) => l.included);
  const includedFeatureCount = includedRows.reduce((sum, row) => {
    return sum + (descriptorByKey.get(gdbLayerKeyString(row.key))?.featureCount ?? 0);
  }, 0);
  const canImport = issues.length === 0 && !busy;

  function updateRow(key: GdbLayerPlan["key"], patch: Partial<GdbLayerPlan>): void {
    const keyString = gdbLayerKeyString(key);
    setPlan((current) => ({
      ...current,
      layers: current.layers.map((row) =>
        gdbLayerKeyString(row.key) === keyString ? { ...row, ...patch } : row,
      ),
    }));
  }

  function setBuildingIncluded(buildingId: string, include: boolean): void {
    setPlan((current) => ({
      ...current,
      layers: current.layers.map((row) =>
        row.buildingId === buildingId ? { ...row, included: include } : row,
      ),
    }));
  }

  function setRuleKind(row: GdbLayerPlan, kind: RuleKind): void {
    if (kind === "none") {
      updateRow(row.key, { levelRule: null });
      return;
    }
    // Never invent a default: an explicit field / label / ordinal is required.
    if (kind === "layer-name") updateRow(row.key, { levelRule: { kind: "layer-name" } });
    else if (kind === "fixed")
      updateRow(row.key, { levelRule: { kind: "fixed", label: "", ordinal: Number.NaN } });
    else updateRow(row.key, { levelRule: { kind, field: "" } });
  }

  function renameBuilding(id: string, name: string): void {
    setPlan((current) => ({
      ...current,
      buildings: current.buildings.map((b) => (b.id === id ? { ...b, name } : b)),
    }));
  }

  function addBuilding(): void {
    setPlan((current) => {
      const maxId = current.buildings.reduce((max, b) => {
        const n = Number.parseInt(b.id.replace(/^building-/, ""), 10);
        return Number.isFinite(n) && n > max ? n : max;
      }, 0);
      return {
        ...current,
        buildings: [...current.buildings, { id: `building-${maxId + 1}`, name: "" }],
      };
    });
  }

  function deleteBuilding(id: string): void {
    setPlan((current) => ({
      ...current,
      buildings: current.buildings.filter((b) => b.id !== id),
      // Clear every matching assignment (included or excluded) so a later
      // re-include cannot keep a deleted id that is missing from the select.
      layers: current.layers.map((row) =>
        row.buildingId === id ? { ...row, buildingId: null } : row,
      ),
    }));
  }

  function fieldSelect(
    row: GdbLayerPlan,
    value: string | null,
    onChange: (next: string | null) => void,
    label: string,
  ) {
    const descriptor = descriptorByKey.get(gdbLayerKeyString(row.key));
    const fields = descriptor?.fields ?? [];
    return (
      <select
        className="gdb-dialog__select"
        aria-label={label}
        value={value ?? ""}
        disabled={fields.length === 0}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">{ui.none[locale]}</option>
        {fields.map((field) => (
          <option key={field.name} value={field.name}>
            {field.name}
          </option>
        ))}
      </select>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      className="gdb-dialog"
      aria-labelledby={headingId}
    >
      <form
        method="dialog"
        className="gdb-dialog__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canImport) onImport(pruneUnusedBuildings(plan));
        }}
      >
        <h2 id={headingId} className="gdb-dialog__title">
          {ui.title[locale]}
        </h2>

        {/* Region 1: venue + buildings */}
        <section className="gdb-dialog__section" aria-label={ui.buildings[locale]}>
          <label className="gdb-dialog__field">
            <span>{ui.venueName[locale]}</span>
            <input
              ref={venueInputRef}
              type="text"
              className="gdb-dialog__input"
              aria-label={ui.venueName[locale]}
              value={plan.venueName}
              readOnly={venueNameLocked}
              onChange={(event) => {
                if (venueNameLocked) return;
                setPlan((c) => ({ ...c, venueName: event.target.value }));
              }}
            />
          </label>
          <ul className="gdb-dialog__buildings">
            {plan.buildings.map((building) => {
              const assigned = plan.layers.some((l) => l.included && l.buildingId === building.id);
              return (
                <li key={building.id} className="gdb-dialog__building-row">
                  <input
                    type="checkbox"
                    className="gdb-dialog__checkbox"
                    aria-label={`${ui.includeBuilding[locale]} ${building.name || building.id}`}
                    checked={assigned}
                    onChange={(event) => setBuildingIncluded(building.id, event.target.checked)}
                  />
                  <input
                    type="text"
                    className="gdb-dialog__input"
                    aria-label={`${ui.buildingNamePlaceholder[locale]} ${building.id}`}
                    placeholder={ui.buildingNamePlaceholder[locale]}
                    value={building.name}
                    onChange={(event) => renameBuilding(building.id, event.target.value)}
                  />
                  <button
                    type="button"
                    className="gdb-dialog__btn"
                    aria-label={`${ui.deleteBuilding[locale]} ${building.name || building.id}`}
                    disabled={assigned}
                    onClick={() => deleteBuilding(building.id)}
                  >
                    {ui.deleteBuilding[locale]}
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" className="gdb-dialog__btn" onClick={addBuilding}>
            {ui.addBuilding[locale]}
          </button>
        </section>

        {/* Region 2: layers */}
        <section className="gdb-dialog__section" aria-label={ui.layers[locale]}>
          <input
            type="search"
            className="gdb-dialog__input"
            aria-label={ui.filter[locale]}
            placeholder={ui.filter[locale]}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setPage(0);
            }}
          />
          <table className="gdb-dialog__table" aria-label={ui.layers[locale]}>
            <thead>
              <tr>
                <th scope="col">{ui.colInclude[locale]}</th>
                <th scope="col">{ui.colLayer[locale]}</th>
                <th scope="col">{ui.colFeatures[locale]}</th>
                <th scope="col">{ui.colType[locale]}</th>
                <th scope="col">{ui.colBuilding[locale]}</th>
                <th scope="col">{ui.colLevelRule[locale]}</th>
                <th scope="col">{ui.colId[locale]}</th>
                <th scope="col">{ui.colOrdinal[locale]}</th>
                <th scope="col">{ui.colShortName[locale]}</th>
                <th scope="col">{ui.colName[locale]}</th>
                <th scope="col">{ui.colCategory[locale]}</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => {
                const descriptor = descriptorByKey.get(gdbLayerKeyString(row.key));
                const family = descriptor?.geometryFamily ?? "none";
                const empty = (descriptor?.featureCount ?? 0) === 0;
                const rule = row.levelRule;
                const kind: RuleKind = rule ? rule.kind : "none";
                return (
                  <tr key={gdbLayerKeyString(row.key)} className="gdb-dialog__row">
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${ui.colInclude[locale]} ${row.key.layerName}`}
                        checked={row.included}
                        disabled={empty}
                        onChange={(event) => updateRow(row.key, { included: event.target.checked })}
                      />
                    </td>
                    <td>
                      <span className="gdb-dialog__db">{row.key.databaseId}</span>
                      <span className="gdb-dialog__layer">{row.key.layerName}</span>
                    </td>
                    <td>
                      {descriptor?.featureCount ?? 0} / {family}
                    </td>
                    <td>
                      <select
                        className="gdb-dialog__select"
                        aria-label={`${ui.colType[locale]} ${row.key.layerName}`}
                        value={row.targetType ?? ""}
                        onChange={(event) =>
                          updateRow(row.key, {
                            targetType: event.target.value === "" ? null : (event.target.value as GdbTargetType),
                          })
                        }
                      >
                        <option value="">{ui.none[locale]}</option>
                        {gdbTargetTypesForGeometry(family).map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="gdb-dialog__select"
                        aria-label={`${ui.colBuilding[locale]} ${row.key.layerName}`}
                        value={row.buildingId ?? ""}
                        onChange={(event) =>
                          updateRow(row.key, { buildingId: event.target.value === "" ? null : event.target.value })
                        }
                      >
                        <option value="">{ui.none[locale]}</option>
                        {plan.buildings.map((building) => (
                          <option key={building.id} value={building.id}>
                            {building.name || building.id}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="gdb-dialog__select"
                        aria-label={`${ui.colLevelRule[locale]} ${row.key.layerName}`}
                        value={kind}
                        onChange={(event) => setRuleKind(row, event.target.value as RuleKind)}
                      >
                        <option value="none">{ui.none[locale]}</option>
                        <option value="source-reference">{ui.ruleSourceReference[locale]}</option>
                        <option value="property">{ui.ruleProperty[locale]}</option>
                        <option value="layer-name">{ui.ruleLayerName[locale]}</option>
                        <option value="fixed">{ui.ruleFixed[locale]}</option>
                      </select>
                      {rule && (rule.kind === "source-reference" || rule.kind === "property") ? (
                        fieldSelect(
                          row,
                          rule.field,
                          (next) =>
                            updateRow(row.key, {
                              levelRule: { kind: rule.kind, field: next ?? "" },
                            }),
                          `${ui.colLevelRule[locale]} ${ui.colId[locale]} ${row.key.layerName}`,
                        )
                      ) : null}
                      {rule && rule.kind === "fixed" ? (
                        <span className="gdb-dialog__fixed">
                          <input
                            type="text"
                            className="gdb-dialog__input"
                            aria-label={`${ui.fixedLabel[locale]} ${row.key.layerName}`}
                            placeholder={ui.fixedLabel[locale]}
                            value={rule.label}
                            onChange={(event) =>
                              updateRow(row.key, {
                                levelRule: { kind: "fixed", label: event.target.value, ordinal: rule.ordinal },
                              })
                            }
                          />
                          <input
                            type="number"
                            className="gdb-dialog__input"
                            aria-label={`${ui.fixedOrdinal[locale]} ${row.key.layerName}`}
                            value={Number.isFinite(rule.ordinal) ? rule.ordinal : ""}
                            onChange={(event) =>
                              updateRow(row.key, {
                                levelRule: {
                                  kind: "fixed",
                                  label: rule.label,
                                  ordinal: event.target.value === "" ? Number.NaN : Number(event.target.value),
                                },
                              })
                            }
                          />
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {fieldSelect(
                        row,
                        row.idField,
                        (next) => updateRow(row.key, { idField: next }),
                        `${ui.colId[locale]} ${row.key.layerName}`,
                      )}
                    </td>
                    <td>
                      {fieldSelect(
                        row,
                        row.ordinalField,
                        (next) => updateRow(row.key, { ordinalField: next }),
                        `${ui.colOrdinal[locale]} ${row.key.layerName}`,
                      )}
                    </td>
                    <td>
                      {fieldSelect(
                        row,
                        row.shortNameField,
                        (next) => updateRow(row.key, { shortNameField: next }),
                        `${ui.colShortName[locale]} ${row.key.layerName}`,
                      )}
                    </td>
                    <td>
                      {fieldSelect(
                        row,
                        row.nameField,
                        (next) => updateRow(row.key, { nameField: next }),
                        `${ui.colName[locale]} ${row.key.layerName}`,
                      )}
                    </td>
                    <td>
                      {fieldSelect(
                        row,
                        row.categoryField,
                        (next) => updateRow(row.key, { categoryField: next }),
                        `${ui.colCategory[locale]} ${row.key.layerName}`,
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="gdb-dialog__pager">
            <button
              type="button"
              className="gdb-dialog__btn"
              disabled={safePage <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              {ui.prev[locale]}
            </button>
            <span className="gdb-dialog__page-count">{pageText[locale](safePage + 1, pageCount)}</span>
            <button
              type="button"
              className="gdb-dialog__btn"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              {ui.next[locale]}
            </button>
          </div>
        </section>

        {/* Region 3: summary + actions */}
        <section className="gdb-dialog__section" aria-label={ui.summary[locale]}>
          <p className="gdb-dialog__summary">
            {summaryText[locale](includedRows.length, includedFeatureCount)}
          </p>
          {onAddNetwork ? (
            <label className="gdb-dialog__btn gdb-dialog__network-add">
              {ui.addNetwork[locale]}
              <input
                type="file"
                accept=".zip,.gdb.zip"
                style={{ display: "none" }}
                aria-label={ui.addNetwork[locale]}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onAddNetwork(file);
                  event.target.value = "";
                }}
              />
            </label>
          ) : null}
          {network ? (
            <p className="gdb-dialog__network-summary">
              {routingSummaryText[locale](network.nodeCount, network.edgeCount, network.floors.length)}
            </p>
          ) : null}
          {onAddFacilities ? (
            <label className="gdb-dialog__btn gdb-dialog__facilities-add">
              {ui.addFacilities[locale]}
              <input
                type="file"
                accept=".zip,.gdb.zip"
                style={{ display: "none" }}
                aria-label={ui.addFacilities[locale]}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onAddFacilities(file);
                  event.target.value = "";
                }}
              />
            </label>
          ) : null}
          {facilities ? (
            <p className="gdb-dialog__facilities-summary">
              {facilitiesSummaryText[locale](facilities.facilityCount, facilities.floors.length)}
            </p>
          ) : null}
          {inspection.warnings.length > 0 ? (
            <div className="gdb-dialog__warnings">
              <p>{ui.warnings[locale]}</p>
              <ul>
                {inspection.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {error ? (
            <div className="gdb-dialog__error" role="alert">
              <p>{gdbErrorMessage(error, locale)}</p>
              {(() => {
                const failures = conversionFailureList(error, locale);
                if (failures !== null) {
                  return (
                    <>
                      <p className="gdb-dialog__error-detail">
                        {conversionListHeader[locale](failures.length)}
                      </p>
                      <ul className="gdb-dialog__error-layers">
                        {failures.map((failure) => (
                          <li key={failure.layer}>{failure.text}</li>
                        ))}
                      </ul>
                    </>
                  );
                }
                const detail = conversionErrorDetail(error, locale);
                return detail !== null ? (
                  <p className="gdb-dialog__error-detail">{detail}</p>
                ) : null;
              })()}
            </div>
          ) : null}
          {issues.length > 0 ? (
            <div className="gdb-dialog__blocking" role="alert">
              <p>{ui.blocking[locale]}</p>
              <ul>
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="gdb-dialog__actions">
            <button type="button" className="gdb-dialog__btn" onClick={onCancel}>
              {ui.cancel[locale]}
            </button>
            <button
              type="submit"
              className="gdb-dialog__btn gdb-dialog__btn--primary"
              disabled={!canImport}
            >
              {ui.import[locale]}
            </button>
          </div>
        </section>
      </form>
    </dialog>
  );
}
