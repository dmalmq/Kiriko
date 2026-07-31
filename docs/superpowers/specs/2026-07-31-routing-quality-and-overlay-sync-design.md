# Routing quality, doorway approach, and floor-switch overlay sync — design

Date: 2026-07-31
Status: approved (design), pending implementation plan

## Background

Three reported defects in the Kiriko viewer/routing stack, investigated against
`kiriko-route`, `kiriko-bundle` (`synth_medial`), `src/map/IndoorMap.tsx`, and
maplibre-gl 5.24.0 source. The affected venues in the dev database
(`server/data/data/kiriko.db`) run the **generated** network (`synth_medial`,
versions with the synth flag set), so Issues 1 and 2 target the generated-
network path; the query-time fixes also benefit imported (JR East GDB)
networks.

## Root causes (verified)

### Issue 1 — routes visibly longer than an available path

The A* in `core/crates/kiriko-route/src/query.rs` is optimal for the graph it
is given: the heuristic `k · haversine` with
`k = min over edges of (weight / straight-line endpoint distance)` is
consistent (every edge satisfies `weight ≥ k · straight`, and summed straight
distances bound the haversine to the goal). Generated-network weights are pure
distance (`meters_to_cost`, 1000 cost units per metre). Three real causes:

1. **Topology gaps (dominant).** The medial-axis centerline hugs the middle of
   walkable space and rings obstacles; open concourses have no straight chord
   edge where a person would cut diagonally. A* cannot use an edge that does
   not exist.
2. **Same-edge shortcut.** When both endpoints snap to the same edge, `route()`
   walks along that edge's polyline and never compares against leaving and
   re-entering via the network. On long or loopy edges this is visibly wrong.
3. **Single-edge snap.** `snap_to_edge` picks the one nearest same-floor edge
   per endpoint; a slightly farther edge can yield a much shorter total route.
   The click→projection connector leg is also excluded from optimization.

### Issue 2 — routes enter openings diagonally or from behind

`synth_medial.rs` collapses each IMDF `opening` LineString to its midpoint
(`linestring_midpoint`); the line direction is discarded. The doorway node is
bridged to the nearest centerline node within `SNAP_MAX_M` (12 m) whose
segment stays in walkable space, so the approach angle is whatever the nearest
node happens to give. "Front of the opening" is not encoded in the graph.

### Issue 3 — stale routes/network overlay after floor switch

In maplibre-gl 5.24.0, `GeoJSONSource.setData()`/`updateData()` synchronously
sets `_isUpdatingWorker = true` (first statement of `_dispatchWorkerUpdate`,
reached synchronously from `setData`), so `loaded()` returns false and
`map.isStyleLoaded()` flips to false immediately after the indoor source swap.

On a floor change, React runs `IndoorMap` effects in declaration order:

1. The venue/level effect (~L980) calls `updateSourceData` → indoor
   `setData`/`updateData` → style becomes not-loaded.
2. The directions (~L1183), network (~L1194), facility (~L1217), and
   layer-visibility effects run next, hit `if (!map.isStyleLoaded()) return;`,
   and silently drop their update. Nothing re-fires them when the style
   becomes ready again.

Clicking any network editing tool recreates the `networkEditing` prop, which
re-fires the network effect after the worker round-trip has completed — the
"fixes itself when I click a tool" symptom. Unit tests pass because the
FakeMap's `styleLoaded` flag is static and does not mimic the real flip.

## Design

Three independent slices. Query-time ships before build-time (decided with the
user). No new user-facing strings; no UI changes.

### Slice 1 — query-time routing fixes (`core/crates/kiriko-route/src/query.rs`)

**1a. Demote the same-edge shortcut to a candidate.** When both endpoints snap
to the same edge, compute the along-edge walk (cost = edge weight proportioned
by arc length, as today) AND run the normal A* seeded from that edge's two
endpoint nodes; return the cheaper result. The along-edge candidate is not
reachable via A* (it traverses no node), so it remains an explicit candidate.
Tie-break: prefer the A* result on exact cost equality (traces real junctions;
deterministic).

**1b. Top-K snap with connector-aware selection.** Replace `snap_to_edge`
(single best) with `snap_candidates(graph, p, K = 3)`: the up-to-K nearest
distinct same-floor edges by projection distance, ties broken by edge index;
if no same-floor edge exists, fall back to the single nearest off-floor edge
(current behavior preserved).

`route()` seeds A* from every origin candidate's two partial endpoints and
treats every destination candidate's two partial endpoints as goals, choosing
the minimum of `graph cost + partial costs + connector legs`, where a
connector leg is `haversine(click, projection)` converted to cost units via
`meters_to_cost`. One A* run with ≤ 2K seeds and ≤ 2K goals; `total_weight`
keeps its current meaning (graph cost only — connector legs are used for
selection, not added to the reported total, to avoid changing the DTO
contract).

Also run candidate 1a per (origin, destination) candidate pair sharing an
edge.

Selection determinism: candidates sorted by (projection distance, edge
index); final choice by (total cost, origin edge index, destination edge
index).

### Slice 2 — network generation (`core/crates/kiriko-bundle/src/synth_medial.rs`)

**2a. Perpendicular doorway stubs.** Carry the opening LineString (midpoint +
unit direction) through synthesis instead of the midpoint alone. For each
opening with at least one attachable centerline blob:

- Normal `n` = unit perpendicular of the opening line.
- Stub nodes `O = M + n·δ` and `I = M − n·δ`, δ = 1.2 m. Each stub is valid
  only if the point lies inside the walkable area and the segment stub→M
  passes `segment_within_area` with `SEGMENT_OUTSIDE_TOL_M`.
- Side assignment for transit-adjacent openings: the side containing the unit
  centroid is "inside". For walkway↔walkway openings both stubs are used and
  "side" is decided per attaching blob by the cross-product sign of its
  centerline node against the opening line.
- Edges: `O–M` and `M–I` with real metre distances (converted once via
  `meters_to_cost`, as all synth edges). Centerline blobs attach to the stub
  on their own side within `SNAP_MAX_M`, never directly to `M`. Transit units
  keep attaching through their doorway, terminating at the inner stub.
- Fallbacks: a side failing validation collapses to `M` (today's attach); if
  both sides fail, keep the current midpoint attach unchanged.

Result: every route crosses a doorway perpendicular over the last δ metres.

**2b. Visibility-chord densification.** After skeleton construction, doorway
attachment, and near-blob bridging, per floor:

- Bucket skeleton nodes on a grid (same pattern as near-blob bridging, cell
  sized to `R`).
- For each same-blob node pair within `R = 40 m` (chord length `c`), in
  deterministic order (sorted by node indices): add a straight chord edge
  with weight `meters_to_cost(c)` when
  - `bridge_passable(a, b, area)` holds (full `MIN_PASSAGE_M` width inside
    walkable space — rejects chords across kiosks, walls, track beds), and
  - `c < 0.7 · d_graph(a, b)` where `d_graph` is the current graph distance
    (bounded Dijkstra with cutoff `c / 0.7` on the same-blob subgraph), and
  - both nodes have fewer than 4 added chords.
- Chord edges are ordinary edges: they render in the network review overlay,
  are exported, and remain deletable in the network editor.

**Regeneration semantics.** Synth changes only affect newly generated
networks. Published versions and hand-edited networks are unchanged until a
user regenerates (a new version via "Generate routing"). No migration.

### Slice 3 — floor-switch overlay sync (`src/map/IndoorMap.tsx`)

Replace the drop-on-busy early return in the overlay effects (directions,
network, facility, layer-visibility) with a deferred apply:

- Keep the existing latest-value refs (`directionsRef`, `networkRef`,
  `networkEditingRef`, `facilitiesRef`, plus a `layerVisibilityRef`).
- Each overlay effect updates its ref and calls a shared
  `syncOverlays(map, venue, levelId)` (debounced to one scheduled call per
  commit).
- `syncOverlays` applies all overlay sources from refs immediately when
  `map.isStyleLoaded()`; otherwise it subscribes once to `styledata` and
  applies from refs when it fires. Reading refs at fire time means the newest
  props always win; the activation refs (`routeSourceActiveRef` etc.) keep
  their current clear-exactly-once semantics, computed at apply time.
- The venue/level effect is unchanged.

Rejected alternative: reordering effects so overlays update before the indoor
swap — order-coupled and breaks whenever any earlier effect touches a source.

## Error handling

- Slice 1: no new failure modes; `route()` still returns `None` for
  non-finite endpoints or disconnected projections. A* internals unchanged.
- Slice 2: stub/chord validation failures fall back to current behavior
  (midpoint attach, no chord). Existing warning codes reused
  (`synth_opening_no_walkway`); no new `WarningCode`s, so the TS bridge
  allowlist is untouched. Chord budget guards keep degenerate floors from
  exploding edge counts.
- Slice 3: if the map is torn down before `styledata` fires, the subscription
  is removed by the existing cleanup path; apply is a no-op on a removed map
  (`mapRef.current == null` guard).

## Testing

- **Slice 1 (Rust, `query.rs` tests):**
  - same-edge case where the network detour is shorter → A* result returned;
  - same-edge case where along-edge is shorter → candidate returned;
  - second-nearest edge wins when it yields a shorter total route;
  - connector leg breaks a tie toward the nearer snap;
  - determinism: identical inputs → byte-identical route across runs.
- **Slice 2 (Rust, `synth_medial.rs` tests):**
  - doorway crossing is perpendicular: route through an opening traverses
    `O–M–I` with the stub segments collinear with the opening normal;
  - blob attaches only to the stub on its own side;
  - one-side-invalid stub collapses to midpoint attach;
  - open hall gains a chord that shortens a sampled route; narrow corridor
    and kiosk-blocked pairs gain none;
  - chord degree cap respected; synthesis deterministic.
  - Extend `examples/analyze_synth.rs` to report chords added per floor.
- **Slice 3 (Vitest, `IndoorMap.test.tsx`):**
  - FakeMap mimics real semantics: indoor `setData`/`updateData` flips
    `styleLoaded` to false until a `styledata` event is emitted.
  - Floor switch with active directions / network review / facilities /
    non-default layer visibility lands the new floor's data after `styledata`
    (each currently lost).
  - Props changing again before `styledata` → only the newest data is applied.
- Full gates per AGENTS.md: `cargo test --manifest-path core/Cargo.toml
  --workspace`, `pnpm exec tsc --noEmit`, `pnpm --dir server exec tsc
  --noEmit`, `pnpm exec vitest run`, `pnpm --dir server exec vitest run`.

## Sequencing

Slices are independent; Slices 3 and 1 can proceed in parallel, Slice 2 after
or in parallel (its tests do not depend on Slice 1). Suggested: Slice 3 ∥
Slice 1 → Slice 2. One implementation plan covering all three slices, one
commit per logical change (TDD).

## Non-goals

- Query-time path smoothing / string-pulling against walkable polygons
  (needs §2 geometry at query time; revisit only if 1+2 prove insufficient).
- Modeling one-way `direction`, `passage_type` penalties, barriers, or time
  windows (already deferred; unchanged).
- Retroactive changes to published or hand-edited networks.
- Renaming `total_weight` units in the viewer (known follow-up, separate).
