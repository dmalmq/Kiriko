# 3D rendering architecture spike — gate report

Date: 2026-08-03  
Branch: `spike/3d-rendering-architecture`  
Design: `docs/superpowers/specs/2026-08-03-3d-rendering-architecture-design.md`  
Plan: `docs/superpowers/plans/2026-08-03-3d-rendering-spike.md`  
Issue: [#23 — Choose the 3D rendering architecture](https://github.com/dmalmq/imdf-map-application/issues/23)

## Verdict

The architecture holds. **Gate 1 passes with a 6× margin, gates 3 and 6 pass on
measured numbers, and no documented flip condition triggered** — the D3 raw
WebGL2 path stayed viable, so three.js was not needed. Gate 2 is partially
verified, gate 4 is verified for identity but not yet for coordinates, and gates
5 and 7 are partially complete. The spike found and fixed five real defects, four
of them in the plan's own pinned recipe, which is what a spike is for.

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

## Gate 2 — Custom-layer interop: **PARTIAL**

Verified:
- MapLibre's own layers render correctly with the custom layer present; GL state
  is saved and restored around every draw and every pick pass.
- `webglcontextlost` **and** `webglcontextrestored` both fire and are observed
  when the loss is forced through `WEBGL_lose_context`, and `stats()` reports the
  same draw-call count before and after.

Not verified:
- That picking works again after a forced context loss. The post-loss pick probe
  returned no hit, and the harness could not distinguish "rebuild incomplete"
  from "camera not aimed at geometry" before this session ended.

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

## Gate 4 — Picking: **PARTIAL**

Verified: the GPU feature-ID pass resolves real features. A representative probe
returned `featureIndex 746` → role `Structure`, level 0, `revitUniqueId`
`06bb4d95-30e…`, and neighbouring pixels resolved distinct features (746, 747,
4205). Pick latency is **≈3.0–3.3 ms per call**, which includes a full pick-pass
render plus a synchronous `readPixels`.

Not verified:
1. **Coordinate correctness.** Fixed during the spike (see defect 3) but not
   re-measured green afterwards: the returned position must be venue-local
   metres.
2. **Feature attribution under floor filtering.** With level 0 active, some
   picks resolved features belonging to level 58. Either the per-feature
   visibility gate is not excluding non-active levels from the pick pass, or the
   `_FEATURE_ID_0` vertex attribute is being read with a wrong stride/offset.
   **This is the most important open question on the branch** — wrong picks would
   undermine issue #27's editing cockpit — and it is unresolved.
3. The 10 px / 12 px graph precedence path is unit-tested (9 tests in
   `pick.test.ts`) but was never exercised against rendered graph geometry,
   because the spike renders no routing graph.

## Gate 5 — Precision: **PARTIAL**

The composition was wrong and is now right; this is the spike's headline finding
(defect 2). After the fix, a known level-0 vertex projects to NDC
`(0.000, 0.042, 0.991)` with `inFrustum: true` while the camera is centred on it,
and the composed model translation matches an independently computed mercator
origin to 7 significant figures: layer `(0.8882346, 0.3937873, 3.7936e-6)` vs
expected `(0.888234603, 0.393787299, 3.7895e-6)`.

Not verified: sustained visual inspection for jitter or z-fighting at maximum
zoom. Headless screenshots of the MapLibre canvas came back byte-identical
regardless of scene content — WebGL canvases without `preserveDrawingBuffer` do
not reliably survive headless capture — so visual gates need a headed browser.

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

## Gate 7 — Registration: **NOT RUN**

Task 8 was not reached. The companion datasets are in place for it —
`C:/cesium/NW,POI_20260625東京/` holds `network_WebMercator.gdb`,
`point_facility_WebMercator_202006.gdb`, and `JRTokyoSta_3857.gdb` — which also
unblocks issue #33.

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

## Validation

- `cargo test --manifest-path core/Cargo.toml -p kiriko-scene` — 13 tests pass.
- `pnpm exec vitest run src/spikes/renderer` — 11 tests pass.
- `pnpm exec tsc --noEmit` — zero diagnostics.
- `pnpm exec vite build` — success (1,918.13 kB / 599.75 kB gzip).

## Recommended next steps

1. Resolve gate 4's feature-attribution question before anything else.
2. Correct the design spec's matrix instruction (defect 2).
3. Re-run gates 2, 5, and 6's visual checks in a headed browser.
4. Run gate 7 against the now-available companion GDBs.
5. Hand gate 3 to issue #26 with the vsync caveat stated.
