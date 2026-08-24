/**
 * The renderer's scene reader: turns a described render document into typed
 * array views the GL layer uploads directly.
 *
 * Both scene sources arrive here in the same shape — a venue bundle's
 * generated §9 scene, or (Stage 3) a server-derived tile package — so nothing
 * downstream of this module can tell them apart. That is the point: one render
 * format means one renderer and one visual language, and a source cannot fork
 * either (#23 D4).
 *
 * TypeScript never interprets section bytes, source-property keys, or
 * elevation. Semantic roles, occlusion policy, resolved planes, and
 * confidence all arrive already decided by the Rust producer; this module only
 * builds views over them.
 */
import { decodeScene, generatedScene, type DescribedSceneDto } from "../../bundle/wasm";

/**
 * The thirteen semantic roles of the visual language, spelled as the Rust
 * producer serializes them. `Conveyance` is a conveyance whose transport type
 * the source never evidenced — the never-guess rule keeps it untyped rather
 * than promoting it to an escalator.
 */
export type SemanticRoleName =
  | "Walkable"
  | "Public"
  | "Service"
  | "Restricted"
  | "Structure"
  | "Ceiling"
  | "Opening"
  | "Elevator"
  | "Escalator"
  | "Stairs"
  | "Ramp"
  | "Context"
  | "Conveyance"
  | "TicketGate";

/** Whether an object may fade for the camera (#32 section 6). */
export type OcclusionClassName = "Never" | "ProtectedCorridor" | "Context";

export interface SceneHeaderView {
  formatVersion: number;
  deriverVersion: number;
  /** Identity of the compiled input — usable as a cache key. */
  sourceHash: string;
  /** ECEF translation of the venue-local frame origin, double precision. */
  frameOriginEcef: readonly [number, number, number];
  /** Column-major 4x4 world transform: ENU basis columns, ECEF translation. */
  worldTransform: readonly number[];
  boundsMin: readonly [number, number, number];
  boundsMax: readonly [number, number, number];
}

export interface SceneLevelView {
  canonicalId: string;
  /** Empty for the generated source: it has no composite source level. */
  sourceLevelKey: string;
  sourceLevelName: string;
  /** `null` when the source carries no elevation for this level. */
  sourceElevationMeters: number | null;
  /** Venue-local metres — the plane the renderer draws this floor on. */
  resolvedPlaneZ: number;
  quantizedElevationDm: number;
}

export interface SceneFeatureView {
  /** The pick handle: what a feature-ID hit resolves to. */
  sourceObjectId: string;
  /** The canonical venue feature, when this object represents one. */
  canonicalId: string | null;
  levelIndex: number;
  role: SemanticRoleName;
  occlusion: OcclusionClassName;
  minZ: number;
  maxZ: number;
}

/**
 * One merged `(level, role)` batch: the quantization frame plus typed views
 * into the shared payload buffer. Restoring a position is
 * `origin + quantized * scale`, done on the GPU from the two uniforms.
 */
export interface SceneBatchView {
  levelIndex: number;
  role: SemanticRoleName;
  quantizationOrigin: readonly [number, number, number];
  quantizationScale: readonly [number, number, number];
  vertexCount: number;
  /** `u16 x3` per vertex. */
  positions: Uint16Array;
  /** Octahedral-encoded `i16 x2` per vertex. */
  normals: Int16Array;
  /** Index into `features` per vertex. */
  featureIndices: Uint32Array;
}

export interface SceneView {
  header: SceneHeaderView;
  levels: readonly SceneLevelView[];
  features: readonly SceneFeatureView[];
  batches: readonly SceneBatchView[];
}

/** Raw JSON shape of the wasm description; offsets are payload byte offsets. */
interface SceneMeta {
  header: {
    formatVersion: number;
    deriverVersion: number;
    sourceHash: string;
    frameOriginEcef: [number, number, number];
    worldTransform: number[];
    boundsMin: [number, number, number];
    boundsMax: [number, number, number];
  };
  levels: {
    canonicalId: string;
    sourceLevelKey: string;
    sourceLevelName: string;
    sourceElevationMeters: number | null;
    resolvedPlaneZ: number;
    quantizedElevationDm: number;
  }[];
  features: {
    sourceObjectId: string;
    canonicalId: string | null;
    levelIndex: number;
    role: string;
    occlusion: string;
    minZ: number;
    maxZ: number;
  }[];
  batches: {
    levelIndex: number;
    role: string;
    quantizationOrigin: [number, number, number];
    quantizationScale: [number, number, number];
    vertexCount: number;
    positionsOffset: number;
    normalsOffset: number;
    featureIndicesOffset: number;
  }[];
}

const SEMANTIC_ROLES: Record<SemanticRoleName, true> = {
  Walkable: true,
  Public: true,
  Service: true,
  Restricted: true,
  Structure: true,
  Ceiling: true,
  Opening: true,
  Elevator: true,
  Escalator: true,
  Stairs: true,
  Ramp: true,
  Context: true,
  Conveyance: true,
  TicketGate: true,
};

const OCCLUSION_CLASSES: Record<OcclusionClassName, true> = {
  Never: true,
  ProtectedCorridor: true,
  Context: true,
};

/**
 * An unrecognized role or occlusion class means the producer and this reader
 * disagree about the format. Styling it as a default would silently render
 * unknown geometry as navigable floor, so it fails loudly instead.
 */
function semanticRole(value: string): SemanticRoleName {
  if (!Object.hasOwn(SEMANTIC_ROLES, value)) {
    throw new Error(`scene: unknown semantic role "${value}"`);
  }
  return value as SemanticRoleName;
}

function occlusionClass(value: string): OcclusionClassName {
  if (!Object.hasOwn(OCCLUSION_CLASSES, value)) {
    throw new Error(`scene: unknown occlusion class "${value}"`);
  }
  return value as OcclusionClassName;
}

/**
 * Build typed views over a described scene. The payload is not copied: each
 * batch's positions, normals, and feature indices are views into the same
 * buffer, so uploading a scene costs one decode and no re-parse.
 */
export function readScene(described: DescribedSceneDto): SceneView {
  const meta = JSON.parse(described.meta) as SceneMeta;
  const payload = described.payload;
  const buffer = payload.buffer as ArrayBuffer;
  const base = payload.byteOffset;

  const batches: SceneBatchView[] = meta.batches.map((batch) => {
    const vertexCount = batch.vertexCount;
    return {
      levelIndex: batch.levelIndex,
      role: semanticRole(batch.role),
      quantizationOrigin: batch.quantizationOrigin,
      quantizationScale: batch.quantizationScale,
      vertexCount,
      positions: new Uint16Array(buffer, base + batch.positionsOffset, vertexCount * 3),
      normals: new Int16Array(buffer, base + batch.normalsOffset, vertexCount * 2),
      featureIndices: new Uint32Array(buffer, base + batch.featureIndicesOffset, vertexCount),
    };
  });

  return {
    header: meta.header,
    levels: meta.levels,
    features: meta.features.map((feature) => ({
      sourceObjectId: feature.sourceObjectId,
      canonicalId: feature.canonicalId,
      levelIndex: feature.levelIndex,
      role: semanticRole(feature.role),
      occlusion: occlusionClass(feature.occlusion),
      minZ: feature.minZ,
      maxZ: feature.maxZ,
    })),
    batches,
  };
}

/**
 * Read the generated scene compiled into a venue bundle. Must only be called
 * after `initKirikoWasm` has resolved. Throws when the bundle carries no
 * scene — callers decide that from the scene projection's capability state
 * before asking for geometry.
 */
export function readGeneratedScene(bundleBytes: Uint8Array): SceneView {
  return readScene(generatedScene(bundleBytes));
}

/** Read a server-derived `.kscene` tile package (Stage 3's source). */
export function readDerivedScene(sceneBytes: Uint8Array): SceneView {
  return readScene(decodeScene(sceneBytes));
}

/**
 * How many draw calls a level costs: one per merged batch. The renderer's
 * budget is stated per visible level (#26 section 4), so this is the number
 * the performance harness asserts against.
 */
export function drawCallsForLevel(scene: SceneView, levelIndex: number): number {
  return scene.batches.filter((batch) => batch.levelIndex === levelIndex).length;
}

/**
 * Primitive collapse: source objects per merged batch. The budget floor is
 * 15x on the registered station data (#26 section 4); a small fixture
 * legitimately collapses less because it has fewer objects to merge.
 */
export function primitiveCollapse(scene: SceneView): number {
  if (scene.batches.length === 0) {
    return 0;
  }
  return scene.features.length / scene.batches.length;
}
