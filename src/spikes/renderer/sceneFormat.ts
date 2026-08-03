/**
 * `.kscene` decode path for the spike renderer (3D rendering spike Task 4).
 *
 * The wasm `decodeScene` export splits a scene document into a JSON `meta`
 * description plus one packed binary `payload`. `loadScene` parses the meta,
 * copies the payload into a fresh 4-byte-aligned `ArrayBuffer`, and exposes
 * typed-array views (u16 positions, i16 octahedral normals, u32 feature
 * indices) per batch using the byte offsets in the meta — so rendering never
 * re-parses geometry and never widens a decoded role string to `string`.
 *
 * Disposable spike code: never imported by production modules.
 */
import init, { decodeScene as decodeSceneWasm } from "@kiriko/wasm";
// Vite emits a hashed, origin-relative asset path for `?url` imports;
// resolving it explicitly (see `resolveWasmUrl`) is what makes instantiation
// work in a Vite inline worker, where `import.meta.url` is a `blob:` URL.
// Pattern follows `src/bundle/wasm.ts`.
import wasmAssetUrl from "@kiriko/wasm/pkg/kiriko_wasm_bg.wasm?url";
import type { readFile as ReadFileFn } from "node:fs/promises";

/** The twelve semantic roles (issue #32), spelled exactly as the wasm
 *  `Debug`-serialized strings arrive ("Walkable", "Public", …). */
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
  | "Context";

/** Occlusion classes, likewise `Debug`-serialized by the wasm export. */
export type OcclusionClassName = "Never" | "ProtectedCorridor" | "Context";

export interface SceneHeaderView {
  formatVersion: number;
  deriverVersion: number;
  sourceHash: string;
  frameOriginEcef: readonly [number, number, number];
  worldTransform: readonly [
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
  ];
  boundsMin: readonly [number, number, number];
  boundsMax: readonly [number, number, number];
}

export interface SceneLevelView {
  canonicalId: string;
  sourceLevelKey: string;
  sourceLevelName: string;
  sourceElevationMeters: number;
  resolvedPlaneZ: number;
  quantizedElevationDm: number;
}

export interface SceneFeatureView {
  sourceObjectId: string;
  canonicalId: string | null;
  levelIndex: number;
  role: SemanticRoleName;
  occlusion: OcclusionClassName;
  minZ: number;
  maxZ: number;
}

/** One merged batch: quantization frame plus typed views into the shared
 *  payload buffer. Field names are load-bearing — Task 5 consumes this type
 *  unchanged. */
export interface SceneBatchView {
  levelIndex: number;
  role: SemanticRoleName;
  quantizationOrigin: readonly [number, number, number];
  quantizationScale: readonly [number, number, number];
  vertexCount: number;
  positions: Uint16Array;
  normals: Int16Array;
  featureIndices: Uint32Array;
}

export interface SceneView {
  header: SceneHeaderView;
  levels: readonly SceneLevelView[];
  features: readonly SceneFeatureView[];
  batches: readonly SceneBatchView[];
}

/** Raw JSON shape of the wasm `meta` string (offsets are payload bytes). */
interface SceneMeta {
  header: {
    formatVersion: number;
    deriverVersion: number;
    sourceHash: string;
    frameOriginEcef: [number, number, number];
    worldTransform: [
      number, number, number, number,
      number, number, number, number,
      number, number, number, number,
      number, number, number, number,
    ];
    boundsMin: [number, number, number];
    boundsMax: [number, number, number];
  };
  levels: Array<{
    canonicalId: string;
    sourceLevelKey: string;
    sourceLevelName: string;
    sourceElevationMeters: number;
    resolvedPlaneZ: number;
    quantizedElevationDm: number;
  }>;
  features: Array<{
    sourceObjectId: string;
    canonicalId: string | null;
    levelIndex: number;
    role: string;
    occlusion: string;
    minZ: number;
    maxZ: number;
  }>;
  batches: Array<{
    levelIndex: number;
    role: string;
    quantizationOrigin: [number, number, number];
    quantizationScale: [number, number, number];
    vertexCount: number;
    positionsOffset: number;
    normalsOffset: number;
    featureIndicesOffset: number;
  }>;
}

const SEMANTIC_ROLES: ReadonlySet<string> = new Set([
  "Walkable", "Public", "Service", "Restricted", "Structure", "Ceiling",
  "Opening", "Elevator", "Escalator", "Stairs", "Ramp", "Context",
]);

const OCCLUSION_CLASSES: ReadonlySet<string> = new Set([
  "Never", "ProtectedCorridor", "Context",
]);

function semanticRole(value: string): SemanticRoleName {
  if (!SEMANTIC_ROLES.has(value)) {
    throw new Error(`unknown semantic role "${value}" in scene meta`);
  }
  return value as SemanticRoleName;
}

function occlusionClass(value: string): OcclusionClassName {
  if (!OCCLUSION_CLASSES.has(value)) {
    throw new Error(`unknown occlusion class "${value}" in scene meta`);
  }
  return value as OcclusionClassName;
}

let initPromise: Promise<void> | null = null;

/**
 * Under Vitest/Node there is no HTTP origin to fetch from, so the module
 * bytes are read from disk and instantiated directly. Same path as
 * `src/bundle/wasm.ts`.
 */
async function initFromDisk(): Promise<void> {
  // `node:fs/promises` only exists under Node.js and must never enter the
  // browser bundle graph; the dynamic import (guarded by `isNodeRuntime`)
  // keeps it out of the client build entirely.
  const nodeFsSpecifier = "node:fs/promises";
  const { readFile } = (await import(/* @vite-ignore */ nodeFsSpecifier)) as { readFile: typeof ReadFileFn };
  const wasmUrl = new URL("kiriko_wasm_bg.wasm", import.meta.resolve("@kiriko/wasm/pkg/kiriko_wasm.js"));
  const bytes = await readFile(wasmUrl);
  await init({ module_or_path: bytes });
}

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && process.versions?.node != null;
}

/** In a real browser, resolve the `?url` asset against the page origin. */
function resolveWasmUrl(): URL {
  return new URL(wasmAssetUrl, globalThis.location.origin);
}

/**
 * Instantiates the wasm module once, idempotently, under both a browser
 * (Vite) and Vitest/Node — mirroring `src/bundle/wasm.ts`.
 */
async function initSceneWasm(): Promise<void> {
  initPromise ??= isNodeRuntime() ? initFromDisk() : init({ module_or_path: resolveWasmUrl() }).then(() => undefined);
  await initPromise;
}

/**
 * Decode a `.kscene` byte stream into a `SceneView` of typed batch views.
 * The payload copy lands in a fresh `ArrayBuffer` so every per-batch offset
 * is aligned relative to a 4-byte-aligned base; misaligned or out-of-range
 * offsets throw a descriptive `Error` instead of silently truncating a view.
 */
export async function loadScene(bytes: Uint8Array): Promise<SceneView> {
  await initSceneWasm();
  const decoded = decodeSceneWasm(bytes);
  const meta = JSON.parse(decoded.meta) as SceneMeta;

  const buffer = new ArrayBuffer(decoded.payload.byteLength);
  new Uint8Array(buffer).set(decoded.payload);

  const batches = meta.batches.map((batch) => {
    const positionsBytes = batch.vertexCount * 3 * Uint16Array.BYTES_PER_ELEMENT;
    const normalsBytes = batch.vertexCount * 2 * Int16Array.BYTES_PER_ELEMENT;
    const featureIndicesBytes = batch.vertexCount * Uint32Array.BYTES_PER_ELEMENT;
    if (batch.positionsOffset % Uint16Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error(`misaligned positions offset ${batch.positionsOffset} for batch role ${batch.role}`);
    }
    if (batch.normalsOffset % Int16Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error(`misaligned normals offset ${batch.normalsOffset} for batch role ${batch.role}`);
    }
    if (batch.featureIndicesOffset % Uint32Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error(`misaligned feature indices offset ${batch.featureIndicesOffset} for batch role ${batch.role}`);
    }
    if (batch.positionsOffset + positionsBytes > buffer.byteLength) {
      throw new Error(`positions view for batch role ${batch.role} exceeds payload`);
    }
    if (batch.normalsOffset + normalsBytes > buffer.byteLength) {
      throw new Error(`normals view for batch role ${batch.role} exceeds payload`);
    }
    if (batch.featureIndicesOffset + featureIndicesBytes > buffer.byteLength) {
      throw new Error(
        `feature indices view for batch role ${batch.role} exceeds payload: offset ${batch.featureIndicesOffset} + ${featureIndicesBytes} bytes > ${buffer.byteLength}`,
      );
    }
    return {
      levelIndex: batch.levelIndex,
      role: semanticRole(batch.role),
      quantizationOrigin: batch.quantizationOrigin,
      quantizationScale: batch.quantizationScale,
      vertexCount: batch.vertexCount,
      positions: new Uint16Array(buffer, batch.positionsOffset, batch.vertexCount * 3),
      normals: new Int16Array(buffer, batch.normalsOffset, batch.vertexCount * 2),
      featureIndices: new Uint32Array(buffer, batch.featureIndicesOffset, batch.vertexCount),
    };
  });

  return {
    header: {
      formatVersion: meta.header.formatVersion,
      deriverVersion: meta.header.deriverVersion,
      sourceHash: meta.header.sourceHash,
      frameOriginEcef: meta.header.frameOriginEcef,
      worldTransform: meta.header.worldTransform,
      boundsMin: meta.header.boundsMin,
      boundsMax: meta.header.boundsMax,
    },
    levels: meta.levels.map((level) => ({
      canonicalId: level.canonicalId,
      sourceLevelKey: level.sourceLevelKey,
      sourceLevelName: level.sourceLevelName,
      sourceElevationMeters: level.sourceElevationMeters,
      resolvedPlaneZ: level.resolvedPlaneZ,
      quantizedElevationDm: level.quantizedElevationDm,
    })),
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
