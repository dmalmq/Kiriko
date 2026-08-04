# 3D rendering architecture spike — gate report

Date: 2026-08-03  
Branch: `spike/3d-rendering-architecture`  
Design: `docs/superpowers/specs/2026-08-03-3d-rendering-architecture-design.md`  
Plan: `docs/superpowers/plans/2026-08-03-3d-rendering-spike.md`  
Issue: [#23 — Choose the 3D rendering architecture](https://github.com/dmalmq/imdf-map-application/issues/23)

## Verdict

The architecture holds. **All six architecture gates pass on measured numbers,
gate 7 now has measured numbers (issue #31's trusted bands do not hold
venue-wide), and no documented flip condition triggered** — the raw WebGL2 path
stayed viable, so three.js was not needed. Gate 5 is confirmed visually as well
as numerically, and gate 2 now passes with its trigger derived from MapLibre's
source rather than guessed: recovery is an application-level contract, and the
application must hook the **Map** `webglcontextrestored` event and wait for
`idle` before re-adding. The spike found and fixed **nine** real defects, four of
them in the plan's own pinned recipe, which is what a spike is for.

**Action that follows: issue #31's conclusion is reopened.** Its falsifier was
named in advance — a p90 above 0.50 m, or any spatially separated coherent
residual above 1.0 m — and gate 7 hit both (combined p90 0.626 m over 1,920
samples; B1F Yaesu clusters at 1.57 m and 1.33 m). This changes **no decision in
this design**: registration accuracy is a data and activation-gate question for
issues #30 and #31, not a renderer-architecture question. The renderer applies
the tileset transform unchanged either way.

Hardware: Intel i9-14900K, NVIDIA RTX 4500 Ada, Windows 11, Chromium headless.
Every number below is from the real JR East assets in `C:/cesium/`, not
synthetic fixtures.

## Gate 1 — Rust deriver: **PASS**

| Fixture | Source GLB | Derived `.kscene` | Ratio | Derive | Encode | Levels | Features | Batches | Largest batch |
|---|---|---|---|---|---|---|---|---|---|
| LumineEst | 13.4 MB | **0.56 MB** | 23.9× | 61 ms | 565 ms | 11 | 2,032 | 63 | 21,024 v |
| **Tokyo** | 179.9 MB | **8.10 MB** | **22.2×** | 1,997 ms | 7,272 ms | 90 | 22,387 | 308 | 164,520 v |
| Shinjuku | 169.2 MB | **9.10 MB** | 18.6× | 1,622 ms | 6,809 ms | 43 | 19,739 | 191 | 312,837 v |

Falsifier was "Tokyo above ~50 MB". Actual: **8.1 MB** — better than the design's
own 20–30 MB estimate, because quantization, oct-encoded normals, dropping the
redundant index buffer, and zstd-19 compound. Tokyo's 22,387 features and
4,702,167 vertices reproduce the design's baseline facts exactly.

Tokyo batches per role: Structure 81, Walkable 80, Stairs 56, Service 39,
Ceiling 34, Opening 12, Context 5, Ramp 1.

Notes for issue #26:
- `encodeMs` is zstd level 19 and dominates derive cost. Level 9 would cut it
  roughly an order of magnitude for a modest size increase; it is an
  ingestion-time, once-per-version cost either way.
- `gatheredPrimitives = 0` on all three assets: every primitive carried identity
  indices, so the de-index gather path is unit-tested only.

## Gate 2 — Custom-layer interop: **PASS** (recovery is an application contract)

MapLibre's own layers render correctly with the custom layer present; GL state is
saved and restored around every draw and every pick pass.

**A custom layer cannot survive context loss on its own**, and MapLibre says so:

> Custom layer with id 'scene-3d' cannot be restored after WebGL context loss.
> You will need to re-add it manually after context restoration.

On loss MapLibre destroys the style outright (`style.destroy(); style = null`)
after snapshotting it; a custom layer cannot survive that serialization. `render`
is never called again, so the layer can never heal itself. Measured on Tokyo
before the fix: **31 picks before a forced loss, 0 after**, `map.getLayer` absent.

`stats()` reported 5 draw calls and 5 visible batches throughout, because those
are last-render values and no render happened — a reporting trap for anyone
verifying recovery by stats alone. Use `map.getLayer(id)` or a pick.

### The trigger, from MapLibre's source

Two things have to be right, and both were wrong at first. The measured event
order for a forced loss/restore cycle:

| # | Event | `isStyleLoaded()` |
|---|---|---|
| 1 | `map` `webglcontextlost` | — |
| 2 | `canvas` `webglcontextlost` | — |
| 3 | `map` `webglcontextrestored` | **false** |
| 4 | `canvas` `webglcontextrestored` | false |
| 5–6 | `styledata` ×2 | — |
| 7 | `map` `idle` | true |

1. **Hook the Map event, not the canvas DOM event.** MapLibre registers its own
   canvas listener at construction and runs the entire rebuild there —
   `setStyle(snapshot, {diff: false})`, `_setupPainter`, `resize`, `_update`,
   `_resizeInternal` — and only then fires `webglcontextrestored` on the Map
   (`maplibre-gl-dev.js:71362`). A canvas listener races that sequence.
2. **Wait for `idle`.** At step 3 the style is still loading and two more
   `styledata` events follow as `setStyle` swaps the style object, so a layer
   added before step 7 is silently dropped again.

So: `map.on("webglcontextrestored")` → `map.once("idle")` → re-add. Verified
through the application with no console assistance:

| | picks in an 8×11 grid | `map.getLayer("scene-3d")` | draw calls |
|---|---|---|---|
| before loss | 31 | present | 5 |
| after restore | **31** | **present** | 5 |

The rebuilt layer is a genuinely new object, and a pick on it returns feature
747 (`Walkable`, level 0) at real venue-local metres — the same identity and
coordinate behaviour gate 4 established.

**Consequence for issue #23:** recovery is an *application-level* contract, not a
renderer-internal one. Whichever rendering boundary is chosen, an owner above the
layer must detect restoration and re-add, restoring active level and context-level
selection. MapLibre also warns that custom-layer **event listeners** do not
survive (`maplibre-gl-dev.js:71340–71343`), so that owner must re-register those
too.

## Gate 3 — Frame time: **PASS (with a stated ceiling)**

Continuous bearing sweep at pitch 55, zoom 17, sampling `requestAnimationFrame`
deltas.

| Scenario | Draw calls | p50 | p95 |
|---|---|---|---|
| Desktop 1440×900, busiest level (58: 2,698 features) | 6 | 16.7 ms | 17.1 ms |
| Desktop 1440×900, all 90 levels visible | **308** | 16.7 ms | 16.8 ms |
| Mobile profile 390×844 @ DPR 2, 4× CPU throttle, single level | 5 | 16.7 ms | 17.5 ms |
| Mobile profile, all levels | 5 | 16.7 ms | 17.3 ms |

**Honest ceiling:** every number sits at the 16.7 ms vsync floor, so this proves
"holds 60 fps with headroom to spare" and does **not** measure how much headroom.
Issue #26 should set budgets from a vsync-uncapped or GPU-timer measurement, and
on weaker GPUs than an RTX 4500 Ada. The mobile "all levels" row reports 5 draw
calls because the context toggle in that run did not take effect before
sampling — treat it as a single-level number.

The batching thesis is confirmed: **23,556 source primitives collapse to 5–6
draw calls per active level, and 308 for the entire 90-level venue.**

## Gate 4 — Picking: **PASS** (identity, attribution, and coordinates)

The GPU feature-ID pass resolves real features, attributes them to the correct
floor, and returns venue-local metres. Two defects had to be fixed first
(defects 6 and 7 below); the numbers here are post-fix.

Measured on Tokyo, active level 0, a 176-point screen grid:

| Property | Result |
|---|---|
| Picks landing on the active level | **4 / 4 — all level 0** (before the fix, some resolved level 58) |
| Returned coordinate | venue-local metres, e.g. `(-13.2, -74.1, -114.7)` |
| Independent coordinate check | **0 out of range** — every returned Z falls inside the picked feature's own `minZ`/`maxZ` (e.g. `-114.7` within `[-115.2, -114.7]`) |
| Feature identity | `featureIndex 747/748` → role `Walkable`, level 0, real `revitUniqueId` |
| Pick latency | **1.2–3.4 ms per call**, including a full pick-pass render plus synchronous `readPixels` |

The attribution proof is a hard one: level 0's lowest feature index is **747**, so
any returned index below it cannot belong to a drawn level-0 batch. Before the
fix, `746` appeared; after it, every hit is a genuine level-0 feature.

Still not exercised:
1. Levels 58 and 30 returned no hits, because the harness aims the camera at a
   batch centroid and those levels' geometry spans several hundred metres. This
   is a harness limitation, not a renderer finding — level 0's evidence is
   unambiguous.
2. The 10 px / 12 px graph precedence path is unit-tested (9 tests in
   `pick.test.ts`) but was never exercised against rendered graph geometry,
   because the spike renders no routing graph.

## Gate 5 — Precision: **PASS** (numerically and visually)

The composition was wrong and is now right; this is the spike's headline finding
(defect 2). After the fix, a known level-0 vertex projects to NDC
`(0.000, 0.042, 0.991)` with `inFrustum: true` while the camera is centred on it,
and the composed model translation matches an independently computed mercator
origin to 7 significant figures: layer `(0.8882346, 0.3937873, 3.7936e-6)` vs
expected `(0.888234603, 0.393787299, 3.7895e-6)`.

Visually confirmed after fixing the capture path. Headless screenshots were
byte-identical regardless of scene content until `preserveDrawingBuffer: true`
was set — it belongs under `canvasContextAttributes` in MapLibre 5.24, not at
the top level of `MapOptions`. With it, captures became content-dependent
(2.18 MB distinct images vs a byte-identical 42 KB before), which is what made
every visual check in this report measurable:

- `assets/visual-active-level.png` — the derived slabs sit exactly over the
  station's platform layout in the basemap. Independent confirmation that gate
  5's placement is correct, from a source the renderer does not control.
- `assets/visual-max-zoom.png` — zoom 21, pitch 55: clean stable edges, no
  z-fighting stripes, no vertex jitter.

## Gate 6 — Floor filtering and occlusion: **PASS**

Repaint-synchronised measurements on Tokyo:

| State | Draw calls |
|---|---|
| Active level 0 (123 features) | 5 |
| Active level 58 (2,698 features) | 6 |
| Context levels on (all 90) | **308** |
| Context levels off | 5 |

Per-feature visibility through the state texture drives this, and batches whose
features are all invisible are skipped wholesale, so the draw-call count is an
honest measure. Occluder fade values are implemented per the visual language
(context 0.24, inactive route floor 0.28, faded occluder 0.15) but their
*appearance* was not visually confirmed, for the headless-capture reason above.

## Gate 7 — Registration: **MEASURED — issue #31's trusted bands do not hold venue-wide**

Tile surface boundaries were measured against the venue GDB's unit-polygon edges on
three floors (four tile levels). **1F passes all three of issue #31's bands; B1F is at
the p90 edge; B1F Yaesu and M2F fail the p90 band, and Yaesu also shows two localized
coherent residuals above 1.0 m.** The registration is sub-metre in the median on every
floor, but the 90th percentile is 0.43–0.92 m, and the venue is not inside the bands.

### Method

1. **Tile side** — new example `core/crates/kiriko-scene/examples/export_level_outline.rs`
   decodes `target/spike/tokyo.kscene`, resolves a level by exact key (or index /
   substring), dequantizes its `Walkable` batches (`local = quantizationOrigin +
   position × quantizationScale`), converts the header's `frame_origin_ecef` to WGS84
   (reproduces the verified `139.764457, 35.678519`, altitude `123.36 m`), and emits
   GeoJSON: one Polygon per triangle with the contract flat-earth lng/lat plus the
   **native venue-local ENU metres** (`e_m`/`n_m`) and triangle mean Z (`z_m`).
2. **GDB side** — the repo's existing gdal3.js wrapper was reused verbatim:
   `server/src/gdb/gdalWorker.mjs` (`getGdal` + `runGdalRequest {op:"convert"}`) staged
   `C:/cesium/NW,POI_20260514東京/JRTokyoSta_3857.gdb.zip` to a `*.gdb.zip` temp path and
   extracted the matched floors' unit layers (`*_Space`) to WGS84 GeoJSON
   (`ogr2ogr -t_srs EPSG:4326`). It runs fine outside the server process; no GDAL
   install and no new packages were needed.
3. **Boundary sampling** — the Walkable batches are closed extruded-slab meshes (top /
   bottom faces are coincident in XY, side walls close the outline), so mesh-boundary
   extraction yields nothing. The 2D union silhouette was extracted by rasterizing
   triangle footprints on a 0.5 m occupancy grid, marking boundary cells (occupied with
   an unoccupied neighbour), and sampling the **exact** triangle edges in those cells
   whose two sides differ in occupancy (sub-mm sample accuracy; the raster only selects
   cells). 600 deterministic samples per floor (120 for M2F — its full silhouette).
4. **Residual** — per sample: planar distance to the nearest GDB unit polygon edge plus
   the offset vector (nearest edge point minus sample point), all in metres.
5. **Frames** — the tile side uses its native ENU metres; the GDB side is projected
   from WGS84 with the **exact** WGS84 tangent-plane radii at the frame origin
   (meridian 110,953 m/°, parallel 90,528 m/°). The contract's rough constants
   (110,540 / 111,320·cos) are used only for the display lng/lat: feeding 110,540 into
   the GDB conversion injects a spurious southward gradient of up to ~2.2 m at the far
   ends (0.37% scale error; the gradient was observed during development and
   disappeared when the exact scales were used).
6. **Clusters** — 40 m grid cells with ≥5 samples and median offset-vector magnitude
   > 1.0 m; 8-connected cells grouped into clusters. Seed-to-seed stability: p50
   ±0.005 m, p90 ±0.05 m.

### Floors compared

| Tile level (TP) | GDB reference layers (physical floor) | Match basis |
|---|---|---|
| `1fl_コンコース_tp_3_45` (TP+3.45) | `JRTokyoSta_1_Space` + `JRTokyoSta_0_Space` + `G空間_1_Space` (1F concourse) | labels + spatial + network altitudes |
| `b1fl_地下コンコース_丸の内_tp_3_12` (TP−3.12) | `JRTokyoSta_B1_Space` + `G空間_B1_Space` + `Yaechika_B1_Space` (B1F) | labels + spatial |
| `b1fl_地下コンコース_八重洲_tp_1_25` (TP−1.25) | same B1F set | labels + spatial |
| `m2fl_東海道新幹線コンコース_tp_6_10` (TP+6.10) | `JRTokyoSta_M2_Space` (M2F) | network altitude exact match (6.10 m) |

Floor pairing was cross-checked against the routing GDB: network `F1` junctions sit at
TP+3.45 (the concourse) and `M2` junctions at exactly TP+6.10, and 1,188 `F1` nodes at
TP+3.45 fall inside `JRTokyoSta_1` units (282 inside `JRTokyoSta_0`) — all three 1F
layers are the same physical floor.

### Residuals (metres, tile boundary → nearest GDB unit edge)

| Floor | samples | p50 | p90 | p95 | max | median offset vector (m) | clusters > 1 m |
|---|---|---|---|---|---|---|---|
| 1F concourse | 600 | 0.182 | **0.433** | 0.550 | 2.54 (to 42 at overhangs) | (−0.057, +0.056) = 0.080 | 0 |
| B1F Marunouchi concourse | 600 | 0.230 | 0.501 | 0.694 | 5.23 | (−0.116, +0.038) = 0.122 | 0 |
| B1F Yaesu concourse | 600 | 0.275 | 0.921 | 1.924 | 20.83 | (−0.004, +0.083) = 0.083 | 2 |
| M2F Shinkansen concourse | 120 | 0.239 | 0.678 | 1.194 | 1.13 | (−0.156, +0.179) = 0.238 | 0 |
| **Combined** | 1920 | 0.230 | **0.626** | 0.905 | 20.83 | — | 2 |

### Issue #31 bands

1. **Trusted horizontal residual p90 ≤ 0.50 m — NOT HELD.** 1F passes (0.433); B1F
   Marunouchi sits at the band edge (0.501; 0.48–0.52 across sampling seeds); B1F
   Yaesu (0.921) and M2F (0.678) fail; combined 0.626 fails.
2. **Median coherent shift ≤ 0.15 m — MARGINAL.** Interpreting "coherent shift" as the
   magnitude of the median offset vector, 1F (0.080), B1F Marunouchi (0.122) and B1F
   Yaesu (0.083) pass; M2F fails (0.238). Interpreting it as the median residual
   distance, every floor is 0.18–0.28 m — above 0.15 m everywhere except 1F (0.182).
3. **No spatially separated coherent residual above 1.0 m — NOT HELD (B1F Yaesu).**
   Two localized clusters: (a) E 400–440 / N 320–360 (lng ≈ 139.7690–139.7694, lat ≈
   35.6814–35.6818), 20 samples, median shift 1.57 m, offset (+1.33, −0.83); (b) E
   360–400 / N 240–280, 6 samples, median shift 1.33 m, offset (−1.18, +0.60). 1F,
   B1F Marunouchi and M2F have no such clusters.

**Verdict: issue #31's trusted bands are reopened with real numbers.** The two datasets
are sub-metre apart in the median on every measured floor — a genuine, usable
registration — but the 90th percentile is 1.3–1.9× the 0.50 m band, and B1F Yaesu has
two coherent 1.3–1.6 m pockets.

### Approximations and limitations

- **Flat-earth ENU→WGS84** (contract formula) is used only for the display GeoJSON.
  The distance measurement runs in native ENU metres on the tile side and exact
  WGS84 tangent-plane projection (110,953 m/°N, 90,528 m/°E at the frame origin) on
  the GDB side; curvature terms are ~0.02 m over the venue. Using the contract's
  110,540 m/°N constant for the GDB would bias north residuals by up to ~2.2 m at the
  far ends — measured and rejected.
- **1F match was ambiguous and is resolved as: three GDB layers, one physical floor.**
  `JRTokyoSta_1_Space` ("1F", ordinal 1) covers the central/east concourse, while
  `JRTokyoSta_0_Space` ("JR東京駅", floor `F1`, ordinal 0) covers the west part and
  `G空間_1_Space` is GranSta 1F. Evidence they are the same TP+3.45 floor: the unit
  tessellations tile without overlap (1/667 and 4/169 centroid intersections), and
  network-junction altitudes place 1,188+282 `F1` nodes at TP+3.45 inside them.
  Without `JRTokyoSta_0`, the 1F comparison degrades to p50 ≈ 25 m because the tile's
  concourse extends ~80 m west / ~22 m south / ~20 m east of the `J1`-only coverage —
  a real coverage difference between the tile model and the GDB's 1F layer.
- **B1F is one GDB floor, two tile levels.** The GDB models the B1 underground as
  station + GranSta (`G空間_B1`) + Yaesu underground mall (`Yaechika_B1`); the tiles
  split it into Marunouchi and Yaesu concourses. Both tile levels were measured
  against the same B1F reference set.
- **M2F is one GDB floor, five tile levels (TP+4.45 … +6.75).** The Shinkansen
  concourse level (TP+6.10, network `M2` altitude exactly 6.10 m) was chosen; the
  other four M2F levels were not measured. Because the tile level is a strict subset
  of the GDB M2 floor, some of its boundary samples lie *inside* GDB units with no
  coincident unit edge — that inflates M2F's p90 (0.678) and median offset (0.238)
  regardless of registration quality.
- **B1F Yaesu east protrusion.** The tile models a passage at E 428–437 / N 347–378
  (lng ≈ 139.7693, lat ≈ 35.6814–35.6818) where no GDB B1 unit edge exists within
  ~20 m (measured 3–21 m; the 20.83 m max). This is a coverage difference, not a
  shift; it also drives the 1.57 m cluster (a). The 1F max is similarly unstable
  (2.5–42 m across seeds) at the east/south overhangs; max is reported but not banded.
- **Silhouette extraction** uses a 0.5 m occupancy raster for boundary-cell detection
  only; the sampled points are exact triangle edges (sub-mm). u16 quantization of the
  tile positions contributes ~7 mm. `Structure`-role geometry (columns, walls) is
  excluded: it is not walkable-surface boundary and would add interior edges.
- **Sampling** is deterministic (fixed seed, 600 per floor; 120 = full M2F silhouette).
  gdal3.js ran directly outside the server process (imported from
  `server/src/gdb/gdalWorker.mjs`); the alternative GDB copy at
  `C:/cesium/Takanawa Gateway/` was not used.

## Defects found and fixed

1. **MRT fragment outputs without explicit locations** (`sceneLayer.ts`). GLSL ES
   3.0 requires `layout(location = N)` once a shader declares more than one
   output unless `EXT_blend_func_extended` is enabled; the program failed to link
   on Chromium/ANGLE and the scene never drew. Fixed with explicit locations.
2. **Wrong MapLibre matrix — the plan's error.** The design pinned
   `options.modelViewProjectionMatrix`, whose doc comment reads "world space to
   clip space". Measured: that matrix consumes mercator **× worldSize** (pixel)
   coordinates, while `options.defaultProjectionData.mainMatrix` consumes
   mercator `[0, 1]` — the space the model matrix produces. Feeding the frame
   origin to `mainMatrix` yields NDC x = **0** with the camera centred on it;
   `modelViewProjectionMatrix` yields NDC x = **−4.88**, i.e. the whole venue
   ~1.1 mercator units off-screen. **The design spec must be corrected.**
3. **Pick position read from the wrong attachment.** With MRT, `readPixels`
   samples whatever `readBuffer` names; the second read had no `readBuffer` call
   and re-sampled attachment 0, so the "world position" was the packed
   feature-id colour reinterpreted as floats — which is why every pick reported
   the same `(0.9, 0.4, 0)`. Fixed with explicit `readBuffer` calls, and the
   float path now emits venue-local metres directly from the shader instead of
   round-tripping through view space.
4. **Multi-table metadata silently misattributed** (`kiriko-scene/src/glb.rs`).
   Feature ids are property-table-local and `GlbPrimitive` records no table
   index, so concatenating tables would mislabel every row past the first. Now
   rejected loudly; all three measured assets ship exactly one table.
5. **Role mapping dropped 808 stair features** (`kiriko-scene/src/roles.rs`).
   Decoding the real `category` column showed Revit models stairs as `Runs` (529)
   and `Landings` (279) — the actual walkable stair geometry — plus `Supports`
   (138). The plan's rule list left all of them in `Context`, which would have
   broken issue #32's conveyance treatment and issue #25's route storytelling.

6. **Interpolated feature index caused off-by-one picks** (`sceneLayer.ts`).
   `v_featureIndex` was a plain `float` varying, so a triangle whose three
   vertices all carry feature `747` interpolates to `746.9999…` across the face,
   and `int()` truncates to `746` — a pick silently attributed to the wrong
   feature and, because features are ordered by property table rather than by
   floor, usually the wrong **floor**. Most pixels were correct, which is what
   made it look like a state-texture or stride bug. Fixed by `flat`-qualifying
   `v_featureIndex` and `v_state`; both are per-feature constants, so
   interpolating them was never meaningful. The offline invariant check that
   ruled out the deriver is worth keeping in mind as a technique: 13,334 sampled
   feature references across all 308 batches, zero violations, proved the data
   was clean and forced the search into the renderer.
7. **Pick coordinates were raw u16, not metres** (`sceneLayer.ts`). Because the
   precision recipe folds each batch's quantization into `u_matrix`, the shader's
   `local` value carries raw `0..65535` units — visible as a returned "position"
   of `(13580, 49373, 65535)`. Fixed with dedicated `u_localOrigin`/`u_localScale`
   uniforms used only for the pick output, leaving the matrix fold intact.
8. **Every visual gate was silently unmeasurable** (`RendererSpike.tsx`).
   Headless screenshots of the MapLibre canvas came back byte-identical
   regardless of scene content, which reads as "the renderer draws nothing" and
   cost real diagnosis time before the cause was clear. A WebGL canvas needs
   `preserveDrawingBuffer: true` to survive capture, and in MapLibre 5.24 it
   belongs under `canvasContextAttributes`, not at the top level of `MapOptions`
   — where it type-errors. With it set, captures became content-dependent
   (2.18 MB of distinct images vs a byte-identical 42 KB), unblocking gate 5's
   visual check and making gate 2's failure observable at all.
9. **`sceneRef.current` was never assigned** (`RendererSpike.tsx`). The ref was
   read in three places and nulled on teardown, but never set, so every consumer
   bailed on `!scene` — including the context-loss re-add (which is why gate 2
   still failed after the trigger was correct) and the click pick readout. Gate 4
   measured through `window.__spikeScene` and `pickAt` from the console, so it
   never exercised the app's own path and the wiring gap stayed invisible.
   A reminder that measuring around the application can hide application bugs.

Plan bugs also caught before they shipped: a payload alignment assumption that
made `Uint32Array` views throw (`featureIndicesOffset` landed at byte 30); a
`discard when v_state.r < 0.5` rule that would have discarded every faded feature
(0.15/0.24/0.28) and silently disabled gate 6; a double-transform between the
pinned precision recipe and the shader outline; and `in float a_featureIndex`
against `Uint32Array` data, which GLSL ES 3.0 forbids.

## Finding for issues #26, #30, and #33: no conveyance semantics in the tiles

None of the three assets contains an `Escalator` or `Elevator` category. Tokyo's
19 categories are Walls 17,116 · Floors 2,341 · Ceilings 708 · Runs 529 ·
Stairs 451 · Mechanical Equipment 344 · Landings 279 · Columns 279 · Doors 153 ·
Supports 138 · then nine categories with ≤10 features each.

So **conveyance identity cannot come from tile metadata**; it must come from the
canonical GDB/graph association that issue #30 already makes the source of
canonical identity. This strengthens the design's insistence that the tiles
scene keeps GDB/IMDF data as an invisible semantic layer.

## Finding for issue #33: the routing network *is* registered with the venue

A first pass at #33 reported that `net_junction` / `net_path` store decimal
degrees while declaring EPSG:3857, placing the routing graph ~670 m west of the
venue. **That is wrong, and it is recorded here so nobody chases it.** Two
independent checks (`.diag/net-srs-truth.mjs`, `.diag/net-coverage.mjs`):

1. Dumped without `RFC7946=YES`, `net_junction` coordinates come out as
   `15557679.9, 4256064.0` — genuine 3857 metres, matching the declared
   `PROJCRS["WGS 84 / Pseudo-Mercator"]`. The earlier probe used `RFC7946=YES`,
   which **always** reprojects to WGS84, so its "raw" degrees were an artifact
   of the dump options, not the data.
2. The offset came from sampling the **first 3 of 10,118** junctions in file
   order, which happen to sit at the western extent edge (`139.757017` is
   exactly the layer's `minLng`). Measured across all of them:

| Measure | Value |
|---|---|
| Extent | 1,758 m × 2,513 m |
| Nearest junction to the venue frame origin | **22.2 m** |
| Junctions within 100 m / 300 m / 1 km | 278 / 1,589 / 7,624 |

The network covers the station complex and registers with the venue, so #33's
premise holds and its snapping measurement can proceed. Method note for whoever
takes it: never characterise a 10k-feature layer from its first few features,
and never read coordinates out of an RFC7946 dump.

## Validation

- `cargo test --manifest-path core/Cargo.toml -p kiriko-scene` — 13 tests pass.
- `pnpm exec vitest run src/spikes/renderer` — 11 tests pass.
- `pnpm exec tsc --noEmit` — zero diagnostics.
- `pnpm exec vite build` — success (1,918.13 kB / 599.75 kB gzip).

## 2026-08-04 follow-up pass — Yaesu clusters diagnosed; the 0.50 m collision between #31 and #33 settled

This pass executes next-step items 1 and 2 in one measurement run: it identifies
what the two B1F Yaesu coherent clusters physically are (Phase 1), measures the
graph/facility association distances #33 needs (Phase 2), and reconciles the two
roles of `0.50 m` into one recommendation (Phase 3). All GDAL work ran serially
in one agent (two earlier concurrent agents produced misleading Emscripten FS
failures); scripts are in `.diag/` (gitignored): `yaesu-clusters.mjs`,
`assoc-distances.mjs`, `probe-network.mjs`, `probe-units.mjs`. Raw outputs in
`target/spike/out/gate33/` (`yaesu-clusters.json`, `assoc-distances.json`).

### Phase 1 — what the two B1F Yaesu clusters actually are (issue #31)

**Verdict: both clusters are localised tile-vs-GDB model-boundary (coverage)
differences, not a stale GDB revision, not a displacement, and not a
misplacement defect. The asset does not need geometric revision for them.**

**Vintage comparison kills the stale-revision hypothesis.** The B1 unit layers
of the two GDB vintages are geometry-identical: 1,909 units each; 1,890 matched
by `id`; **0 with any vertex displaced more than 1 cm**; 0 added, 0 removed in
0625. (`G空間_B1` has one duplicated id pair, leaving 19 ids that are present in
both vintages but not uniquely matchable; that does not affect the result.)

| Vintage pair (JRTokyoSta B1 layers) | Units 0514 | Units 0625 | Matched by id | Moved > 1 cm | Added | Removed |
|---|---|---|---|---|---|---|
| `JRTokyoSta_B1_Space` + `G空間_B1_Space` + `Yaechika_B1_Space` | 1,909 | 1,909 | 1,890 | **0** | 0 | 0 |

**Cluster (b) — E 360–400 / N 240–280 (10 samples, median shift 1.33 m): a
~1.3 m tile-model overhang.** All ten samples lie on tile feature 247
(`98b4f0da-…-003dce1b`, `Walkable`, 80 triangles, E 353–422 / N 266–346), on the
silhouette edge facing unit `JRTokyoSta_B1_Space bd9f6b4a` (category B001,
4,273.5 m²). Every sample is outside the unit's polygon, and the nearest unit
edge lies **inside** the tile footprint at the sample (offset along the tile
interior direction +0.53 m median, 100% into the tile): the tile walkable
surface extends ~1.3 m beyond the unit edge, which no B1 unit (any layer) covers.
Nearest-unit offset (−1.18, +0.60) m, distance 1.32 m. This is precisely the
"coverage-difference carve-out for tile-model overhangs" gate 7's report
contemplated.

**Cluster (a) — E 400–440 / N 320–360 (20 samples in the gate-7 seed, median
shift 1.57 m): the border zone of a diagonal passage the GDB models
differently.** The full silhouette has 43 samples in that bbox; they split by
nearest unit:

| Nearest unit | samples | median offset (m) | median dist (m) | character |
|---|---|---|---|---|
| `309ed58f` B001 (5,993.8 m²) | 29 | (+0.47, +0.30) | 4.61 | mix of well-registered edge samples and the protrusion (max 17.55 m) |
| `af777c42` B023 (13.6 m²) | 5 | (+2.69, −0.83) | 2.82 | tile surface 2.8 m from this tiny unit |
| `23b6a1b1` B029 (12,877.5 m²) | 4 | (−0.71, +0.22) | 0.74 | ordinary sub-metre residual |
| `bd9f6b4a` B001 (4,273.5 m²) | 5 | (−0.28, +0.14) | 0.31 | well registered |

The 20-sample gate-7 cluster (offset (+1.33, −0.83)) is the median of the two
borders: the passage's SW start runs 2.6–2.8 m from the edges of `309ed58f` /
`af777c42` (tile feature 7430 `ecf46c5f-…-007aa35a`, E 378–438 / N 330–395), then
the same tile surface continues NE for up to **17.5–20.8 m with no B1 unit
coverage at all** (25 silhouette samples > 1.5 m not inside any unit), then
converges back to **0.31 m** at its NE end (E 425–437 / N 381–384). The offset
rotates continuously along the passage (from (+2.7, −0.8) to (−1.3, −13.7)),
so a rigid displacement of the unit is excluded; the same unit `bd9f6b4a` is
registered to 0.31 m at the same time its cluster-(b) edge shows 1.32 m.

**Carve-out quantification (full 755-sample B1F Yaesu silhouette, 0514):**

| Set | p50 | p90 | p95 | max |
|---|---|---|---|---|
| Full silhouette (this pass, n=755) | 0.273 | 0.917 | 1.924 | 17.55 |
| gate 7 (deterministic 600-sample seed, for reference) | 0.275 | 0.921 | 1.924 | 20.83 |
| Excluding samples > 1 m from **any** unit edge and not inside any unit (coverage-difference carve-out, 70 samples) | 0.249 | **0.608** | 0.845 | 0.99 |
| Excluding samples > 1.5 m similarly (40 samples) | 0.255 | 0.657 | 1.148 | 1.48 |

The carve-out drops Yaesu's p90 from 0.92 m to **0.61–0.66 m** — still above the
0.50 m band. So even after removing the two clusters and the protrusion, B1F
Yaesu's registration noise is genuinely ~0.6 m at p90; the 0.50 m trusted band
does not describe that floor with or without the carve-out.

### Phase 2 — graph and facility association distances (issue #33)

**Floor-key mapping** (gate-7 floor set, same as the registration table):
`F1` → `1fl_コンコース_tp_3_45` (TP +3.45); `B1` → `b1fl_地下コンコース_丸の内_tp_3_12`
(TP −3.12) ∪ `b1fl_地下コンコース_八重洲_tp_1_25` (TP −1.25), union surface;
`M2` → `m2fl_東海道新幹線コンコース_tp_6_10` (TP +6.10). The network's `FLOOR`
values are exactly `F1`/`B1`/`M2` (5,230/2,681/144 junctions of 10,118; 13,132/
6,208/386 paths of 25,625; 819/782/84 facilities of 2,591). Vintage 20260514
primary (gate 7's vintage — registration numbers are directly comparable);
20260625 secondary (identical to within measurement noise: layer counts 10,098/
25,587/2,596; combined p90 deltas ≤ 0.08 m for junctions/paths/facilities).
"Venue" scope = inside the floor's walkable tile bounding box + 20 m margin; the
unscoped district-wide sets are reported as context where meaningful. Horizontal
distance = 0 inside a filled walkable triangle, else distance to the nearest
triangle edge. Vertical = |junction `altitude` − assigned level TP| (junction
`altitude` is TP-metres: F1 p50 = 3.45, M2 p50 = 6.10, matching the level names
exactly; scene `source_elevation_meters` carries the same plane with a constant
−87.355 m scene-z offset, verified on all four levels).

**Junctions — horizontal (in-venue) and vertical:**

| Floor | n (venue/total) | p50 | p90 | max | ≤ 0.50 m | 0.50–3.0 m | > 3.0 m |
|---|---|---|---|---|---|---|---|
| F1 | 2,048/5,230 | 0.000 | 65.97 | 187.6 | 55.9% | 4.6% | 39.5% |
| B1 | 963/2,681 | 0.000 | 74.99 | 152.3 | 56.0% | 2.4% | 41.6% |
| M2 | 86/144 | 0.000 | 0.209 | 0.291 | **100%** | 0% | 0% |
| **Combined** | 3,097/8,055 | 0.000 | 66.98 | 187.6 | 57.1% | 3.8% | 39.1% |

| Floor | n | vertical p50 | vertical p90 | vertical max | ≤ 0.50 m | 0.50–3.0 m | > 3.0 m |
|---|---|---|---|---|---|---|---|
| F1 | 2,048 | 0.000 | 1.000 | 3.30 | 83.2% | 16.4% | 0.4% |
| B1 | 963 | 0.420 | 0.750 | 3.36 | 84.1% | 15.1% | 0.8% |
| M2 | 86 | 0.000 | 0.000 | 0.00 | 100% | 0% | 0% |
| **Combined** | 3,097 | 0.000 | 1.000 | 3.36 | 83.9% | 15.5% | 0.5% |

The M2F floor is registered essentially perfectly (max 0.291 m, 100% ≤ 0.5 m) —
its gate-7 p90 failure (0.678) is a strict-subset artifact of the boundary
sampling (the tile level is a subset of the GDB floor; some boundary samples lie
inside GDB units), not a registration error.

**Paths (`net_path`, sampled at vertices + 1 m steps; `net_path` has no Z —
verified by dumping without `-dim XY` — so the vertical measure for paths is
n/a; plane agreement is reported via endpoint junction altitudes below):**

| Floor | edges | in-venue samples | p50 | p90 | max | ≤ 0.50 m | 0.50–3.0 m | > 3.0 m |
|---|---|---|---|---|---|---|---|---|
| F1 | 13,132 | 60,303 | 0.000 | 77.28 | 230.5 | 54.9% | 2.1% | 43.0% |
| B1 | 6,208 | 27,188 | 0.000 | 64.02 | 158.7 | 60.9% | 1.4% | 37.7% |
| M2 | 386 | 1,330 | 0.000 | 0.000 | 0.401 | **100%** | 0% | 0% |
| **Combined** | 19,726 | 88,821 | 0.000 | 71.33 | 230.5 | 57.4% | 1.8% | 40.7% |

**Connector endpoints** — junctions incident to inter-floor edges, identified
from the network topology: a `net_path` edge whose `FNODEID`/`TNODEID` junctions
have different `FLOOR` values. 1,341 of 25,625 edges (5.2%) are inter-floor;
top pairs `B1→F1` (662), `F1→F2` (195), `B1→B2` (146), `F1→M2` (34). Venue-scoped
endpoints (inside the endpoint's floor bbox + 20 m): 531 F1 + 279 B1 + 32 M2 =
842. Measured against the floor's Stairs+Ramp surface (the geometry an
inter-floor junction should sit on) and, for reference, the walkable surface:

| Floor | n | vs Stairs/Ramp p50 / p90 / max | ≤ 0.50 / mid / > 3 | vs walkable p50 / p90 / max | ≤ 0.50 / mid / > 3 | vertical ≤ 0.50 m |
|---|---|---|---|---|---|---|
| F1 | 531 | 23.7 / 149.0 / 258.6 | 10.2% / 6.8% / 83.1% | 0.21 / 65.9 / 187.6 | 58.8% / 7.2% / 34.1% | 88.7% |
| B1 | 279 | 27.5 / 93.5 / 155.4 | 20.8% / 10.4% / 68.8% | 0.78 / 80.9 / 148.8 | 48.7% / 5.4% / 45.9% | 83.9% |
| M2 | 32 | 0.31 / 5.02 / 7.50 | 53.1% / 9.4% / 37.5% | 0.20 / 0.28 / 0.29 | 100% / 0% / 0% | 100% |
| **Combined** | 842 | 21.5 / 127.2 / 258.6 | 15.3% / 8.1% / 76.6% | 0.23 / 70.2 / 187.6 | 57.0% / 6.3% / 36.7% | ~84–89% |

Connector endpoints sit on walkable surface (49–100% ≤ 0.5 m) and on their floor
plane (84–100% ≤ 0.5 m), but mostly **not** on Stairs/Ramp polygons (10–53%
≤ 0.5 m). This is an asset content gap, not a network error: the Tokyo tiles
carry almost no conveyance semantics (17,116 Walls / 2,341 Floors / 708 Ceilings
/ 529 Runs / 451 Stairs / 344 Mechanical / 279 Landings / 279 Columns / 153 Doors
/ 138 Supports, then nine categories with ≤ 10 each — **0 Escalator, 0 Elevator**),
so "associate the connector to the stair geometry" has almost nothing to
associate to. Inter-floor path samples (both endpoints in venue, 2,654 samples):
p50 0.000, p90 51.6, max 150.5; 57.3% ≤ 0.5, 10.9% mid, 31.7% > 3.

**Facility anchors (`Facility_Merge`, floor field `F1`/`B1`/`M2`; no altitude
field — vertical measure n/a, stated):**

| Floor | n (venue/total) | p50 | p90 | max | ≤ 0.50 m | 0.50–3.0 m | > 3.0 m |
|---|---|---|---|---|---|---|---|
| F1 | 598/813 | 0.000 | 51.6 | 160.2 | 64.7% | 7.7% | 27.6% |
| B1 | 325/765 | 0.000 | 72.5 | 152.0 | 58.5% | 5.8% | 35.7% |
| M2 | 44/75 | 0.198 | 4.89 | 5.47 | 79.5% | 2.3% | 18.2% |
| **Combined** | 967/1,653 | 0.000 | 55.7 | 160.2 | 63.3% | 6.8% | 29.9% |

**Coverage diagnostic** — in-venue items > 3 m from the measured floor surface,
re-measured against the walkable union of other same-ordinal tile levels of the
same asset (F1: `tp_0`, `1fl`, `1fl_トフロム八重洲`, `1fl_東京ミッドタウン八重洲`,
`1fl_八重洲地下街`; B1: `b1fl`, `東京駅コンコース地下1階`; M2: `m2fl`, `m2fl_tp_4_45`,
`m2fl_北町ダイニング`, `m2fl_東海道新幹線日本橋コンコース`):

| Floor | junctions > 3 m | covered by same-ordinal levels | facilities > 3 m | covered |
|---|---|---|---|---|
| F1 | 809 | 216 (27%) | 165 | 55 (33%) |
| B1 | 401 | 120 (30%) | 116 | 49 (42%) |
| M2 | 0 | — | 8 | 8 (100%) |

So the > 3.0 m tail (~30–40% of in-venue items) is dominated by items on *other
levels or buildings of the same floor ordinal*, not by association ambiguity:
27–42% of them are within 3 m of another same-ordinal tile level, and the rest
concentrate in footprint pockets of the measured floors (e.g. 71 F1 junctions in
the E 440–500 / N 380–450 pocket, median ~47 m) or adjacent buildings. The
0.50–3.0 m band — the genuine ambiguity range — holds only ~2–8% of items
depending on class.

### Phase 3 — reconciled band recommendation (issues #31 and #33 together)

**How much of an association distance is registration noise vs ambiguity.**
The measured floors register to the tiles at p50 0.18–0.28 m and p90 0.43–0.92 m
(gate 7, unchanged; Yaesu 0.92 m raw / 0.61 m with the coverage carve-out). The
graph and facility association distances add nothing on top: their p50 is 0.00 m
for junctions, path samples and facilities (more than half of those in-venue
items sit *inside* the walkable surface), connector endpoints sit on walkable at
p50 0.2–0.8 m, and the distances in the
0.5–3.0 m band are dominated by the same registration/boundary noise, not by
topological ambiguity. Raising or keeping a threshold therefore mostly trades
against the registration noise, and the noise is per-floor (1F 0.43, B1M 0.50,
B1Y 0.92/0.61, M2F 0.68-but-artefactual).

**Recommendation for #33 (auto-association distance).** Replace the flat
`≤ 0.50 m` auto band with a per-floor threshold of `max(0.50 m, 1.25 × floor
registration p90 with the coverage carve-out)` — concretely **F1 0.55 m, B1F
0.65 m, M2F 0.50 m** (M2F's measured association is ≤ 0.3 m, so 0.50 stays).
A venue-wide simplification with the same effect is **auto ≤ 1.0 m everywhere**:
the sensitivity data show that moving the auto boundary from 0.50 m to 1.0 m
adds only ~1 percentage point of auto-associations (the 0.50–1.0 m band holds
1.0–1.2% of in-venue junctions; facilities ~0.2–2.3%) while covering every
floor's registration p90 with margin — eliminating the systematic misclassification
of correct B1F Yaesu associations (up to 0.92 m of legitimate noise) that the
0.50 m threshold causes. Keep the 0.50–3.0 m producer-review band (with the
recalibrated auto edge, it becomes the true ambiguity band, holding ~2–8% of
items) and keep > 3.0 m as no-association, but note that 27–42% of the > 3 m
tail maps to *other same-ordinal tile levels of the same asset*: the association
should be tried per level (altitude first, then horizontal) before giving up.

**Recommendation for #31 (trusted registration band).** Re-certify with two
changes, both evidenced above: (1) a **coverage-difference carve-out** — exclude
tile-boundary samples that are > 1 m from every GDB unit edge and inside no unit
(this is exactly the two Yaesu clusters and the east protrusion; the carve-out
is confirmed as the right frame because the 0625 GDB is geometry-identical to
0514 and the offsets vary continuously along the features involved, so neither
revision nor displacement explains them); and (2) **per-floor p90 bands** —
1F 0.50 m (passes, 0.433), B1F Marunouchi 0.50 m (edge, 0.501), B1F Yaesu
0.65 m (0.608 carved; 0.921 raw — the floor genuinely needs a wider band), M2F
0.70 m (0.678, but inflated by the strict-subset sampling artifact; direct
association shows ≤ 0.3 m). Combined-with-carve-out p90 for the venue is ~0.61 m
(Yaesu) to 0.43–0.68 m per floor, so no single 0.50 m band describes the asset.

**What, if anything, blocks activation of the supplied Tokyo asset.**
Nothing blocks *rendering* activation: gates 1–6 pass, the kscene is registered
to the venue in the median on every floor (median offset vectors 0.080–0.238 m),
and the two Yaesu pockets are localised boundary differences, not global
misregistration. Three decisions gate #33 activation specifically: (1) the
0.50 m collision — resolved above (per-floor auto band, or 1.0 m flat); (2) the
asset's near-total absence of conveyance semantics (0 Escalator / 0 Elevator,
451 Stairs triangles venue-wide) — connector endpoints can only associate via
walkable surface and floor plane (49–100% and 84–100% ≤ 0.5 m), never via stair
polygons (10–53%), so any conveyance-specific association rule must not require
stair geometry; (3) per-level association for the ~30–40% of in-venue items that
are > 3 m from their floor's measured surface (they belong to other same-ordinal
levels of the same asset or adjacent buildings).

**Stated limitations.** (1) `net_path` carries no Z (verified), so path
vertical is reported via endpoint junction altitudes only. (2) Facility anchors
have no altitude field; vertical n/a. (3) B1/M2 junctions were assigned to a
level by horizontal containment/nearest-surface; junctions at other B1/M2
sub-level altitudes (e.g. −2.7, −6.0) are still counted in the floor class and
mostly land in the > 3 m bucket — the coverage diagnostic separates those that
another same-ordinal tile level covers. (4) The same-ordinal union for the
coverage diagnostic uses the levels named above, a subset of the asset's full
ordinal sets (the asset contains district-wide levels — Yurakucho, Otemachi,
Ginza, Hibiya B1F etc.); the covered fractions are therefore lower bounds. (5)
The 20260514 `network_WebMercator.gdb.zip` and `point_facility_WebMercator_202006.gdb.zip`
were recreated from their unzipped directories during this pass after a cleanup
bug deleted the original archives; the parent agent verified the recreated zips
are entry-for-entry identical to the directories (662/662 and 254/254 files, no
size or content mismatch), which proves zip ≡ directory *now* — it cannot
retroactively prove the original zips matched before deletion, though nothing in
any measurement depends on archive structure rather than content. (6) All GDAL
work in this pass ran serially in one process, per the concurrency constraint.

## Outcome

Every question this spike was created to answer is now closed on the issue
tracker. Recorded here so the report does not read as if work is still pending.

| Issue | Outcome |
|---|---|
| #23 Rendering architecture | **Closed.** All six gates pass. Recovery owner named: `src/map/IndoorMap.tsx`, the component that constructs the MapLibre instance. Dormant until the custom layer ships — production uses only native layers today, which MapLibre restores itself. |
| #26 Capability / accessibility / performance gates | **Closed.** One 3D tier, no degraded middle: WebGL2 + explicit MRT locations + `EXT_color_buffer_float` all required, anything less gets the 2D fallback as a peer view. Budgets are structural, not temporal. Tokyo is the reference ceiling. |
| #31 Registration | **Closed, re-certified.** Per-floor bands (1F 0.50 / B1F Marunouchi 0.50 / B1F Yaesu 0.65 / M2F 0.70) plus the coverage-difference carve-out. Not activation-blocking. |
| #33 Graph snapping | **Closed.** Auto-association raised to a flat **1.0 m** venue-wide; 0.5–3.0 m producer review retained; level resolved by altitude before distance; conveyance association never requires stair geometry. |

**The `rgba8` pick path in this spike is evidence, not a supported path.** #26
requires `EXT_color_buffer_float`, because the packed-depth fallback returns an
approximate position — precisely the degraded middle tier that decision refuses.
It stays here because measuring it is what justified ruling it out.

Two things deliberately left open, both recorded on the issues:

1. **Frame-time budgets.** Every frame figure here sits on the 16.7 ms vsync
   floor on an RTX 4500 Ada, so committing them would commit an unfalsifiable
   number. A vsync-uncapped or GPU-timer run on weaker GPUs sets them; this
   harness already does everything else that run needs.
2. **Delivery sequencing** — issue #28, the last open question in the workstream.

Done during the spike: gate 4's attribution question resolved (defect 6), the
design spec's matrix instruction corrected (`3b6d057` on `main`), and the visual
gates unblocked by fixing the capture path (defect 8). The spike branch is
disposable and is not merged to `main`.
