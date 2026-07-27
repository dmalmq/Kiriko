/**
 * Pure mapping helpers for the server-side File Geodatabase import path.
 *
 * {@link suggestGdbMapping} derives an editable plan from an inspection
 * (target-type guesses, building groups, field aliases). {@link buildGdbImdf}
 * converts the reviewed WGS84 GeoJSON layers into a `ParsedImdfArchive`
 * (manifest + per-type FeatureCollections) that the IMDF zip serializer
 * writes and the Rust importer then validates and compiles.
 *
 * Ported from the legacy branch's `src/gdb/gdbMapping.ts`, with two
 * adaptations for the server path:
 * 1. No `normalizeVenue` — the Rust importer owns normalization. Output is the
 *    pre-normalization collection map instead of a `LoadedVenue`.
 * 2. Original GDB attributes + the `__gdb_*` metadata keys are written
 *    straight into each feature's `properties`, not restored in a second
 *    pass — the Rust importer preserves arbitrary properties through
 *    canonicalization into `source_properties`, so nothing is lost.
 */
import type { GdbGeometryFamily, GdbTargetType } from "./types";
import { mapCategoryCode } from "./categoryCodes";
import {
  gdbLayerKeyString,
  type GdbBuildingPlan,
  type GdbConversionResult,
  type GdbConvertedLayer,
  type GdbFieldDescriptor,
  type GdbInspection,
  type GdbLayerDescriptor,
  type GdbLayerKey,
  type GdbLayerPlan,
  type GdbLevelRule,
  type GdbMappingPlan,
} from "./types";

/** IMDF feature type. Matches `FeatureType` in `core/crates/kiriko-model`. */
export type FeatureType =
  | "address"
  | "amenity"
  | "anchor"
  | "building"
  | "detail"
  | "fixture"
  | "footprint"
  | "geofence"
  | "kiosk"
  | "level"
  | "occupant"
  | "opening"
  | "relationship"
  | "section"
  | "unit"
  | "venue";

/** IMDF 1.0.0 manifest. Only `version` and `language` are consumed by the importer. */
export interface ImdfManifest {
  version: "1.0.0";
  language: string;
}

/** Per-type GeoJSON collections, ready to be serialized into an IMDF archive. */
export interface ParsedImdfArchive {
  manifest: ImdfManifest;
  collections: Partial<Record<FeatureType, GeoJSON.FeatureCollection>>;
  warnings: GdbConversionWarning[];
}

export interface GdbConversionWarning {
  code: string;
  message: string;
}

/**
 * IMDF feature: a GeoJSON Feature with the required top-level `feature_type`
 * discriminator. The strict Rust importer rejects any feature whose declared
 * `feature_type` doesn't match its collection filename.
 */
type ImdfFeature = GeoJSON.Feature & { feature_type: FeatureType };

/** Build an {@link ImdfFeature} from a plain GeoJSON Feature. */
function imdfFeature(type: FeatureType, feature: GeoJSON.Feature): ImdfFeature {
  return { ...feature, feature_type: type };
}

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
 * designation `n` maps to `n - 1`. Basements keep `B<n> \u2192 -n`. Keeping the
 * two parsers aligned is what stops network/facility floors from landing on
 * ordinals the venue does not have.
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
  // A literal `0`/`F0` is the European ground-floor spelling — the same
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
export function extractGdbFloorOrdinal(value: unknown): number | null {
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

// ---------------------------------------------------------------------------
// UUID normalization
// ---------------------------------------------------------------------------

const HYPHENATED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX32_UUID = /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/i;

/**
 * Normalize a raw source id to canonical UUIDv4 form. A valid hyphenated
 * UUIDv4 (version nibble 4, RFC variant [89ab]) is preserved (lowercased); a
 * 32-hex UUIDv4 is hyphenated; any other value returns null so the caller can
 * allocate a fresh UUIDv4.
 */
export function normalizeGdbUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (HYPHENATED_UUID.test(trimmed)) return trimmed.toLowerCase();
  if (HEX32_UUID.test(trimmed)) {
    const h = trimmed.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Target-type + structured-name inference
// ---------------------------------------------------------------------------

interface TargetGuess {
  type: GdbTargetType | null;
  /** Cross-floor `_to_` edge: keep the guess but default excluded. */
  crossFloor: boolean;
}

/**
 * Infer a target type from the complete layer-name suffix/token, honoring both
 * the Tokyo (`_Floor`/`_Space`/`_Drawing`) and Shinjuku
 * (`_level`/`_unit`/`_detail`) conventions, case-insensitively.
 */
function inferTargetType(layerName: string): TargetGuess {
  const lower = layerName.toLowerCase();
  const ends = (suffix: string): boolean => lower.endsWith(suffix);
  const crossFloor = lower.includes("_to_");

  let type: GdbTargetType | null = null;
  if (ends("_floor") || ends("_level")) type = "level";
  else if (ends("_space") || ends("_unit")) type = "unit";
  else if (ends("_opening")) type = "opening";
  else if (ends("_drawing") || ends("_detail") || ends("_nw")) type = "detail";
  else if (ends("_fixture")) type = "fixture";
  else if (
    ends("_facility") ||
    ends("_amenity") ||
    lower === "facility_merge" ||
    lower.startsWith("point_facility") ||
    lower === "wifi" ||
    lower === "beacon" ||
    lower === "net_junction"
  ) {
    type = "amenity";
  } else if (ends("_occupant")) type = "occupant";
  else if (lower === "net_path" || /_link$/.test(lower)) type = "detail";

  if (crossFloor) type = "detail";

  return { type, crossFloor };
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

// ---------------------------------------------------------------------------
// Field alias detection
// ---------------------------------------------------------------------------

/** First descriptor field (case-insensitively) matching any candidate name. */
function findField(
  fields: readonly GdbFieldDescriptor[],
  candidates: readonly string[],
): string | null {
  for (const candidate of candidates) {
    const found = fields.find((field) => field.name.toLowerCase() === candidate.toLowerCase());
    if (found) return found.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// suggestGdbMapping
// ---------------------------------------------------------------------------

function suggestLayerPlan(
  layer: GdbLayerDescriptor,
  buildingIdByPrefix: ReadonlyMap<string, string>,
): GdbLayerPlan {
  const name = layer.key.layerName;
  const fields = layer.fields;
  const family = layer.geometryFamily;
  const { type: guessed, crossFloor } = inferTargetType(name);

  const idField = findField(fields, ["id", "uuid"]);
  const nameField = findField(fields, ["name", "\u540d\u79f0"]);
  const categoryField = findField(fields, ["category"]);
  const ordinalField = findField(fields, ["ordinal"]);
  const shortNameField = findField(fields, ["short_name"]);

  const levelIdField = findField(fields, ["level_id"]);
  const floorIdField = findField(fields, ["floor_id"]);
  const floorField = findField(fields, ["floor"]);
  const layerToken = structuredFloorOrdinal(name) !== null;

  // Geometry gating: null out a guessed type that the geometry cannot support.
  let targetType: GdbTargetType | null = guessed;
  let included = false;
  if (family === "mixed" || family === "none") {
    targetType = null;
  } else if (targetType !== null) {
    if (!isGdbTargetGeometryCompatible(targetType, family)) {
      targetType = null;
    } else {
      included = layer.featureCount > 0 && !crossFloor;
    }
  }

  // Level rule precedence.
  let levelRule: GdbLevelRule | null = null;
  if (targetType === "level") {
    if (floorField) levelRule = { kind: "property", field: floorField };
    else if (layerToken) levelRule = { kind: "layer-name" };
  } else if (targetType !== null) {
    if (levelIdField) levelRule = { kind: "source-reference", field: levelIdField };
    else if (floorIdField) levelRule = { kind: "source-reference", field: floorIdField };
    else if (floorField) levelRule = { kind: "property", field: floorField };
    else if (layerToken) levelRule = { kind: "layer-name" };
  }

  // Unstructured POIs without a level/floor source-reference stay opted out;
  // the reviewer must choose include + level binding intentionally.
  const structured = STRUCTURED_NAME.test(name);
  if (included && targetType !== null && targetType !== "level" && !structured) {
    const hasLevelRef = levelIdField !== null || floorIdField !== null;
    if (!hasLevelRef) {
      included = false;
    }
  }

  // Building assignment. Every row keeps its structured-prefix building,
  // including source-reference rows; a flat POI layer stays null and inherits
  // its building from the resolved level.
  const prefix = STRUCTURED_NAME.exec(name)?.[1] ?? null;
  const structuredBuildingId = prefix
    ? (buildingIdByPrefix.get(prefix.toLowerCase()) ?? null)
    : null;
  const buildingId: string | null = targetType === null ? null : structuredBuildingId;

  return {
    key: layer.key,
    included,
    targetType,
    buildingId,
    levelRule,
    idField,
    ordinalField,
    shortNameField,
    nameField,
    categoryField,
  };
}

/**
 * Build an editable {@link GdbMappingPlan} from an inspection: an editable
 * venue name, sorted structured building groups, and one suggested layer plan
 * per inspected layer.
 */
export function suggestGdbMapping(inspection: GdbInspection): GdbMappingPlan {
  const prefixDisplay = new Map<string, string>();
  for (const layer of inspection.layers) {
    const prefix = STRUCTURED_NAME.exec(layer.key.layerName)?.[1] ?? null;
    if (prefix === null) continue;
    const key = prefix.toLowerCase();
    if (!prefixDisplay.has(key)) prefixDisplay.set(key, prefix);
  }

  const sortedKeys = [...prefixDisplay.keys()].sort();
  const buildings: GdbBuildingPlan[] = sortedKeys.map((key, index) => ({
    id: `building-${index + 1}`,
    name: prefixDisplay.get(key) as string,
  }));

  const buildingIdByPrefix = new Map<string, string>();
  sortedKeys.forEach((key, index) => buildingIdByPrefix.set(key, `building-${index + 1}`));

  const layers = inspection.layers.map((layer) => suggestLayerPlan(layer, buildingIdByPrefix));

  return {
    venueName: inspection.sourceName
      .replace(/\.gdb\.zip$/i, "")
      .replace(/\.gdb$/i, "")
      .replace(/\.zip$/i, ""),
    buildings,
    layers,
  };
}

/** Coerce wire-footgun empty strings so conversion treats them as unset. */
export function normalizeGdbPlan(plan: GdbMappingPlan): GdbMappingPlan {
  return {
    ...plan,
    clipToSelection: plan.clipToSelection === true,
    layers: plan.layers.map((row) => ({
      ...row,
      buildingId: row.buildingId === "" ? null : row.buildingId,
      idField: row.idField === "" ? null : row.idField,
      ordinalField: row.ordinalField === "" ? null : row.ordinalField,
      shortNameField: row.shortNameField === "" ? null : row.shortNameField,
      nameField: row.nameField === "" ? null : row.nameField,
      categoryField: row.categoryField === "" ? null : row.categoryField,
    })),
  };
}

// ---------------------------------------------------------------------------
// buildGdbImdf: reviewed GeoJSON -> ParsedImdfArchive
// ---------------------------------------------------------------------------

/** Padding for a zero-width/zero-height synthesized rectangle side (degrees). */
const SYNTHETIC_PADDING = 0.000001;

/** Metadata keys appended to every converted feature's properties. */
const GDB_META_DATABASE = "__gdb_database";
const GDB_META_LAYER = "__gdb_layer";
const GDB_META_RESOLVED_LEVEL = "__gdb_resolved_level_id";

type SpatialFamily = "point" | "line" | "polygon";

interface MutableBounds {
  west: number;
  south: number;
  east: number;
  north: number;
  found: boolean;
}

interface LevelRecord {
  id: string;
  ordinal: number;
  buildingUuid: string;
  geometry: GeoJSON.Geometry | null;
  /** IMDF properties (name, short_name, ordinal, building_ids, level_id self). */
  transient: Record<string, unknown>;
  /** Raw GDB attributes to merge into the feature's `properties`. */
  original: Record<string, unknown> | null;
  databaseId: string;
  layerName: string;
  synthetic: boolean;
}

interface NonLevelRecord {
  id: string;
  featureType: FeatureType;
  geometry: GeoJSON.Geometry;
  transient: Record<string, unknown>;
  original: Record<string, unknown>;
  databaseId: string;
  layerName: string;
  levelUuid: string;
  buildingUuid: string;
}

/** Fail conversion with the fixed corrective copy plus diagnostic details. */
function conversionFailed(reason: string, details?: Record<string, unknown>): never {
  throw new GdbConversionError("gdb_conversion_failed", reason, details);
}

/** Thrown when the reviewed plan cannot be converted to an IMDF archive. */
export class GdbConversionError extends Error {
  constructor(
    readonly code: "gdb_conversion_failed",
    readonly reason: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(`GDB conversion failed: ${reason}`);
    this.name = "GdbConversionError";
  }
}

/** A UUIDv4 guaranteed absent from `used`. The returned id is recorded in `used`. */
function freshUuid(used: Set<string>): string {
  let id = crypto.randomUUID();
  while (used.has(id)) id = crypto.randomUUID();
  used.add(id);
  return id;
}

/** Non-empty string form of a source value; numbers stringify, else null. */
function coerceString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Spatial family of a geometry, or null for empty/unsupported geometry. */
function geometryFamily(geometry: GeoJSON.Geometry): SpatialFamily | null {
  switch (geometry.type) {
    case "Point":
    case "MultiPoint":
      return "point";
    case "LineString":
    case "MultiLineString":
      return "line";
    case "Polygon":
    case "MultiPolygon":
      return "polygon";
    default:
      return null;
  }
}

interface GeometryFailureContext {
  databaseId: string;
  layerName: string;
  targetType: GdbTargetType;
  featureId: string | number | null;
  featureIndex: number;
}

/**
 * Coerce a feature geometry to the layer's required spatial family. A plain
 * geometry passes through unchanged so a genuine family mismatch is caught by
 * the caller. A GeometryCollection is shallow-flattened to its finite members
 * of the required family. Any finite spatial member of another family fails.
 */
function normalizeGeometryForFamily(
  geometry: GeoJSON.Geometry,
  family: SpatialFamily,
  context: GeometryFailureContext,
): GeoJSON.Geometry | null {
  if (geometry.type !== "GeometryCollection") return geometry;
  const members: GeoJSON.Geometry[] = [];
  for (const member of geometry.geometries) {
    if (!geometryIsSpatiallyFinite(member)) continue;
    if (geometryFamily(member) !== family) {
      conversionFailed("incompatible GeometryCollection member family", {
        requiredFamily: family,
        memberType: member.type,
        databaseId: context.databaseId,
        layer: context.layerName,
        targetType: context.targetType,
        ...(context.featureId !== null
          ? { featureId: context.featureId }
          : { featureIndex: context.featureIndex }),
      });
    }
    members.push(member);
  }
  if (members.length === 0) return null;
  if (members.length === 1) return members[0] ?? null;
  if (family === "polygon") {
    const coordinates: GeoJSON.Position[][][] = [];
    for (const member of members) {
      if (member.type === "Polygon") coordinates.push(member.coordinates);
      else if (member.type === "MultiPolygon") coordinates.push(...member.coordinates);
    }
    return { type: "MultiPolygon", coordinates };
  }
  if (family === "line") {
    const coordinates: GeoJSON.Position[][] = [];
    for (const member of members) {
      if (member.type === "LineString") coordinates.push(member.coordinates);
      else if (member.type === "MultiLineString") coordinates.push(...member.coordinates);
    }
    return { type: "MultiLineString", coordinates };
  }
  const coordinates: GeoJSON.Position[] = [];
  for (const member of members) {
    if (member.type === "Point") coordinates.push(member.coordinates);
    else if (member.type === "MultiPoint") coordinates.push(...member.coordinates);
  }
  return { type: "MultiPoint", coordinates };
}

/** True when the geometry recursively contains ≥1 finite lon/lat pair. */
function geometryIsSpatiallyFinite(geometry: GeoJSON.Geometry): boolean {
  if (geometry.type === "GeometryCollection") {
    for (const nested of geometry.geometries) {
      if (geometryIsSpatiallyFinite(nested)) return true;
    }
    return false;
  }
  return boundsOf([geometry]) !== null;
}

/** Extend the running bounds with every finite position in the geometry. */
function extendBounds(bounds: MutableBounds, geometry: GeoJSON.Geometry): void {
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number") {
      const lon = value[0];
      const lat = value[1];
      if (typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat)) {
        bounds.west = Math.min(bounds.west, lon);
        bounds.south = Math.min(bounds.south, lat);
        bounds.east = Math.max(bounds.east, lon);
        bounds.north = Math.max(bounds.north, lat);
        bounds.found = true;
      }
      return;
    }
    for (const nested of value) visit(nested);
  };
  if (geometry.type === "GeometryCollection") {
    for (const nested of geometry.geometries ?? []) extendBounds(bounds, nested);
    return;
  }
  visit(geometry.coordinates);
}

/** Bounding box of every finite coordinate across the geometries, or null. */
function boundsOf(geometries: readonly (GeoJSON.Geometry | null)[]): MutableBounds | null {
  const bounds: MutableBounds = {
    west: Infinity,
    south: Infinity,
    east: -Infinity,
    north: -Infinity,
    found: false,
  };
  for (const geometry of geometries) {
    if (geometry !== null) extendBounds(bounds, geometry);
  }
  return bounds.found ? bounds : null;
}

/** Rectangle polygon from bounds, padding any zero-width/height side. */
function rectanglePolygon(bounds: MutableBounds): GeoJSON.Polygon {
  let { west, south, east, north } = bounds;
  if (east <= west) east = west + SYNTHETIC_PADDING;
  if (north <= south) north = south + SYNTHETIC_PADDING;
  return {
    type: "Polygon",
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

/** True when (px,py) lies on the segment a-b (with a small tolerance). */
function onSegment(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): boolean {
  const lengthSq = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
  if (lengthSq === 0) return px === ax && py === ay;
  const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  if (Math.abs(cross) > 1e-12) return false;
  const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
  if (dot < 0) return false;
  return dot <= lengthSq;
}

/** Ray-cast strictly-interior test for a single ring (boundary excluded). */
function rayCastInside(px: number, py: number, ring: GeoJSON.Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    const [xi, yi] = a;
    const [xj, yj] = b;
    if (xi === undefined || yi === undefined || xj === undefined || yj === undefined) continue;
    if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** True when (px,py) is on any edge of the ring. */
function onRingEdge(px: number, py: number, ring: GeoJSON.Position[]): boolean {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    const [ax, ay] = a;
    const [bx, by] = b;
    if (ax === undefined || ay === undefined || bx === undefined || by === undefined) continue;
    if (onSegment(px, py, ax, ay, bx, by)) return true;
  }
  return false;
}

/** Point-in-polygon with holes respected, boundary treated as inside. */
function pointInPolygon(px: number, py: number, rings: GeoJSON.Position[][]): boolean {
  const outer = rings[0];
  if (outer === undefined || outer.length === 0) return false;
  if (!onRingEdge(px, py, outer) && !rayCastInside(px, py, outer)) return false;
  for (let h = 1; h < rings.length; h += 1) {
    const hole = rings[h];
    if (hole === undefined) continue;
    if (!onRingEdge(px, py, hole) && rayCastInside(px, py, hole)) return false;
  }
  return true;
}

function pointInGeometry(px: number, py: number, geometry: GeoJSON.Geometry): boolean {
  if (geometry.type === "Polygon") return pointInPolygon(px, py, geometry.coordinates);
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((rings) => pointInPolygon(px, py, rings));
  }
  return false;
}

/** Coordinate of a single GeoJSON Point, else null. */
function pointCoordinate(geometry: GeoJSON.Geometry): [number, number] | null {
  if (geometry.type !== "Point") return null;
  const [x, y] = geometry.coordinates;
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)
    ? [x, y]
    : null;
}

/**
 * Resolve a level feature's ordinal: explicit ordinal field, then a
 * property/fixed level rule, then short-name/name/layer-name token.
 */
function resolveLevelOrdinal(
  plan: GdbLayerPlan,
  props: Record<string, unknown>,
): number | null {
  const rule = plan.levelRule;
  if (rule?.kind === "property") {
    const parsed = extractGdbFloorOrdinal(props[rule.field]);
    if (parsed !== null) return parsed;
  }
  if (rule?.kind === "fixed") return Number.isFinite(rule.ordinal) ? rule.ordinal : null;
  if (plan.shortNameField) {
    const parsed = extractGdbFloorOrdinal(props[plan.shortNameField]);
    if (parsed !== null) return parsed;
  }
  if (plan.nameField) {
    const parsed = extractGdbFloorOrdinal(props[plan.nameField]);
    if (parsed !== null) return parsed;
  }
  // Last resort. A source `ordinal` attribute is only as trustworthy as the
  // GDB that wrote it: across the JR East databases it mixes conventions
  // (`F2` is ordinal 2 in JRTakanawaGatewaySta, ordinal 1 in LinkPillar1),
  // which silently merged distinct floors onto one ordinal. The floor labels
  // above are consistent, so they decide; this only fills in rows whose
  // labels do not parse at all.
  if (plan.ordinalField) {
    const raw = props[plan.ordinalField];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    const parsed = extractGdbFloorOrdinal(raw);
    if (parsed !== null) return parsed;
  }
  return layerNameFloorOrdinal(plan.key.layerName);
}

/**
 * Convert reviewed WGS84 GeoJSON layers into a {@link ParsedImdfArchive}. All
 * selected layers process together so references cross GDB boundaries. Every
 * failure surfaces as {@link GdbConversionError}.
 */
export function buildGdbImdf(
  conversion: GdbConversionResult,
  plan: GdbMappingPlan,
): ParsedImdfArchive {
  const convertedByKey = new Map<string, GdbConvertedLayer>();
  for (const layer of conversion.layers) {
    convertedByKey.set(gdbLayerKeyString(layer.key), layer);
  }

  const included = plan.layers.filter((layer) => layer.included);
  if (included.length === 0) {
    conversionFailed("no included layers");
  }

  for (const layer of included) {
    if (!convertedByKey.has(gdbLayerKeyString(layer.key))) {
      conversionFailed("missing converted layer", { layer: layer.key.layerName });
    }
    if (layer.targetType === null) {
      conversionFailed("included layer without target type", { layer: layer.key.layerName });
    }
  }

  // Pre-count normalized valid source UUIDs across every selected feature. A
  // UUID appearing more than once anywhere is reassigned; only count-one UUIDs
  // are preserved. Count-one UUIDs are reserved up front.
  const sourceUuidCounts = new Map<string, number>();
  for (const layer of included) {
    if (layer.targetType === null || layer.idField === null) continue;
    const converted = convertedByKey.get(gdbLayerKeyString(layer.key));
    if (converted === undefined) continue;
    for (const feature of converted.featureCollection.features) {
      const rawId = coerceString((feature.properties ?? {})[layer.idField]);
      const normalized = rawId !== null ? normalizeGdbUuid(rawId) : null;
      if (normalized !== null) {
        sourceUuidCounts.set(normalized, (sourceUuidCounts.get(normalized) ?? 0) + 1);
      }
    }
  }
  const reservedSourceUuids = new Set<string>();
  for (const [uuid, count] of sourceUuidCounts) {
    if (count === 1) reservedSourceUuids.add(uuid);
  }

  const usedIds = new Set<string>(reservedSourceUuids);
  const buildingUuidById = new Map<string, string>();
  for (const building of plan.buildings) {
    buildingUuidById.set(building.id, freshUuid(usedIds));
  }
  const venueUuid = freshUuid(usedIds);

  const rawLevelMap = new Map<string, string>();
  const importedLevelByBuildingOrdinal = new Map<string, string>();
  const syntheticLevelByKey = new Map<string, string>();
  const levelBuildingByUuid = new Map<string, string>();
  const levelRecords: LevelRecord[] = [];
  const nonLevelRecords: NonLevelRecord[] = [];
  const conversionWarnings: GdbConversionWarning[] = [];

  const requiredBuildingUuid = (layer: GdbLayerPlan): string => {
    if (layer.buildingId === null) {
      conversionFailed("row without building", { layer: layer.key.layerName });
    }
    const uuid = buildingUuidById.get(layer.buildingId);
    if (uuid === undefined) {
      conversionFailed("unknown building id", {
        layer: layer.key.layerName,
        buildingId: layer.buildingId,
      });
    }
    return uuid;
  };

  // Ambiguity pre-scan: canonical duplicate raw level ids fail across every
  // selected level feature, before geometry filtering.
  const seenLevelCanonical = new Set<string>();
  for (const layer of included) {
    if (layer.targetType !== "level") continue;
    const converted = convertedByKey.get(gdbLayerKeyString(layer.key));
    if (converted === undefined) continue;
    for (const feature of converted.featureCollection.features) {
      const rawId = coerceString(
        layer.idField ? (feature.properties ?? {})[layer.idField] : undefined,
      );
      if (rawId === null) continue;
      const canonicalKey = normalizeGdbUuid(rawId) ?? rawId;
      if (seenLevelCanonical.has(canonicalKey)) {
        conversionFailed("ambiguous duplicate raw level id", {
          layer: layer.key.layerName,
          rawLevelId: rawId,
        });
      }
      seenLevelCanonical.add(canonicalKey);
    }
  }

  // ---- Phase 1: levels + the global raw-level-id map ----------------------
  for (const layer of included) {
    if (layer.targetType !== "level") continue;
    const converted = convertedByKey.get(gdbLayerKeyString(layer.key))!;
    const features = converted.featureCollection.features;
    const buildingUuid = requiredBuildingUuid(layer);
    let spatial = 0;
    for (const [featureIndex, feature] of features.entries()) {
      const rawGeometry = feature.geometry;
      if (rawGeometry === null) continue;
      const geometry = normalizeGeometryForFamily(rawGeometry, "polygon", {
        databaseId: layer.key.databaseId,
        layerName: layer.key.layerName,
        targetType: "level",
        featureId: feature.id ?? null,
        featureIndex,
      });
      const fam = geometry === null ? null : geometryFamily(geometry);
      if (geometry === null || fam === null || boundsOf([geometry]) === null) continue;
      if (fam !== "polygon") {
        conversionFailed("incompatible level geometry", { layer: layer.key.layerName });
      }
      spatial += 1;
      const props = feature.properties ?? {};
      const ordinal = resolveLevelOrdinal(layer, props);
      if (ordinal === null) {
        conversionFailed("unresolved level ordinal", { layer: layer.key.layerName });
      }
      const rawId = coerceString(layer.idField ? props[layer.idField] : undefined);
      const normalized = rawId !== null ? normalizeGdbUuid(rawId) : null;
      const canonicalKey = rawId !== null ? (normalized ?? rawId) : null;
      let id: string;
      if (normalized !== null && reservedSourceUuids.has(normalized)) {
        id = normalized;
        usedIds.add(id);
      } else {
        id = freshUuid(usedIds);
      }
      if (canonicalKey !== null) rawLevelMap.set(canonicalKey, id);
      const boKey = `${buildingUuid}\u0000${ordinal}`;
      if (!importedLevelByBuildingOrdinal.has(boKey)) {
        importedLevelByBuildingOrdinal.set(boKey, id);
      }
      levelBuildingByUuid.set(id, buildingUuid);

      const name = coerceString(layer.nameField ? props[layer.nameField] : undefined);
      const shortName = coerceString(
        layer.shortNameField ? props[layer.shortNameField] : undefined,
      );
      let floorLabel: string | null;
      if (layer.levelRule?.kind === "fixed") floorLabel = layer.levelRule.label;
      else if (layer.levelRule?.kind === "property") {
        floorLabel = coerceString(props[layer.levelRule.field]);
      } else {
        floorLabel = STRUCTURED_NAME.exec(layer.key.layerName)?.[2] ?? null;
      }
      const original = { ...props };
      const label = name ?? shortName ?? floorLabel ?? String(ordinal);
      const transient: Record<string, unknown> = {
        name: { ja: label },
        short_name: { ja: shortName ?? label },
        ordinal,
        building_ids: [buildingUuid],
      };
      delete original.restriction;
      delete original.accessibility;
      levelRecords.push({
        id,
        ordinal,
        buildingUuid,
        geometry,
        transient,
        original,
        databaseId: layer.key.databaseId,
        layerName: layer.key.layerName,
        synthetic: false,
      });
    }
    if (features.length === 0 || spatial === 0) {
      conversionFailed("empty or geometry-less level layer", { layer: layer.key.layerName });
    }
  }

  const resolveOrCreateLevel = (
    buildingUuid: string,
    ordinal: number,
    label: string | null,
  ): string => {
    const imported = importedLevelByBuildingOrdinal.get(`${buildingUuid}\u0000${ordinal}`);
    if (imported !== undefined) return imported;
    const synthLabel = label ?? String(ordinal);
    const synthKey = `${buildingUuid}\u0000${ordinal}\u0000${synthLabel.trim().toLowerCase()}`;
    const existing = syntheticLevelByKey.get(synthKey);
    if (existing !== undefined) return existing;
    const synthId = freshUuid(usedIds);
    syntheticLevelByKey.set(synthKey, synthId);
    levelBuildingByUuid.set(synthId, buildingUuid);
    levelRecords.push({
      id: synthId,
      ordinal,
      buildingUuid,
      geometry: null,
      transient: {
        name: { ja: synthLabel },
        short_name: { ja: synthLabel },
        ordinal,
        building_ids: [buildingUuid],
      },
      original: null,
      databaseId: "",
      layerName: "",
      synthetic: true,
    });
    return synthId;
  };

  const rowOrPrefixBuilding = (layer: GdbLayerPlan): string | undefined => {
    if (layer.buildingId !== null) {
      const uuid = buildingUuidById.get(layer.buildingId);
      if (uuid === undefined) {
        conversionFailed("unknown building id", {
          layer: layer.key.layerName,
          buildingId: layer.buildingId,
        });
      }
      return uuid;
    }
    const prefix = STRUCTURED_NAME.exec(layer.key.layerName)?.[1] ?? null;
    if (prefix === null) return undefined;
    const matches = plan.buildings.filter((b) => b.name.toLowerCase() === prefix.toLowerCase());
    return matches.length === 1 ? buildingUuidById.get(matches[0]!.id) : undefined;
  };

  // ---- Phase 2: non-level features + synthetic levels ---------------------
  for (const layer of included) {
    const targetType = layer.targetType;
    if (targetType === null || targetType === "level") continue;
    const converted = convertedByKey.get(gdbLayerKeyString(layer.key))!;
    const features = converted.featureCollection.features;
    const requiredFamily = GEOMETRY_REQUIREMENT[targetType] as SpatialFamily;
    let spatial = 0;
    let fallbackCount = 0;
    for (const [featureIndex, feature] of features.entries()) {
      const rawGeometry = feature.geometry;
      if (rawGeometry === null) continue;
      const geometry = normalizeGeometryForFamily(rawGeometry, requiredFamily, {
        databaseId: layer.key.databaseId,
        layerName: layer.key.layerName,
        targetType,
        featureId: feature.id ?? null,
        featureIndex,
      });
      const fam = geometry === null ? null : geometryFamily(geometry);
      if (geometry === null || fam === null || boundsOf([geometry]) === null) continue;
      if (fam !== requiredFamily) {
        conversionFailed("incompatible feature geometry", {
          layer: layer.key.layerName,
          targetType,
        });
      }
      const props = feature.properties ?? {};
      const rule = layer.levelRule;
      if (rule === null) {
        conversionFailed("row without level rule", { layer: layer.key.layerName });
      }

      let levelUuid: string;
      let featureBuilding: string;

      // Step 1: a raw level_id/floor_id reference resolves against the global
      // raw-level map first — in either UUID form — for every non-level rule
      // kind. A source-reference rule tries its own field first.
      let referenced: string | undefined;
      const referenceFields =
        rule.kind === "source-reference"
          ? [rule.field, "level_id", "floor_id"]
          : ["level_id", "floor_id"];
      for (const field of referenceFields) {
        const value = coerceString(props[field]);
        if (value === null) continue;
        const hit = rawLevelMap.get(normalizeGdbUuid(value) ?? value);
        if (hit !== undefined) {
          referenced = hit;
          break;
        }
      }

      if (referenced !== undefined) {
        levelUuid = referenced;
        featureBuilding = levelBuildingByUuid.get(referenced)!;
      } else if (rule.kind === "fixed") {
        if (!Number.isFinite(rule.ordinal)) {
          conversionFailed("non-finite fixed ordinal", { layer: layer.key.layerName });
        }
        featureBuilding = requiredBuildingUuid(layer);
        levelUuid = resolveOrCreateLevel(featureBuilding, rule.ordinal, rule.label);
      } else if (rule.kind === "layer-name") {
        const ordinal = layerNameFloorOrdinal(layer.key.layerName);
        if (ordinal === null) {
          conversionFailed("unresolved feature floor", { layer: layer.key.layerName });
        }
        featureBuilding = requiredBuildingUuid(layer);
        levelUuid = resolveOrCreateLevel(
          featureBuilding,
          ordinal,
          STRUCTURED_NAME.exec(layer.key.layerName)?.[2] ?? null,
        );
      } else if (rule.kind === "property") {
        let ordinal = extractGdbFloorOrdinal(props[rule.field]);
        let label = coerceString(props[rule.field]);
        if (ordinal === null) {
          ordinal = layerNameFloorOrdinal(layer.key.layerName);
          label = STRUCTURED_NAME.exec(layer.key.layerName)?.[2] ?? label;
        }
        const bUuid = rowOrPrefixBuilding(layer);
        if (ordinal === null || bUuid === undefined) {
          conversionFailed("unresolved feature floor", {
            layer: layer.key.layerName,
            feature: coerceString(layer.idField ? props[layer.idField] : undefined),
            reference: coerceString(props[rule.field]),
          });
        }
        featureBuilding = bUuid;
        levelUuid = resolveOrCreateLevel(bUuid, ordinal, label);
      } else {
        const bUuid = rowOrPrefixBuilding(layer);
        const floorKey = Object.keys(props).find((key) => key.toLowerCase() === "floor");
        const floorValue = floorKey !== undefined ? coerceString(props[floorKey]) : null;
        const floorRef =
          floorValue !== null
            ? rawLevelMap.get(normalizeGdbUuid(floorValue) ?? floorValue)
            : undefined;
        const tokenOrdinal = layerNameFloorOrdinal(layer.key.layerName);
        const floorOrdinal = floorValue !== null ? extractGdbFloorOrdinal(floorValue) : null;
        let spatialLevel: string | undefined;
        let spatialBuilding: string | undefined;
        const point =
          floorOrdinal !== null && requiredFamily === "point"
            ? pointCoordinate(geometry)
            : null;
        if (point !== null) {
          const containing = new Set<string>();
          for (const candidate of levelRecords) {
            if (
              candidate.synthetic ||
              candidate.ordinal !== floorOrdinal ||
              candidate.geometry === null
            ) {
              continue;
            }
            if (pointInGeometry(point[0], point[1], candidate.geometry)) {
              containing.add(candidate.buildingUuid);
            }
          }
          if (containing.size === 1) {
            const [only] = [...containing];
            if (only !== undefined) {
              spatialLevel = importedLevelByBuildingOrdinal.get(`${only}\u0000${floorOrdinal}`);
              spatialBuilding = only;
            }
          }
        }
        if (floorRef !== undefined) {
          levelUuid = floorRef;
          featureBuilding = levelBuildingByUuid.get(floorRef)!;
        } else if (bUuid !== undefined && floorOrdinal !== null) {
          featureBuilding = bUuid;
          levelUuid = resolveOrCreateLevel(bUuid, floorOrdinal, floorValue);
          fallbackCount += 1;
        } else if (bUuid !== undefined && tokenOrdinal !== null) {
          featureBuilding = bUuid;
          levelUuid = resolveOrCreateLevel(
            bUuid,
            tokenOrdinal,
            STRUCTURED_NAME.exec(layer.key.layerName)?.[2] ?? null,
          );
          fallbackCount += 1;
        } else if (spatialLevel !== undefined && spatialBuilding !== undefined) {
          levelUuid = spatialLevel;
          featureBuilding = spatialBuilding;
          fallbackCount += 1;
        } else {
          conversionFailed("unresolved source-reference level", {
            layer: layer.key.layerName,
            feature: coerceString(layer.idField ? props[layer.idField] : undefined),
            reference: coerceString(props[rule.field]),
          });
        }
      }

      const rawId = coerceString(layer.idField ? props[layer.idField] : undefined);
      const normalized = rawId !== null ? normalizeGdbUuid(rawId) : null;
      let id: string;
      if (normalized !== null && reservedSourceUuids.has(normalized)) {
        id = normalized;
        usedIds.add(id);
      } else {
        id = freshUuid(usedIds);
      }

      const name = coerceString(layer.nameField ? props[layer.nameField] : undefined);
      let category = coerceString(layer.categoryField ? props[layer.categoryField] : undefined);
      if (category !== null) category = mapCategoryCode(category);
      if (targetType === "unit" && category === null) category = "room";

      const original = { ...props };
      delete original.restriction;
      delete original.accessibility;
      const transient: Record<string, unknown> = { ...original, level_id: levelUuid };
      if (name !== null) transient.name = { ja: name };
      if (category !== null) transient.category = category;
      else delete transient.category;

      spatial += 1;
      nonLevelRecords.push({
        id,
        featureType: targetType,
        geometry,
        transient,
        original,
        databaseId: layer.key.databaseId,
        layerName: layer.key.layerName,
        levelUuid,
        buildingUuid: featureBuilding,
      });
    }
    if (features.length === 0 || spatial === 0) {
      conversionFailed("empty or geometry-less layer", { layer: layer.key.layerName });
    }
    if (fallbackCount > 0) {
      conversionWarnings.push({
        code: "unresolved_reference",
        message: `${layer.key.layerName}: ${fallbackCount} feature(s) fell back to a resolved floor for unresolved floor references`,
      });
    }
  }

  if (levelRecords.length === 0) {
    conversionFailed("no levels produced");
  }

  // ---- Phase 3: synthesize geometry for synthetic levels ------------------
  for (const level of levelRecords) {
    if (!level.synthetic) continue;
    const assigned = nonLevelRecords
      .filter((record) => record.levelUuid === level.id)
      .map((record) => record.geometry);
    const bounds = boundsOf(assigned);
    if (bounds === null) {
      conversionFailed("synthetic level without finite geometry");
    }
    level.geometry = rectanglePolygon(bounds);
  }

  // ---- Phase 4: synthesize building and venue polygons --------------------
  const buildingGeometries: GeoJSON.Geometry[] = [];
  const buildingFeatures: ImdfFeature[] = [];
  for (const building of plan.buildings) {
    const buildingUuid = buildingUuidById.get(building.id)!;
    const geometries: (GeoJSON.Geometry | null)[] = [];
    for (const level of levelRecords) {
      if (level.buildingUuid === buildingUuid) geometries.push(level.geometry);
    }
    for (const record of nonLevelRecords) {
      if (record.featureType === "unit" && record.buildingUuid === buildingUuid) {
        geometries.push(record.geometry);
      }
    }
    const bounds = boundsOf(geometries);
    if (bounds === null) {
      conversionFailed("building without finite geometry", { buildingId: building.id });
    }
    const polygon = rectanglePolygon(bounds);
    buildingGeometries.push(polygon);
    buildingFeatures.push(
      imdfFeature("building", {
        type: "Feature",
        id: buildingUuid,
        geometry: polygon,
        properties: { name: { ja: building.name }, venue_id: venueUuid },
      }),
    );
  }

  const venueBounds = boundsOf(buildingGeometries);
  if (venueBounds === null) {
    conversionFailed("venue without finite geometry");
  }
  const venueFeature = imdfFeature("venue", {
    type: "Feature",
    id: venueUuid,
    geometry: rectanglePolygon(venueBounds),
    properties: { name: { ja: plan.venueName } },
  });

  // ---- Phase 5: assemble collections --------------------------------------
  const collections: Partial<Record<FeatureType, GeoJSON.FeatureCollection>> = {
    venue: { type: "FeatureCollection", features: [venueFeature] },
    building: { type: "FeatureCollection", features: buildingFeatures },
  };

  const pushFeature = (type: FeatureType, feature: GeoJSON.Feature): void => {
    let collection = collections[type];
    if (collection === undefined) {
      collection = { type: "FeatureCollection", features: [] };
      collections[type] = collection;
    }
    collection.features.push(imdfFeature(type, feature));
  };

  // The Rust importer preserves every `properties` entry into
  // `source_properties`, so transient IMDF fields + raw GDB attributes +
  // gdb metadata are written together in one shot — no separate restore pass.
  const mergeGdbProperties = (
    transient: Record<string, unknown>,
    original: Record<string, unknown> | null,
    databaseId: string,
    layerName: string,
    levelUuid: string | null,
  ): Record<string, unknown> => ({
    ...original,
    ...transient,
    ...(levelUuid !== null ? { [GDB_META_RESOLVED_LEVEL]: levelUuid } : {}),
    [GDB_META_DATABASE]: databaseId,
    [GDB_META_LAYER]: layerName,
  });

  for (const level of levelRecords) {
    if (level.geometry === null) {
      conversionFailed("level without geometry", { levelId: level.id });
    }
    const properties = level.synthetic
      ? level.transient
      : mergeGdbProperties(
          level.transient,
          level.original,
          level.databaseId,
          level.layerName,
          level.id,
        );
    pushFeature("level", {
      type: "Feature",
      id: level.id,
      geometry: level.geometry,
      properties,
    });
  }
  for (const record of nonLevelRecords) {
    const properties = mergeGdbProperties(
      record.transient,
      record.original,
      record.databaseId,
      record.layerName,
      record.levelUuid,
    );
    pushFeature(record.featureType, {
      type: "Feature",
      id: record.id,
      geometry: record.geometry,
      properties,
    });
  }

  const archive: ParsedImdfArchive = {
    manifest: { version: "1.0.0", language: "ja" },
    collections,
    warnings: conversionWarnings,
  };

  // One aggregated warning per included layer whose export dropped geometry-less
  // features.
  for (const layer of included) {
    const converted = convertedByKey.get(gdbLayerKeyString(layer.key));
    if (converted === undefined || converted.skippedGeometryCount <= 0) continue;
    archive.warnings.push({
      code: "gdb_geometry_skipped",
      message: `${layer.key.databaseId}/${layer.key.layerName}: ${converted.skippedGeometryCount} feature(s) skipped for missing geometry`,
    });
  }

  const seenWorkerWarnings = new Set<string>();
  for (const message of conversion.warnings) {
    if (seenWorkerWarnings.has(message)) continue;
    seenWorkerWarnings.add(message);
    archive.warnings.push({ code: "gdb_worker_warning", message });
  }

  return archive;
}

/** One layer that blocks {@link buildGdbImdf}, with its raw failure reason. */
export interface GdbConversionFailure {
  layer: string;
  reason: string;
}

/**
 * Enumerate every layer that blocks conversion. Repeatedly attempts
 * {@link buildGdbImdf}; on each per-layer failure it records the blamed layer
 * and re-attempts with that layer excluded, until the plan converts or a
 * failure names no single layer. Returns the layers to exclude or fix — empty
 * when the plan already converts. Pure: the plan is cloned per attempt.
 */
export function collectGdbConversionFailures(
  conversion: GdbConversionResult,
  plan: GdbMappingPlan,
): GdbConversionFailure[] {
  const failures: GdbConversionFailure[] = [];
  const excluded = new Set<string>();
  let working = plan;
  const maxAttempts = plan.layers.filter((layer) => layer.included).length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      buildGdbImdf(conversion, working);
      return failures;
    } catch (error) {
      if (!(error instanceof GdbConversionError)) {
        throw error;
      }
      const blamed = error.details?.layer;
      const layer = typeof blamed === "string" && blamed.length > 0 ? blamed : null;
      if (layer === null || excluded.has(layer)) {
        return failures;
      }
      const rawReason = error.reason;
      failures.push({ layer, reason: typeof rawReason === "string" ? rawReason : "" });
      excluded.add(layer);
      working = {
        ...working,
        layers: working.layers.map((row) =>
          row.key.layerName === layer ? { ...row, included: false } : row,
        ),
      };
    }
  }
  return failures;
}

export interface GdbImdfResolveResult {
  archive: ParsedImdfArchive;
  excludedLayers: GdbConversionFailure[];
}

/**
 * Normalize plan, build IMDF, or auto-prune blamed layers via
 * collectGdbConversionFailures. Throws GdbConversionError when nothing
 * remains convertible or the failure is not layer-attributable.
 */
export function resolveGdbImdfWithExclusions(
  conversion: GdbConversionResult,
  plan: GdbMappingPlan,
): GdbImdfResolveResult {
  const normalized = normalizeGdbPlan(plan);
  try {
    return { archive: buildGdbImdf(conversion, normalized), excludedLayers: [] };
  } catch (error) {
    if (!(error instanceof GdbConversionError)) throw error;

    const failures = collectGdbConversionFailures(conversion, normalized);
    if (failures.length === 0) {
      throw error;
    }

    const excludedNames = new Set(failures.map((f) => f.layer));
    const working: GdbMappingPlan = {
      ...normalized,
      layers: normalized.layers.map((row) =>
        excludedNames.has(row.key.layerName) ? { ...row, included: false } : row,
      ),
    };

    const stillIncluded = working.layers.some((l) => l.included && l.targetType !== null);
    if (!stillIncluded) {
      throw new GdbConversionError(
        "gdb_conversion_failed",
        "no convertible layers after exclusions",
        { excludedLayers: failures },
      );
    }

    const archive = buildGdbImdf(conversion, working);
    return { archive, excludedLayers: failures };
  }
}
