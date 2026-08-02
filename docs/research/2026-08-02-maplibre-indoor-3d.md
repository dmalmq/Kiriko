# MapLibre GL JS 5.24 — Indoor 3D Rendering & Picking/Editing Assessment

**Ticket:** [Assess MapLibre indoor-3D rendering and picking limits](https://github.com/dmalmq/imdf-map-application/issues/22)
**Question:** Which MapLibre GL JS 5.24 native layers, elevation features, custom-layer hooks, feature-picking APIs, and accessibility/performance constraints can satisfy Kiriko's schematic multi-floor scene and precise desktop graph editing — and where would another renderer be *an option* (including authoritative OGC 3D Tiles)?
**Version investigated:** `maplibre-gl@5.24.0` (`@maplibre/maplibre-gl-style-spec@24.10.0`), pinned in [`package.json`](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/package.json) (`maplibre-gl: 5.24.0`). MapLibre source read at the pinned tag [`v5.24.0`](https://github.com/maplibre/maplibre-gl-js/tree/v5.24.0); style-spec at installed `@maplibre/maplibre-gl-style-spec@24.10.0/src/reference/v8.json`.
**Date:** 2026-08-02 · **Status:** Research only (read-only). No architecture decision is made here; no renderer is recommended as *necessary*.

---

## 0. How to read this document (labels & scope)

Every material statement carries one of:

- **[DOC]** — stated in the official MapLibre docs / style-spec docs (URL given) and consistent with source.
- **[SRC]** — read directly from MapLibre 5.24 source at the pinned tag; cited with a `v5.24.0` GitHub permalink **and** the local path/lines.
- **[APP]** — read from Kiriko source in this repo (`src/...`); cited with a `research/maplibre-indoor-3d` permalink **and** relative path/lines.
- **[INF]** — recommendation / inference drawn from the above; not a primary claim.
- **[PROTO]** — plausible but only verifiable by a prototype benchmark; listed in §8.

> **Scope.** This file assesses MapLibre's capabilities and limits against the *current* app (§2.1). It deliberately does **not** declare another renderer necessary and does **not** choose a final architecture.

---

## 1. Bottom line (conclusions first)

1. **Extruded floors/rooms work natively.** `fill-extrusion` with data-driven `fill-extrusion-base`/`fill-extrusion-height` (meters, both `minimum: 0`) can stack IMDF polygons into a true-3D multi-floor block, and those features are **pickable** via `queryRenderedFeatures` with real 3D ray/face intersection. **[DOC]+[SRC]** §3, §5.
2. **The navigation graph cannot be lifted into 3D natively.** There is no `line-extrusion` and no point/line elevation property; `circle`/`symbol`/`line` sit on the ground/terrain plane. `["elevation"]` is restricted to `color-relief`. Kiriko already computes a per-node `altitude = ordinal * 4 m` but **discards it on render** (graph is purely 2D today). **[SRC]+[APP]** §2.1, §3.3.
3. **Custom-layer geometry is invisible to MapLibre picking** — but a custom WebGL layer with its **own** picking can fully suffice; another renderer is *not* required. `queryRenderedFeatures` only indexes built-in tile layers; a `type:"custom"` layer contributes nothing to the feature index. **[SRC]** §5.4.
4. **Camera is altitude-aware (good for multi-floor) and has no `FreeCameraOptions`.** Floor-level views are reachable via `calculateCameraOptionsFromTo(..., altitudeFrom, ..., altitudeTo)` and `centerAltitude`; `maxPitch` default is 60° (non-experimental), 60–180° is officially experimental. **[SRC]** §6.
5. **Current Kiriko scene is locked flat** (`maxPitch: 0`, `dragRotate:false`, rotation disabled) and picks an **active-floor-only** GeoJSON graph with **junction-first, then path** hit-testing over **12 px / 10 px** hit layers. Any 3D promotion must preserve this precision. **[APP]** §2.1.
6. **Renderer options, not mandates.** If a true-3D pickable/editable graph is ever wanted, the candidate paths — custom WebGL + own picking, deck.gl `MapboxOverlay`, or three.js via the custom-layer hook (MapLibre ships an official three.js example) — are presented as **primary-source-backed options**, with a recommendation only to *prototype*, not to commit. **[INF]** §7, §10.
7. **Authoritative OGC 3D Tiles are not native to MapLibre** (the style-spec source enum is `vector`/`raster`/`raster-dem`/`geojson`/`video`/`image` only). A 3D-Tiles venue needs a custom/overlay layer (e.g. deck.gl `Tile3DLayer`+`MapboxOverlay`) or a dedicated renderer (CesiumJS); a *generated* schematic polygon scene can stay native. Both share coordinate + semantic-pick adapter needs and require prototype validation. **[SRC]+[INF]** §9.

---

## 2. Current app grounding (what Kiriko does today) **[APP]**

These facts are read from the app source on `research/maplibre-indoor-3d` so the limits below are assessed against reality, not assumption.

### 2.1 Map & interaction config

- **Locked flat.** The map is constructed with `pitchWithRotate: false, dragRotate: false, maxPitch: 0` and then `map.touchZoomRotate.disableRotation()` — pitch and rotation are both disabled. [`src/map/IndoorMap.tsx`](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/src/map/IndoorMap.tsx) lines 861–872.
- **Version.** `maplibre-gl: 5.24.0`. [`package.json`](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/package.json) line 36.

### 2.2 Data model: active-floor-only GeoJSON

- The graph is served per **active floor**: `setNetworkSourceData` resolves the active `ordinal` and calls `source.setData(buildNetworkFeatures(network, ordinal, render))`. [`src/map/IndoorMap.tsx`](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/src/map/IndoorMap.tsx#L218-L233). Only one floor's junctions/paths are ever in the GeoJSON source at a time.

### 2.3 Picking: 12 px / 10 px hit layers, junction-first

- **Wide, near-invisible hit targets sit beneath the thin visible overlay** so editing clicks land on 1.5 px paths / 2.5 px junctions reliably: the path-hit layer is `line-width: 12` (`line-opacity: 0.01`); the junction-hit layer is `circle-radius: 10` (`circle-opacity: 0.01`). [`src/map/featureLayers.ts`](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/src/map/featureLayers.ts) lines 662–685 (`LAYER_NETWORK_PATH_HIT`/`LAYER_NETWORK_JUNCTION_HIT`).
- **Junction-first, then path.** `networkPickAt` queries the junction hit layer first; only if that misses does it query the path hit layer; otherwise it reports a bare coordinate. [`src/map/IndoorMap.tsx`](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/src/map/IndoorMap.tsx#L246-L273). This precedence is the editing contract any 3D path must reproduce.

### 2.4 Graph altitude exists in source/edit data, then is discarded for rendering

- Imported graph properties include source `altitude` and `relative_height`; newly added junctions are serialized with `altitude: ordinal * FLOOR_HEIGHT_M` (`FLOOR_HEIGHT_M = 4`) and `relative_height: null`. [`docs/gdb-data-reference.md`](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/docs/gdb-data-reference.md#L29-L36); [`src/map/networkFeatures.ts`](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/src/map/networkFeatures.ts#L295-L296) and [lines 411–425](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/src/map/networkFeatures.ts#L411-L425).
- `buildNetworkFeatures` copies only graph IDs and selection flags into the rendered GeoJSON, so neither altitude property reaches a style layer. [`src/map/networkFeatures.ts`](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/src/map/networkFeatures.ts#L123-L177). **[APP]** A future 3D graph has source/nominal elevation inputs, but the current overlay intentionally renders them in 2D.

### 2.5 Markers are DOM, placed via 2D `map.project`

- Feature markers and issue pins are absolutely-positioned DOM children placed with an **integral 2D `translate` from `map.project`**, deliberately *avoiding* MapLibre's own `Marker` (whose `rotateX/rotateZ` 3D transform destabilizes composited text rasterization across processes). [`src/map/useFeatureMarkers.ts`](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/src/map/useFeatureMarkers.ts) lines 192–232; [`src/map/useIssuePins.ts`](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/src/map/useIssuePins.ts) lines 71–108. **[APP]** `map.project` here returns the ground-plane point — already the 2D path MapLibre gives natively (§6).

### 2.6 Scale to benchmark against

- The JR East Tokyo dataset (the canonical large fixture) is **`net_junction` = 10,118 nodes** and **`net_path` = 25,625 edges**. [`docs/gdb-data-reference.md`](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/docs/gdb-data-reference.md) lines 32, 34. Any prototype (§8) must hold these counts.

---

## 3. Native style layers & 3D extrusion

### 3.1 Layer types available in 5.24 (no `line-extrusion`)

> `"type" ... must be one of background, fill, line, symbol, raster, circle, fill-extrusion, heatmap, hillshade, color-relief.` — **[DOC]** `v8.json` `$root.layers.doc`. Absence of `line-extrusion` confirmed by exhaustive search of `v8.json` (0 matches). **[SRC]**

| Need | Native layer | Verdict |
|---|---|---|
| Floor plates / rooms / units as 3D blocks | `fill-extrusion` | ✅ Native, data-driven base/height (meters), pickable |
| Floor slabs / footprints (flat) | `fill` | ✅ Native |
| Walls, railings, route edges (3D tubes/edges) | **(none)** | ❌ No `line-extrusion`; `line` is ground-clamped |
| Graph nodes / POIs | `circle` / `symbol` | ⚠️ 2D, ground-clamped (pitch-*alignment* only) |
| Heat/coverage overlays | `heatmap` | ✅ Native (2D) |

### 3.2 `fill-extrusion` — the one true-3D built-in

Paint properties (**[DOC]** `v8.json` `paint_fill-extrusion`; **[SRC]** pinned source):

- `fill-extrusion-height` — `number`, **meters**, `default 0`, **`minimum: 0`**, `data-driven`. `"doc": "The height with which to extrude this layer."` [`v8.json:6359`](https://github.com/maplibre/maplibre-style-spec/blob/v24.10.0/src/reference/v8.json#L6359-L6386).
- `fill-extrusion-base` — `number`, **meters**, `default 0`, **`minimum: 0`**; *"Must be less than or equal to `fill-extrusion-height`."*; `requires ["fill-extrusion-height"]`; data-driven.
- `fill-extrusion-vertical-gradient` — `boolean`, `default true`.
- No rounded/curved roof property (0 matches in `v8.json`). **[SRC]**

> **Heights/base are non-negative (meters).** [INF] **Use a positive scene datum**: model ground as altitude 0 and express each floor as `base = floorIndex * storyHeightMeters`, `height = base + slabHeight`. **Do not** rely on negative base/height values: the spec `minimum` is 0 for both `-height` and `-base`, so negative values are **out of contract**; the render fixture `fill-extrusion-height/negative` feeds `property: -10/-30` to `fill-extrusion-height` precisely to exercise **out-of-range input**, not to demonstrate usable negative extrusion. **[SRC]** `v8.json` `paint_fill-extrusion`; `test/integration/render/tests/fill-extrusion-height/negative/style.json`.

First-party proof of the intended indoor path: **[DOC]** [Extrude polygons for 3D indoor mapping](https://maplibre.org/maplibre-gl-js/docs/examples/extrude-polygons-for-3d-indoor-mapping/) ("Create a 3D indoor map with the fill-extrude-height paint property") and [Display buildings in 3D](https://maplibre.org/maplibre-gl-js/docs/examples/display-buildings-in-3d/). **[SRC]** passing render fixtures on `v5.24.0`: `fill-extrusion-height/{default,function,property-function,zoom-and-property-function}`, `fill-extrusion-multiple/{multiple,interleaved-layers}`, plus `fill-extrusion-{base,color,pattern,translate,vertical-gradient}`.

### 3.3 `terrain` (raster-DEM) and the hard point/line limit

- **[DOC]** `TerrainSpecification = { source (raster-dem, required), exaggeration (number, min 0, default 1.0) }`; elevation units are meters above the DEM datum (`["elevation"]` doc: *"Can only be used in the color-relief-color property of a color-relief layer."*). [TerrainSpecification](https://maplibre.org/maplibre-style-spec/root/#terrain).
- **[SRC]** `Map.setTerrain`/`getTerrain`: [`src/ui/map.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/map.ts) L2326, L2397.
- **[SRC]** No elevation/height/z property exists for `line`/`circle`/`symbol` (the only `elevation` reference outside `terrain` is the color-relief-only expression). `circle`/`symbol` offer only orientation props (`circle-pitch-alignment`, `icon-pitch-alignment`, `text-pitch-alignment`) — these orient a marker with a pitched map; they do **not** lift it to a Z. [`v8.json`](https://github.com/maplibre/maplibre-style-spec/blob/v24.10.0/src/reference/v8.json) `paint_circle`/`layout_symbol`.

**[INF]** Terrain is a single continuous ground surface (site context), not discrete floors. The graph's per-node `altitude` (§2.4) has no native elevation sink; placing graph elements at a true floor Z requires either a `type:"custom"` layer or an external renderer (§9, §10).

### 3.4 Native vs precomputed vs custom — what each geometry type needs

**[SRC]** The decisive constraint: `fill-extrusion-height`/`-base` are `.evaluate(feature)` → **one scalar per feature**, and `projectExtrusion(geometry, zBase: number, zTop: number, m)` applies those two scalars uniformly to *every* vertex of that feature ([`src/style/style_layer/fill_extrusion_style_layer.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/style/style_layer/fill_extrusion_style_layer.ts) L56–57, L167–194). So each extruded feature has exactly **one constant horizontal top plane and one constant horizontal base plane** — no in-feature slope, no tube, no per-vertex Z, no true sloped connector. **[SRC]** Confirmed: there is no `line-extrusion` and no point/line elevation property (§3.1, §3.3).

| Geometry need | Path | Notes / limit |
|---|---|---|
| **Polygon floors / rooms** (slabs, units, footprints) | **Native** `fill-extrusion` | Once `base`/`height` (meters, `≥ 0`) are computed per feature, the polygon extrudes. Only a **constant horizontal** top/base per feature. |
| **Line walls** (perimeter walls from line strings) | **Precomputed polygon ribbon/prism → `fill-extrusion`** | Buffer the line into a thin polygon; extrude it. Walls are vertical prisms, **not** sloped. (A wall is really a vertical face, so a constant top/base prism is adequate.) |
| **Line graph edges** (3D route/connector) | **Precomputed polygon ribbon → `fill-extrusion`, OR custom** | A flat ribbon at one Z works natively; a **true tube** or **sloped connector** between two different floor Zs is impossible natively (no per-vertex Z) — needs custom rendering/projection. |
| **Point graph nodes** (junctions at a floor Z) | **Precomputed polygon footprint → `fill-extrusion`, OR custom** | A node as a thin extruded disc/pad at one Z works natively; an **arbitrary-Z point** has no native elevation sink — needs custom rendering/projection. |
| **True arbitrary-Z points/lines, sloped connectors, elevated labels** | **Custom layer / overlay projection** | None of `circle`/`symbol`/`line` lift to a Z (§3.3); Kiriko's DOM markers are deliberately 2D `map.project` (§2.5). Any elevated element needs a custom WebGL/three.js/deck.gl layer or a DOM element placed with a custom 3D projection. |

**[INF]** Practical consequence for Kiriko: floors/rooms/walls/flat ribbons can stay in native `fill-extrusion` (with a positive scene datum, §3.2); the *navigation graph itself* (true 3D nodes/edges/connectors) and any elevated labels must be custom/overlay (§4, §10).

---

## 4. Custom-layer contract (the in-tree escape hatch)

### 4.1 What MapLibre hands you

**[DOC]** [CustomLayerInterface](https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/), [CustomRenderMethodInput](https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/CustomRenderMethodInput/). **[SRC]** [`src/style/style_layer/custom_style_layer.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/style/style_layer/custom_style_layer.ts):

```ts
interface CustomLayerInterface {
  id: string;
  type: 'custom';
  renderingMode?: '2d' | '3d';   // defaults '2d'
  render: (gl, options: CustomRenderMethodInput) => void;        // required
  prerender?: (gl, options: CustomRenderMethodInput) => void;    // optional (render-to-texture)
  onAdd?(map, gl): void;
  onRemove?(map, gl): void;
}
```

`CustomRenderMethodInput` per frame (**[SRC]** [`src/webgl/draw/draw_custom.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/webgl/draw/draw_custom.ts)): `modelViewProjectionMatrix`, `projectionMatrix`, `farZ`/`nearZ`/`fov`, plus projection-aware `shaderData` (`variantName` cache key, `vertexShaderPrelude`, `define`) and `defaultProjectionData`. In `renderingMode:"3d"` *"the z coordinate is conformal. A box with identical x, y, and z lengths in mercator units would be rendered as a cube."*

### 4.2 Depth-buffer sharing contract

**[SRC]** [`src/webgl/draw/draw_custom.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/webgl/draw/draw_custom.ts):

```ts
const depthMode = renderingMode === '3d'
  ? painter.getDepthModeFor3D()                      // ReadWrite, shared 3D range
  : painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);  // 2D: read-only slot 0
```

The 3D range is shared with `fill-extrusion`: [`src/render/painter.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/render/painter.ts) L552 (`depthRangeFor3D = [0, 1 - ((order.length + 2) * numSublayers * depthEpsilon)]`); `draw_fill_extrusion.ts` L27 uses the same `depthRangeFor3D`. **[INF]** A `renderingMode:"3d"` graph can depth-interleave with extruded floors under this contract; actual occlusion and z-fighting remain prototype gates (§8).

### 4.3 GL-state & lifecycle caveats

- **[DOC/SRC]** *"The layer can assume blending and depth state is set ... cannot make any other assumptions about the current GL state."* Fixed blend: `gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)` → **premultiplied alpha required**.
- **[DOC]** `Map.triggerRepaint()` to redraw; **handle `webglcontextlost`/`webglcontextrestored`**.
- **[SRC]** Custom layers can't be serialized: `CustomStyleLayer.serialize()` throws `"Custom layers cannot be serialized."` — they won't survive `getStyle()` round-trips; manage out-of-band (as Kiriko already does for the network overlay).
- **[SRC]** First-party proofs on `v5.24.0`: render fixtures `custom-layer-js/{null-island, tent-3d, depth}` (the `depth` fixture exercises depth interleaving). Official **[DOC]** examples: [Add a custom style layer](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-custom-style-layer/), [Add a simple custom layer on a globe](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-simple-custom-layer-on-a-globe/), and **[three.js via the custom-layer hook](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-3d-model-using-threejs/)** (plus [globe](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-3d-model-to-globe-using-threejs/) and [terrain](https://maplibre.org/maplibre-gl-js/docs/examples/adding-3d-models-using-threejs-on-terrain/) variants) — three.js is a first-party-supported custom-layer option (§10).

---

## 5. Feature picking / querying (and the custom-layer hole)

### 5.1 Public API surface

**[DOC]** [Map.queryRenderedFeatures](https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/#queryrenderedfeatures), [QueryRenderedFeaturesOptions](https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/QueryRenderedFeaturesOptions/). **[SRC]** [`src/ui/map.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/map.ts) L1969; [`src/source/query_features.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/source/query_features.ts) L21–39:

```ts
queryRenderedFeatures(
  geometryOrOptions?: PointLike | [PointLike, PointLike] | QueryRenderedFeaturesOptions,
  options?: QueryRenderedFeaturesOptions
): MapGeoJSONFeature[]
// options: { layers?: string[]|Set<string>; filter?: FilterSpecification; availableImages?: string[]; validate?: boolean }
```

Query geometry is a pixel **or** a bbox; omitted = whole viewport. Results are **top-to-bottom (nearest first)** z-order; each feature carries `layer`, `source`, `sourceLayer`, and fully-evaluated paint/layout. **[DOC]** `validate:false` skips style-spec filter validation — a perf optimization useful for hover/`mousemove` hit-testing during editing (Kiriko's `networkPickAt`/`updateNetworkCursor` already rely on per-move `queryRenderedFeatures`). **[APP]** [`src/map/IndoorMap.tsx`](https://github.com/dmalmq/imdf-map-application/blob/research/maplibre-indoor-3d/src/map/IndoorMap.tsx).

### 5.2 `fill-extrusion` is pickable in true 3D

**[SRC]** [`src/style/style_layer/fill_extrusion_style_layer.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/style/style_layer/fill_extrusion_style_layer.ts): `is3D()` returns `true`; features are indexed in a **separate `grid3D`** ([`src/data/feature_index.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/data/feature_index.ts)). `queryIntersectsFeature()` projects base + top rings and tests the query ray against the **roof face and each wall quad**, returning the barycentric intersection distance — i.e. you hit the *actual* extruded surface, not the footprint. The 3D path is opted into only when a fill-extrusion layer is in scope: `queryIncludes3DLayer()` checks `layer.type === 'fill-extrusion'` ([`src/source/query_features.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/source/query_features.ts)). **[INF]** Room/unit selection on extruded 3D floors works through the standard pipeline — no custom raycaster for polygons.

### 5.3 Symbols are pickable (separate path)

**[SRC]** `queryRenderedSymbols(...)` ([`src/source/query_features.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/source/query_features.ts) L157) runs for symbol layers via the collision index; collision-hidden symbols are excluded (**[DOC]**).

### 5.4 Two editing risks

1. **Custom-layer features never reach the feature index.** **[SRC]** `queryIncludes3DLayer()` returns true only for `fill-extrusion`; a `type:"custom"` layer registers no tile data in the feature index. Therefore `queryRenderedFeatures` returns **nothing** for anything drawn in a custom layer — including a 3D graph. **[INF]** That graph would need **self-built picking** (CPU raycast against projected geometry, or a GPU color-ID pass in `prerender`). This is work, **not** a blocker: custom WebGL + own picking is a self-sufficient option (§10).
2. **Features can split/duplicate across tile boundaries.** **[DOC]** *"feature geometries may be split or duplicated across tile boundaries ... a point feature near a tile boundary may appear in multiple tiles."* **[INF] → Editing risk:** dedupe by feature id before treating a hit as "the" feature — especially long route edges. This applies to Kiriko's current inline GeoJSON too because MapLibre converts GeoJSON to tiles internally; whether geometry stitching is needed depends on the edit operation.

---

## 6. Camera, pitch/roll, and multi-floor positioning

- **Pitch.** **[SRC]** `defaultMaxPitch = 60` ([`src/ui/map.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/map.ts) L441). `setMaxPitch` throws above `maxPitchThreshold = 180` and is documented: *"Values greater than 60 degrees are experimental and may result in rendering issues."* (L1321). **[DOC]** `pitch` sdk-support: 0–60° (js 0.8.0), 0–85° (js 2.0.0), 0–180° (js 5.0.0). [INF] **0–60° is the documented default / non-experimental band** (not "stable" — just non-experimental and supported). Steeper is **[PROTO]**. First-party `>60°` proofs: render fixtures `high-pitch/{pitch95, pitch95-roll135, terrain-pitch95}`.
- **Roll** added in 5.0.0 (`v8.json` `$root.roll`); proven with high pitch in `high-pitch/pitch95-roll135`.
- **Zoom** `defaultMaxZoom = 22`, `defaultMinZoom = -2` ([`src/ui/map.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/map.ts) L436–437). **[DOC]** `centerAltitude` (meters above sea level) added js 5.0.0.
- **Altitude-aware camera (multi-floor positioning).** **[SRC]** `calculateCameraOptionsFromTo(from, altitudeFrom, to, altitudeTo = 0): CameraOptions` ([`src/ui/camera.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/camera.ts) L1041) frames the camera from/to explicit **meters-above-sea-level** altitudes, returning `center`, `elevation`, `zoom`, `pitch`, `bearing`. **[INF]** Supported way to frame a floor; `freezeElevation` (L234) keeps elevation stable across a `flyTo` while terrain streams in.
- **No `FreeCameraOptions`.** **[SRC]** Absent in 5.24 (0 matches for `freeCamera`/`FreeCameraOptions` across `src/`). That is a **Mapbox-GL-only** API; do not plan around it. Full framing goes through center/elevation/pitch/bearing/roll + `calculateCameraOptionsFromTo`.
- **`Map.project`/`unproject`.** **[SRC]** ([`src/ui/map.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/map.ts) L1470/L1488) are terrain-aware but resolve to the **ground/terrain** Z, not an arbitrary floor Z — which is exactly the 2D placement Kiriko's DOM markers already use (§2.5). **[INF]** confirms points cannot be projected to a floor Z natively.

---

## 7. WebGL / browser / performance / accessibility constraints

### 7.1 WebGL context acquisition (corrected)

- **[SRC]** Default `canvasContextAttributes.contextType` is **`undefined`** ([`src/ui/map.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/map.ts) L462). When `contextType` is unset, MapLibre acquires **WebGL2 first, then falls back to WebGL1**: `gl = getContext('webgl2', attrs) || getContext('webgl', attrs)` (L3473). If `contextType` is explicitly `'webgl2'`/`'webgl'`, that version is forced (L3470–3471). Other defaults (L456–462): `antialias:false`, `preserveDrawingBuffer:false`, `powerPreference:'high-performance'`, `failIfMajorPerformanceCaveat:false`, `desynchronized:false`.
- **[INF]** MapLibre itself runs on WebGL1-or-2. deck.gl **interleaved** mode specifically requires MapLibre's context to be WebGL2 (§9, §10); overlaid mode uses a separate canvas, so its WebGL requirements come from the selected deck.gl/luma.gl version rather than MapLibre's context fallback.
- **[INF]** To capture canvas screenshots (review/QA) opt into `preserveDrawingBuffer:true` (perf cost).

### 7.2 Depth/stencil budget

**[SRC]** Stencil IDs are shared 8-bit (`nextStencilID + tileIDs.length > 256` triggers `clearStencil`); 3D depth uses `depthEpsilon = 1/2^16` and `numSublayers` planes ([`src/render/painter.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/render/painter.ts) L552). **[PROTO]** confirm headroom for a deep floor stack + many line layers.

### 7.3 Large-data & GeoJSON update contract (new)

- **[DOC]** Official guide: [Optimising MapLibre Performance: Tips for Large GeoJSON Datasets](https://maplibre.org/maplibre-gl-js/docs/guides/large-data/) — set GeoJSON source `maxZoom` (e.g. 12 for points), set layer `minZoom`, simplify styles, and use `cluster`/`clusterMaxZoom`/`clusterRadius` to reduce features.
- **[SRC]** GeoJSON source supports **incremental diff updates** via `updateData(diff, waitForCompletion?)`: *"It is an error to call updateData on a source that did not have unique IDs for each of its features already. The IDs can either be specified on the feature, or by using the promoteId option."* ([`src/source/geojson_source.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/source/geojson_source.ts) L255–285). **[INF]** For live graph editing at Tokyo scale (§2.6), prefer `updateData` keyed by a `promoteId` over full `setData` to avoid re-parsing the whole source on each edit; `setData` re-tiles the entire source each call.

### 7.4 Accessibility (corrected)

- **[SRC]** The map canvas **does** set `tabindex` (`'0'` when interactive else `'-1'`), `aria-label` (`Map.Title` locale string), and `role="region"`. [`src/ui/map.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/map.ts) L3421–3423. Verified by test [`src/ui/map_tests/map_options.test.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/map_tests/map_options.test.ts) L17–21.
- **[SRC]** Camera keyboard nav (`KeyboardHandler`, arrow/`+`/`-`/Shift) is enabled by default (`keyboard: true`, [`src/ui/map.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/map.ts) L474); `flyTo`/camera animations honor **`prefers-reduced-motion`** (jump instead of animate) unless `essential: true`. [`src/ui/camera.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/camera.ts) L1421–1425.
- **[SRC]** `cooperativeGestures` injects a helper overlay marked `aria-hidden="true"` ([`src/ui/handler/cooperative_gestures.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/handler/cooperative_gestures.ts) L68–69).
- **[INF] The gap:** MapLibre provides **container/keyboard semantics but no per-feature semantics** — there is no accessible name/role/description for individual rendered features or graph nodes. **[INF]** Kiriko already mitigates this with keyboard-operable center-place actions (`networkEditing.centerActionLabel`), DOM issue pins (focusable), and panel lists (§2.5); for WCAG AA, the app (not MapLibre) must keep feature/node meaning exposed via those DOM/list surfaces and center actions. This is an app responsibility, not a MapLibre feature.

---

## 8. Prototype benchmarks required before commitment **[PROTO]**

These are claims source/docs cannot settle — a throwaway prototype in this repo at the **Tokyo scale (10,118 nodes / 25,625 edges, §2.6)** plus a deterministic fixture:

1. **3D graph picking latency & accuracy** on a deterministic fixture (e.g. the minimal IMDF in `tests/fixtures/minimal-imdf/`, plus a synthetic N-floor clone). Raycast / GPU color-pick hit-testing for the full graph in a `renderingMode:"3d"` custom layer at 30–60 FPS on the target matrix (below). Compare to the current 2D `queryRenderedFeatures` path.
2. **Fill-extrusion floor-stack scale.** Render a multi-floor venue as one data-driven `fill-extrusion` layer; measure initial GPU buffer build, per-frame time, VRAM; confirm `queryRenderedFeatures` 3D hit on extruded rooms stays < ~16 ms on hover.
3. **Pitch at the documented default vs. experimental range.** Whether the schematic + extrusions render correctly across the **browser/GPU matrix** (Chromium/Firefox × the AMD Radeon 890M iGPU and RX 7600 dGPU on this workstation) at 60° default and at 60–85° experimental.
4. **Tile-split dedup correctness.** Verify long route edges and boundary-adjacent nodes dedupe correctly under today's GeoJSON tiling so editing never creates phantom features; repeat if the graph later moves to a vector-tile source.
5. **Depth interleaving of a custom 3D graph vs. extruded walls** at high polygon counts (§4.2) — confirm correct occlusion and no z-fighting with `depthEpsilon`.
6. **Pick correctness specifics:** occlusion (which floor's feature is nearest-first), **ties** at shared edges/junctions, **drag-update** throughput (per-pointer-move re-pick), and **label** readability — all vs. the current 12 px/10 px junction-first contract (§2.3).
7. **deck.gl interleaved overlay** on MapLibre 5.24: draw-call/frame overhead, picking accuracy, and whether interleaving degrades map-label rendering. (WebGL2 required for interleaved only.)
8. **3D-Tiles scene (§9):** coordinate/elevation alignment of a sample OGC 3D Tiles tileset to the Kiriko Web-Mercator + meters-altitude scene; precise per-feature picking (deck.gl `Tile3DLayer` is tile-level — verify whether a batch/property-table accessor or GPU color-id pass yields stable feature IDs; Cesium `Scene.pick`→`Cesium3DTileFeature` + `pickMetadata` is per-feature); floor filtering via tileset per-feature metadata (only if a floor/level property exists); adapter normalization of renderer-specific hit/world-coord/floor-IDs across the generated-polygon and tiles scenes, with graph picking separate. **[PROTO]**

---

## 9. Authoritative OGC 3D Tiles vs generated schematic fallback **[INF] + primary sources**

If an authoritative indoor model exists as OGC 3D Tiles—whether BIM-derived, textured mesh, point cloud, or another supported content type—that is a different data class from Kiriko's generated schematic polygons. This section maps what is and isn't native, and what an adapter must do.

### 9.1 MapLibre has no native 3D Tiles source

- **[SRC]** The MapLibre style-spec source enum is exactly `vector, raster, raster-dem, geojson, video, image` — there is **no** `3d-tiles`/`tiles-3d` source type, and no built-in 3D-Tiles layer (the built-in layer types are `background, fill, line, symbol, raster, circle, fill-extrusion, heatmap, hillshade, color-relief` + `custom`, §3.1). `@maplibre/maplibre-gl-style-spec@24.10.0/src/reference/v8.json` (`source` array L284–291; `source_vector`/`source_raster`/`source_raster_dem`/`source_geojson`/`source_video`/`source_image`).
- **[INF]** Authoritative 3D Tiles therefore need either a custom/overlay layer (§4) or a dedicated renderer. Options below.

### 9.2 OGC 3D Tiles data model (coordinate + metadata semantics)

- **[DOC]** Spec versions: OGC [3D Tiles 1.0 (18-053r2)](https://docs.ogc.org/cs/18-053r2/18-053r2.html) and [3D Tiles 1.1 (22-025r4)](https://docs.ogc.org/cs/22-025r4/22-025r4.html); community reference spec [CesiumGS/3d-tiles](https://github.com/CesiumGS/3d-tiles/tree/main/specification).
- **Coordinate/transform.** **[DOC]** OGC 3D Tiles uses meters for linear distances, right-handed Cartesian coordinates, and z-up for local Cartesian systems; a tileset's global CRS is often WGS 84 ECEF (EPSG:4978), but may instead be local. A tile may transform its local coordinates into its parent's coordinates, and `region` bounding volumes use EPSG:4979 longitude/latitude/**ellipsoidal height**. [OGC 3D Tiles 1.1 §§6.5–6.6](https://docs.ogc.org/cs/22-025r4/22-025r4.html#units). **[SRC]** MapLibre converts `(longitude, latitude, altitudeMeters)` to conformal Mercator z with `MercatorCoordinate.fromLngLat`; [`mercator_coordinate.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/geo/mercator_coordinate.ts#L99-L115). **[INF] → Alignment risk:** preserve and compose the tileset transforms, convert its declared CRS into MapLibre Mercator, and explicitly reconcile ellipsoidal/local heights with Kiriko's source-first or nominal floor elevations. A shared horizontal origin alone does not establish a shared vertical datum.
- **Per-feature metadata.** **[DOC]** Per-feature application properties live in a **Batch Table** (3D Tiles 1.0), which *"was deprecated in 3D Tiles 1.1"* in favor of glTF `EXT_mesh_features` + `EXT_structural_metadata` property tables (functionally similar; richer types). **[INF] → Floor-filtering gate:** floor/level filtering is possible **only if the tileset's per-feature metadata exposes a floor semantic** (e.g. a `level`/`floor` batch/property). If the tileset carries no such semantic, neither Cesium styles nor deck.gl accessors can *infer* it — you must preprocess/re-author the tileset to add the property. (Kiriko's own data already has per-floor semantics, §2.2/§2.4.)

### 9.3 Option A — deck.gl `Tile3DLayer` over MapLibre (overlay/interleaved)

- **[DOC]** [`Tile3DLayer`](https://deck.gl/docs/api-reference/geo-layers/tile-3d-layer) (`@deck.gl/geo-layers`) *"renders 3d tiles data formatted according to the 3D Tiles Specification and ESRI I3S, supported by the Tiles3DLoader."* It is a `CompositeLayer` that dispatches per tile format to sublayers: `b3dm`/`i3dm` → `ScenegraphLayer` (PBR lighting), `pnts` → `PointCloudLayer`, ESRI `MeshPyramids` → `SimpleMeshLayer`. It is mounted on MapLibre via [`MapboxOverlay`](https://deck.gl/docs/api-reference/mapbox/mapbox-overlay) (§10): **interleaved** renders into MapLibre's WebGL2 context (shared depth → correct occlusion with extruded floors); **overlaid** is a separate canvas (no shared depth → no cross-occlusion).
- **Picking/metadata (tile-level, not per-feature).** **[DOC]** `Tile3DLayer`'s `pickable` prop: *"When picking is enabled, `info.object` will be a `Tile3DHeader` object."* — that is a **tile-level** hit, **not a guaranteed per-feature** pick; `loadOptions.tileset` forwards to loaders.gl `Tileset3D` for metadata access. **[INF]** deck.gl owns the picking but does **not** by itself resolve precise per-feature 3D-Tiles feature IDs from a `Tile3DHeader`; resolving a batch/property-table feature at the hit point needs extra work on top of the tile hit (e.g. an accessor against the loaded tile's batch table, or a GPU color-id pass). This is **renderer-owned picking**, not MapLibre `queryRenderedFeatures`.
- **[INF]** MapLibre interleaving requires WebGL2 (§7.1). Overlaid mode isolates deck.gl in a separate context; confirm the selected deck.gl/luma.gl version's own browser requirements.

### 9.4 Option B — dedicated CesiumJS renderer

- **[DOC]** [`Cesium3DTileset`](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html) (`Cesium3DTileset.fromUrl(...)` → `scene.primitives.add(tileset)`) streams a 3D Tiles tileset with screen-space-error LOD and a GPU-memory cache (`cacheBytes`). It supports `classificationType`, `clippingPlanes`/`clippingPolygons`, and per-feature color blending.
- **Picking/metadata (per-feature object, metadata-dependent identity).** **[DOC]** [`Scene.pick(windowPosition)`](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html#pick): *"When a feature of a 3D Tiles tileset is picked, `pick` returns a [`Cesium3DTileFeature`](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileFeature.html) object."* [`Scene.pickPosition`](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html#pickPosition) *"Returns the cartesian position reconstructed from the depth buffer"*; [`Scene.drillPick`](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html#drillPick) returns all hits at a pixel; [`Scene.pickMetadata`](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html#pickMetadata) picks a metadata value, and `pickMetadataSchema` picks its schema. **[INF]** Unlike deck.gl's tile-level hit, Cesium returns a feature-granular object and depth-derived world position. A durable application feature ID still depends on the tileset carrying suitable feature metadata; renderer object identity alone is not a persistence key.
- **Floor filtering.** **[DOC]** [`Cesium3DTileStyle`](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileStyle.html) applies the [3D Tiles Styling language](https://github.com/CesiumGS/3d-tiles/tree/main/specification/Styling) — e.g. `show: '${Floor} === "B1"'`, `color: { conditions: [...] }` referencing per-feature batch/property values. **[INF]** So floor filtering is declarative **only when the floor semantic exists in feature metadata** (§9.2); absent it, the style can't invent it.
- **[INF]** CesiumJS is a full separate globe/scene renderer (its own camera, depth, coordinate system) — adopting it means a second map surface, not a MapLibre layer; heaviest integration cost.

### 9.5 Shared adapter + implication

- **[INF]** A 3D-Tiles-backed scene and Kiriko's generated-polygon scene need a **shared interaction adapter** that normalizes each renderer's **renderer-specific hit, world-coordinate, and floor-ID** into one editor contract (junction-first, 12 px/10 px hit precedence, §2.3): MapLibre `queryRenderedFeatures` (generated scene), deck.gl `info.object` = `Tile3DHeader` (tile-level, §9.3), or Cesium `Scene.pick` → `Cesium3DTileFeature` + `pickPosition` (per-feature + world coord, §9.4). None of these is interchangeable as-is — deck.gl's tile-level hit in particular cannot stand in for a precise per-feature pick without extra work. The adapter cannot reuse MapLibre `queryRenderedFeatures` for tiles features.
- **[INF]** **Graph picking is separately renderer-owned.** The editable navigation graph is never a 3D-Tiles feature; whichever renderer draws the graph (custom WebGL / three.js / a deck.gl graph layer / Cesium entities) must run its **own** picking for junctions and edges (§5.4-1), and that pick feeds the same shared adapter above. Tile-feature picking and graph-node/edge picking are distinct pipelines.
- **[INF] Revised map gist implication:** authoritative 3D Tiles need a custom/overlay or dedicated renderer; generated schematic polygons can stay native (`fill-extrusion`, §3). Both require shared coordinate + semantic-pick adapters and prototype validation (§8). No final architecture is chosen.

---

## 10. Renderer options (presented, not mandated) **[INF]**

The **concrete capability gap** is a *3D, pickable, editable* graph (nodes/edges at arbitrary per-floor Z). MapLibre 5.24 cannot do that natively (§3.3), and custom-layer geometry isn't natively picked (§5.4-1). But **no external renderer is necessary**: a custom WebGL layer with its own picking can suffice. The options below are primary-source-backed candidates for prototyping; **no final architecture is chosen here**.

1. **Custom WebGL in a `renderingMode:"3d"` layer + own picking.** Fits a MapLibre-only constraint; reuses the shared depth buffer (§4.2); requires self-built picking (§5.4-1) and GL-context-loss handling (§4.3). Kiriko already manages the network overlay out-of-band. Lowest external dependency.
2. **three.js via the custom-layer hook.** **[DOC]** MapLibre ships an official example: [Add a 3D model using three.js](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-3d-model-using-threejs/) (plus [globe](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-3d-model-to-globe-using-threejs/) and [terrain](https://maplibre.org/maplibre-gl-js/docs/examples/adding-3d-models-using-threejs-on-terrain/) variants). Same CustomLayerInterface contract (§4); three.js handles scene/graph/scene-graph and raycasting, but you still own picking against your graph and GL-context-loss. No first-party picking bridge to MapLibre.
3. **deck.gl `MapboxOverlay` (+ `Tile3DLayer` for authoritative 3D Tiles, §9).** **[DOC]** [Using with MapLibre](https://deck.gl/docs/developer-guide/base-maps/using-with-maplibre), [MapboxOverlay](https://deck.gl/docs/api-reference/mapbox/mapbox-overlay), [Tile3DLayer](https://deck.gl/docs/api-reference/geo-layers/tile-3d-layer). **Interleaved** (`interleaved:true`) renders into MapLibre's WebGL2 context for correct cross-layer 3D occlusion and requires WebGL2 plus `maplibre-gl@>3` (5.24 qualifies). **Overlaid** uses a separate canvas and therefore cannot cross-occlude with MapLibre geometry; its browser requirements come from the selected deck.gl/luma.gl version. deck.gl brings its **own picking** (`Deck.pickObject`/`pickMultipleObjects`), but `Tile3DLayer.pickable` returns a tile-level `Tile3DHeader` (§9.3), so it does **not** by itself solve precise per-feature tiles picking. Elevated deck.gl graph layers are possible, but graph picking stays renderer-owned (§5.4-1, §9.5).
4. **CesiumJS (dedicated renderer, only if authoritative 3D Tiles are central).** **[DOC]** [Cesium3DTileset](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html), [Scene.pick/pickPosition/drillPick](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html#pick), [Cesium3DTileStyle](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileStyle.html). A second globe/scene surface, not a MapLibre layer; highest integration cost (§9.4).

**[INF]** In options 1–3, MapLibre remains the base map + extruded-floors renderer; only the graph (and, if chosen, tiles) layer is delegated. None is mandated; the decision belongs to a prototype (§8).

---

## 11. Source & doc reference index

MapLibre GL JS [`maplibre/maplibre-gl-js@v5.24.0`](https://github.com/maplibre/maplibre-gl-js/tree/v5.24.0) (read at the pinned tag; local mirror `/tmp`):

- [`src/style/style_layer/custom_style_layer.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/style/style_layer/custom_style_layer.ts) — `CustomLayerInterface`, `CustomRenderMethodInput`, `is3D`, serialize-throws.
- [`src/webgl/draw/draw_custom.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/webgl/draw/draw_custom.ts) — custom-layer depth-mode dispatch (2d vs 3d).
- [`src/style/style_layer/fill_extrusion_style_layer.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/style/style_layer/fill_extrusion_style_layer.ts) — 3D picking; per-feature scalar `base`/`height` (L56–57); `projectExtrusion(geometry, zBase, zTop, m)` uniform-scalar extrusion (L167–194).
- [`src/data/feature_index.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/data/feature_index.ts) — `grid` vs `grid3D`, `query()`.
- [`src/source/query_features.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/source/query_features.ts) — `queryRenderedFeatures`, `queryIncludes3DLayer` (fill-extrusion only), `queryRenderedSymbols`.
- [`src/source/geojson_source.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/source/geojson_source.ts) — `setData`/`updateData` (unique-ID/`promoteId` diff contract), L255–285.
- [`src/ui/map.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/map.ts) — `queryRenderedFeatures`/`querySourceFeatures`, `setTerrain`, `project`/`unproject`, pitch/zoom defaults (L436–441), canvas-context defaults (L456–462), WebGL2→WebGL1 fallback (L3470–3473), canvas a11y attrs (L3421–3423).
- [`src/ui/camera.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/camera.ts) — `calculateCameraOptionsFromTo`, `freezeElevation`, `prefers-reduced-motion`.
- [`src/ui/handler/cooperative_gestures.ts`](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/ui/handler/cooperative_gestures.ts) — `aria-hidden` overlay.
- Render fixtures: `test/integration/render/tests/{fill-extrusion-*, custom-layer-js/*, high-pitch/*, line-pitch/*}`.

Style spec `@maplibre/maplibre-gl-style-spec@24.10.0/src/reference/v8.json`: layer-type enum, **source enum (vector/raster/raster-dem/geojson/video/image — no 3D Tiles)**, `pitch`/`roll`/`centerAltitude` sdk-support, `paint_fill-extrusion` (`-height`/`-base`/`-vertical-gradient`, **both `minimum: 0`**), `terrain`, `elevation` expression (color-relief only). Docs: https://maplibre.org/maplibre-style-spec/ .

Official MapLibre docs/examples: [Map API](https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/), [CustomLayerInterface](https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/), [QueryRenderedFeaturesOptions](https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/QueryRenderedFeaturesOptions/), [GeoJSONSource](https://maplibre.org/maplibre-gl-js/docs/API/classes/GeoJSONSource/), [Large-data guide](https://maplibre.org/maplibre-gl-js/docs/guides/large-data/), [Extrude polygons for 3D indoor mapping](https://maplibre.org/maplibre-gl-js/docs/examples/extrude-polygons-for-3d-indoor-mapping/), [Display buildings in 3D](https://maplibre.org/maplibre-gl-js/docs/examples/display-buildings-in-3d/), [Add a custom style layer](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-custom-style-layer/), [Add a 3D model using three.js](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-3d-model-using-threejs/), [Get features under the mouse pointer](https://maplibre.org/maplibre-gl-js/docs/examples/get-features-under-the-mouse-pointer/).

OGC 3D Tiles: spec [1.0 (18-053r2)](https://docs.ogc.org/cs/18-053r2/18-053r2.html), [1.1 (22-025r4)](https://docs.ogc.org/cs/22-025r4/22-025r4.html); community spec [CesiumGS/3d-tiles](https://github.com/CesiumGS/3d-tiles/tree/main/specification) (transform, boundingVolume region/box/sphere, Batch Table, [Styling](https://github.com/CesiumGS/3d-tiles/tree/main/specification/Styling)).

deck.gl: [Using with MapLibre](https://deck.gl/docs/developer-guide/base-maps/using-with-maplibre), [MapboxOverlay](https://deck.gl/docs/api-reference/mapbox/mapbox-overlay), [Tile3DLayer](https://deck.gl/docs/api-reference/geo-layers/tile-3d-layer).

CesiumJS: [Cesium3DTileset](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html), [Scene.pick/pickPosition/pickMetadata/drillPick](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html#pick) (Cesium3DTileFeature), [Cesium3DTileStyle](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileStyle.html).

