# 3D rendering architecture spike — gate report

Date: 2026-08-03  
Branch: `spike/3d-rendering-architecture`  
Design: `docs/superpowers/specs/2026-08-03-3d-rendering-architecture-design.md`  
Plan: `docs/superpowers/plans/2026-08-03-3d-rendering-spike.md`  
Issue: [#23 — Choose the 3D rendering architecture](https://github.com/dmalmq/imdf-map-application/issues/23)

## Verdict

The architecture holds. **Gates 1, 3, 4, 5, and 6 pass on measured numbers,
gate 7 now has measured numbers (issue #31's trusted bands do not hold
venue-wide), and no documented flip condition triggered** — the D3 raw WebGL2
path stayed viable, so three.js was not needed. Gate 5 is now confirmed visually
as well as numerically. **Gate 2 is the one failure**, and its cause is no longer
a mystery: MapLibre removes custom layers on context loss and requires the
application to re-add them, so recovery is an application-level contract rather
than anything the renderer can own. The spike found and fixed **eight** real
defects, four of them in the plan's own pinned recipe, which is what a spike is
for.

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

## Gate 2 — Custom-layer interop: **FAIL, with the cause identified**

Verified:
- MapLibre's own layers render correctly with the custom layer present; GL state
  is saved and restored around every draw and every pick pass.
- `webglcontextlost` **and** `webglcontextrestored` both fire and are observed
  when the loss is forced through `WEBGL_lose_context`.

**A custom layer cannot survive context loss on its own.** MapLibre logs the
contract explicitly:

> Custom layer with id 'scene-3d' cannot be restored after WebGL context loss.
> You will need to re-add it manually after context restoration.

MapLibre **removes** the layer, so `render` is never called again and the layer
can never heal itself. Measured on Tokyo with a forced loss/restore cycle:

| | picks in a 8×11 grid | `map.getLayer("scene-3d")` |
|---|---|---|
| before loss | 31 | present |
| after restore | **0** | **absent** |

`stats()` kept reporting 5 draw calls and 5 visible batches throughout, because
those are last-render values and no render ever happened — a reporting trap for
anyone verifying recovery by stats alone. Use `map.getLayer(id)` or a pick.

Two remedies were tried and **both failed**: rebuilding inside the layer's own
`webglcontextrestored` handler (the layer is already gone), and re-adding from
the application on `webglcontextrestored` (loses a race with MapLibre's own
restore) or on the first `idle` after it (never fired in headless Chromium).
The scaffolding is committed with a `KNOWN INCOMPLETE` marker in
`RendererSpike.tsx`.

**Consequence for issue #23:** recovery is an *application-level* contract, not
a renderer-internal one — whichever rendering boundary is chosen, some owner
above the layer must detect restoration and re-add. The correct trigger point is
the one open question and it is unresolved.

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

## Recommended next steps

1. **Settle the context-loss re-add trigger (gate 2).** It is the only gate that
   fails, the cause is known, and the fix is an application-level contract that
   issue #23's chosen boundary has to name an owner for. Needs a headed browser:
   `idle` never fired in headless Chromium after restore.
2. Hand gate 7's numbers to issue #31 (reopened): the venue is not inside the
   trusted bands (combined p90 0.63 m; B1F Yaesu has two coherent 1.3–1.6 m
   pockets), and decide whether the bands need tightening, a per-floor scope, or
   an explicit coverage-difference carve-out for tile-model overhangs.
3. Hand gate 3 to issue #26 with the vsync caveat stated, and gate 1's 8.1 MB
   derived-scene figure as the size input.
4. Resume issue #33's snapping measurement. Its premise is now verified sound
   (see the registration finding above); the `--roles` exporter selector it
   needs is committed.
5. Diagnose the two B1F Yaesu coherent clusters (1.57 m / 1.33 m). Median offset
   there is only 0.083 m, so a global transform error is ruled out — it is
   localised geometry, a stale GDB revision, or a genuine model defect, and that
   distinction decides whether #31 re-certifies with a per-floor band or the
   asset needs revision.

Done during the spike: gate 4's attribution question is resolved (defect 6), the
design spec's matrix instruction is corrected (`3b6d057` on `main`), and gates 2
and 5's visual checks are no longer blocked on capture tooling.
