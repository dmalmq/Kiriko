import {
  compileImdf,
  deriveTileScene as deriveTileSceneNative,
  evaluateTileActivation as evaluateTileActivationNative,
  exportNetwork,
  ingestTilePackage as ingestTilePackageNative,
  inspectBundle,
} from "@kiriko/node";

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
  /**
   * The activated tile package's §9 descriptor, JSON. When present the
   * compiled bundle's §9 carries it, which is where the renderer reads
   * activation state and floor mappings from (#74). Absent for a venue with no
   * activated package, and then the compile is byte-identical to before.
   */
  tilesDescriptorJson?: string;
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
  tilesDescriptorJson?: string,
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
        metadata.tilesDescriptorJson,
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

/**
 * `@kiriko/node`'s raw tile-package ingestion bridge contract. Treated as
 * untrusted FFI output — validated before use.
 */
export type NativeTilePackageFn = (packageBytes: Buffer) => Promise<unknown>;

/** Kinds of member a package graph references. */
export type TileMemberKind = "tileset" | "content";

export interface TileMemberRecord {
  path: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  kind: TileMemberKind;
}

export interface TilePackageRecord {
  sourceHash: string;
  rootTileset: string;
  assetVersions: string[];
  extensions: string[];
  members: TileMemberRecord[];
  /** Entries the graph never references; reported, never stored. */
  ignored: string[];
  totalBytes: number;
}

/**
 * A refused tile package. `code` is the stable `kiriko-scene` refusal code
 * (`pathTraversal`, `externalReference`, `unresolvedMember`, …), or
 * `"bridge_error"` when the native response itself was malformed. `details`
 * carries the refusal's own fields so the producer UI can name the offending
 * path without re-parsing the message.
 */
export class CoreTilePackageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CoreTilePackageError";
  }
}

function parseTilePackageError(errorJson: unknown): CoreTilePackageError {
  if (typeof errorJson !== "string") {
    return new CoreTilePackageError("bridge_error", "native ingest returned no error payload");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(errorJson);
  } catch {
    return new CoreTilePackageError("bridge_error", "native ingest error was not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || !("code" in parsed)) {
    return new CoreTilePackageError("bridge_error", "native ingest error had no code");
  }
  const { code, ...details } = parsed as { code: unknown } & Record<string, unknown>;
  if (typeof code !== "string" || code === "") {
    return new CoreTilePackageError("bridge_error", "native ingest error code was not a string");
  }
  return new CoreTilePackageError(code, `tile package refused: ${code}`, details);
}

function isMemberKind(value: unknown): value is TileMemberKind {
  return value === "tileset" || value === "content";
}

function parseTilePackageReport(reportJson: unknown): TilePackageRecord {
  if (typeof reportJson !== "string") {
    throw new CoreTilePackageError("bridge_error", "native ingest returned no report");
  }
  const parsed: unknown = JSON.parse(reportJson);
  if (parsed === null || typeof parsed !== "object") {
    throw new CoreTilePackageError("bridge_error", "native ingest report was not an object");
  }
  const record = parsed as Record<string, unknown>;
  const sourceHash = record["sourceHash"];
  const rootTileset = record["rootTileset"];
  const members = record["members"];
  const totalBytes = record["totalBytes"];
  if (
    typeof sourceHash !== "string" ||
    !SHA256_HEX.test(sourceHash) ||
    typeof rootTileset !== "string" ||
    rootTileset === "" ||
    !Array.isArray(members) ||
    members.length === 0 ||
    typeof totalBytes !== "number" ||
    !Number.isFinite(totalBytes)
  ) {
    throw new CoreTilePackageError("bridge_error", "native ingest report was malformed");
  }

  const parsedMembers: TileMemberRecord[] = members.map((entry) => {
    if (entry === null || typeof entry !== "object") {
      throw new CoreTilePackageError("bridge_error", "a member entry was not an object");
    }
    const member = entry as Record<string, unknown>;
    const path = member["path"];
    const sha256 = member["sha256"];
    const byteSize = member["byteSize"];
    const contentType = member["contentType"];
    const kind = member["kind"];
    if (
      typeof path !== "string" ||
      path === "" ||
      typeof sha256 !== "string" ||
      !SHA256_HEX.test(sha256) ||
      typeof byteSize !== "number" ||
      !Number.isInteger(byteSize) ||
      byteSize < 0 ||
      typeof contentType !== "string" ||
      contentType === "" ||
      !isMemberKind(kind)
    ) {
      throw new CoreTilePackageError("bridge_error", `member ${String(path)} was malformed`);
    }
    return { path, sha256, byteSize, contentType, kind };
  });

  const stringList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

  return {
    sourceHash,
    rootTileset,
    assetVersions: stringList(record["assetVersions"]),
    extensions: stringList(record["extensions"]),
    members: parsedMembers,
    ignored: stringList(record["ignored"]),
    totalBytes,
  };
}

/**
 * Validate an uploaded 3D Tiles package through the native bridge: the URI
 * graph is resolved inside the archive, anything escaping it is refused, and
 * every referenced member's content address is recorded.
 *
 * Throws `CoreTilePackageError` for a refused package (with the refusal's
 * typed code) and for a malformed native response. Never performs network or
 * filesystem access: the package bytes are the only input.
 */
export async function ingestTilePackage(
  packageBytes: Buffer,
  nativeIngest: NativeTilePackageFn = ingestTilePackageNative,
): Promise<TilePackageRecord> {
  let response: unknown;
  try {
    response = await nativeIngest(packageBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CoreTilePackageError("bridge_error", `native ingest bridge failed: ${message}`);
  }
  if (response === null || typeof response !== "object" || !("ok" in response)) {
    throw new CoreTilePackageError("bridge_error", "native ingest response was malformed");
  }
  const { ok } = response as { ok: unknown };
  if (ok !== true) {
    const errorJson = "errorJson" in response ? response.errorJson : undefined;
    throw parseTilePackageError(errorJson);
  }
  const reportJson = "reportJson" in response ? response.reportJson : undefined;
  try {
    return parseTilePackageReport(reportJson);
  } catch (error) {
    if (error instanceof CoreTilePackageError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CoreTilePackageError("bridge_error", `native ingest report failed: ${message}`);
  }
}

/**
 * `@kiriko/node`'s raw tile-activation bridge contract. Treated as untrusted
 * FFI output — validated before use.
 */
export type NativeTileActivationFn = (
  bundle: Buffer,
  contents: Buffer[],
  requestJson: string,
) => Promise<unknown>;

/**
 * The versioned registration profile. Every field is optional over the bridge:
 * the native default profile carries #31's certified bands, and a stored
 * profile written before a field existed still loads as that field's old
 * meaning.
 */
export interface RegistrationProfileInput {
  id?: string;
  version?: number;
  sampleSpacingM?: number;
  carveOutDistanceM?: number;
  p90MaxM?: number;
  /** Per-canonical-floor p90 bands: no single number describes an asset. */
  floorP90MaxM?: Record<string, number>;
  medianShiftMaxM?: number;
  coherentResidualMaxM?: number;
  clusterCellM?: number;
  clusterMinSamples?: number;
  levelMatchToleranceM?: number;
  /** Added to tile planes before matching — a producer decision, never inferred. */
  verticalOffsetM?: number;
}

export interface TileActivationRequest {
  /** The immutable asset version: the first component of composite level identity. */
  assetVersion: string;
  /** The published tileset root transform, column-major, applied unchanged (#31). */
  rootTransform: number[];
  /** Whether every declared member resolved and hashed as recorded. */
  integrityVerified: boolean;
  capabilityProfile: string | null;
  contextualSourceObjects?: string[];
  profile?: RegistrationProfileInput;
}

export interface ResidualStats {
  samples: number;
  p50M: number;
  p90M: number;
  maxM: number;
}

export interface TileLevelRegistration {
  compositeId: string;
  sourceDocument: string;
  sourceLinkName: string;
  levelKey: string;
  levelName: string;
  quantizedElevationDm: number;
  metadataElevationM: number;
  /** The dominant walkable-surface height; `null` when the level exposes none. */
  resolvedPlaneM: number | null;
  /** Metadata minus resolved: provenance, and the disagreement finding's input. */
  metadataDifferenceM: number | null;
  surfaceTriangles: number;
  sourceObjectIds: string[];
  opaqueSourceObjectIds: string[];
  /**
   * The canonical floor this level matched, and that floor's own plane. The one
   * decision in the report a producer must check by eye: a stack offset by about
   * a storey maps every level to its neighbour, and where footprints repeat the
   * residuals against the wrong floor are as small as against the right one.
   */
  mappedCanonicalLevelId: string | null;
  mappedFloorPlaneM: number | null;
  /**
   * What this level's own label says about that match: `agrees`, `contradicts`,
   * or `unknown`. The only check that does not come from altitude, and so the
   * only one that sees a stack offset by a whole storey where footprints repeat.
   * `unknown` is the absence of a check, never a passed one.
   */
  labelAgreement: "agrees" | "contradicts" | "unknown";
}

export interface CoherentCluster {
  eastM: number;
  northM: number;
  samples: number;
  offsetM: [number, number];
  distanceM: number;
}

export interface FloorRegistration {
  canonicalLevelId: string;
  compositeSourceLevels: string[];
  sampled: number;
  carvedOut: number;
  /**
   * `null` when no sample survived the carve-out. Zeroed statistics read as
   * perfect agreement, which is the opposite of what no samples mean — so the
   * absence is in the type, and every consumer has to answer for it.
   */
  stats: ResidualStats | null;
  medianOffsetM: [number, number];
  medianShiftM: number;
  coherentClusters: CoherentCluster[];
}

export interface TileRegistrationReport {
  profileId: string;
  profileVersion: number;
  levels: TileLevelRegistration[];
  floors: FloorRegistration[];
  unmappedLevels: string[];
  /**
   * Levels with more than one candidate floor inside the match tolerance. The
   * tolerance is wider than some floor-to-floor gaps, so nearest-wins would be a
   * guess wearing a mapping's clothes.
   */
  ambiguousLevels: string[];
  appliedVerticalOffsetM: number;
  venueWide: ResidualStats | null;
}

/** One blocked gate: what failed, on what, and against which number. */
export interface TileActivationGate {
  code: string;
  subject: string;
  measured: number | null;
  band: number | null;
}

export interface TileActivationEvaluation {
  report: TileRegistrationReport;
  /** Canonical floor → the composite tile levels it renders. */
  floorMappings: [string, string[]][];
  /** Empty exactly when the package may be activated. */
  gates: TileActivationGate[];
}

/**
 * An activation evaluation that could not be produced at all — a bundle or
 * content that would not decode, a venue with no §8 frame to measure in, or a
 * malformed native response. A package that fails its *gates* is not an error:
 * that is the evaluation's answer, and it comes back in `gates`.
 */
export class CoreTileActivationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoreTileActivationError";
  }
}

function parseActivationEvaluation(evaluationJson: unknown): TileActivationEvaluation {
  if (typeof evaluationJson !== "string") {
    throw new CoreTileActivationError("bridge_error", "native activation returned no evaluation");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(evaluationJson);
  } catch {
    throw new CoreTileActivationError("bridge_error", "native activation evaluation was not JSON");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new CoreTileActivationError(
      "bridge_error",
      "native activation evaluation was not an object",
    );
  }
  const value = parsed as Record<string, unknown>;
  const report = value["report"];
  const gates = value["gates"];
  const floorMappings = value["floorMappings"];
  if (
    report === null ||
    typeof report !== "object" ||
    !Array.isArray(gates) ||
    !Array.isArray(floorMappings)
  ) {
    throw new CoreTileActivationError(
      "bridge_error",
      "native activation evaluation was malformed",
    );
  }
  const record = report as Record<string, unknown>;
  if (
    typeof record["profileId"] !== "string" ||
    typeof record["profileVersion"] !== "number" ||
    !Array.isArray(record["levels"]) ||
    !Array.isArray(record["floors"]) ||
    !Array.isArray(record["unmappedLevels"])
  ) {
    throw new CoreTileActivationError("bridge_error", "native activation report was malformed");
  }
  for (const gate of gates) {
    if (
      gate === null ||
      typeof gate !== "object" ||
      typeof (gate as Record<string, unknown>)["code"] !== "string" ||
      typeof (gate as Record<string, unknown>)["subject"] !== "string"
    ) {
      throw new CoreTileActivationError("bridge_error", "an activation gate was malformed");
    }
  }
  return parsed as TileActivationEvaluation;
}

/**
 * Measure an ingested tile package against a venue version's own compiled
 * bundle and apply the versioned profile's bands. `contents` is every content
 * member of the package's tileset graph, evaluated as one asset.
 *
 * Resolves with the evaluation whether or not the package may be activated —
 * `gates` is empty exactly when it may. Throws `CoreTileActivationError` only
 * when no evaluation could be produced.
 */
export async function evaluateTileActivation(
  bundle: Buffer,
  contents: Buffer[],
  request: TileActivationRequest,
  nativeEvaluate: NativeTileActivationFn = evaluateTileActivationNative,
): Promise<TileActivationEvaluation> {
  let response: unknown;
  try {
    response = await nativeEvaluate(bundle, contents, JSON.stringify(request));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CoreTileActivationError(
      "bridge_error",
      `native activation bridge failed: ${message}`,
    );
  }
  if (response === null || typeof response !== "object" || !("ok" in response)) {
    throw new CoreTileActivationError("bridge_error", "native activation response was malformed");
  }
  if (response.ok !== true) {
    const errorJson = "errorJson" in response ? response.errorJson : undefined;
    if (typeof errorJson !== "string") {
      throw new CoreTileActivationError("bridge_error", "native activation returned no reason");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(errorJson);
    } catch {
      throw new CoreTileActivationError("bridge_error", "native activation reason was not JSON");
    }
    const reason = parsed as { code?: unknown; message?: unknown };
    if (typeof reason.code !== "string" || reason.code === "") {
      throw new CoreTileActivationError("bridge_error", "native activation reason had no code");
    }
    throw new CoreTileActivationError(
      reason.code,
      typeof reason.message === "string" ? reason.message : `activation refused: ${reason.code}`,
    );
  }
  return parseActivationEvaluation("evaluationJson" in response ? response.evaluationJson : undefined);
}

/**
 * `@kiriko/node`'s raw tile-scene bridge contract. Treated as untrusted FFI
 * output — validated before use.
 */
export type NativeTileSceneFn = (
  bundle: Buffer,
  contents: Buffer[],
  requestJson: string,
) => Promise<unknown>;

/** How a producer classified an unassigned source object (#32 section 6). */
export type SceneOcclusionClass = "never" | "protected_corridor" | "context";

export interface TileSceneRequest {
  assetVersion: string;
  /** The published tileset root transform, column-major, applied unchanged. */
  rootTransform: number[];
  /** Identity of the derived document — the package's own content address. */
  sourceHash: string;
  /** Composite level identity → canonical floor id. */
  floorMappings: Record<string, string>;
  /** Source object id → canonical venue feature id. */
  sourceObjectAssociations?: Record<string, string>;
  /** Source object id → the producer's occlusion policy for it. */
  contextualClassifications?: Record<string, SceneOcclusionClass>;
}

/** A render document that could not be derived. */
export class CoreTileSceneError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoreTileSceneError";
  }
}

/** The container magic a freshly derived document starts with. */
const SCENE_MAGIC = Buffer.from("KSC2", "ascii");

/**
 * Derive an activated package's render document: the same `KSC2` format the
 * generated scene compiles to, so the renderer consumes both unchanged.
 *
 * Called once, at activation. A 172 MiB package cannot be re-derived per
 * request, and the bytes belong to the version the activation produced — which
 * is what lets a pinned URL promise they never change.
 */
export async function deriveTileScene(
  bundle: Buffer,
  contents: Buffer[],
  request: TileSceneRequest,
  nativeDerive: NativeTileSceneFn = deriveTileSceneNative,
): Promise<Buffer> {
  let response: unknown;
  try {
    response = await nativeDerive(bundle, contents, JSON.stringify(request));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CoreTileSceneError("bridge_error", `native derive bridge failed: ${message}`);
  }
  if (response === null || typeof response !== "object" || !("ok" in response)) {
    throw new CoreTileSceneError("bridge_error", "native derive response was malformed");
  }
  if (response.ok !== true) {
    const errorJson = "errorJson" in response ? response.errorJson : undefined;
    if (typeof errorJson !== "string") {
      throw new CoreTileSceneError("bridge_error", "native derive returned no reason");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(errorJson);
    } catch {
      throw new CoreTileSceneError("bridge_error", "native derive reason was not JSON");
    }
    const reason = parsed as { code?: unknown; message?: unknown };
    if (typeof reason.code !== "string" || reason.code === "") {
      throw new CoreTileSceneError("bridge_error", "native derive reason had no code");
    }
    throw new CoreTileSceneError(
      reason.code,
      typeof reason.message === "string" ? reason.message : `derive refused: ${reason.code}`,
    );
  }
  const scene = "scene" in response ? response.scene : undefined;
  if (!Buffer.isBuffer(scene) || !scene.subarray(0, 4).equals(SCENE_MAGIC)) {
    // The bytes go straight into the blob store and out to viewers; a
    // container that is not the current KSC version would be served as one.
    // Packages activated before `KSC2` keep their stored `KSC1` bytes, which
    // the reader still decodes; nothing may *write* an older container.
    throw new CoreTileSceneError("bridge_error", "native derive returned no KSC2 document");
  }
  return scene;
}
