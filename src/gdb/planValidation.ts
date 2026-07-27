import type { LocaleCode } from "../imdf/types";
import {
  gdbLayerKeyString,
  type GdbGeometryFamily,
  type GdbLayerDescriptor,
  type GdbMappingPlan,
  type GdbTargetType,
} from "./types";

/** All target types, in a stable order for dropdown rendering. */
export const GDB_TARGET_TYPES: readonly GdbTargetType[] = [
  "level",
  "unit",
  "opening",
  "detail",
  "fixture",
  "kiosk",
  "amenity",
  "occupant",
];

/** Geometry family each target type requires. */
const GEOMETRY_REQUIREMENT: Record<GdbTargetType, GdbGeometryFamily> = {
  level: "polygon",
  unit: "polygon",
  fixture: "polygon",
  kiosk: "polygon",
  opening: "line",
  detail: "line",
  amenity: "point",
  occupant: "point",
};

/**
 * True when a target type may be assigned to a layer of the given geometry
 * family. `mixed`/`none` never satisfy any target type.
 */
export function isGdbTargetGeometryCompatible(
  type: GdbTargetType,
  family: GdbGeometryFamily,
): boolean {
  return GEOMETRY_REQUIREMENT[type] === family;
}

/** Target types selectable for a layer with the given geometry family. */
export function gdbTargetTypesForGeometry(family: GdbGeometryFamily): GdbTargetType[] {
  return GDB_TARGET_TYPES.filter((type) => isGdbTargetGeometryCompatible(type, family));
}

// ---------------------------------------------------------------------------
// Floor ordinal parsing
// ---------------------------------------------------------------------------

/**
 * floor ordinal -> textual forms, mirroring the proven Cesium parser.
 *
 * Ordinals are **0-based**, per `docs/gdb-data-reference.md` and Rust
 * `kiriko_route::floor_to_ordinal`: `F1` (ground) is ordinal 0, so a floor
 * designation `n` maps to `n - 1`. Basements keep `B<n> \u2192 -n`.
 *
 * This is a deliberate duplicate of `buildFloorSynonyms` in
 * `server/src/gdb/mapping.ts` (no shared module exists between the client and
 * the server bundle). The two copies must stay byte-for-byte equivalent \u2014
 * they are the same parser, and a divergence means the dialog's floor
 * reasoning disagrees with what the importer actually does.
 */
function buildFloorSynonyms(): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (let n = 1; n <= 60; n += 1) {
    const variants = [`${n}f`, `f${n}`, `${n}\u968e`, `${n}fl`, `${n}floor`, `floor${n}`, `${n}`];
    if (n === 1) variants.push("gf", `g\u968e`, "ground");
    map.set(n - 1, variants);
  }
  for (let n = 1; n <= 10; n += 1) {
    map.set(-n, [
      `b${n}`, `b${n}f`, `b${n}fl`, `b${n}floor`,
      `${n}b`, `bf${n}`,
      `\u5730\u4e0b${n}\u968e`, `\u5730\u4e0b${n}f`, `\u5730\u4e0b${n}fl`,
      `basement${n}`,
    ]);
  }
  // A literal `0`/`F0` is the European ground-floor spelling \u2014 the same
  // ordinal 0 that `F1`/`GF` already resolve to, so extend that entry rather
  // than replacing it.
  map.set(0, [...(map.get(0) ?? []), "0", "f0", "0f", "0fl", "0floor", "floor0"]);
  return map;
}

const SYNONYM_LOOKUP: Map<string, number> = (() => {
  const lookup = new Map<string, number>();
  for (const [num, variants] of buildFloorSynonyms()) {
    for (const v of variants) lookup.set(v.toLowerCase(), num);
  }
  return lookup;
})();

/**
 * Map a single separator-free token to a source floor ordinal, extending the
 * base synonym table with the observed `KB3`/`SB4` basement aliases and the
 * `M2` mezzanine-as-positive-ordinal convention. `R`/`RF` return null: a roof
 * ordinal must come from a source level feature or a fixed ordinal, never
 * invented.
 */
function parseFloorToken(token: string): number | null {
  const direct = SYNONYM_LOOKUP.get(token);
  if (direct !== undefined) return direct;
  const mezz = /^m(\d+)$/.exec(token);
  if (mezz) return Number(mezz[1]);
  const basement = /^[a-z]+b(\d+)f?$/.exec(token);
  if (basement) return -Number(basement[1]);
  return null;
}

/**
 * Parse a source floor value or floor-bearing layer name into a source floor
 * ordinal. Accepts a finite number directly.
 *
 * Ported safeguard from cesium `shortLevelName`/`levelNameToNumber`: the real
 * floor designation lives in the LEADING token, parsed first and outright. This
 * prevents appended metadata such as `"(TP-5.11)"` from letting its bare
 * digits win — `"B2FL(1FL)_…(TP-5.11)"` resolves to `-2`, never `5`.
 */
function extractGdbFloorOrdinal(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const leading = text.split(/[_\s（(\u3000]+/, 1)[0];
  if (leading) {
    const leadingOrdinal = parseFloorToken(leading.toLowerCase());
    if (leadingOrdinal !== null) return leadingOrdinal;
  }
  const tokens = text.toLowerCase().split(/[_\-\s.]+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const ordered = [...tokens].sort((a, b) => b.length - a.length);
  for (const token of ordered) {
    const parsed = parseFloorToken(token);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * `Station_2_B1_level` etc. Capture group 1 is the building-name prefix; group
 * 2 is the floor token; group 3 is the layer category.
 */
const STRUCTURED_NAME =
  /^(.*)_(B\d+|M\d+|F?\d+|R|RF|0)_(Drawing|Fixture|Floor|Space|Opening|Facility|Occupant|detail|fixture|level|unit|opening|amenity|occupant)$/i;

/**
 * Resolve a layer-name floor ordinal from ONLY the structured floor token,
 * never arbitrary digits elsewhere in the name. `Station_2_R_level` -> null
 * (token `R`); `Station_2_0_level` -> 0.
 */
export function structuredFloorOrdinal(layerName: string): number | null {
  const match = STRUCTURED_NAME.exec(layerName);
  if (!match) return null;
  return extractGdbFloorOrdinal(match[2]);
}

/**
 * Resolve a floor ordinal from a layer name. Structured names use ONLY the
 * structured floor token; non-structured names use the loose token parse.
 */
export function layerNameFloorOrdinal(layerName: string): number | null {
  if (STRUCTURED_NAME.test(layerName)) return structuredFloorOrdinal(layerName);
  return extractGdbFloorOrdinal(layerName);
}

const blockingText = {
  incompatibleType: {
    ja: (name: string) => `${name}: 対象種別が形状と一致しません`,
    en: (name: string) => `${name}: target type is missing or incompatible with the geometry`,
  },
  noLevel: {
    ja: () => "少なくとも 1 つのレベルを取り込むか固定レベルを指定してください",
    en: () => "Include at least one level, or a fixed/property-derived level",
  },
  levelNoBuilding: {
    ja: (name: string) => `${name}: レベルに建物を割り当ててください`,
    en: (name: string) => `${name}: assign a building to this level`,
  },
  levelNoOrdinal: {
    ja: (name: string) => `${name}: レベルの序数の取得元を指定してください`,
    en: (name: string) => `${name}: this level needs a resolvable ordinal`,
  },
  noLevelRule: {
    ja: (name: string) => `${name}: レベル規則を指定してください`,
    en: (name: string) => `${name}: choose a level rule`,
  },
  needBuilding: {
    ja: (name: string) => `${name}: 建物または参照規則を指定してください`,
    en: (name: string) => `${name}: assign a building or use a source-reference rule`,
  },
  fixed: {
    ja: (name: string) => `${name}: 固定レベルにはラベルと序数が必要です`,
    en: (name: string) => `${name}: fixed level needs a label and a finite ordinal`,
  },
  field: {
    ja: (name: string) => `${name}: 選択された項目がレイヤーに存在しません`,
    en: (name: string) => `${name}: a selected field does not exist on this layer`,
  },
} as const;

function fieldExists(descriptor: GdbLayerDescriptor | undefined, field: string | null): boolean {
  if (field === null || field === "") return true;
  if (!descriptor) return false;
  return descriptor.fields.some((f) => f.name === field);
}

/**
 * Compute every blocking review issue for the current plan. Import is allowed
 * only when this returns an empty list.
 */
export function collectBlockingIssues(
  plan: GdbMappingPlan,
  descriptorByKey: ReadonlyMap<string, GdbLayerDescriptor>,
  locale: LocaleCode,
): string[] {
  const issues: string[] = [];
  const included = plan.layers.filter((l) => l.included);
  const buildingIds = new Set(plan.buildings.map((building) => building.id));
  const hasBuilding = (id: string | null): boolean =>
    typeof id === "string" && id !== "" && buildingIds.has(id);

  let hasLevelSource = false;
  for (const row of included) {
    const layerName = row.key.layerName;
    // Canonical, unambiguous label so duplicate layer names across databases
    // read distinctly and yield unique React keys.
    const label = `${row.key.databaseId} / ${layerName}`;
    const descriptor = descriptorByKey.get(gdbLayerKeyString(row.key));
    const family = descriptor?.geometryFamily ?? "none";

    if (row.targetType === null || !isGdbTargetGeometryCompatible(row.targetType, family)) {
      issues.push(blockingText.incompatibleType[locale](label));
      continue;
    }

    const rule = row.levelRule;
    if (row.targetType === "level") {
      hasLevelSource = true;
      if (!hasBuilding(row.buildingId)) {
        issues.push(blockingText.levelNoBuilding[locale](label));
      }
      // A level defines its own ordinal; source-reference is never a valid
      // ordinal source for a level.
      if (rule?.kind === "source-reference") {
        issues.push(blockingText.levelNoOrdinal[locale](label));
      } else {
        const hasFixed =
          rule?.kind === "fixed" && rule.label.trim() !== "" && Number.isFinite(rule.ordinal);
        const hasProperty = rule?.kind === "property" && rule.field.trim() !== "";
        const hasToken = layerNameFloorOrdinal(layerName) !== null;
        const hasField = Boolean(row.ordinalField || row.shortNameField || row.nameField);
        if (!(hasFixed || hasProperty || hasToken || hasField)) {
          issues.push(blockingText.levelNoOrdinal[locale](label));
        }
      }
    } else if (!rule) {
      issues.push(blockingText.noLevelRule[locale](label));
    } else {
      if (rule.kind === "fixed" || rule.kind === "property") hasLevelSource = true;
      if (rule.kind !== "source-reference" && !hasBuilding(row.buildingId)) {
        issues.push(blockingText.needBuilding[locale](label));
      }
      // Layer-name rules must resolve the same way conversion does, so Import
      // never enables a plan that buildGdbVenue will reject for an unresolved
      // ordinal. Structured R/RF stays null (no prefix-digit fallback).
      if (rule.kind === "layer-name" && layerNameFloorOrdinal(layerName) === null) {
        issues.push(blockingText.levelNoOrdinal[locale](label));
      }
    }

    if (
      rule?.kind === "fixed" &&
      (rule.label.trim() === "" || !Number.isFinite(rule.ordinal))
    ) {
      issues.push(blockingText.fixed[locale](label));
    }

    const ruleField =
      rule && (rule.kind === "source-reference" || rule.kind === "property") ? rule.field : null;
    const selectedFields = [
      row.idField,
      row.ordinalField,
      row.shortNameField,
      row.nameField,
      row.categoryField,
      ruleField,
    ];
    if (selectedFields.some((field) => !fieldExists(descriptor, field))) {
      issues.push(blockingText.field[locale](label));
    }
  }

  if (included.length > 0 && !hasLevelSource) {
    issues.push(blockingText.noLevel[locale]());
  }
  if (included.length === 0) {
    issues.push(blockingText.noLevel[locale]());
  }

  return issues;
}
