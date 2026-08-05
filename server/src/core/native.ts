import { compileImdf, exportNetwork, inspectBundle } from "@kiriko/node";

/** Bundle statistics, API-compatible with the existing `stats_json` shape. */
export interface ImdfStats {
  levels: number;
  features: number;
}

export type ViewerWarningCode =
  | "missing_locale"
  | "unresolved_reference"
  | "missing_level_geometry"
  | "missing_display_point"
  | "unknown_archive_entry"
  | "route_build"
  | "facility_build"
  | "floor_override";

export interface ViewerWarning {
  code: ViewerWarningCode;
  message: string;
  featureId?: string;
  archiveEntry?: string;
}

export interface CompileVenueMetadata {
  datasetId: string;
  version: number;
  /**
   * WGS84 GeoJSON for the routing network's `net_junction`/`net_path`
   * layers. When both are present the compiled bundle carries a section-5
   * routing graph; when absent the compile is byte-identical to a
   * network-less import.
   */
  networkJunctionsGeoJson?: string;
  networkPathsGeoJson?: string;
  /**
   * WGS84 GeoJSON for the optional `point_facility_network` layer. When
   * present the compiled bundle carries the facility point index as section
   * 7; when absent facility compilation is unchanged.
   */
  facilitiesGeoJson?: string;
  /**
   * When `true` and no network GeoJSON is supplied, the compiler derives a
   * routing graph from the venue's own geometry (walkway/opening/transit
   * adjacency) and embeds it as section 5. Ignored when a real network is
   * supplied.
   */
  synthesizeNetwork?: boolean;
  /**
   * When `true`, the compiler drops network nodes and facilities that fall
   * outside the imported venue's level/unit polygons. Set by a GDB import that
   * selected a subset of a multi-building dataset, where the network and
   * facility GDBs still describe the whole site.
   */
  clipToVenue?: boolean;
}

/**
 * `@kiriko/node`'s raw bridge contract. Mirrors the generated
 * `NativeCompileResponse` napi-rs type: a flat, always-defined `ok`
 * discriminant with the remaining fields optional depending on which side
 * of the discriminant is populated. Treated as untrusted input — see
 * `validateNativeResponse` — since the native addon crosses an FFI
 * boundary and its resolved value is never assumed well-formed.
 */
export interface NativeCompileResponse {
  ok: boolean;
  bundle?: Buffer;
  statsJson?: string;
  warningsJson?: string;
  errorJson?: string;
}

/**
 * Untrusted: the native addon's resolved value is validated from scratch
 * (see `validateNativeResponse`), not assumed to match this shape.
 */
export type NativeCompileFn = (
  source: Buffer,
  datasetId: string,
  version: number,
  networkJunctionsGeoJson?: string,
  networkPathsGeoJson?: string,
  facilitiesGeoJson?: string,
  synthesizeNetwork?: boolean,
  clipToVenue?: boolean,
) => Promise<unknown>;

const WARNING_CODES: Record<ViewerWarningCode, true> = {
  missing_locale: true,
  unresolved_reference: true,
  missing_level_geometry: true,
  missing_display_point: true,
  unknown_archive_entry: true,
  route_build: true,
  facility_build: true,
  floor_override: true,
};

const U32_MAX = 0xffff_ffff;

/**
 * A venue compile failure. `code` is either a stable `kiriko-model`
 * importer code or a stable `kiriko-bundle` codec code (both documented in
 * the Phase Two bundle format contract), or `"bridge_error"` when the
 * native addon's response itself was malformed.
 */
export class CoreCompileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CoreCompileError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isU32(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= U32_MAX;
}

/** A validated `NativeCompileResponse` success side: every field checked. */
interface ValidatedSuccess {
  ok: true;
  bundle: Buffer;
  statsJson: string;
  warningsJson: string;
}

/** A validated `NativeCompileResponse` failure side: every field checked. */
interface ValidatedFailure {
  ok: false;
  errorJson: string;
}

/**
 * Validates the native addon's resolved value field-by-field before any of
 * it is trusted: the FFI boundary means a bridge bug (wrong napi-rs
 * version, a broken build, a future refactor that drops a field) must
 * surface as a `CoreCompileError("bridge_error", ...)`, never a raw
 * `TypeError` from blindly dereferencing an unexpected shape.
 */
function validateNativeResponse(raw: unknown): ValidatedSuccess | ValidatedFailure {
  if (!isRecord(raw)) {
    throw new CoreCompileError("bridge_error", "native compile response is not an object");
  }
  if (typeof raw.ok !== "boolean") {
    throw new CoreCompileError("bridge_error", "native compile response ok is not a boolean");
  }
  if (raw.ok) {
    if (!Buffer.isBuffer(raw.bundle)) {
      throw new CoreCompileError("bridge_error", "native compile response bundle is not a Buffer");
    }
    if (typeof raw.statsJson !== "string") {
      throw new CoreCompileError("bridge_error", "native compile response statsJson is not a string");
    }
    if (typeof raw.warningsJson !== "string") {
      throw new CoreCompileError("bridge_error", "native compile response warningsJson is not a string");
    }
    return { ok: true, bundle: raw.bundle, statsJson: raw.statsJson, warningsJson: raw.warningsJson };
  }
  if (typeof raw.errorJson !== "string") {
    throw new CoreCompileError("bridge_error", "native compile response errorJson is not a string");
  }
  return { ok: false, errorJson: raw.errorJson };
}

function parseJson(json: string, field: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new CoreCompileError("bridge_error", `native ${field} is not valid JSON`);
  }
}

function parseStats(json: string): ImdfStats {
  const parsed = parseJson(json, "statsJson");
  if (!isRecord(parsed) || !isU32(parsed.levels) || !isU32(parsed.features)) {
    throw new CoreCompileError("bridge_error", "native statsJson has an unexpected shape");
  }
  return { levels: parsed.levels, features: parsed.features };
}

/** `undefined` is a valid absence; any other non-string value is rejected. */
function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new CoreCompileError("bridge_error", `native warningsJson entry has a non-string ${field}`);
  }
  return value;
}

function parseWarning(value: unknown): ViewerWarning {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") {
    throw new CoreCompileError("bridge_error", "native warningsJson entry has an unexpected shape");
  }
  if (!WARNING_CODES[value.code as ViewerWarningCode]) {
    throw new CoreCompileError("bridge_error", `native warningsJson entry has an unknown code: ${value.code}`);
  }
  const warning: ViewerWarning = { code: value.code as ViewerWarningCode, message: value.message };
  const featureId = parseOptionalString(value.featureId, "featureId");
  if (featureId !== undefined) {
    warning.featureId = featureId;
  }
  const archiveEntry = parseOptionalString(value.archiveEntry, "archiveEntry");
  if (archiveEntry !== undefined) {
    warning.archiveEntry = archiveEntry;
  }
  return warning;
}

function parseWarnings(json: string): ViewerWarning[] {
  const parsed = parseJson(json, "warningsJson");
  if (!Array.isArray(parsed)) {
    throw new CoreCompileError("bridge_error", "native warningsJson is not an array");
  }
  return parsed.map(parseWarning);
}

function parseError(json: string): CoreCompileError {
  const parsed = parseJson(json, "errorJson");
  if (!isRecord(parsed) || typeof parsed.code !== "string" || typeof parsed.message !== "string") {
    throw new CoreCompileError("bridge_error", "native errorJson has an unexpected shape");
  }
  let details: Record<string, unknown> | undefined;
  if (parsed.details !== undefined) {
    if (!isRecord(parsed.details)) {
      throw new CoreCompileError("bridge_error", "native errorJson details is not an object");
    }
    details = parsed.details;
  }
  return new CoreCompileError(parsed.code, parsed.message, details);
}

/**
 * Compile raw IMDF `source` bytes into a `kvb1` bundle via the native
 * `@kiriko/node` addon (off the Node.js event loop; see
 * `napi::bindgen_prelude::AsyncTask` on the Rust side). The native addon's
 * resolved value is treated as untrusted FFI output and validated field by
 * field (see `validateNativeResponse`) before any of it is used. Throws
 * `CoreCompileError` for genuine domain failures (a rejected IMDF archive
 * or bundle-codec error, native `code` `"bridge_error"` — the native addon
 * itself never rejects this promise except for a true bridge/runtime
 * failure, and any such failure (or any other unexpected throw) is also
 * normalized to `CoreCompileError("bridge_error", ...)` here — never a raw
 * `TypeError`/`SyntaxError` escapes this function.
 */
export async function compileVenueBundle(
  source: Buffer,
  metadata: CompileVenueMetadata,
  nativeCompile: NativeCompileFn = compileImdf,
): Promise<{ bundle: Buffer; stats: ImdfStats; warnings: ViewerWarning[] }> {
  try {
    const response = validateNativeResponse(
      await nativeCompile(
        source,
        metadata.datasetId,
        metadata.version,
        metadata.networkJunctionsGeoJson,
        metadata.networkPathsGeoJson,
        metadata.facilitiesGeoJson,
        metadata.synthesizeNetwork,
        metadata.clipToVenue,
      ),
    );
    if (response.ok) {
      return {
        bundle: response.bundle,
        stats: parseStats(response.statsJson),
        warnings: parseWarnings(response.warningsJson),
      };
    }
    throw parseError(response.errorJson);
  } catch (error) {
    if (error instanceof CoreCompileError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CoreCompileError("bridge_error", `native compile bridge failed: ${message}`);
  }
}

/**
 * `@kiriko/node`'s raw inspection bridge contract. Mirrors the generated
 * `NativeInspectResponse` napi-rs type; treated as untrusted input — see
 * `validateNativeInspectResponse`.
 */
export interface NativeInspectResponse {
  ok: boolean;
  inspectionJson?: string;
  errorJson?: string;
}

/**
 * Untrusted: the native addon's resolved value is validated from scratch
 * (see `validateNativeInspectResponse`), not assumed to match this shape.
 */
export type NativeInspectFn = (bundle: Buffer) => Promise<unknown>;

/**
 * Level/feature anchor projection of one immutable published bundle.
 * `featureLevels` maps every feature id to its level id, a level feature to
 * its own id, and a level-independent feature to `null`; both collections
 * preserve the bundle's canonical decoded order.
 */
export interface BundleAnchorIndex {
  bundleHash: string;
  levelIds: ReadonlySet<string>;
  featureLevels: ReadonlyMap<string, string | null>;
}

/**
 * A bundle inspection failure. `code` is a stable `kiriko-bundle` codec
 * code (`invalid_bundle`, `unsupported_bundle_version`,
 * `bundle_integrity_failed`, `bundle_too_large`),
 * `"bundle_hash_mismatch"` when the bytes do not hash to the expected
 * stored value, or `"bridge_error"` when the native addon's response
 * itself was malformed. These are internal core errors: callers translate
 * them into their own client-facing codes (never `invalid_anchor` here).
 */
export class CoreInspectError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CoreInspectError";
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function inspectBridgeError(message: string): CoreInspectError {
  return new CoreInspectError("bridge_error", message);
}

/** A validated `NativeInspectResponse`: every field checked before use. */
type ValidatedInspectResponse = { ok: true; inspectionJson: string } | { ok: false; errorJson: string };

function validateNativeInspectResponse(raw: unknown): ValidatedInspectResponse {
  if (!isRecord(raw)) {
    throw inspectBridgeError("native inspect response is not an object");
  }
  if (typeof raw.ok !== "boolean") {
    throw inspectBridgeError("native inspect response ok is not a boolean");
  }
  if (raw.ok) {
    if (typeof raw.inspectionJson !== "string") {
      throw inspectBridgeError("native inspect response inspectionJson is not a string");
    }
    return { ok: true, inspectionJson: raw.inspectionJson };
  }
  if (typeof raw.errorJson !== "string") {
    throw inspectBridgeError("native inspect response errorJson is not a string");
  }
  return { ok: false, errorJson: raw.errorJson };
}

function parseInspectJson(json: string, field: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw inspectBridgeError(`native ${field} is not valid JSON`);
  }
}

/**
 * The only error codes the native inspect addon can legitimately emit: the
 * four stable `kiriko-bundle` codec codes. Anything else in `errorJson`
 * (client codes like `invalid_anchor`, importer codes, or the
 * wrapper-generated `bundle_hash_mismatch`) is a bridge contract violation.
 */
const BUNDLE_CODEC_CODES: Record<string, true> = {
  invalid_bundle: true,
  unsupported_bundle_version: true,
  bundle_integrity_failed: true,
  bundle_too_large: true,
};

/**
 * Validated inspection payload as plain scalars/arrays: hash form, level id
 * uniqueness, tuple arity, feature id uniqueness, and level-reference
 * closure are all checked here, but the final `Set`/`Map` are only
 * constructed by the caller after the expected-hash equality check passes,
 * so no index collection ever exists for a bundle that failed validation.
 */
function parseInspection(json: string): {
  bundleHash: string;
  levelIds: string[];
  featureLevels: Array<[string, string | null]>;
} {
  const parsed = parseInspectJson(json, "inspectionJson");
  if (!isRecord(parsed)) {
    throw inspectBridgeError("native inspectionJson is not an object");
  }
  if (typeof parsed.bundleHash !== "string" || !SHA256_HEX.test(parsed.bundleHash)) {
    throw inspectBridgeError("native inspectionJson bundleHash is not 64 lowercase hex chars");
  }
  if (!Array.isArray(parsed.levelIds)) {
    throw inspectBridgeError("native inspectionJson levelIds is not an array");
  }
  const levelIds: string[] = [];
  const seenLevels = new Set<string>();
  for (const levelId of parsed.levelIds) {
    if (typeof levelId !== "string") {
      throw inspectBridgeError("native inspectionJson levelIds entry is not a string");
    }
    if (seenLevels.has(levelId)) {
      throw inspectBridgeError(`native inspectionJson levelIds contains a duplicate: ${levelId}`);
    }
    seenLevels.add(levelId);
    levelIds.push(levelId);
  }
  if (!Array.isArray(parsed.featureLevels)) {
    throw inspectBridgeError("native inspectionJson featureLevels is not an array");
  }
  const featureLevels: Array<[string, string | null]> = [];
  const seenFeatures = new Set<string>();
  for (const entry of parsed.featureLevels) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw inspectBridgeError("native inspectionJson featureLevels entry is not a 2-tuple");
    }
    const [featureId, levelId] = entry as [unknown, unknown];
    if (typeof featureId !== "string") {
      throw inspectBridgeError("native inspectionJson featureLevels entry has a non-string feature id");
    }
    if (levelId !== null && typeof levelId !== "string") {
      throw inspectBridgeError("native inspectionJson featureLevels entry level is neither a string nor null");
    }
    if (levelId !== null && !seenLevels.has(levelId)) {
      throw inspectBridgeError(`native inspectionJson featureLevels references an unknown level: ${levelId}`);
    }
    if (seenFeatures.has(featureId)) {
      throw inspectBridgeError(`native inspectionJson featureLevels contains a duplicate feature id: ${featureId}`);
    }
    seenFeatures.add(featureId);
    featureLevels.push([featureId, levelId]);
  }
  return { bundleHash: parsed.bundleHash, levelIds, featureLevels };
}

function parseInspectError(json: string): CoreInspectError {
  const parsed = parseInspectJson(json, "errorJson");
  if (!isRecord(parsed) || typeof parsed.code !== "string" || typeof parsed.message !== "string") {
    throw inspectBridgeError("native errorJson has an unexpected shape");
  }
  let details: Record<string, unknown> | undefined;
  if (parsed.details !== undefined) {
    if (!isRecord(parsed.details)) {
      throw inspectBridgeError("native errorJson details is not an object");
    }
    details = parsed.details;
  }
  // Own-key membership only: a plain index would accept inherited
  // Object.prototype keys ("toString", "constructor", "__proto__") as
  // truthy and let them masquerade as stable codec codes.
  if (!Object.hasOwn(BUNDLE_CODEC_CODES, parsed.code)) {
    throw inspectBridgeError(`native errorJson has an unknown code: ${parsed.code}`);
  }
  return new CoreInspectError(parsed.code, parsed.message, details);
}

/**
 * Inspect immutable `kvb1` `bundle` bytes via the native `@kiriko/node`
 * addon (off the Node.js event loop; see `InspectTask` on the Rust side)
 * and return the level/feature anchor index. The native addon's resolved
 * value is treated as untrusted FFI output and validated field by field
 * before any of it is used, and the whole-file hash the native side
 * computed must equal `expectedBundleHash` (the stored content address)
 * exactly. Throws `CoreInspectError` for domain failures (corrupt stored
 * bytes surface the stable bundle-codec codes; a hash disagreement is
 * `"bundle_hash_mismatch"`); any malformed native output or unexpected
 * throw is normalized to `CoreInspectError("bridge_error", ...)` — never a
 * raw `TypeError`/`SyntaxError` escapes this function.
 */
export async function inspectVenueBundle(
  bundle: Buffer,
  expectedBundleHash: string,
  nativeInspect: NativeInspectFn = inspectBundle,
): Promise<BundleAnchorIndex> {
  try {
    const response = validateNativeInspectResponse(await nativeInspect(bundle));
    if (!response.ok) {
      throw parseInspectError(response.errorJson);
    }
    const parsed = parseInspection(response.inspectionJson);
    const { bundleHash } = parsed;
    if (!SHA256_HEX.test(expectedBundleHash) || bundleHash !== expectedBundleHash) {
      throw new CoreInspectError(
        "bundle_hash_mismatch",
        `bundle bytes hash to ${bundleHash} but ${JSON.stringify(expectedBundleHash)} was expected`,
      );
    }
    // The final Set/Map are only built once the bytes' hash equals the
    // stored content address exactly.
    return {
      bundleHash,
      levelIds: new Set(parsed.levelIds),
      featureLevels: new Map(parsed.featureLevels),
    };
  } catch (error) {
    if (error instanceof CoreInspectError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CoreInspectError("bridge_error", `native inspect bridge failed: ${message}`);
  }
}

/**
 * `@kiriko/node`'s raw network-export bridge contract. Treated as untrusted
 * FFI output — validated before use.
 */
export type NativeExportFn = (bundle: Buffer) => Promise<unknown>;

/**
 * A network-export failure. `code` is a stable `kiriko-bundle` code
 * (`no_graph`, the four codec codes, or `export_serialize_failed`), or
 * `"bridge_error"` when the native response itself was malformed.
 */
export class CoreExportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoreExportError";
  }
}

type ValidatedExportResponse =
  | { ok: true; junctionsJson: string; pathsJson: string }
  | { ok: false; errorJson: string };

function validateNativeExportResponse(raw: unknown): ValidatedExportResponse {
  if (!isRecord(raw) || typeof raw.ok !== "boolean") {
    throw new CoreExportError("bridge_error", "native export response is malformed");
  }
  if (raw.ok) {
    if (typeof raw.junctionsJson !== "string" || typeof raw.pathsJson !== "string") {
      throw new CoreExportError("bridge_error", "native export response is missing GeoJSON strings");
    }
    return { ok: true, junctionsJson: raw.junctionsJson, pathsJson: raw.pathsJson };
  }
  if (typeof raw.errorJson !== "string") {
    throw new CoreExportError("bridge_error", "native export errorJson is not a string");
  }
  return { ok: false, errorJson: raw.errorJson };
}

function parseExportError(json: string): CoreExportError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CoreExportError("bridge_error", "native export errorJson is not valid JSON");
  }
  if (!isRecord(parsed) || typeof parsed.code !== "string" || typeof parsed.message !== "string") {
    throw new CoreExportError("bridge_error", "native export errorJson has an unexpected shape");
  }
  return new CoreExportError(parsed.code, parsed.message);
}

/**
 * Export a compiled `kvb1` bundle's §5 routing graph as `net_junction` /
 * `net_path` GeoJSON via the native `@kiriko/node` addon. Throws
 * `CoreExportError("no_graph", …)` when the bundle carries no graph; any
 * malformed native output normalizes to `CoreExportError("bridge_error", …)`.
 */
export async function exportVenueNetwork(
  bundle: Buffer,
  nativeExport: NativeExportFn = exportNetwork,
): Promise<{ junctions: string; paths: string }> {
  try {
    const response = validateNativeExportResponse(await nativeExport(bundle));
    if (!response.ok) {
      throw parseExportError(response.errorJson);
    }
    return { junctions: response.junctionsJson, paths: response.pathsJson };
  } catch (error) {
    if (error instanceof CoreExportError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CoreExportError("bridge_error", `native export bridge failed: ${message}`);
  }
}
