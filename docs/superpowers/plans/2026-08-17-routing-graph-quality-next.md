# Routing Graph Quality Next — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the attrs already stored on Kiriko graphs at query time (travel modes, clearance, then imported GDB / IMDF flags), persist those flags without regenerating Tokyo, then add §11 network QA. Do not rewrite the medial-axis generator.

**Architecture:** One stored graph, several `RouteProfile`s. A* in `kiriko-route` currently reads only `e.weight` and builds bidirectional adjacency. Add `route_with(graph, origin, dest, profile)` that filters edges (and, from Phase 2, directions) when building adjacency and snap candidates. Keep `route(...)` as the walking default so existing tests stay valid. Persist new flags on an **optional KVB §13** — do not grow postcard `GraphEdgeAttrDto` (§12 uses `postcard_take_exact`; extra fields would invalidate every existing §12). Wheelchair / default profiles in Phase 1 consume §12 `vertical` + `clearance_m` only. Producer residual (campus sidewalks, stair landings, landmarks) stays manual.

**Tech Stack:** Rust 2024 workspace (`kiriko-route`, `kiriko-bundle`, `kiriko-wasm`, `kiriko-node`), TypeScript viewer (`src/bundle/*`, `src/app/App.tsx`), Vitest, existing bilingual `ui = { key: { ja, en } }` copy.

**Spec / research (do not re-derive):**
- `docs/superpowers/reports/2026-08-17-routing-graph-quality-next.md`
- Sources: `docs/superpowers/reports/2026-08-17-routing-graph-quality-sources.md`
- Shipped generator: `docs/superpowers/specs/2026-08-13-generated-network-quality-design.md` (its §9 non-goals are this plan)
- Deferred GDB fields: `docs/gdb-data-reference.md` (“Deferred routing semantics”)

## Global Constraints

- TDD. Observe each focused test fail before production code. One commit per task.
- Bilingual UI: every new user string is a `ui` pair `{ ja, en }`.
- Absence is never a zero: `clearance_m` stays `Option<f32>` / JSON `null`. An unknown clearance **must not** fail a wheelchair query; only `Some(c)` with `c < min_clearance_m` is rejected.
- Do not bump `SECTION_VERSION`. Do not add fields to `GraphEdgeAttrDto`. Old §12 bytes must keep decoding. Unknown section ids stay tolerated.
- Do not change `Route.total_weight` meaning (graph cost only). The viewer still mislabels it `m` — out of scope; do not “fix” it by rewriting cost.
- Do not regenerate Tokyo imported graphs with `synth_medial`. Re-compiling the existing `net_junction`/`net_path` GeoJSON after Phase 2 (to emit §13) is allowed and required for those flags to reach published bundles.
- Do not replace the medial-axis spine (no lattice, UCN, IndoorGML dual, visibility graph).
- Do not add build-time open-space chords. Do not re-penalize `passage_type` on top of imported `cost`.
- Do not clone the graph per profile. Do not bake zones, hours, or “now” into `weight`.
- Keep the A* heuristic as **2D** `k * haversine`. Recompute `k` only over edges the profile allows. Do not switch to 3D Euclidean.
- New `WarningCode`s must be added to `server/src/core/native.ts` **and** `src/imdf/types.ts`. This plan adds none unless a task says so (Phase 3 Relationship hours may reuse `WarningCode::RouteBuild`).
- Skip formatters / linters / full-workspace suites until a task names them.
- Isolated worktree (if used) is created at execution time via `using-git-worktrees`.

## File structure

| File | Responsibility |
|---|---|
| `core/crates/kiriko-route/src/graph.rs` | `EdgeFlags`, `TravelDirection` (Phase 2); `RouteEdge.flags` |
| `core/crates/kiriko-route/src/query.rs` | `RouteProfile`, `route_with`, edge filter, directed adjacency |
| `core/crates/kiriko-route/src/lib.rs` | Re-export `RouteProfile`, `route_with`, flag types |
| `core/crates/kiriko-route/src/build.rs` | Read `direction` / `BARRIER` / `GATE` / `STARTTIME` / `ENDTIME` |
| `core/crates/kiriko-bundle/src/format.rs` | `SECTION_GRAPH_TRAVERSAL = 13` (Phase 2); real decoder for `SECTION_NETWORK_QA = 11` (Phase 4) |
| `core/crates/kiriko-bundle/src/sections.rs` | Encode/decode §13 and §11 |
| `core/crates/kiriko-bundle/src/codec.rs` | Emit/classify §13 / §11; `CapabilityReport` fields |
| `core/crates/kiriko-bundle/src/export.rs` | Write real `direction` / `BARRIER` / `GATE` / hours (stop hard-coding 0 / null / -1) |
| `core/crates/kiriko-bundle/src/clip.rs` | Copy `flags` through clip |
| `core/crates/kiriko-bundle/src/synth_medial.rs` | Opening width → doorway `clearance_m`; Opening accessibility → flags |
| `core/crates/kiriko-bundle/src/walkable.rs` | `route_smoothed` gains a profile argument (default walking) |
| `core/crates/kiriko-wasm/src/lib.rs` | `route_bundle` accepts a profile object |
| `src/bundle/wasm.ts` | `RouteProfileDto`; `routeBundle(..., profile?)` |
| `src/bundle/types.ts` | `profile?` on `BundleRouteRequest` |
| `src/bundle/bundle.worker.ts` | Pass profile through |
| `src/bundle/routeKirikoBundle.ts` | Pass profile through |
| `src/app/App.tsx` | Wheelchair chip; re-fire route on toggle |
| `docs/gdb-data-reference.md` | Tick off deferred routing semantics as they land |

Do not add a new crate.

## Spec decisions (locked here; do not re-open)

1. **`route` stays walking.** Add `route_with`. Callers that need a profile (wasm, later UI) use `route_with`. Existing `kiriko_route::route(...)` tests and `route_smoothed` default to walking.
2. **Wheelchair is a restriction, not a cost rewrite.** Skip `VerticalKind::Stairs` and `VerticalKind::Escalator`. Optional `min_clearance_m` default `0.8` (Kallmann `2r < cl` with r ≈ 0.4 m). Elevators remain allowed.
3. **Default / walking profile** sets `exclude_accessible_only: true` (IndoorAtlas `EXCLUDE_ACCESSIBLE_ONLY`). Until Phase 3 stamps the flag, every edge is `accessible_only = false` and the filter is a no-op.
4. **Unknown clearance is allowed.** `None` never fails a clearance check.
5. **§13 for traversal flags, not §12.** Postcard `GraphEdgeAttrDto` stays `{ kind, rank, clearance_m, vertical }`. §13 is one row per §5 edge, omitted when every row is default (same emit rule as §12). Requires §5. Unknown id on old decoders is ignored → walking-only, which is correct.
6. **Reciprocal PATHID/RPATHID collapse stays.** One-way is a flag on the kept edge (`TravelDirection` relative to stored `from → to`), not a second graph edge. Read `direction` from the kept (smaller PATHID) feature: `null` / `0` / absent → `Both`; `1` → `Forward`; `2` → `Reverse`. Unknown values → `Both`.
7. **`BARRIER != 0` skips the edge** on every profile unless `allow_barriers` (default false). **`GATE != 0` is stored but not skipped in Phase 2** (staff/gate policy is not specified in Tokyo data; do not guess). Hours: `STARTTIME`/`ENDTIME` as `i32`, `-1` = none; when `profile.at_minutes` is `Some` and both ends are set, skip outside the window (wrap if start > end).
8. **Do not re-penalize `passage_type`.** Leave the derived HFLAG/passage_type export behaviour as-is.
9. **IMDF Opening width** (`OpeningAxis.arc_length_m`) is the doorway `clearance_m`. Do not replace skeleton/bridge/chord clearance (those stay medial half-width).
10. **IMDF `accessibility[]` is already on `VenueFeature` / the geometry section.** The bug is that synth never copies it onto edges. Do not invent a second accessibility store on features.
11. **Heuristic stays 2D.** Forbidden edges (Infinity zones in Phase 6, skipped stairs, one-way reverse) are not in the filtered graph; `k` is min `weight/m` over **allowed** edges. If that set is empty, `k = 0`.
12. **Phase 5–6 do not start until Phase 4 is done**, and Phase 5 is skipped if greedy-LOS already looks acceptable for wheelchair-width agents on a real generated venue.

---

## Phase 1 — Query travel modes (no synth change)

Do this first. Helps imported Tokyo **and** generated graphs as soon as §12 `vertical` is present (generated). Tokyo imported edges are `VerticalKind = None`; wheelchair still skips nothing vertical until those graphs carry `TRANSITION_CATEGORY` (already true for generated verticals; Tokyo floor-changes are cost-encoded, not typed — do not invent categories from `passage_type`).

### Task 1: `RouteProfile` + `edge_allowed` + diamond test

**Files:**
- Modify: `core/crates/kiriko-route/src/query.rs`, `core/crates/kiriko-route/src/lib.rs`

**Interfaces:**
- Produces: `RouteProfile { skip_stairs, skip_escalators, exclude_accessible_only, min_clearance_m: Option<f32>, at_minutes: Option<u16> }` with `walking()` and `wheelchair()` constructors. Phase 2 adds `allow_barriers` default false (add the field now with default so later tasks do not reshuffle literals — or add it in Task 6; prefer **add `allow_barriers: bool` now**, default false).
- Produces: `fn edge_allowed(edge: &RouteEdge, profile: &RouteProfile) -> bool` in `query.rs` (private).
- `accessible_only` is read from `edge.flags.accessible_only` once Task 6 exists. In this task, treat it as `false` (inline `false` or a private helper that returns false) so the wheelchair tests compile before flags exist. **Do not add `RouteEdge.flags` in this task.**

- [ ] **Step 1: Write the failing tests** in `query.rs` `mod tests`.

Constructors:

```rust
impl RouteProfile {
    pub fn walking() -> Self {
        Self {
            skip_stairs: false,
            skip_escalators: false,
            exclude_accessible_only: true,
            min_clearance_m: None,
            at_minutes: None,
            allow_barriers: false,
        }
    }
    pub fn wheelchair() -> Self {
        Self {
            skip_stairs: true,
            skip_escalators: true,
            exclude_accessible_only: false,
            min_clearance_m: Some(0.8),
            at_minutes: None,
            allow_barriers: false,
        }
    }
}
```

Diamond graph (same-floor walk to two verticals, then same-floor walk):

- Nodes: `A`(ord 0), `S0`(0), `E0`(0), `S1`(1), `E1`(1), `B`(1).
- Walk edges weight `1000` (1 m).
- Stairs `S0→S1`: `weight = 10_000`, `attrs.kind = Vertical`, `attrs.vertical = Some(Stairs)`.
- Elevator `E0→E1`: `weight = 16_000`, `attrs.kind = Vertical`, `attrs.vertical = Some(Elevator)`.
- Origin at `A`, dest at `B`.

Tests:

1. `walking_profile_takes_the_cheaper_stairs` — `route_with(..., &RouteProfile::walking())` uses the stairs (lower weight). Assert the route polyline visits a point equal to `S0` or `S1` (the stair nodes), not only the elevator.
2. `wheelchair_profile_skips_stairs_and_uses_elevator` — `RouteProfile::wheelchair()` cannot use stairs; path goes via elevator. Walking still prefers stairs on the same graph.
3. `wheelchair_rejects_sub_clearance_edge` — one-floor corridor of two parallel edges, same endpoints: wide `clearance_m = Some(1.2)` weight `3000`, narrow `Some(0.4)` weight `1000`. Wheelchair must take the wide edge. Walking takes the cheap narrow edge.
4. `unknown_clearance_is_allowed_for_wheelchair` — single edge `clearance_m = None`, wheelchair still routes.

Until `route_with` exists, these tests will not compile — write them against `route_with` and implement a stub in Step 2 that currently ignores the profile so you can watch tests 1–3 fail on behaviour, not compilation. Preferred: implement `route_with` as `route(...)` (ignore profile) first, commit nothing, watch 1–3 fail, then filter.

- [ ] **Step 2: Implement `RouteProfile`, `edge_allowed`, `route_with`.**

`edge_allowed` (Phase 1):

```rust
fn edge_allowed(edge: &RouteEdge, profile: &RouteProfile) -> bool {
    if let Some(v) = edge.attrs.vertical {
        if profile.skip_stairs && v == VerticalKind::Stairs {
            return false;
        }
        if profile.skip_escalators && v == VerticalKind::Escalator {
            return false;
        }
    }
    if let (Some(min), Some(c)) = (profile.min_clearance_m, edge.attrs.clearance_m) {
        if c < min {
            return false;
        }
    }
    true
}
```

`route_with` copies `route` but:

1. `snap_candidates` skips edges where `!edge_allowed`.
2. Adjacency loop: skip disallowed edges; still push both directions.
3. `k` is min `weight/m` over **allowed** edges with `m > 0`.
4. Same-edge direct walk: skip if the shared edge is disallowed.
5. `route(g, o, d)` becomes `route_with(g, o, d, &RouteProfile::walking())`.

Re-export `RouteProfile` and `route_with` from `lib.rs`.

- [ ] **Step 3: Run the focused tests.**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-route -- walking_profile_takes wheelchair_profile_skips wheelchair_rejects_sub unknown_clearance -- --nocapture`

Expected: PASS.

- [ ] **Step 4: Commit.**

```text
feat(route): filter A* by travel-mode profile
```

### Task 2: WASM + TS profile plumbing (no UI yet)

**Files:**
- Modify: `core/crates/kiriko-wasm/src/lib.rs`, `core/crates/kiriko-bundle/src/walkable.rs`
- Modify: `src/bundle/wasm.ts`, `src/bundle/types.ts`, `src/bundle/bundle.worker.ts`, `src/bundle/bundle.worker.test.ts`, `src/bundle/routeKirikoBundle.ts`, `src/bundle/routeKirikoBundle.test.ts`

**Interfaces:**
- `route_in_document(document, origin, dest, profile: &RouteProfile)`
- `route_smoothed(document, origin, dest, profile: &RouteProfile)` — existing 3-arg tests can call `.walking()`.
- JS: `routeBundle(bytes, origin, dest, profile?: RouteProfileDto | null)`
- `RouteProfileDto = { accessible?: boolean; minClearanceM?: number | null }`
- `accessible === true` → `RouteProfile::wheelchair()`, then if `minClearanceM` is a finite number, overwrite `min_clearance_m`; `null`/omitted keeps the constructor default. `accessible !== true` → `walking()`.

Wasm binding: keep the seven numeric endpoint args; add an 8th `JsValue` `profile`. `JsValue::NULL` / `undefined` / `{}` → walking. Deserialize with serde (`camelCase`).

Worker `BundleRouteRequest` gains optional `profile?: RouteProfileDto`. Omit → walking. `routeKirikoBundle(src, origin, dest, signal?, profile?)` — put `profile` last so existing 3-arg calls compile; `signal` is already optional. If the current signature is `(src, origin, dest, signal?)`, extend to `(src, origin, dest, signal?, profile?)`.

- [ ] **Step 1: Failing tests.**
  - wasm (in `kiriko-wasm/src/lib.rs` tests): diamond graph compiled into a `BundleDocument`, `route_in_document` with walking vs wheelchair yields different `total_weight`.
  - `bundle.worker.test.ts`: `routeBundleMock` is called with a 4th profile argument when the request carries `profile: { accessible: true }`, and without it (or `undefined`) when omitted.
  - `routeKirikoBundle.test.ts`: if it asserts `postMessage` shape, include optional `profile`.

- [ ] **Step 2: Implement plumbing.** Update every `route_in_document` / `route_smoothed` / `kiriko_route::route` call in wasm tests to pass walking explicitly where needed.

- [ ] **Step 3: Run focused tests.**

Run:

```text
cargo test --manifest-path core/Cargo.toml -p kiriko-wasm -- route_
pnpm exec vitest run src/bundle/bundle.worker.test.ts src/bundle/routeKirikoBundle.test.ts src/bundle/wasm.test.ts
```

(`wasm.test.ts` only if it exists; skip if not.)

Expected: PASS.

- [ ] **Step 4: Commit.**

```text
feat(wasm): pass RouteProfile through routeBundle
```

### Task 3: Directions wheelchair chip

**Files:**
- Modify: `src/app/App.tsx`, `src/app/App.test.tsx`

**Copy (exact pairs):**

```ts
directionsAccessible: { ja: "車椅子", en: "Wheelchair" },
```

Place a second chip immediately after the Directions chip, **only when `directions.active`**. `aria-pressed` reflects `directions.accessible`. Toggling it:

1. Sets `directions.accessible`.
2. If both origin and destination are set, re-invokes `fireRoute` with `{ accessible: true/false }`.

`fireRoute` must close over `directions.accessible` (or take it as an argument) so a stale closure cannot send the wrong profile.

Do not show the chip when Directions is off. Do not change the `totalWeight / 1000` label.

- [ ] **Step 1: Failing App test** in `describe("App directions mode")`:

```ts
it("re-routes with accessible:true when Wheelchair is pressed", async () => {
  const user = userEvent.setup();
  routeKirikoBundleMock.mockResolvedValue(ROUTE_RESULT);
  await renderDataset(PUBLIC_VERSION_ID, buildMinimalVenue(), true);
  await user.click(screen.getByRole("button", { name: "Directions" }));
  await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
  await user.click(screen.getByRole("button", { name: "Tap map for directions" }));
  await waitFor(() => expect(routeKirikoBundleMock).toHaveBeenCalled());
  routeKirikoBundleMock.mockClear();
  await user.click(screen.getByRole("button", { name: "Wheelchair" }));
  await waitFor(() => {
    expect(routeKirikoBundleMock).toHaveBeenCalled();
    const args = routeKirikoBundleMock.mock.calls[0];
    expect(args[args.length - 1]).toEqual({ accessible: true });
  });
});
```

Adjust the argument index to whatever `routeKirikoBundle` actually receives after Task 2 (profile is last). If `signal` is in between, assert `expect.objectContaining({ accessible: true })` on the profile argument.

Also assert the Wheelchair chip is absent until Directions is on.

- [ ] **Step 2: Implement the chip and state.** Extend `DirectionsState` with `accessible: boolean` default `false`. Reset it in `clearDirections` / toggling Directions off.

- [ ] **Step 3: Run.** `pnpm exec vitest run src/app/App.test.tsx`

Expected: the new test PASS. Existing directions tests still PASS (they omit profile / pass `undefined`).

- [ ] **Step 4: Commit.**

```text
feat(app): wheelchair travel mode on Directions
```

**Phase 1 gate:** a generated venue with typed stairs vs elevator changes path when Wheelchair is on. Tokyo imported graphs likely will not, until verticals are typed (out of scope to invent from `passage_type`). That is expected.

---

## Phase 2 — Honour imported GDB direction / barrier / hours

Do not touch `cost`. Do not regenerate Tokyo. After this phase, **re-import** (re-compile existing GDB GeoJSON) so §13 is emitted; old published versions stay walking-bidirectional.

### Task 4: `EdgeFlags` on `RouteEdge`

**Files:**
- Modify: `core/crates/kiriko-route/src/graph.rs`, `core/crates/kiriko-route/src/lib.rs`
- Modify every `RouteEdge {` literal that does not go through `RouteEdge::new` (~55). Prefer adding `flags: EdgeFlags::default()` to `RouteEdge::new` and to each literal. `EdgeAttrs { ..Default::default() }` paths are unchanged.

**Interfaces:**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum TravelDirection {
    #[default]
    Both = 0,
    Forward = 1, // stored from → to only
    Reverse = 2, // stored to → from only
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeFlags {
    pub direction: TravelDirection,
    pub barrier: bool,
    pub gate: bool,
    pub start_minute: i32, // -1 = none
    pub end_minute: i32,   // -1 = none
    pub wheelchair: bool,  // default true
    pub accessible_only: bool, // default false
}

impl Default for EdgeFlags {
    fn default() -> Self {
        Self {
            direction: TravelDirection::Both,
            barrier: false,
            gate: false,
            start_minute: -1,
            end_minute: -1,
            wheelchair: true,
            accessible_only: false,
        }
    }
}

impl EdgeFlags {
    pub fn is_default(self) -> bool { self == Self::default() }
}
```

`RouteEdge` gains `pub flags: EdgeFlags`. `RouteEdge::new` sets `flags: EdgeFlags::default()`.

`edge_allowed` (query.rs) additionally:

- `if edge.flags.barrier && !profile.allow_barriers { return false; }`
- hours: if `profile.at_minutes` is `Some(t)` and both start/end `>= 0`, skip when `t` is outside `[start, end)` (if `start <= end`) or outside the wrap window (if `start > end`).
- `if profile.exclude_accessible_only && edge.flags.accessible_only { return false; }`
- wheelchair profile: `if profile.skip_stairs /* i.e. wheelchair() */ && !edge.flags.wheelchair { return false; }` — implement as `if profile.min_clearance_m.is_some() && !edge.flags.wheelchair` so we do not need a new bool. **Cleaner:** add `pub require_wheelchair: bool` to `RouteProfile`, set true only in `wheelchair()`. Use that.

Add `require_wheelchair: bool` to `RouteProfile` in this task (walking false, wheelchair true). `edge_allowed`: `if profile.require_wheelchair && !edge.flags.wheelchair { return false; }`.

- [ ] **Step 1:** Add the types; fix compile errors from the new `RouteEdge` field. No behaviour tests yet.

- [ ] **Step 2:** `cargo test --manifest-path core/Cargo.toml -p kiriko-route`

Expected: PASS (existing tests, all flags default).

- [ ] **Step 3: Commit.**

```text
feat(route): EdgeFlags on RouteEdge
```

### Task 5: Import GDB fields in `build_route_graph`

**Files:**
- Modify: `core/crates/kiriko-route/src/build.rs`

GDAL already dumps all `net_path` properties onto the FeatureCollection. This task only **reads** them.

After reciprocal collapse, flags come from the **kept** feature.

```rust
fn flags_from_properties(properties: &Option<...>) -> EdgeFlags {
    let direction = match prop(properties, "direction").and_then(|v| {
        v.as_i64().or_else(|| v.as_u64().map(|n| n as i64))
    }) {
        Some(1) => TravelDirection::Forward,
        Some(2) => TravelDirection::Reverse,
        _ => TravelDirection::Both, // null, 0, absent, junk
    };
    let barrier = prop(properties, "BARRIER").and_then(|v| v.as_i64()).unwrap_or(0) != 0;
    let gate = prop(properties, "GATE").and_then(|v| v.as_i64()).unwrap_or(0) != 0;
    let start_minute = prop(properties, "STARTTIME").and_then(|v| v.as_i64()).unwrap_or(-1) as i32;
    let end_minute = prop(properties, "ENDTIME").and_then(|v| v.as_i64()).unwrap_or(-1) as i32;
    EdgeFlags { direction, barrier, gate, start_minute, end_minute, ..EdgeFlags::default() }
}
```

When a reciprocal partner is found and the **incoming** candidate replaces the stored edge (`p < r`), write that candidate’s flags. When the incoming candidate is dropped, keep the partner’s flags (already stored).

Do not read `passage_type` into flags.

- [ ] **Step 1: Failing tests** in `build.rs`:

1. `one_way_direction_1_imports_as_forward` — single (non-paired) path `direction: 1` → `flags.direction == Forward`.
2. `reciprocal_pair_keeps_the_forward_feature_direction` — pair PATHID 1/2 with `direction: 1` on PATHID 1 and `direction: 1` on PATHID 2 (source often copies the field). Kept edge is PATHID 1 (`from=0,to=1`); direction is whatever PATHID 1 carried.
3. `barrier_1_imports_as_barrier` — `BARRIER: 1` → `flags.barrier`.
4. `hours_minus_one_is_open` — missing or `-1` → `start_minute == -1`.
5. Existing reciprocal tests still have `flags == default` when the properties are absent.

- [ ] **Step 2: Implement `flags_from_properties` and assign `edge.flags`.**

- [ ] **Step 3:** `cargo test --manifest-path core/Cargo.toml -p kiriko-route -- one_way_direction barrier_1 hours_minus reciprocal`

Expected: PASS.

- [ ] **Step 4: Commit.**

```text
feat(route): import GDB direction, barrier, and hours
```

### Task 6: Directed adjacency + barrier/hours at A*

**Files:**
- Modify: `core/crates/kiriko-route/src/query.rs`

Adjacency currently always does `adj[from].push(to)` and `adj[to].push(from)`. Change:

```rust
if !edge_allowed(e, profile) { continue; }
match e.flags.direction {
    TravelDirection::Both => {
        adj[from].push((to, ei, e.weight));
        adj[to].push((from, ei, e.weight));
    }
    TravelDirection::Forward => adj[from].push((to, ei, e.weight)),
    TravelDirection::Reverse => adj[to].push((from, ei, e.weight)),
}
```

Same-edge direct walk: if the walk along the polyline from origin snap to dest snap travels `from → to`, require `Both | Forward`; if it travels `to → from`, require `Both | Reverse`. If the direction forbids that along-edge walk, skip the direct candidate (A* via other edges may still win).

Snap: a one-way edge is still a valid snap target (you may stand on it); leaving it uses directed adjacency.

- [ ] **Step 1: Failing tests.**

1. `forward_only_edge_does_not_route_backwards` — two nodes, one Forward edge. Origin at `to`, dest at `from` → `None`. Opposite way → `Some`.
2. `barrier_edge_is_skipped` — only edge has `barrier: true`, walking profile → `None`. `allow_barriers: true` → `Some`.
3. `hours_window_skips_outside` — edge `start_minute=600, end_minute=720` (10:00–12:00). Profile `at_minutes: Some(660)` routes; `Some(800)` does not.

- [ ] **Step 2: Implement.** Extend `edge_allowed` with barrier / hours / `accessible_only` / `require_wheelchair` as specified in Task 4.

- [ ] **Step 3:** `cargo test --manifest-path core/Cargo.toml -p kiriko-route -- forward_only_edge barrier_edge hours_window`

Expected: PASS.

- [ ] **Step 4: Commit.**

```text
feat(route): honour one-way, barrier, and hours at A*
```

### Task 7: KVB §13 graph traversal flags

**Files:**
- Modify: `core/crates/kiriko-bundle/src/format.rs`, `sections.rs`, `codec.rs`, `clip.rs`
- Modify: `src/bundle/wasm.ts` (`CapabilityReportDto.graphTraversal`)

**Interfaces:**

```rust
pub(crate) const SECTION_GRAPH_TRAVERSAL: u16 = 13;
// declared_dependencies: requires SECTION_GRAPH, references []
```

```rust
struct GraphTraversalRowDto {
    direction: u8,       // 0 both, 1 forward, 2 reverse
    barrier: bool,
    gate: bool,
    start_minute: i32,
    end_minute: i32,
    wheelchair: bool,
    accessible_only: bool,
}
struct GraphTraversalSectionDto { edges: Vec<GraphTraversalRowDto> }
```

Emit only when at least one edge’s `flags` is non-default (mirror §12). Decode: length must match §5; unknown `direction` discriminant invalidates **§13 only** (leave flags at default; do not fail §5). `postcard_take_exact`.

Update `format.rs` module docs: section 13 is emitted when flags are non-default; 4, 6, 10 still never emitted; 11 still declared until Phase 4.

`CapabilityReport` gains `graph_traversal: SectionCapability` with getter. `Default` sets `Absent`. Classify like §12 (available / invalid / absent / disabledByDependency).

Clip copies `flags` the same way it copies `attrs`.

- [ ] **Step 1: Failing tests** in `sections.rs` (copy the §12 round-trip test):

1. `graph_traversal_section_round_trips_on_a_one_way_edge`
2. `default_flags_do_not_emit_section_13`
3. `invalid_direction_discriminant_leaves_flags_default_and_marks_section_invalid`

- [ ] **Step 2: Implement encode/decode/classify/clip.** Wire emit into `encode_bundle` next to §12.

- [ ] **Step 3:** `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle -- graph_traversal`

Expected: PASS.

- [ ] **Step 4: Commit.**

```text
feat(bundle): optional KVB §13 graph traversal flags
```

### Task 8: Export real GDB fields (stop hard-coding zeros)

**Files:**
- Modify: `core/crates/kiriko-bundle/src/export.rs`
- Modify: `src/map/networkFeatures.ts` only if tests assert `BARRIER: 0` on **exported** graphs that now carry flags. Editor `addConnection` may keep writing 0 / null / -1 (new edges are bidirectional and open).

Map:

- `direction`: `null` if `Both`, else `1` / `2`
- `BARRIER`: `1` if barrier else `0`
- `GATE`: `1` if gate else `0`
- `STARTTIME` / `ENDTIME`: the stored i32

Do not change `passage_type` / `HFLAG` derivation.

- [ ] **Step 1: Failing export test** — a one-way barrier edge round-trips through `export_network` → `build_route_graph` and recovers `Forward` + `barrier`.

- [ ] **Step 2: Implement.** Pass `flags` into the path-feature JSON builder (it already takes `attrs`).

- [ ] **Step 3:** `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle -- export_`

Expected: PASS.

- [ ] **Step 4: Update `docs/gdb-data-reference.md`** Known follow-ups: mark `direction` / `barrier` / `gate` / time windows as honoured at import+query (gate stored, not yet a restriction). Leave `passage_type` cost and accessibility profiles as remaining.

- [ ] **Step 5: Commit.**

```text
feat(bundle): export imported direction, barrier, and hours
```

**Phase 2 gate:** recompile a Tokyo GDB (no synth) and confirm a known one-way / barrier edge, if any exist in the source, is no longer bidirectional. If Tokyo `direction` is universally null/0, the import is still correct (all `Both`); do not invent one-way from geometry.

---

## Phase 3 — IMDF Opening / Relationship onto edges

Venue features already carry `accessibility[]` in the geometry section. Copy onto **edges**. Do not treat curated Relationship LINEAL geometry as the network.

### Task 9: Doorway `clearance_m` from Opening length

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs`

Doorway edges currently set `kind: Doorway` and leave `clearance_m: None`. `OpeningAxis` already has `arc_length_m` (LineString length; IMDF: MUST approximate physical width).

When pushing a `EdgeKind::Doorway` edge, set `clearance_m: clearance_attr(opening.arc_length_m)`. Stub edges that only exist to reach the door keep medial/boundary clearance (or inherit the opening width — **use opening width for Doorway only**, stubs stay `None` unless they already get a boundary clearance).

Do not change skeleton/bridge/chord clearance.

- [ ] **Step 1: Failing test** near existing doorway tests: a 1.2 m straight opening produces a Doorway edge with `clearance_m == Some(1.2)` (epsilon ~0.05). A wheelchair profile with `min_clearance_m: Some(1.5)` cannot use that doorway (query test may live in `kiriko-bundle` via `route_with` on the synthesized graph).

- [ ] **Step 2: Implement.** Thread `OpeningAxis` into the emit site that currently builds the Doorway `RouteEdge`.

- [ ] **Step 3:** `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen -- doorway_`

Expected: PASS. Existing doorway topology tests still PASS (node/edge counts unchanged).

- [ ] **Step 4: Commit.**

```text
feat(synth): stamp opening width onto doorway clearance
```

### Task 10: Opening `accessibility[]` → `EdgeFlags`

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs` (and `synth.rs` hub/door edges if that fallback still emits doorways)

Mapping (do not invent IndoorAtlas tags):

- `accessibility` empty → `wheelchair = true`, `accessible_only = false` (public default).
- `accessibility` non-empty → `wheelchair = list.iter().any(|s| s.eq_ignore_ascii_case("wheelchair"))`.
- `accessible_only = false` always from IMDF Openings (IMDF does not express “wheelchair-only special lift”). Leave the flag for a future IndoorAtlas-style import; walking profile’s `exclude_accessible_only` stays a no-op on generated IMDF.

Stamp these flags on **Doorway** edges of that opening. Vertical edges: if the matched transit unit’s `accessibility` is non-empty, apply the same `wheelchair` rule (a stairs unit listing no wheelchair → `wheelchair = false`, which wheelchair profile already skips via `VerticalKind::Stairs`; an elevator with empty list stays `wheelchair = true`).

- [ ] **Step 1: Failing tests.**
  1. Opening with `accessibility: ["wheelchair"]` → doorway `flags.wheelchair == true`.
  2. Opening with `accessibility: ["assisted"]` only → doorway `flags.wheelchair == false`; `route_with(..., wheelchair())` cannot traverse it; walking can.
  3. Opening with empty accessibility → `wheelchair == true`.

Test fixtures: the `feature()` helper in `synth_medial.rs` currently hard-codes `accessibility: Vec::new()`. Add an overload or extra arg; do not change every existing call.

- [ ] **Step 2: Implement stamping.** Read `VenueFeature.accessibility` on the Opening (and transit Unit for verticals). The Opening feature id is already on `OpeningAxis.feature_id`.

- [ ] **Step 3:** `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen -- accessibility_`

Expected: PASS.

- [ ] **Step 4: Commit.**

```text
feat(synth): copy IMDF opening accessibility onto doorway flags
```

### Task 11: Relationship direction / hours (best-effort)

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs` (or a small `relationship.rs` next to `transit_match.rs`)

IMDF Relationship is already a `FeatureType`. Properties live in `source_properties` (`origin`, `destination`, `hours`, directed / one-way — use the IMDF 1.0 names from the Opening/Relationship spec: https://register.apple.com/resources/imdf/types/relationship).

Scope this tightly:

- If a Relationship references an Opening id as origin or destination and carries a directed one-way hint, set that Opening’s doorway `TravelDirection` relative to the stored `from → to` (doorway edges are mid ↔ unit; if the mapping is ambiguous, **leave Both** and do not guess).
- Hours: if `source_properties["hours"]` is absent, skip. Do **not** parse full OSM opening_hours in this task. If you cannot map to `start_minute`/`end_minute` without a parser, leave `-1` and do not warn (no new WarningCode).
- **MUST NOT** add Relationship LINEAL geometry as graph edges.

If no Relationship in the fixture has a usable directed field, ship the code path with a unit test on a hand-built `VenueFeature { feature_type: Relationship, source_properties: { origin, destination, ... } }` and accept Both when the field is missing.

- [ ] **Step 1: Test** `relationship_without_direction_leaves_both`.
- [ ] **Step 2: Implement a conservative mapper; prefer no-op over wrong one-way.**
- [ ] **Step 3:** `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen -- relationship_`
- [ ] **Step 4: Commit.**

```text
feat(synth): optional IMDF Relationship direction on doorways
```

Update `docs/gdb-data-reference.md` follow-up: accessibility profiles honoured for **generated** graphs via Opening flags; Tokyo GDB still has no IMDF accessibility.

**Phase 3 gate:** wheelchair + `min_clearance_m` now sees real doorway widths on generated graphs. Tokyo imported graphs still have `clearance_m = None` (allowed).

---

## Phase 4 — §11 network QA decoder

Declared in `format.rs` since Stage 0; `classify_declared_section` currently reports “no decoder”. Stage 6 of the architecture spec wanted persistent findings, validation profiles, and accepted exceptions. This phase ships **findings + stretch**, shows them in Network Review, and **does not block publish**. No accepted-exceptions UI yet.

`SECTION_NETWORK_QA` already `requires` §8 spatial context. Only emit §11 when §8 is present (GDB/IMDF compiles already emit §8). If §8 is missing, omit §11 (legacy bundles).

### Task 12: Compute findings in-memory

**Files:**
- Create: `core/crates/kiriko-bundle/src/network_qa.rs`
- Modify: `lib.rs` (module + re-export if needed)

**Interfaces:**

```rust
pub struct NetworkFinding {
    pub code: String,          // "disconnected_component" | "isolated_node" | "opening_uncovered"
    pub severity: u8,          // 0 info, 1 warning
    pub detail: String,        // English, deterministic; UI maps code → ja/en
    pub feature_id: Option<String>,
}

pub struct StretchSummary {
    pub sample_count: u32,
    pub rho_max: f32,          // max network/euclidean on same-floor samples
}

pub struct NetworkQa {
    pub findings: Vec<NetworkFinding>,
    pub stretch: Option<StretchSummary>,
}

pub fn analyze_network(document: &BundleDocument) -> NetworkQa
```

Compute:

1. **Components / isolated nodes** — same definition as `networkConnectivity` (union-find on undirected edges). Finding if `components > 1` (`disconnected_component`) or `isolated > 0` (`isolated_node`). Detail includes counts only (deterministic).
2. **Opening coverage** (generated graphs): every walkable Opening id used in synth should have at least one Doorway edge. If synth does not currently keep opening-id on edges, **skip this finding** rather than reverse-engineering; do not block the phase. Prefer: if `OpeningAxis` ids are not stored on the graph, emit nothing for coverage in v1.
3. **Same-floor stretch (advisory):** sample up to 50 pairs of nodes on the same ordinal with Euclidean distance in `(10 m, 40 m]`. `ρ = network_length_m / euclidean_m` where network length is shortest-path on **walking profile** using geometric metres (not `weight`). Skip pairs that do not connect. `rho_max = max ρ`. Do **not** fail compile if `rho_max` is large. Do **not** add chords to drive this down.

Determinism: sort node indices; take pairs in sorted order until 50 successful samples.

- [ ] **Step 1: Failing unit tests** with tiny hand-built `BundleDocument` graphs:
  1. Two disconnected edges → `disconnected_component`.
  2. One isolated node → `isolated_node`.
  3. Two nodes 20 m apart with a 40 m two-edge path → `stretch.rho_max ≈ 2` (tolerance 0.15).
  4. Cross-floor pair is never sampled.

- [ ] **Step 2: Implement `analyze_network`.** Do not call this from encode yet.

- [ ] **Step 3:** `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle -- analyze_network`

Expected: PASS.

- [ ] **Step 4: Commit.**

```text
feat(bundle): in-memory network QA findings
```

### Task 13: Encode / decode §11

**Files:**
- Modify: `format.rs` (docs: §11 now has a decoder), `sections.rs`, `codec.rs`

Postcard DTO mirroring `NetworkQa`. Emit in `encode_bundle` when a graph exists **and** §8 is being emitted. Classify with the real decoder (like §12): available / invalid / absent / disabledByDependency. Invalid §11 must not fail the bundle or the graph.

Replace `classify_declared_section` for id 11 with the real path. Leave §10 on `classify_declared_section`.

- [ ] **Step 1: Failing round-trip test** `network_qa_section_round_trips`.
- [ ] **Step 2: Implement.** Call `analyze_network` at encode time; store on `BundleDocument` at decode time (`document.network_qa: Option<NetworkQa>`).
- [ ] **Step 3:** `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle -- network_qa`
- [ ] **Step 4: Commit.**

```text
feat(bundle): decode KVB §11 network QA
```

### Task 14: Network Review shows findings

**Files:**
- Modify: `core/crates/kiriko-wasm/src/lib.rs` (decode DTO)
- Modify: `src/bundle/wasm.ts`, `src/app/App.tsx`, `src/app/App.test.tsx`

Expose `networkQa` on the decode response when capability is `available`: `{ findings: { code, severity, featureId }[], stretch: { sampleCount, rhoMax } | null }`. Do **not** put English `detail` in the UI; map codes:

```ts
reviewFindingDisconnected: { ja: "グラフが分割されています", en: "Network has disconnected parts" },
reviewFindingIsolated: { ja: "孤立したノードがあります", en: "Isolated nodes present" },
reviewStretch: { ja: "迂回率", en: "detour" },
```

Show under the existing review report line, e.g. `迂回率 1.8` when `stretch` is present (`rhoMax` one decimal). Findings as extra `role="status"` text. Do not block editing or publishing. Do not add a new WarningCode.

- [ ] **Step 1: Failing App test** — mock decode with `networkQa.findings: [{ code: "disconnected_component", severity: 1, featureId: null }]` and assert the Japanese/English string appears when Review network is on (`?lang=en` → English).
- [ ] **Step 2: Implement.** If decode currently drops unknown capability payloads, thread `networkQa` through `DecodeResponseDto` / worker `loaded` response only as needed. Prefer reading it from `decodeBundle().networkQa` rather than a new wasm export.
- [ ] **Step 3:** `pnpm exec vitest run src/app/App.test.tsx src/bundle/wasm.ts` (plus any decode tests).
- [ ] **Step 4: Commit.**

```text
feat(app): show network QA findings in Review
```

**Phase 4 gate:** generate-network on a fixture with two blobs and no doorway produces a disconnected finding in Review. Stretch never fails the job.

Editor rank / type / one-way / accessible tools are **not** in this phase (producer residual; addConnection already writes default flags).

---

## Phase 5 — Optional smoother (gated)

Start only after Phase 4, and only if wheelchair-width greedy-LOS still hugs corners on a real generated venue (JR Takanawa or Shibuya). Default remains greedy-LOS (`smooth.rs`).

### Task 15: Mappedin-style RDP with locked doorway vertices

**Files:**
- Modify: `core/crates/kiriko-route/src/smooth.rs`

Add `smooth_route_rdp(route, floors, epsilon_m)` that:

- Never drops a vertex whose corresponding graph edge `kind == Doorway` (pass a parallel `locked: Vec<bool>` from the unsmoothed route, or lock any vertex within `0.4 m` of a doorway — the existing greedy-LOS already uses a 0.4 m door lock; **reuse that lock set**).
- Runs Ramer–Douglas–Peucker per floor segment in the local metre frame.
- Does not change `total_weight`.

Keep `smooth_route` as greedy-LOS. wasm continues to call greedy-LOS. Wire RDP behind `RouteProfile` only if a later task needs it; this task can stay Rust + unit tests.

- [ ] **Step 1: Failing test** — a three-point almost-collinear corridor; RDP with `epsilon_m = 0.5` drops the middle point; a doorway-locked middle point is kept.
- [ ] **Step 2: Implement RDP; do not switch the wasm default.**
- [ ] **Step 3:** `cargo test --manifest-path core/Cargo.toml -p kiriko-route -- smooth_`
- [ ] **Step 4: Commit.**

```text
feat(route): optional RDP smoother with locked doorways
```

Kallmann r-funnel is **not** in this task. If RDP is insufficient, a follow-up spike (not this plan) implements r-funnel on the existing CDT, still query-time, still locking doorways. Do not add build-time chords.

---

## Phase 6 — Runtime zones (gated)

Start only when a producer has a spill/closure story. Rust API first; no UI until that story exists.

### Task 16: `RouteProfile.zones` extra cost / forbid

**Files:**
- Modify: `core/crates/kiriko-route/src/query.rs`

```rust
pub struct RouteZone {
    pub ring: Vec<[f64; 2]>, // closed lon/lat ring
    pub ordinal: Option<f64>, // None = all floors
    pub extra_cost: f32,      // INFINITY => skip the edge
}
```

If an edge’s midpoint (or any vertex) is inside the ring and the ordinal matches, add `extra_cost` to the adjacency weight, or skip if non-finite. Do not mutate `RouteEdge.weight`. Do not bake into §5.

- [ ] **Step 1: Failing tests** — an edge through a polygon with `extra_cost = f32::INFINITY` is skipped; with `extra_cost = 10_000` the solver prefers a parallel edge with weight 2000.
- [ ] **Step 2: Implement point-in-ring (reuse a tiny existing helper if one exists in `geo_math`; otherwise even-odd in lon/lat is acceptable at corridor scale).
- [ ] **Step 3:** `cargo test --manifest-path core/Cargo.toml -p kiriko-route -- zone_`
- [ ] **Step 4: Commit.**

```text
feat(route): query-time cost zones
```

Do not add wasm/UI in this task.

---

## Out of scope (producer residual — do not implement)

- Campus sidewalks / inter-facility links (“The Indoors tools do not connect facilities in the network.”)
- Multi-vertex stair landings / 3D stair polylines
- Landmarks / 4 m callout directions
- Extra travel modes beyond walking + wheelchair
- Auto-populating `TRAVEL_DIRECTION` from geometry
- Lattice / UCN / IndoorGML dual / ML floorplan / Mappedin AI-as-generator
- Regenerating Tokyo with `synth_medial`
- Changing `total_weight` meaning or “fixing” the `m` label
- Re-penalizing `passage_type`
- Chin–Snoeyink–Wang “for real”
- MazeMap / Google Indoor internals
- Compile-time thin-to-POIs (unsafe until facilities are true graph attachments)
- Network editor rank / type / one-way / accessible widgets
- Accepted-exceptions UI for §11
- §10 canonical graph decoder

---

## Suggested execution cut lines

| After | Ship as |
|---|---|
| Phase 1 | Wheelchair toggle on generated graphs with typed verticals |
| Phase 2 | Tokyo re-import honours one-way / barrier / hours |
| Phase 3 | Generated doorways carry width + IMDF accessibility |
| Phase 4 | Review overlay shows components + detour; publish still succeeds |
| Phase 5 | Only if LOS looks wrong |
| Phase 6 | Only if a producer needs closures |

Stop at the first cut line that meets the current product need; later phases stay in this file.
