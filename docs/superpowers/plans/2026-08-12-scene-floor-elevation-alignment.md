# Scene Floor Elevation Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every active-floor MapLibre overlay on the generated scene's resolved floor plane and retain one automatic, non-pickable context floor while inspecting a cross-floor route.

**Architecture:** A private MapLibre protocol serves cached, solid-color Terrarium DEM tiles keyed by signed millimetres; the initial style owns one internal raster-dem source, and `IndoorMap` attaches it as terrain only while a valid 3D scene floor is active. A pure scene-floor resolver derives active scene indices, one route-context floor, and the single valid active plane. `SceneLayer` keeps transient all-floor handoff separate from persistent route context.

**Tech Stack:** React 19, TypeScript 7 strict mode, MapLibre GL JS 5.24, Vitest, Playwright/browser smoke testing.

## Global Constraints

- `SceneLevel.resolvedPlaneZ` is the only elevation datum; do not derive elevation from IMDF metadata, ordinal, source level names, or a nominal storey height.
- Active composite scene levels must quantize to one signed millimetre plane; absence, non-finite values, or disagreement detaches terrain rather than substituting zero.
- The ordinary 2D view remains unchanged: the raster-dem source may exist in the style, but terrain is `null` whenever no scene is attached.
- Route context contains at most one canonical floor, at the scene's existing `0.22` context opacity, and is never pickable or editable.
- The active floor remains the sole FloorStack selection and the sole MapLibre terrain plane.
- No server, Rust, KVB, persistence, or user-facing copy change. Strict TypeScript; no `any` or type escape hatch.
- Follow TDD: observe the targeted test fail for the intended missing contract before writing each production change.

---

### Task 1: Constant-elevation Terrarium source

**Files:**
- Create: `src/map/scene/floorElevation.ts`
- Create: `src/map/scene/floorElevation.test.ts`
- Modify: `src/map/buildIndoorStyle.ts`
- Modify: `src/map/featureLayers.test.ts`

**Interfaces:**
- Consumes: MapLibre `AddProtocolAction` and `RasterDEMSourceSpecification`.
- Produces:
  - `FLOOR_ELEVATION_PROTOCOL: "kiriko-floor"`
  - `FLOOR_ELEVATION_SOURCE_ID: "kiriko-floor-elevation"`
  - `floorElevationTileUrl(planeM: number): string | null`
  - `floorElevationSource(): RasterDEMSourceSpecification`
  - `createFloorElevationProtocol(encodePng?: FloorTileEncoder): AddProtocolAction`
  - `FloorTileEncoder = (rgb: readonly [number, number, number]) => Promise<ArrayBuffer>`

- [ ] **Step 1: Write failing encoding and protocol tests**

Create `floorElevation.test.ts` with observable numeric, validation, and cache contracts:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createFloorElevationProtocol,
  floorElevationSource,
  floorElevationTileUrl,
  terrariumRgbForMillimetres,
} from "./floorElevation";

describe("floor elevation DEM", () => {
  it("keys finite representable planes by signed millimetres", () => {
    expect(floorElevationTileUrl(8)).toBe("kiriko-floor://8000/{z}/{x}/{y}");
    expect(floorElevationTileUrl(-6.02)).toBe("kiriko-floor://-6020/{z}/{x}/{y}");
    expect(floorElevationTileUrl(Number.NaN)).toBeNull();
    expect(floorElevationTileUrl(40_000)).toBeNull();
  });

  it("encodes Terrarium zero and whole metres exactly", () => {
    expect(terrariumRgbForMillimetres(0)).toEqual([128, 0, 0]);
    expect(terrariumRgbForMillimetres(8_000)).toEqual([128, 8, 0]);
  });

  it("caches one PNG per plane across tile coordinates", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
    const encode = vi.fn(async () => bytes);
    const load = createFloorElevationProtocol(encode);
    const abort = new AbortController();

    const first = await load(
      { url: "kiriko-floor://8000/18/232800/103246" },
      abort,
    );
    const second = await load(
      { url: "kiriko-floor://8000/19/465600/206492" },
      abort,
    );

    expect(first.data).toBe(bytes);
    expect(second.data).toBe(bytes);
    expect(encode).toHaveBeenCalledOnce();
    expect(encode).toHaveBeenCalledWith([128, 8, 0]);
  });

  it("declares a Terrarium raster-dem source", () => {
    expect(floorElevationSource()).toEqual({
      type: "raster-dem",
      tiles: ["kiriko-floor://0/{z}/{x}/{y}"],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 22,
      encoding: "terrarium",
    });
  });
});
```

The `RequestParameters` test values intentionally use only `url`; TypeScript will identify any required fields in MapLibre 5.24. Supply those exact required fields rather than casting.

- [ ] **Step 2: Run the focused test and observe RED**

Run: `pnpm exec vitest run src/map/scene/floorElevation.test.ts`

Expected: FAIL because `./floorElevation` does not exist.

- [ ] **Step 3: Implement bounded millimetre keys and the cached protocol**

Create `floorElevation.ts` with these rules:

```ts
import type {
  AddProtocolAction,
  RasterDEMSourceSpecification,
} from "maplibre-gl";

export const FLOOR_ELEVATION_PROTOCOL = "kiriko-floor";
export const FLOOR_ELEVATION_SOURCE_ID = "kiriko-floor-elevation";
const TILE_SIZE = 256;
const TERRARIUM_OFFSET_M = 32_768;
const TERRARIUM_SCALE = 256;
const MAX_TERRARIUM_VALUE = 0xff_ff_ff;
const FLOOR_URL = /^kiriko-floor:\/\/(-?\d+)\//;

export type FloorTileEncoder = (
  rgb: readonly [number, number, number],
) => Promise<ArrayBuffer>;

function encodedTerrariumValue(millimetres: number): number | null {
  if (!Number.isSafeInteger(millimetres)) return null;
  const value = Math.round(
    (millimetres / 1000 + TERRARIUM_OFFSET_M) * TERRARIUM_SCALE,
  );
  return value >= 0 && value <= MAX_TERRARIUM_VALUE ? value : null;
}

export function terrariumRgbForMillimetres(
  millimetres: number,
): readonly [number, number, number] | null {
  const value = encodedTerrariumValue(millimetres);
  if (value === null) return null;
  return [
    Math.floor(value / 65_536),
    Math.floor((value % 65_536) / 256),
    value % 256,
  ];
}

export function floorElevationTileUrl(planeM: number): string | null {
  if (!Number.isFinite(planeM)) return null;
  const millimetres = Math.round(planeM * 1000);
  if (terrariumRgbForMillimetres(millimetres) === null) return null;
  return `${FLOOR_ELEVATION_PROTOCOL}://${millimetres}/{z}/{x}/{y}`;
}
```

Implement the default encoder with a 256×256 DOM canvas, `fillRect`, and
`canvas.toBlob(..., "image/png")`; reject if no 2D context or Blob is produced.
`createFloorElevationProtocol` parses the signed millimetre host, rejects malformed
or unrepresentable keys, returns `{ data }`, and caches the encoder promise in a
`Map<number, Promise<ArrayBuffer>>`. Check `abortController.signal.aborted` before
starting work and throw its `reason` (or a DOM `AbortError`) rather than populating
the cache for a cancelled first request.

- [ ] **Step 4: Put the source in the initial style and test it**

In `buildIndoorStyle.ts`, import the ID and source builder and add this sibling to
the four GeoJSON sources:

```ts
[FLOOR_ELEVATION_SOURCE_ID]: floorElevationSource(),
```

Extend the existing indoor-style test in `featureLayers.test.ts`:

```ts
expect(style.sources[FLOOR_ELEVATION_SOURCE_ID]).toMatchObject({
  type: "raster-dem",
  encoding: "terrarium",
});
expect(style.terrain).toBeUndefined();
```

- [ ] **Step 5: Run Task 1 tests and typecheck**

Run:

```bash
pnpm exec vitest run src/map/scene/floorElevation.test.ts src/map/featureLayers.test.ts
pnpm exec tsc --noEmit
```

Expected: both test files pass; client typecheck exits zero.

- [ ] **Step 6: Commit the DEM source**

```bash
git add src/map/scene/floorElevation.ts src/map/scene/floorElevation.test.ts src/map/buildIndoorStyle.ts src/map/featureLayers.test.ts
git commit -m "feat(map): add constant floor elevation source"
```

---

### Task 2: Active and route-context floor resolution

**Files:**
- Create: `src/map/scene/sceneFloorState.ts`
- Create: `src/map/scene/sceneFloorState.test.ts`
- Modify: `src/map/scene/scenePolicy.ts`
- Modify: `src/map/scene/scenePolicy.test.ts`
- Modify: `src/map/scene/sceneLayer.ts`

**Interfaces:**
- Consumes: `SceneView`, `ViewerLevel[]`, `RouteResultDto | null`, `ordinalOfLevel`, and `levelIdsForOrdinal`.
- Produces:
  - `SceneFloorState { activeLevelIndices: number[]; contextLevelIndices: number[]; activePlaneM: number | null }`
  - `resolveSceneFloorState(scene, venueLevels, activeLevelId, route): SceneFloorState`
  - `SceneLayer.setContextLevels(levelIndices: readonly number[]): void`
  - `SceneDiagnostics.contextLevelIndices(): number[]`

- [ ] **Step 1: Inspect exported-symbol callsites before changing contracts**

Use LSP references for `VisibilityState`, `batchOpacity`, `SceneLayerOptions`, and
`SceneDiagnostics`. Record every returned client callsite; update all of them in
this task. Do not use text search as a substitute for the symbol references.

- [ ] **Step 2: Write failing scene-floor resolver tests**

Create a typed `scene(levels)` fixture with empty features/batches and a four-level
venue fixture. Assert these contracts:

```ts
expect(resolveSceneFloorState(scene, levels, "b1", null)).toEqual({
  activeLevelIndices: [0],
  contextLevelIndices: [],
  activePlaneM: 8,
});

expect(resolveSceneFloorState(
  scene,
  levels,
  "b1",
  crossFloorRoute([-1, 0]),
)).toMatchObject({
  activeLevelIndices: [0],
  contextLevelIndices: [1],
  activePlaneM: 8,
});

expect(resolveSceneFloorState(
  scene,
  levels,
  "f1",
  crossFloorRoute([-1, 0]),
).contextLevelIndices).toEqual([0]);
```

Add distinct tests proving:

- consecutive route segments on one ordinal collapse before choosing the next;
- a three-floor route chooses the next ordinal in traversal order and the prior
  ordinal on the final floor;
- an active floor absent from the route has no context;
- all composite source levels for one canonical ID become active/context indices;
- equal millimetre-quantized active planes produce one plane;
- non-finite or millimetre-disagreeing active planes produce `activePlaneM: null`
  without deleting the active indices;
- a missing context-floor scene mapping yields no context but preserves the
  active floor.

- [ ] **Step 3: Run the resolver test and observe RED**

Run: `pnpm exec vitest run src/map/scene/sceneFloorState.test.ts`

Expected: FAIL because the resolver module does not exist.

- [ ] **Step 4: Implement the pure resolver**

Use the following shape:

```ts
export interface SceneFloorState {
  activeLevelIndices: number[];
  contextLevelIndices: number[];
  activePlaneM: number | null;
}

export function resolveSceneFloorState(
  scene: SceneView,
  venueLevels: readonly ViewerLevel[],
  activeLevelId: string,
  route: RouteResultDto | null,
): SceneFloorState;
```

Implementation rules:

1. Active indices are every `scene.levels` entry whose `canonicalId` equals
   `activeLevelId`.
2. Convert every active `resolvedPlaneZ` to `Math.round(z * 1000)`. The plane is
   valid only when the list is non-empty, every source value is finite, and the
   resulting set contains exactly one integer.
3. Build the route ordinal sequence in segment order, removing only consecutive
   duplicates.
4. Locate the active venue ordinal. Choose the next ordinal when present; on the
   final ordinal choose the previous. No active match means no route context.
5. Use `levelIdsForOrdinal` to map the context ordinal to canonical IDs, then
   collect every matching scene level index.

- [ ] **Step 5: Write failing persistent-context visibility tests**

Extend `scenePolicy.test.ts` so `VisibilityState` carries both transient and
persistent state:

```ts
const state = {
  activeLevelIndices: [0],
  contextLevelIndices: [1],
  showContextLevels: false,
};
expect(batchOpacity({ levelIndex: 0, role: "Walkable" }, state)).toBe(1);
expect(batchOpacity({ levelIndex: 1, role: "Walkable" }, state)).toBe(0.22);
expect(batchOpacity({ levelIndex: 1, role: "Ceiling" }, state)).toBe(0.15);
expect(batchOpacity({ levelIndex: 2, role: "Walkable" }, state)).toBe(0);
```

Retain a separate assertion that `showContextLevels: true` still exposes any
other floor during the 160 ms handoff.

- [ ] **Step 6: Run the policy test and observe RED**

Run: `pnpm exec vitest run src/map/scene/scenePolicy.test.ts`

Expected: FAIL because persistent context indices are ignored.

- [ ] **Step 7: Add persistent context to policy and SceneLayer**

Update `VisibilityState` and `batchOpacity`:

```ts
export interface VisibilityState {
  activeLevelIndices: readonly number[];
  contextLevelIndices: readonly number[];
  showContextLevels: boolean;
}

if (
  !state.showContextLevels &&
  !state.contextLevelIndices.includes(batch.levelIndex)
) {
  return 0;
}
```

In `SceneLayer`, add `_contextLevelIndices`, seed it from an optional
`SceneLayerOptions.contextLevelIndices`, pass it to both color and pick visibility,
and add:

```ts
setContextLevels(levelIndices: readonly number[]): void {
  const last = this._scene.levels.length - 1;
  this._contextLevelIndices = levelIndices
    .map((index) => Math.floor(index))
    .filter((index) => index >= 0 && index <= last);
  this._map?.triggerRepaint();
}
```

Expose a defensive copy as `diagnostics().contextLevelIndices`. Preserve the pick
rule: opacity below `1` never enters the pick pass.

- [ ] **Step 8: Run Task 2 tests and typecheck**

Run:

```bash
pnpm exec vitest run src/map/scene/sceneFloorState.test.ts src/map/scene/scenePolicy.test.ts
pnpm exec tsc --noEmit
```

Expected: both test files pass; client typecheck exits zero.

- [ ] **Step 9: Commit floor-state resolution**

```bash
git add src/map/scene/sceneFloorState.ts src/map/scene/sceneFloorState.test.ts src/map/scene/scenePolicy.ts src/map/scene/scenePolicy.test.ts src/map/scene/sceneLayer.ts
git commit -m "feat(scene): retain one cross-floor route context"
```

---

### Task 3: IndoorMap terrain lifecycle

**Files:**
- Modify: `src/map/IndoorMap.tsx`
- Modify: `src/map/IndoorMap.test.tsx`

**Interfaces:**
- Consumes: Task 1 protocol/source helpers and Task 2 `resolveSceneFloorState` / `SceneLayer.setContextLevels`.
- Produces: protocol registration scoped to one `IndoorMap`, active-floor terrain synchronization, scene teardown that returns the map to terrain-free 2D, and route-driven persistent context.

- [ ] **Step 1: Extend the MapLibre test double without changing existing behavior**

In `IndoorMap.test.tsx`, retain the existing “all style layers exist” behavior but
make the scene layer real to the double:

```ts
readonly customLayers = new Map<string, { id: string }>();
readonly terrainCalls: Array<
  { source: string; exaggeration: number } | null
> = [];
readonly floorTileUrls: string[][] = [];

getLayer(id: string): Record<string, unknown> | undefined {
  return this.customLayers.get(id) ??
    (id === "kiriko-scene" ? undefined : {});
}
addLayer(layer: { id: string }): void {
  this.customLayers.set(layer.id, layer);
}
removeLayer(id: string): void {
  this.customLayers.delete(id);
}
setTerrain(value: { source: string; exaggeration: number } | null): void {
  this.terrainCalls.push(value);
}
```

Return a raster source with `setTiles(tiles)` when `getSource` receives
`FLOOR_ELEVATION_SOURCE_ID`; preserve the four existing GeoJSON buckets for every
other source. Add the no-op scene camera methods the now-attached `SceneLayer`
needs: `setMaxPitch`, `setPitch`, `setBearing`, `dragRotate.enable/disable`, and
`touchZoomRotate.enableRotation/disableRotation`.

Extend the hoisted `maplibre-gl` mock with `addProtocol` and `removeProtocol` spies
stored in `mapState`, alongside `Map`.

- [ ] **Step 2: Write failing IndoorMap terrain lifecycle tests**

Add a minimal two-floor `SceneView` builder and tests that rerender one mounted
`IndoorMap`:

```ts
const { map, rerender } = renderMap(baseProps({
  levelId: "level-b1",
  scene: sceneWithPlanes([
    ["level-b1", 8],
    ["level-f1", 12],
  ]),
}));
expect(map.floorTileUrls.at(-1)).toEqual([
  "kiriko-floor://8000/{z}/{x}/{y}",
]);
expect(map.terrainCalls.at(-1)).toEqual({
  source: FLOOR_ELEVATION_SOURCE_ID,
  exaggeration: 1,
});

rerender(<IndoorMap {...baseProps({
  levelId: "level-f1",
  scene,
})} />);
expect(map.floorTileUrls.at(-1)).toEqual([
  "kiriko-floor://12000/{z}/{x}/{y}",
]);
```

Add separate tests for:

- rerendering with `scene: null` ends in `terrainCalls.at(-1) === null`;
- an active canonical floor with contradictory composite planes never calls
  terrain with a source;
- unmount removes `kiriko-floor` after map removal;
- a route with segment ordinals `[-1, 0]` yields exactly the other floor in
  `SceneDiagnostics.contextLevelIndices()`;
- clearing the route clears persistent context;
- reduced motion skips transient `showContextLevels` but retains route context;
- the existing 160 ms handoff timer clears only transient context, not the route
  context indices.

- [ ] **Step 3: Run the focused IndoorMap tests and observe RED**

Run: `pnpm exec vitest run src/map/IndoorMap.test.tsx`

Expected: FAIL because protocol registration, terrain methods, and persistent
route context are not wired.

- [ ] **Step 4: Register the protocol around map construction**

At the beginning of the create-once map effect:

```ts
maplibregl.addProtocol(
  FLOOR_ELEVATION_PROTOCOL,
  createFloorElevationProtocol(),
);
```

If `new maplibregl.Map` throws, remove the protocol before returning. In normal
cleanup, call `map.remove()` and then
`maplibregl.removeProtocol(FLOOR_ELEVATION_PROTOCOL)`. The effect still creates
one map and has an empty dependency array.

- [ ] **Step 5: Add one synchronization function inside IndoorMap**

Use a ref to avoid resetting a raster source to the same URL:

```ts
const floorElevationUrlRef = useRef<string | null>(null);
```

Implement one local function/callback that accepts the current map, scene layer,
scene, level ID, and route. It must:

1. call `resolveSceneFloorState`;
2. apply `setActiveLevels` and `setContextLevels`;
3. convert `activePlaneM` with `floorElevationTileUrl`;
4. when valid, call `setTiles([url])` only if the URL changed, then
   `map.setTerrain({ source: FLOOR_ELEVATION_SOURCE_ID, exaggeration: 1 })`;
5. when invalid, call `map.setTerrain(null)` and clear the URL ref;
6. trigger one repaint after the state is coherent.

Narrow the source structurally before calling `setTiles`:

```ts
function hasSetTiles(source: unknown): source is { setTiles(tiles: string[]): void } {
  return typeof source === "object" && source !== null &&
    "setTiles" in source && typeof source.setTiles === "function";
}
```

Do not cast a GeoJSON source to a raster source.

- [ ] **Step 6: Synchronize attach, floor changes, routes, and teardown**

Inside `attach`, call the synchronization function after assigning
`sceneLayerRef.current`, using `directionsRef.current?.route ?? null`; this covers
a scene attached after the earlier React effect already ran.

Replace the current floor-change effect's active-index lookup with the same
synchronization function and depend on `levelId`, `scene`, and `directions?.route`.
Keep the handoff timer independent:

- persistent route indices come from `setContextLevels`;
- `setShowContextLevels(true/false)` controls only the 160 ms transition;
- reduced motion does not set transient context.

In scene-effect cleanup, detach terrain and clear `floorElevationUrlRef` before
resetting pitch/bearing. This makes `scene: null` and source fallback exact 2D
cutovers.

- [ ] **Step 7: Run Task 3 tests and client typecheck**

Run:

```bash
pnpm exec vitest run src/map/IndoorMap.test.tsx src/map/scene/sceneFloorState.test.ts src/map/scene/scenePolicy.test.ts src/map/scene/floorElevation.test.ts
pnpm exec tsc --noEmit
```

Expected: all focused tests pass; client typecheck exits zero.

- [ ] **Step 8: Commit the lifecycle integration**

```bash
git add src/map/IndoorMap.tsx src/map/IndoorMap.test.tsx
git commit -m "fix(map): align overlays to the active scene floor"
```

---

### Task 4: Browser proof and regression gate

**Files:**
- Modify only if proof exposes a real contract defect: files owned by Tasks 1–3.
- Verify: `docs/superpowers/specs/2026-08-12-scene-floor-elevation-alignment-design.md`

**Interfaces:**
- Consumes: the complete active-floor terrain and route-context behavior.
- Produces: observed end-to-end evidence at a pitched camera and a green client regression gate.

- [ ] **Step 1: Run the client regression suite before browser proof**

Run:

```bash
pnpm exec vitest run
pnpm exec tsc --noEmit
pnpm build
```

Expected: all client test files pass, typecheck exits zero, and Vite reports a
successful production build.

- [ ] **Step 2: Launch the application through the repository dev entry point**

Start `bash dev.sh` as a supervised Hub process with the existing non-production
seed environment and wait for both backend health and Vite `:5173`. Do not start
a watcher through a blocking shell call.

- [ ] **Step 3: Prove active-floor alignment on two floors**

Open the published Shibuya generated-3D viewer in Chromium, switch to English,
enter 3D, and pitch to 60 degrees. For B1 and one other floor:

1. obtain the live MapLibre map and `kiriko-scene` implementation from the mounted
   `IndoorMap`;
2. choose a polygon vertex on the active canonical floor;
3. convert the same longitude/latitude through the scene frame at that level's
   `resolvedPlaneZ`;
4. compare `map.project([lng, lat])` with `SceneLayer.projectLocal(local)`;
5. read `map.queryTerrainElevation([lng, lat], { exaggerated: false })`.

Acceptance for each floor:

```text
absolute terrain error <= 0.004 m
screen-space projection distance <= 0.5 CSS px
```

The tolerance covers Terrarium's 1/256 m quantization and subpixel rasterization;
it is far below the original 85.08 px B1 failure.

- [ ] **Step 4: Prove automatic two-floor route context**

Create a route whose ordered segments cross from B1 to 1F. After the 160 ms
handoff settles, inspect `window.__kirikoScene`:

```text
activeLevelIndices: only the selected canonical floor's registered levels
contextLevelIndices: only the next route floor's registered levels
```

Visually confirm both floor plates remain present at distinct Z, the context floor
is quiet, the active route/plan remains on the active plate, and clicking context
geometry does not select a context-floor feature. Clear the route and confirm
`contextLevelIndices` becomes empty without turning 3D off.

- [ ] **Step 5: Prove exact 2D restoration**

Click “Switch to 2D” and confirm:

```text
map.getTerrain() === null
camera pitch === 0
kiriko-scene layer absent
route, floor, and canonical selection preserved
```

- [ ] **Step 6: Run the affected suite once more after smoke proof**

Run:

```bash
pnpm exec vitest run
pnpm exec tsc --noEmit
pnpm build
```

Expected: same green results as Step 1. Stop the supervised dev process.

- [ ] **Step 7: Commit the approved design and plan**

```bash
git add docs/superpowers/specs/2026-08-12-scene-floor-elevation-alignment-design.md docs/superpowers/plans/2026-08-12-scene-floor-elevation-alignment.md
git commit -m "docs: record scene floor elevation alignment"
```
