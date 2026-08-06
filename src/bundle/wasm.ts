/**
 * Kiriko `kvb1` bundle decoder: a thin, typed wrapper over the generated
 * `@kiriko/wasm` package. `initKirikoWasm` performs the module's single
 * required asynchronous initialization (idempotent — safe to call from
 * every call site); `decodeBundle` is synchronous and callable any time
 * after that promise has resolved.
 *
 * Phase Two Task 4: WASM decode adapter (browser side).
 */
import init, {
  decodeBundle as decodeBundleWasm,
  routeBundle as routeBundleWasm,
  facilities as facilitiesWasm,
  exportNetwork as exportNetworkWasm,
  levelElevations as levelElevationsWasm,
  sceneProjection as sceneProjectionWasm,
  generatedScene as generatedSceneWasm,
  decodeScene as decodeSceneWasm,
} from "@kiriko/wasm";
// Vite emits a hashed, origin-relative asset path (e.g.
// `/assets/kiriko_wasm_bg-[hash].wasm`) for this `?url` import. Resolving
// it explicitly here — instead of letting `@kiriko/wasm`'s generated glue
// re-resolve `kiriko_wasm_bg.wasm` against its own `import.meta.url` — is
// what makes instantiation work inside a Vite **inline** worker, where
// `import.meta.url` is a `blob:` URL and `new URL(path, "blob:...")` throws.
import wasmAssetUrl from "@kiriko/wasm/pkg/kiriko_wasm_bg.wasm?url";
import type { readFile as ReadFileFn } from "node:fs/promises";

export type BoundsTuple = [west: number, south: number, east: number, north: number];

export interface DecodedManifestDto {
  version: string;
  language: string;
  rest: Record<string, unknown>;
}

export interface DecodedLevelDto {
  id: string;
  ordinal: number;
  label: Record<string, string>;
  shortName: Record<string, string>;
}

export interface DecodedFeatureDto {
  id: string;
  featureType: string;
  levelId: string | null;
  geometry: GeoJSON.Geometry | null;
  center: [number, number] | null;
  labels: Record<string, string>;
  altLabels: Record<string, string>;
  category: string | null;
  accessibility: string[];
  restriction: string | null;
  sourceProperties: Record<string, unknown>;
}

export interface DecodedWarningDto {
  code: string;
  message: string;
  featureId: string | null;
  archiveEntry: string | null;
}

export interface DecodedVenueDto {
  datasetId: string;
  version: number;
  venueId: string;
  manifest: DecodedManifestDto;
  levels: DecodedLevelDto[];
  features: DecodedFeatureDto[];
  boundsByLevel: [string, BoundsTuple][];
  warnings: DecodedWarningDto[];
  stats: { levels: number; features: number };
}

/** The four stable `kvb1` bundle-codec error codes (see `kiriko-bundle`). */
export type BundleErrorCode =
  | "invalid_bundle"
  | "unsupported_bundle_version"
  | "bundle_integrity_failed"
  | "bundle_too_large";

/**
 * Why one optional section's capability is unavailable, or that it is
 * available. Carries a discriminated state plus numbers rather than prose, so
 * the UI renders its own ja/en copy — the same division as `ViewerWarning`
 * codes.
 *
 * `absent` and the failure states are deliberately distinct: a venue that has
 * no graph is not the same as a venue whose graph cannot be read, and they are
 * presented differently.
 */
export type SectionCapability =
  | { state: "available" }
  | { state: "absent" }
  | { state: "unsupportedVersion"; declared: number; supported: number }
  | { state: "invalid"; reason: string }
  | { state: "disabledByDependency"; requires: number };

/**
 * Per-section availability for one decoded bundle. Carries the shipping
 * optional sections (§5 graph, §7 facilities, §8 spatial context) plus the
 * three *declared* future sections (§9 scene sources, §10 canonical graph,
 * §11 network QA) whose ids and dependency edges are format facts before
 * their decoders arrive. The declared sections' outcomes come from the
 * directory row and the §8 dependency edge; a present one whose requirement
 * is unavailable reports `disabledByDependency` naming it.
 */
export interface CapabilityReportDto {
  graph: SectionCapability;
  facilities: SectionCapability;
  spatialContext: SectionCapability;
  sceneSources: SectionCapability;
  canonicalGraph: SectionCapability;
  networkQa: SectionCapability;
}

export interface DecodeResponseDto {
  ok: boolean;
  venue: DecodedVenueDto | null;
  error: { code: BundleErrorCode; message: string } | null;
  /** Whether the decoded bundle carries a §5 network graph (routing UI gate). */
  hasGraph: boolean;
  /** Whether the decoded bundle carries a §7 facilities section (marker UI gate). */
  hasFacilities: boolean;
  /**
   * Why an optional section is unavailable, which `hasGraph`/`hasFacilities`
   * cannot express. `null` when the bundle failed to decode at all.
   */
  capabilities: CapabilityReportDto | null;
}

/** A facility's routing anchor: the network node it snaps to, when linked. */
export interface FacilityAnchorDto {
  lon: number;
  lat: number;
  ordinal: number;
}

/** One point facility as serialized by the wasm `facilities` binding. */
export interface FacilityDto {
  lon: number;
  lat: number;
  ordinal: number;
  name: string;
  icon: string;
  anchor: FacilityAnchorDto | null;
}

/**
 * One level's elevation answer as serialized by the wasm `levelElevations`
 * binding. `resolved` is a §8-backed plane (with its resolved Z and method);
 * `legacyUnknown` is the honest answer for a bundle published before §8
 * existed — it carries no confidence and no number, so a reviewer sees "we
 * do not know this" rather than a value that looks measured.
 */
export type LevelElevationDto =
  | {
      levelId: string;
      ordinal: number;
      state: "resolved";
      resolvedSceneZMm: number;
      method: "imported_elevation" | "network_altitude" | "nominal_spacing";
    }
  | {
      levelId: string;
      ordinal: number;
      state: "legacyUnknown";
      resolvedSceneZMm: null;
      method: null;
    };

/** One floor-grouped run of the route polyline. */
export interface RouteSegmentDto {
  ordinal: number;
  coordinates: [number, number][];
}

/** A routing endpoint: lon/lat plus the level ordinal the point was picked on. */
export interface RouteEndpoint {
  longitude: number;
  latitude: number;
  ordinal: number;
}

/** Computed route: corridor polyline segments, total edge weight, and the
 *  origin/destination projected onto the network ([lon, lat, ordinal]). */
export interface RouteResultDto {
  segments: RouteSegmentDto[];
  totalWeight: number;
  originProjected: [number, number, number];
  destProjected: [number, number, number];
}

let initPromise: Promise<void> | null = null;

/**
 * In a real browser, the WASM asset URL is resolved explicitly (see
 * `resolveWasmUrl`) and passed to `init()`, because `@kiriko/wasm`'s
 * generated glue would otherwise resolve `kiriko_wasm_bg.wasm` against its
 * own `import.meta.url` — which is a `blob:` URL inside a Vite inline
 * worker, where `new URL(path, blobUrl)` throws. Under Vitest/Node there is
 * no HTTP origin to fetch from — Node's `fetch` does not support `file:`
 * URLs — so the module bytes are read from disk and instantiated directly.
 */
async function initFromDisk(): Promise<void> {
  // `node:fs/promises` only exists under Node.js and must never enter the
  // browser bundle graph; loading it dynamically (guarded by
  // `isNodeRuntime`) keeps it out of the client build entirely.
  const nodeFsSpecifier = "node:fs/promises";
  const { readFile } = (await import(/* @vite-ignore */ nodeFsSpecifier)) as { readFile: typeof ReadFileFn };
  const wasmUrl = new URL("kiriko_wasm_bg.wasm", import.meta.resolve("@kiriko/wasm/pkg/kiriko_wasm.js"));
  const bytes = await readFile(wasmUrl);
  await init({ module_or_path: bytes });
}

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && process.versions?.node != null;
}
/**
 * Resolves the imported WASM asset path to an absolute URL the generated
 * `@kiriko/wasm` glue can `fetch`. Vite's `?url` import is always emitted
 * as a root-relative path (`/assets/kiriko_wasm_bg-[hash].wasm`) or an
 * already-absolute URL, so resolving it against the page origin is correct
 * in both normal modules and Vite **inline** workers. (An inline worker's
 * `import.meta.url` is a `blob:` URL, against which `new URL(path, blobUrl)`
 * throws `TypeError: Invalid URL`; the worker still inherits its creator
 * origin through `globalThis.location`.)
 */
function resolveWasmUrl(): URL {
  return new URL(wasmAssetUrl, globalThis.location.origin);
}

/**
 * Instantiates the Kiriko WASM decoder module. Idempotent: every caller
 * (including every worker instance, and every test) can call this
 * unconditionally; the underlying WASM module is only instantiated once.
 * The same function works under both a real browser (Vite) and Vitest/Node
 * — see `initFromDisk` / `resolveWasmUrl`.
 */
export async function initKirikoWasm(): Promise<void> {
  initPromise ??= isNodeRuntime() ? initFromDisk() : init({ module_or_path: resolveWasmUrl() }).then(() => undefined);
  await initPromise;
}

/**
 * Decodes a `kvb1` bundle. Must only be called after `initKirikoWasm` has
 * resolved. Never throws for domain (bundle-format) failures — inspect
 * `response.ok`/`response.error` instead.
 */
export function decodeBundle(bytes: Uint8Array): DecodeResponseDto {
  return decodeBundleWasm(bytes) as DecodeResponseDto;
}

/**
 * Routes over a `kvb1` bundle's embedded §5 graph. Must only be called after
 * `initKirikoWasm` has resolved. Returns `null` when the bundle carries no
 * graph or no path connects the snapped endpoints. Unlike `decodeBundle`,
 * bundle-format failures throw (the wasm binding's contract) — callers must
 * treat a throw as a runtime failure, never surface the raw message.
 */
export function routeBundle(
  bytes: Uint8Array,
  origin: RouteEndpoint,
  destination: RouteEndpoint,
): RouteResultDto | null {
  return routeBundleWasm(
    bytes,
    origin.longitude,
    origin.latitude,
    origin.ordinal,
    destination.longitude,
    destination.latitude,
    destination.ordinal,
  ) as RouteResultDto | null;
}

/**
 * Reads the point facilities embedded in a `kvb1` bundle's §7 section. Must
 * only be called after `initKirikoWasm` has resolved. Returns an empty array
 * when the bundle carries no facilities section.
 */
export function facilities(bytes: Uint8Array): FacilityDto[] {
  return facilitiesWasm(bytes) as FacilityDto[];
}

/**
 * Lists one elevation answer per level: `resolved` (with the §8-backed
 * resolved Z and method) or `legacyUnknown` for a bundle published before §8
 * existed. Must only be called after `initKirikoWasm` has resolved. Throws
 * when the bundle fails to decode.
 */
export function levelElevations(bytes: Uint8Array): LevelElevationDto[] {
  return levelElevationsWasm(bytes) as LevelElevationDto[];
}

// -- Scene projection (Stage 1: scene-source adapter) ----------------------

/** Which scene source produced a projection. */
export type SceneSourceKindDto = "generated" | "tiles";

/** Immutable scene-source identity and provenance. */
export interface SceneSourceIdentityDto {
  kind: SceneSourceKindDto;
  provenance: string;
}

/** The venue-local scene frame and world transform, from §8. */
export interface SceneFrameProjectionDto {
  anchor: [number, number];
  ecefOrigin: [number, number, number];
  enuBasisEcef: [[number, number, number], [number, number, number], [number, number, number]];
  axes: string;
  unit: string;
  verticalNormalisationOffsetMm: number;
}

/** One canonical level group: resolved plane, scene bounds, source membership. */
export interface SceneLevelProjectionDto {
  levelId: string;
  ordinal: number;
  resolvedSceneZMm: number;
  boundsMm: [number, number, number, number] | null;
  sourceLevels: string[];
}

/** A primitive's confidence class and value. */
export interface SceneConfidenceProjectionDto {
  kind: string;
  value: number;
}

/** A primitive's evidence summary. */
export interface SceneEvidenceProjectionDto {
  method: string;
  detail: string;
}

/** One primitive as the renderer sees it. */
export interface ScenePrimitiveProjectionDto {
  id: string;
  role: "surface" | "wall" | "ceiling" | "portal" | "conveyance";
  levelId: string;
  occlusion: "opaque" | "semi_transparent" | "transparent";
  confidence: SceneConfidenceProjectionDto;
  canonicalFeatureId: string | null;
  sourceObjectIds: string[];
  conveyanceKind: "neutral" | "source_evidenced" | null;
  evidence: SceneEvidenceProjectionDto[];
}

/** Readiness, capability, and structured failure — typed, not prose. */
export type SceneCapabilityStateDto =
  | { state: "ready" }
  | { state: "absent" }
  | { state: "invalid"; reason: string }
  | { state: "unsupportedVersion"; declared: number; supported: number }
  | { state: "disabledByDependency"; requires: number };

/** The full typed scene projection for one bundle. */
export interface SceneProjectionDto {
  identity: SceneSourceIdentityDto;
  frame: SceneFrameProjectionDto | null;
  levels: SceneLevelProjectionDto[];
  primitives: ScenePrimitiveProjectionDto[];
  capability: SceneCapabilityStateDto;
}

/**
 * Projects the Generated scene source of a `kvb1` bundle: identity, frame,
 * level groups, primitives with roles/occlusion/confidence/associations, and
 * the typed capability state. TypeScript never decodes section bytes or
 * resolves elevation — this is the renderer-neutral projection both Generated
 * and Tiles (Stage 3) provide. Must only be called after `initKirikoWasm` has
 * resolved. Throws when the bundle fails to decode.
 */
export function sceneProjection(bytes: Uint8Array): SceneProjectionDto {
  return sceneProjectionWasm(bytes) as SceneProjectionDto;
}

/**
 * A render document as the wasm hands it over: a JSON description plus one
 * packed payload the caller builds typed-array views over. Both scene sources
 * arrive in this shape — a bundle's generated §9 scene through
 * `generatedScene`, a server-derived tile package through `decodeScene` —
 * so the renderer never learns which produced it (#23 D4).
 */
export interface DescribedSceneDto {
  /** JSON description: header, levels, features, and per-batch byte offsets. */
  meta: string;
  /** Concatenated batch geometry: positions (u16 x3), normals (i16 x2), feature indices (u32). */
  payload: Uint8Array;
}

/**
 * Compile a bundle's generated §9 scene into the shared render document. Must
 * only be called after `initKirikoWasm` has resolved. Throws when the bundle
 * carries no scene or no spatial context — a venue without 3D data is not an
 * error state the renderer guesses around, it is the absent capability the
 * scene projection already reports.
 */
export function generatedScene(bytes: Uint8Array): DescribedSceneDto {
  const decoded = generatedSceneWasm(bytes);
  return { meta: decoded.meta, payload: decoded.payload };
}

/**
 * Read an already-derived `.kscene` package (the Tiles source's path, Stage
 * 3). Must only be called after `initKirikoWasm` has resolved.
 */
export function decodeScene(bytes: Uint8Array): DescribedSceneDto {
  const decoded = decodeSceneWasm(bytes);
  return { meta: decoded.meta, payload: decoded.payload };
}

/** The two network feature classes as GeoJSON `FeatureCollection` text. */
export interface NetworkGeoJsonDto {
  junctions: string;
  paths: string;
}

/**
 * Serialize a bundle's §5 routing graph to `net_junction` / `net_path`
 * GeoJSON for floor-by-floor review rendering. Must only be called after
 * `initKirikoWasm` has resolved. Throws when the bundle carries no graph.
 */
export function exportNetwork(bytes: Uint8Array): NetworkGeoJsonDto {
  return exportNetworkWasm(bytes) as NetworkGeoJsonDto;
}
