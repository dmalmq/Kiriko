# 3D rendering architecture — design

Date: 2026-08-03  
Status: chosen, pending spike gates (section 12)  
Issue: [#23 — Choose the 3D rendering architecture](https://github.com/dmalmq/imdf-map-application/issues/23)

## 1. Decision

Kiriko renders all 3D through **one renderer-owned WebGL2 custom layer inside the
existing MapLibre map**, fed by **one Rust-compiled scene format** that both scene
sources produce.

- MapLibre keeps the basemap, the camera, and the 2D fallback viewer.
- A single `CustomLayerInterface` layer in `renderingMode: "3d"` draws venue
  geometry, route, and the editable routing graph, sharing MapLibre's depth
  buffer.
- Both scene sources compile to the same GPU-ready batch format: generated
  geometry at publish into KVB §9, an activated 3D Tiles package at ingestion
  into a content-addressed derived member.
- Text labels render as a DOM overlay positioned from the renderer's
  projection; icon badges render as GL billboards.
- Picking is split by what each mechanism is good at: a GPU feature-ID pass for
  venue surfaces, a CPU screen-space index for graph objects.

The renderer physically cannot distinguish Tiles from Generated geometry,
because by the time either reaches it they are the same buffers with the same
feature-table shape. That is the structural guarantee behind issue #32's "must
not feel like a different product."

## 2. Measured evidence

All decisions below were taken against the real JR East Tokyo asset in
`C:/cesium/tokyo 3dtiles/`, not against the inventory summary.

| Property | Measured value |
|---|---|
| Tileset shape | one root tile, `geometricError: 0`, `refine: "ADD"`, single `content.glb` |
| GLB size | 171.6 MB (21.5 MB JSON chunk + 150.1 MB BIN) |
| Nodes / meshes / primitives | 1 / 1 / **23,556** |
| Accessors / bufferViews | 94,224 / 94,248 |
| Materials / textures | 72 / **0** |
| Geometry | 4,702,167 vertices, **1.57 M triangles**, uncompressed float32, 1:1 index buffer |
| Extensions | `EXT_mesh_features`, `EXT_structural_metadata` |
| Features | **22,387**, addressed by `_FEATURE_ID_0` on every primitive |
| Per-feature properties | `revitElementId`, `revitUniqueId`, `name`, `category`, `familyName`, `typeName`, `levelName`, `levelKey`, `levelElevationMeters`, `heightMeters`, `minZMeters`, `maxZMeters`, `sourceDocument`, `sourceLinkName` |
| Primitive ↔ feature | **1:1** (2000/2000 sampled primitives carry a constant feature id) |
| Levels | 90; busiest floor 2,698 elements, median floor 126 |
| Warm decode | 86 ms read + 52 ms JSON parse |

Three findings reshaped the decision:

1. **This is not a tileset in any operational sense.** One tile, zero geometric
   error, no refinement tree. A 3D Tiles runtime has nothing to schedule,
   stream, or cull, so the value of Cesium or deck.gl `Tile3DLayer` here is
   close to zero. What the asset needs is a glTF reader that understands
   `EXT_mesh_features` and `EXT_structural_metadata`.
2. **The per-feature metadata is exactly the contract issues #30 and #31
   specified.** `levelKey` plus `levelElevationMeters` plus
   `sourceDocument`/`sourceLinkName` per feature makes floor filtering,
   semantic roles, and pick identity addressable per feature rather than
   inferred per tile.
3. **The geometry is small but pathologically packaged.** 1.57 M triangles
   renders anywhere; 23,556 primitives is 23,556 draw calls, ~96 bytes/vertex is
   roughly double what is needed, and an index buffer that maps 1:1 to vertices
   is pure waste. Every one of those is fixable before the client sees the data.

## 3. D1 — One renderer owns all 3D

**Chosen:** a single custom-layer renderer draws venue geometry, route, and
graph for both scene sources.

**Rejected — split path** (native `fill-extrusion` for generated scenes, custom
layer for tiles). Issue #32 commits to one semantic visual language; a split
path implements every material, ceiling rule, occlusion fade, route state, and
selection treatment twice, in two systems with unequal capability. Native
extrusion bases and heights are constant horizontal planes (issue #22), so it
cannot express sloped connectors or true elevated graph nodes, and issue #27's
editing cockpit needs arbitrary-Z picking that native layers structurally lack.
The custom renderer therefore has to exist regardless; the split merely adds a
second one beside it.

**Rejected — dedicated renderer** (Cesium or standalone three.js, MapLibre only
for 2D). Discards the basemap, the existing viewer investment, and 2D parity to
gain a globe engine this asset does not need.

**Accepted cost:** Kiriko owns picking, GL lifecycle, and context recovery.
`queryRenderedFeatures` does not see custom-layer geometry.

## 4. D2 — The renderer consumes an ingestion-derived scene binary

**Chosen:** ingestion derives a GPU-ready artifact from the activated tiles
package. The original package is retained immutably as provenance; the derived
artifact is content-addressed and keyed by `source hash + deriver version`.

Runtime decode was never the problem — 138 ms warm. **Transfer is.** Under issue
#30, Tiles is the primary scene for eligible devices, but a 171.6 MB download
means nearly every device falls back to Generated and the primary path rarely
runs. Deriving lets Kiriko quantize positions, oct-encode normals, drop the
redundant index buffer, merge primitives, and compress — none of which a client
can recover after the fact.

Ingestion already opens this asset for validation, floor-plane resolution, and
the registration table (issues #30 and #31). The deriver is that same pass.

**Rejected — ship the GLB and merge at runtime.** Defensible only if producers
must see byte-identical delivered geometry in the viewer; that property is
preserved instead by retaining the original package and exposing it in producer
QA.

**Accepted cost:** a derived-artifact format and deriver version to maintain,
and re-derivation when the format changes.

## 5. D3 — Raw WebGL2 inside the MapLibre custom layer

**Chosen:** hand-authored WebGL2 in `CustomLayerInterface` with
`renderingMode: "3d"`, which supplies projection matrices and shares MapLibre's
depth buffer.

Decision D2 removed most of the reason to take a rendering library. What the
layer actually draws:

| Pass | Programs |
|---|---|
| Merged venue batches, per-feature visibility/state via feature-ID lookup | 1 |
| Semantic hairline edges (#32) | 1 |
| Route casing/core as screen-space-expanded ribbons | 1 |
| Graph nodes and connectors for the #27 cockpit | 1 (instanced) |
| Picking | reuses the above with `u_pickMode` |

three.js's three main contributions do not apply: `GLTFLoader` is unused after
D2, the scene graph is near-empty because a floor is a handful of merged
batches, and `Raycaster` cannot resolve an individual element inside a merged
batch — picking is feature-ID based either way. Per-feature lookup and
screen-space ribbons require custom shader materials regardless. Against that,
three.js costs roughly 120–170 kB gzip on a 588 kB baseline, in a project whose
entire runtime dependency list is eleven packages, and it interposes
`Object3D.matrixWorld` (float32) exactly where issue #19's venue-local metric
frame needs CPU-composed camera-relative doubles.

**Rejected — deck.gl:** heavier dependency, WebGL2-only interleaving, and its
picking model is another indirection over the same color-ID technique.

**Rejected — separate synchronized canvas:** loses depth interleaving with the
basemap and doubles camera-sync failure modes.

**Documented flip condition.** three.js may replace the raw implementation
behind the same seam, without touching the scene format, the adapter, or
anything upstream, if the spike shows MapLibre GL-state interop or context-loss
recovery is a sustained cost. `renderer.resetState()` and three.js's lifecycle
handling are the specific mitigations that would justify the swap. This is an
implementation detail by construction; D1, D2, and D4 are not.

## 6. D4 — One scene format, both compilers in Rust

**Chosen:** a new `kiriko-scene` crate defines the batch format. Generated
geometry compiles into KVB §9 at publish; the activated tiles package derives to
the same format at ingestion as an external content-addressed member. AGENTS.md
draws the line at "GDAL stays in TypeScript; all data interpretation is Rust,"
and turning `EXT_structural_metadata` into semantic roles, canonical level
identities, and occlusion classes is interpretation.

**Rejected — two formats.** The cheapest structural guarantee of issue #32's one
visual language is that the renderer cannot tell the sources apart. With two
formats, divergence is one convenient shortcut away.

**Rejected — TypeScript deriver.** Puts venue interpretation on the wrong side
of an existing project boundary.

### Format outline

- **Header** — format version, deriver version, source hash, venue-local metric
  frame origin and world transform in double precision, scene bounds.
- **Level table** — canonical Kiriko level ↔ the composite source identities
  required by issue #30 (`asset version + sourceDocument + sourceLinkName +
  levelKey + quantized elevation`), plus the resolved floor plane and the
  source elevation retained as provenance per issue #19.
- **Feature table** — per feature: canonical association when one exists, source
  object identity (`revitUniqueId`), level reference, semantic role, occlusion
  class, confidence, and min/max Z.
- **Batches** — grouped by `(semantic role, level)`. Positions quantized to u16
  within per-batch bounds, normals oct-encoded, per-vertex feature index,
  redundant index buffers dropped, zstd-compressed. KVB already uses zstd and
  `kiriko-wasm` already links a decoder, so the client gains no dependency.

The deriver maps the asset's 72 Revit materials onto the twelve semantic roles
issue #32 defines; the renderer never sees a source material. Batch count per
visible floor is therefore bounded by role count, not element count — roughly a
dozen draw calls for the busiest floor instead of 2,698.

Per-feature GPU state (visibility, selection, diagnostic emphasis) lives in a
small data texture indexed by feature index; 22,387 features fit in a
150 × 150 texture, so a floor change or selection is a texture update rather
than a geometry rebuild.

[INFERENCE] Quantization plus dropping the index buffer takes Tokyo from
~28 B/vertex to ~14 B/vertex and removes 18.8 MB; with typical zstd ratios that
lands near **20–30 MB**. This is arithmetic and typical ratios, not a
measurement — spike gate 1 produces the real number.

## 7. D5 — Composition: GL geometry, DOM text, GL icons

**Chosen:**

- **Geometry, route, graph** — GL, in the custom layer.
- **Text labels** — DOM overlay positioned from the renderer's projection.
- **Icon badges and POI markers** — GL billboards from the staged icon atlas
  that `registerFacilityImages` already builds.
- **Basemap** — native MapLibre, beneath the custom layer, depth-composed.
- **2D fallback** — today's viewer unchanged: native `fill`/`line`/`symbol`
  layers and `queryRenderedFeatures`, with the custom layer simply absent.

**Rejected — native symbol layers for labels.** Issue #22 established MapLibre
has no arbitrary-Z sink for `line`, `circle`, or `symbol`, so native labels pin
to ground Z and would lie in an elevated floor or issue #27's exploded stack.
This is a correctness failure, not a preference.

**Rejected — all labels in GL.** Would require owning a CJK SDF glyph pipeline
for a bilingual product, and would leave the canvas semantically empty.

DOM text also answers issue #22's accessibility gate structurally: the canvas is
not a semantic scene, but the labels above it are real text nodes with correct
`lang`, so assistive technology reads the scene's names without a parallel
description layer. Label count is capped at four in navigation and six in
overview/diagnostics by issue #32, so per-frame DOM transforms are negligible.

## 8. D6 — Picking

**Chosen:** hybrid, split by what each mechanism does well.

| Target | Mechanism |
|---|---|
| Venue surfaces (22,387 features) | GPU feature-ID pass sharing the render VAOs and shaders under `u_pickMode`, WebGL2 MRT: attachment 0 = feature ID, attachment 1 = view-space position |
| Graph junctions and paths | CPU screen-space index, projected on camera change |
| Click | synchronous `readPixels` of a small block |
| Hover and drag | CPU index for graph objects; PBO + fence async readback for surfaces |

Depth testing *is* the occlusion rule, so "nearest visible floor," ties, and
faded-occluder semantics — all open questions in issue #22 — resolve from the
depth buffer instead of being reimplemented on the CPU.

Graph picking stays on the CPU because tolerance with precedence is what a
single-pixel GPU read cannot express. The 3D path must preserve the affordances
the 2D viewer ships today: `LAYER_NETWORK_PATH_HIT` at `line-width: 12`,
`LAYER_NETWORK_JUNCTION_HIT` at `circle-radius: 10`, junctions queried before
paths (`src/map/IndoorMap.tsx:258–266`), and the move tool bypassing hit-testing
for a raw coordinate.

Attachment 1 supplies issue #27's "place at this point" world coordinate
directly, instead of ray-plane intersecting against a guessed floor.

Issue #22 listed "deduplicate tile-split hits" as a risk. D2 removes it: the
derived artifact is not tile-split.

## 9. D7 — MapLibre owns the camera

**Chosen:** MapLibre owns camera state; the renderer consumes the projection
matrix it is handed. `maxPitch` stays at MapLibre's default **60** rather than
the experimental range its own documentation warns about.

- Gestures, inertia, zoom-around-cursor, keyboard camera navigation, and
  reduced-motion handling already exist and are tested here.
- Issue #25's Guided transition maps onto `easeTo` with the phase sequence the
  #32 prototype fixed (`walk-b1 → announce-escalator → pull-back →
  show-destination-floor → switch-floor → settle-1f`), with reduced motion
  becoming `jumpTo` — the discrete-state behavior that prototype demonstrated.
- **Issue #27's exploded stack is a scene transform, not a camera one:** a
  per-floor Z offset applied to batches. It needs no second camera.
- Issue #30 §5 requires preserving the camera target across
  `Tiles → Generated → 2D`. With MapLibre owning camera state that is automatic;
  otherwise fallback would marshal a foreign camera into map state at the worst
  possible moment.

An architectural cutaway reads well at ≤60°, labels stay legible, and no horizon
enters frame. Raising the cap later is a one-line change carrying the
high-pitch risk issue #22 flagged.

## 10. Failure, fallback, and capability

The renderer implements the source-neutral adapter and structured failure state
that issue #30 §4–5 requires:

- Preflight selects the highest eligible source; the renderer reports
  readiness, capability, and structured failure with stage and reason.
- On failure: one bounded automatic retry, then one-way
  `Tiles → Generated 3D → 2D`, preserving route, active floor, camera target,
  and canonical selection, with no automatic flap back to Tiles in the session.
- Context loss is a renderer-owned failure that follows the same path.
- A rendering failure never changes routing results or publication state.

Numeric activation and runtime budgets are **not** set here. They belong to
issue #26 and consume the spike measurements below.

## 11. Downstream constraints

- **Issue #26** receives frame-time, decode, memory, and pick-latency
  measurements from the spike and sets the objective gates.
- **Issue #24** gains one refinement: KVB §9's external descriptor references
  the derived scene member alongside the original package, keyed by
  `source hash + deriver version`. The 171.6 MB GLB is still never copied into a
  KVB.
- **Issue #28** cannot sequence delivery until the spike closes gates 1–5.
- **Issue #33** is unaffected by this decision but is now unblocked on data:
  the companion network and point-facility GDBs are present in
  `C:/cesium/NW,POI_20260625東京/`.

## 12. Spike gates

No production claim is made until these are exercised on a throwaway branch.
Fixtures: **Tokyo** (171.6 MB, 90 levels — worst case), **LumineEst** (12.8 MB —
easy case), **Shinjuku** (161.4 MB — second heavy case), and the deterministic
multi-floor fixture issue #18 requires.

| # | Gate | Falsifier → action |
|---|---|---|
| 1 | Rust deriver: output size, derive time, batch count | > ~50 MB output → revisit quantization/compression before #26 sets budgets |
| 2 | Custom-layer interop: GL state save/restore, depth interleave, context-loss recovery | state corruption or unrecoverable loss → take the D3 flip to three.js |
| 3 | Frame time: p50/p95 on busiest floor and all-floor overview, desktop and mid-tier mobile | feeds #26; no pass/fail set here |
| 4 | Picking: feature-ID accuracy, 10 px / 12 px precedence preserved, drag-time hover without stalls, world-coordinate reconstruction | precedence or drag unusable → revisit D6 |
| 5 | Precision: venue-local metric coordinates against Tokyo's ECEF origin (−3959720, 3350435, 3699347) with camera-relative rendering | visible jitter or z-fighting → change the double-precision strategy |
| 6 | Floor filtering and occlusion: per-feature GPU visibility from `levelKey`, active floor, context fade, protected-corridor occluders | — |
| 7 | Registration: tileset transform applied unchanged (#31), generated GDB geometry overlaid in the same frame | divergence → reopens #31's conclusion |

## 13. Out of scope

- Numeric performance, memory, and capability budgets (issue #26).
- Delivery sequencing and effort bands (issue #28).
- The visual language itself (issue #32, already decided).
- Any change to routing results, publication gating, or the 2D viewer's
  existing behavior.
