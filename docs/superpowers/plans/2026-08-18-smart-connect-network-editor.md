# Smart Connect Network Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a producer pick two same-floor network points, preview the current route plus up to two new walkable paths, add the chosen new path as one undo step, and remove a whole route with box-select (or Select this route) as one undo step.

**Architecture:** Connect stays one tool. Instant hops (< 15 m walkable straight chord) still call `addConnection`. Longer pairs ask Rust `propose_paths` via wasm; App stores a preview; confirm applies `addJunction`/`addConnection` on a working copy and `commit`s once. Selection becomes a set so box-delete and Select this route share `delete_selection`. No generate-network change, no fifth tool, no new `WarningCode`.

**Tech Stack:** Rust 2024 (`kiriko-route`, `kiriko-wasm`), TypeScript viewer (`src/map/networkEditor.ts`, `src/map/networkFeatures.ts`, `src/map/IndoorMap.tsx`, `src/components/NetworkEditorToolbar.tsx`, `src/components/NetworkInspectorPanel.tsx`, `src/app/App.tsx`), Vitest, existing bilingual `ui = { key: { ja, en } }`.

**Spec:** `docs/superpowers/specs/2026-08-18-smart-connect-network-editor-design.md`

## Global Constraints

- TDD. Watch each focused test fail before production code. One commit per task.
- Bilingual UI: every new user string is a `ui` pair `{ ja, en }` with the exact copy in spec §6.3.
- Absence is never success: no current route / no walkable path is a sentence, not an empty polyline.
- Confirm is add-only. Never delete on confirm. Never auto-replace the old path.
- Same-floor only. Existing `cross_floor_connection` stays.
- Walking profile only (`RouteProfile::walking()`). Do not clone the graph.
- Do not change `synth_medial`, add generate-time chords, or regenerate Tokyo.
- No new `WarningCode`. No KVB section version bump. `kiriko-node` does not need this bind.
- New edges use today’s `addConnection` defaults. Do not stamp `EdgeKind::Chord`.
- Undo is the existing stack (`HISTORY_LIMIT = 50`, Ctrl/Cmd+Z). One confirm or bulk delete is one history entry.
- Instant hop: great-circle **< 15.0 m** AND existing `chord_ok` walkable. Otherwise preview.
- Grid A*: 1.0 m cells, 8-connected, 50 000 cells or 400 m cap. Near-graph radius 2.0 m, off-graph cost 3.0×. Snap 0.8 m. Distinct: Hausdorff < 4.0 m AND length ratio inside 0.95…1.05.
- Skip formatters / linters / full-workspace suites unless a step names them.
- Isolated worktree (if used) is created at execution time via `using-git-worktrees`.

## File structure

| File | Responsibility |
|---|---|
| `src/map/networkEditor.ts` | Selection set, preview session state, `box_select`, `confirm_preview`, bulk `delete_selection` |
| `src/map/networkEditor.test.ts` | Reducer tests for set selection, box, bulk delete, preview/confirm/undo |
| `src/map/networkFeatures.ts` | `NetworkRenderState` arrays; `selected` paint on any id in the set |
| `src/map/networkFeatures.test.ts` | Multi-selected junctions/connections paint |
| `src/map/IndoorMap.tsx` | Select-tool box drag; `dragPan` off only in Select; preview strokes; `onBoxSelect` |
| `src/map/IndoorMap.test.tsx` | Box drag vs pan; preview layers |
| `src/components/NetworkInspectorPanel.tsx` | Single-object view vs multi count + Delete |
| `src/components/NetworkEditorToolbar.tsx` | Preview copy and Add / Select this route |
| `src/components/components.test.tsx` | Inspector + toolbar bilingual tests |
| `src/app/App.tsx` | Instant-hop gate, wasm propose, confirm/box wiring |
| `src/app/App.test.tsx` | Selection kind `"set"` if asserted |
| `core/crates/kiriko-route/src/smooth.rs` | `pub(crate)` `walkable` + `chord_ok` (or `pub` `walkable_chord`) |
| `core/crates/kiriko-route/src/propose.rs` | `propose_paths`, grid A*, distinctness |
| `core/crates/kiriko-route/src/query.rs` | Node-index path helper used by current-route candidate |
| `core/crates/kiriko-route/src/lib.rs` | Re-export propose types |
| `core/crates/kiriko-wasm/src/lib.rs` | `proposeNetworkPaths`, `walkableChord` |
| `src/bundle/wasm.ts` | Typed wrappers |

Do not add a crate.

---

### Task 1: Multi-select, box drag, bulk delete

**Files:**
- Modify: `src/map/networkEditor.ts`
- Modify: `src/map/networkEditor.test.ts`
- Modify: `src/map/networkFeatures.ts`
- Modify: `src/map/networkFeatures.test.ts`
- Modify: `src/components/NetworkInspectorPanel.tsx`
- Modify: `src/components/components.test.tsx`
- Modify: `src/map/IndoorMap.tsx`
- Modify: `src/map/IndoorMap.test.tsx`
- Modify: `src/app/App.tsx` (wire `onBoxSelect` + selection kind)
- Modify: any `selection.kind === "junction"` call sites listed in the spec coverage (`IndoorMap.tsx` `networkRenderState`, `App.test.tsx`)

**Interfaces:**
- Consumes: existing `ParsedNetwork`, `addConnection`/`deleteJunction`/`deleteConnection`, `NetworkMapPick`
- Produces:

```ts
export type NetworkSelection =
  | { kind: "set"; junctionIds: number[]; connectionIds: NetworkConnectionId[] }
  | null;

export function singleJunction(nodeId: number): NetworkSelection;
export function singleConnection(id: NetworkConnectionId): NetworkSelection;
export function selectedJunctionId(selection: NetworkSelection): number | null;
export function selectedConnectionId(selection: NetworkSelection): NetworkConnectionId | null;

export type NetworkEditorAction =
  | /* existing except pick still works */
  | { type: "box_select"; nodeIds: number[] };

export interface NetworkRenderState {
  selectedJunctionIds: number[];
  selectedConnections: NetworkConnectionId[];
  pendingJunctionId: number | null;
}

export interface NetworkEditingMapProps {
  tool: NetworkEditTool;
  selection: NetworkSelection;
  pendingNodeId: number | null;
  onPick: (pick: NetworkMapPick) => void;
  onBoxSelect: (bounds: { west: number; south: number; east: number; north: number }) => void;
  centerActionLabel: string;
}
```

`singleJunction(id)` returns `{ kind: "set", junctionIds: [id], connectionIds: [] }`. `selectedJunctionId` returns the id when the set is exactly one junction and zero connections, else `null`. Same idea for connections.

Click-pick of a junction or connection **replaces** the set with that one object (today’s behaviour). `box_select` replaces the set with the given junctions plus every connection whose **both** endpoints are in that junction list. Empty `nodeIds` is a no-op (selection unchanged).

`delete_selection` on a set: delete every selected junction (incident paths go with them) then every remaining selected connection, all on a working copy, then one `commit`. Empty selection is a no-op.

Inspector: `selectedJunctionId` / `selectedConnectionId` non-null → today’s detail. Otherwise show `{n} selected` / `{n}件選択` where `n = junctionIds.length + connectionIds.length`, plus one Delete. Hide Move when not a single junction.

IndoorMap: when `tool === "select"`, disable `dragPan` on attach and on tool change; enable it for every other tool and on unmount. Pointer: `mousedown` records pixel; if `mouseup` movement ≥ 4 px, `unproject` both corners, call `onBoxSelect` with min/max lon/lat, do **not** `onPick`. Movement < 4 px keeps today’s click `onPick`. Other tools never start a box.

App: `onBoxSelect` filters `editor.present.junctions` on `activeOrdinal` whose Point lon/lat is inside the bounds (inclusive), dispatches `{ type: "box_select", nodeIds }`.

- [ ] **Step 1: Write the failing reducer tests**

Add to `src/map/networkEditor.test.ts` (keep existing fixtures). Update every `toEqual({ kind: "junction", nodeId: N })` in this file to `singleJunction(N)` in the same commit as the type change — those updates are mechanical and land with the implementation step so Step 1 can add *new* tests that already use the set type (they will fail to compile until the type exists; if the suite cannot load, write the new tests first against a local cast and switch them when types land). Prefer: add these tests now; they fail because `box_select` is not a known action.

```ts
describe("networkEditorReducer multi-select", () => {
  it("box_select selects junctions and only connections with both ends in the box", () => {
    const net = connected(); // nodes 0-1 plus their pair
    const extra = addJunction(net, { longitude: 139.702, latitude: 35.6, ordinal: 0 });
    if (!extra.ok) throw new Error("fixture");
    let s = createNetworkEditorState(extra.network);
    s = reduce(s, { type: "box_select", nodeIds: [0, 1] });
    expect(s.selection).toEqual({
      kind: "set",
      junctionIds: [0, 1],
      connectionIds: [expect.objectContaining({ pathId: expect.any(Number) })],
    });
    expect(s.selection?.kind).toBe("set");
    if (s.selection?.kind === "set") {
      expect(s.selection.connectionIds).toHaveLength(1);
    }
    expect(s.past).toHaveLength(0);
  });

  it("box_select of no nodes leaves the selection unchanged", () => {
    let s = createNetworkEditorState(connected());
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    const before = s.selection;
    s = reduce(s, { type: "box_select", nodeIds: [] });
    expect(s.selection).toBe(before);
  });

  it("delete_selection removes a multi-set as one undo step", () => {
    let s = createNetworkEditorState(connected());
    s = reduce(s, { type: "box_select", nodeIds: [0, 1] });
    s = reduce(s, { type: "delete_selection" });
    expect(s.present.junctions).toHaveLength(0);
    expect(s.present.paths).toHaveLength(0);
    expect(s.selection).toBeNull();
    expect(s.past).toHaveLength(1);
    s = reduce(s, { type: "undo" });
    expect(s.present.junctions).toHaveLength(2);
    expect(s.present.paths).toHaveLength(2);
  });

  it("click pick replaces a multi-set with a single object", () => {
    let s = createNetworkEditorState(connected());
    s = reduce(s, { type: "box_select", nodeIds: [0, 1] });
    s = reduce(s, { type: "pick", pick: { kind: "junction", nodeId: 0 }, activeOrdinal: 0 });
    expect(s.selection).toEqual(singleJunction(0));
  });
});
```

If `addJunction` is not imported, import it from `./networkFeatures`.

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `pnpm exec vitest run src/map/networkEditor.test.ts`

Expected: FAIL — `box_select` is not a valid action, or selection is still `{ kind: "junction" }`.

- [ ] **Step 3: Implement selection set + box_select + bulk delete**

In `networkEditor.ts`:

- Change `NetworkSelection` to the set form. Add `singleJunction`, `singleConnection`, `selectedJunctionId`, `selectedConnectionId`.
- `applyPick` select / add-junction object hits: `selection: singleJunction(...)` or `singleConnection(...)`.
- Connect success: `singleConnection(result.connectionId)`.
- Move success: `singleJunction(nodeId)`.
- `start_move`: `singleJunction(action.nodeId)`.
- `selectionPresent`: true when every id in the set still exists.
- `delete_selection`: if null, return state. Working copy: for each `junctionIds` call `deleteJunction`; then for each `connectionIds` call `deleteConnection` (ignore `unknown_connection` after a junction delete). One `commit`, `selection: null`.
- `box_select`: if `nodeIds.length === 0` return state. Deduplicate ids. `connectionIds` = every `connectionKeys` pair whose both endpoint NODEIDs are in the set (read endpoints from `present.paths` `FNODEID`/`TNODEID`). Sort junction ids ascending for determinism. Do not `commit`.

Update every existing assertion in `networkEditor.test.ts` that compared `{ kind: "junction", nodeId }` / `{ kind: "connection" }` to the helpers. Connect test `expect(s.selection?.kind).toBe("connection")` becomes `expect(selectedConnectionId(s.selection)).not.toBeNull()`.

- [ ] **Step 4: Re-run reducer tests**

Run: `pnpm exec vitest run src/map/networkEditor.test.ts`

Expected: PASS (after assertion updates).

- [ ] **Step 5: Render state + inspector + map box**

`NetworkRenderState` uses arrays. `buildNetworkFeatures` sets `selected` when `selectedJunctionIds.includes(id)` or the connection id is in `selectedConnections`.

Update `networkFeatures.test.ts` fixtures to `selectedJunctionIds: []` / `selectedConnections: []` (or the selected ids).

Add inspector test in `components.test.tsx`:

```tsx
it("shows a bilingual count and one Delete for a multi-set", () => {
  render(
    <NetworkInspectorPanel
      network={inspectorNet}
      selection={{ kind: "set", junctionIds: [0, 1], connectionIds: [] }}
      locale="en"
      locked={false}
      onClose={() => {}}
      onMove={() => {}}
      onDelete={() => {}}
    />,
  );
  expect(screen.getByText("2 selected")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Move point" })).toBeNull();
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
});
```

Existing inspector tests: change `selection={{ kind: "junction", nodeId: 0 }}` to `singleJunction(0)` (import from `networkEditor`) and same for connection. Title for a one-junction set stays `Point ${id}` / `点 ${id}`.

IndoorMap FakeMap: add

```ts
readonly dragPan = {
  enabled: true,
  disable(): void { this.enabled = false; },
  enable(): void { this.enabled = true; },
};
```

Add `onBoxSelect: vi.fn()` to `editing()`.

Tests:

```ts
it("disables dragPan in select and re-enables it for connect", () => {
  const { map, rerender } = renderMap(baseProps({ networkEditing: editing({ tool: "select" }) }));
  expect(map.dragPan.enabled).toBe(false);
  rerender(baseProps({ networkEditing: editing({ tool: "connect" }) }));
  expect(map.dragPan.enabled).toBe(true);
});

it("reports onBoxSelect for a select-tool drag of at least 4 px and does not onPick", () => {
  const net = editing({ tool: "select" });
  const { map } = renderMap(baseProps({ networkEditing: net }));
  map.unproject = (p: { x: number; y: number }) => ({ lng: p.x, lat: p.y });
  act(() => {
    map.emit("mousedown", { point: { x: 0, y: 0 }, lngLat: { lng: 0, lat: 0 } });
    map.emit("mouseup", { point: { x: 10, y: 8 }, lngLat: { lng: 10, lat: 8 } });
  });
  expect(net.onBoxSelect).toHaveBeenCalledWith({ west: 0, south: 0, east: 10, north: 8 });
  expect(net.onPick).not.toHaveBeenCalled();
});
```

If FakeMap has no `unproject`, add `unproject(point) { return { lng: point.x, lat: point.y }; }`. If events are only `click` today, subscribe to `mousedown`/`mouseup` on the map in the network-editing effect (same place as `click`).

App: pass `onBoxSelect` that maps bounds → node ids on the active floor and dispatches `box_select`. Update `networkRenderState` to pass arrays from the set.

- [ ] **Step 6: Run the UI tests**

Run: `pnpm exec vitest run src/map/networkEditor.test.ts src/map/networkFeatures.test.ts src/map/IndoorMap.test.tsx src/components/components.test.tsx src/app/App.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```
git add src/map/networkEditor.ts src/map/networkEditor.test.ts src/map/networkFeatures.ts src/map/networkFeatures.test.ts src/map/IndoorMap.tsx src/map/IndoorMap.test.tsx src/components/NetworkInspectorPanel.tsx src/components/components.test.tsx src/app/App.tsx src/app/App.test.tsx
git commit -m "feat(editor): box-select and bulk-delete network objects"
```

---

### Task 2: `propose_paths` + wasm bind

**Files:**
- Create: `core/crates/kiriko-route/src/propose.rs`
- Modify: `core/crates/kiriko-route/src/lib.rs`
- Modify: `core/crates/kiriko-route/src/smooth.rs` (export `walkable` + `chord_ok` as `pub(crate)`, add `pub fn walkable_chord`)
- Modify: `core/crates/kiriko-route/src/query.rs` (node-index path helper)
- Modify: `core/crates/kiriko-wasm/src/lib.rs`
- Modify: `src/bundle/wasm.ts`
- Test: `propose.rs` `mod tests` (and a wasm unit test next to `route_returns_floor_grouped_segments` if one can use an existing fixture bundle)

**Interfaces:**
- Consumes: `RouteGraph`, `RouteProfile`, `route_with`, `smooth_route`, `WalkableFloor`, `haversine_m`, `point_seg_dist_m`, `build_route_graph`
- Produces:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathCandidateKind { Current, AlongNetwork, Shorter }

#[derive(Debug, Clone, PartialEq)]
pub struct PathCandidate {
    pub kind: PathCandidateKind,
    pub coordinates: Vec<[f64; 2]>,
    pub node_ids: Option<Vec<u64>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PathProposal {
    pub from_id: u64,
    pub to_id: u64,
    pub candidates: Vec<PathCandidate>,
}

pub fn propose_paths(
    graph: &RouteGraph,
    node_ids: &[u64],
    floors: &[WalkableFloor],
    from_id: u64,
    to_id: u64,
    profile: &RouteProfile,
) -> PathProposal;

pub fn walkable_chord(floor: &WalkableFloor, a: [f64; 2], b: [f64; 2]) -> bool;
```

`walkable_chord` is `chord_ok(&[a, b], 0, 1, floor)`.

`node_ids[i]` is `RouteGraphBuild.node_ids[i]` (NODEID of `graph.nodes[i]`). Unknown `from_id`/`to_id` → empty `candidates`.

Current candidate: crate-private `route_node_path(graph, origin, dest, profile) -> Option<Vec<usize>>` (same A* as `route_with`, return visited node indices). Map through `node_ids`. Display coordinates = `smooth_route` of `route_with(...)`. If `route_with` is `None`, omit Current.

New candidates: only if a `WalkableFloor` with `ordinal == from.ordinal` exists and has polygons. Empty `floors` → no new candidates; Current still computed.

Grid A* (local metres at `from.lat`):

- cell 1.0 m, 8-connected
- cell blocked unless `walkable(center, floor)`
- along-network cost: `step_m * (if min point_seg_dist_m to any same-floor edge < 2.0 { 1.0 } else { 3.0 })`
- shorter cost: `step_m`
- heuristic: haversine to dest
- stop after 50_000 expansions **or** when a popped node is > 400 m from origin (do not expand it)
- reconstruct centres, then greedy-LOS using `chord_ok` on that polyline (same pull as `smooth_segment`)

Distinctness: hide B when both `0.95 ≤ len(A)/len(B) ≤ 1.05` and discrete Hausdorff (sample ≤ 1.0 m) < 4.0 m. Compare each new candidate to Current (if any) and to the other new candidate. Never hide Current. Do not run a third / blocked-corridor search.

Wasm:

```rust
#[wasm_bindgen(js_name = "walkableChord")]
pub fn walkable_chord_js(bundle: &[u8], a_lon: f64, a_lat: f64, b_lon: f64, b_lat: f64, ordinal: f64) -> Result<bool, JsError>;

#[wasm_bindgen(js_name = "proposeNetworkPaths")]
pub fn propose_network_paths_js(
    bundle: &[u8],
    junctions_geojson: &str,
    paths_geojson: &str,
    from_id: f64,
    to_id: f64,
) -> Result<JsValue, JsError>;
```

`walkableChord`: decode bundle, `walkable_floors`, find floor by ordinal, `walkable_chord`. No matching floor → `Ok(false)`.

`proposeNetworkPaths`: decode bundle for floors only; `build_route_graph(junctions, paths, level_ordinals_from_document)`; `propose_paths(..., walking())`. Serialize `{ fromId, toId, candidates: [{ kind: "current"|"along_network"|"shorter", coordinates: [[lon,lat],...], nodeIds: number[] | null }] }` json-compatible.

TS wrappers in `src/bundle/wasm.ts` matching that DTO. Rebuild wasm the same way `pnpm core:build:wasm` / `scripts/build-wasm.mjs` already does when you need the bind in later tasks; this task’s rust tests do not require wasm.

- [ ] **Step 1: Write failing Rust tests in `propose.rs`**

Create the module with `#[cfg(test)] mod tests` first; `propose_paths` can be a stub that panics or returns empty so the test compiles and fails assertions.

Reuse `smooth.rs` test helpers’ idea: `pt(lon,lat)` via a 1 m ≈ deg conversion. Copy the `rect` / `hall` pattern locally (do not make `smooth` tests public).

```rust
fn node(lon: f64, lat: f64, ordinal: f64) -> RouteNode {
    RouteNode { lon, lat, ordinal }
}
fn edge(from: u32, to: u32, weight: f32, ordinal: f64) -> RouteEdge {
    RouteEdge {
        from, to, weight, ordinal, interior: vec![],
        attrs: EdgeAttrs::default(), flags: EdgeFlags::default(),
    }
}

#[test]
fn connected_corridor_emits_current_and_hides_along_when_it_matches() {
    // nodes 0 -- 1 -- 2 along a 20×4 m hall; node_ids 10,11,12
    let graph = RouteGraph { nodes: vec![node(-0.00008, 0.0, 0.0), node(0.0, 0.0, 0.0), node(0.00008, 0.0, 0.0)],
        edges: vec![
            edge(0, 1, 8.0, 0.0), edge(1, 0, 8.0, 0.0),
            edge(1, 2, 8.0, 0.0), edge(2, 1, 8.0, 0.0),
        ]};
    let out = propose_paths(&graph, &[10, 11, 12], &[hall()], 10, 12, &RouteProfile::walking());
    assert!(out.candidates.iter().any(|c| c.kind == PathCandidateKind::Current
        && c.node_ids.as_deref() == Some(&[10, 11, 12][..])));
    assert!(!out.candidates.iter().any(|c| c.kind == PathCandidateKind::AlongNetwork));
}

#[test]
fn open_hall_emits_shorter_when_the_graph_goes_the_long_way() {
    // Graph: A south, around a detour, to B. Walkable is a wide 40×20 m hall
    // so the uniform grid path is a near-straight diagonal, Hausdorff >> 4 m.
}

#[test]
fn disconnected_islands_with_walkable_gap_have_no_current_and_a_joiner() {
    // Two nodes, no edges, hall covering both. Current absent.
    // along_network or shorter present; every sample walkable.
}

#[test]
fn wall_between_disconnected_nodes_yields_no_candidates() {
    // Two nodes, no edges, two separate polygons that do not touch.
    assert!(propose_paths(...).candidates.is_empty());
}

#[test]
fn through_hole_is_never_emitted() {
    // hall_with_hole; from west to east. Any new polyline's 0.5 m samples
    // must pass walkable() — never a chord through the kiosk.
}

#[test]
fn empty_floors_keep_current_and_drop_new() {
    // same connected corridor, floors = &[]
    assert_eq!(out.candidates.len(), 1);
    assert_eq!(out.candidates[0].kind, PathCandidateKind::Current);
}

#[test]
fn walkable_chord_is_false_across_a_hole() { ... }

#[test]
fn distinctness_drops_a_near_duplicate() {
    // unit-test the helper with two polylines 1 m apart, same length
}
```

Fill the open-hall / islands / wall fixtures with real lon/lat using the same `pt` scaling as `smooth.rs` tests (`EARTH_RADIUS_M`, 1 m in lon at lat 0 ≈ `1.0 / (EARTH_RADIUS_M * PI / 180.0)` degrees).

- [ ] **Step 2: Run tests — fail because `propose_paths` is missing or empty**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-route propose -- --nocapture`

Expected: FAIL on assertions (empty candidates or unresolved symbol if you only added tests).

- [ ] **Step 3: Implement `walkable_chord`, `route_node_path`, `propose_paths`**

Promote `walkable` and `chord_ok` to `pub(crate)` in `smooth.rs`. Add `pub fn walkable_chord`.

In `query.rs`, extract the A* parent walk into `pub(crate) fn route_node_path(...) -> Option<Vec<usize>>`. `route_with` keeps using it (or stays as-is if extracting is larger than a private duplicate used only by propose — prefer extract, do not change `route_with` results).

Implement `propose_paths` per Interfaces. `lib.rs`: `mod propose; pub use propose::{PathCandidate, PathCandidateKind, PathProposal, propose_paths, walkable_chord};`

- [ ] **Step 4: Re-run rust tests**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-route propose`

Expected: PASS.

- [ ] **Step 5: Wasm bind + TS types**

Add the two `wasm_bindgen` functions. Add DTOs + `proposeNetworkPaths` / `walkableChord` to `src/bundle/wasm.ts`. Do not call them from App yet.

If a wasm rust test can decode an existing fixture bundle, add one that `propose_network_paths_js` returns a JS object with `candidates` as an array (even empty). Skip if no fixture is already used in `kiriko-wasm` tests.

- [ ] **Step 6: Commit**

```
git add core/crates/kiriko-route/src/propose.rs core/crates/kiriko-route/src/lib.rs core/crates/kiriko-route/src/smooth.rs core/crates/kiriko-route/src/query.rs core/crates/kiriko-wasm/src/lib.rs src/bundle/wasm.ts
git commit -m "feat(route): propose walkable editor paths"
```

---

### Task 3: Connect preview, instant hop, confirm, undo

**Files:**
- Modify: `src/map/networkEditor.ts`
- Modify: `src/map/networkEditor.test.ts`
- Modify: `src/map/networkFeatures.ts` (optional `addPath` helper)
- Modify: `src/app/App.tsx`
- Modify: `src/bundle/wasm.ts` (if a `networkToGeoJson` helper lives here or next to features)
- Modify: `src/components/NetworkEditorToolbar.tsx` (minimal: do not add Select-this-route yet — that is Task 4; do add preview instruction + Add this path if the toolbar is the confirm affordance)

**Interfaces:**
- Consumes: Task 1 selection set; Task 2 `proposeNetworkPaths`, `walkableChord`
- Produces:

```ts
export type PathCandidateKind = "current" | "along_network" | "shorter";
export interface PathCandidate {
  kind: PathCandidateKind;
  coordinates: [number, number][];
  nodeIds: number[] | null;
}
export interface PathPreview {
  fromId: number;
  toId: number;
  candidates: PathCandidate[];
  selectedIndex: number;
}

// NetworkEditorState.preview: PathPreview | null
// createNetworkEditorState: preview: null
// cancel_pending, set_tool, undo, redo, reset: preview = null

export type NetworkEditorAction =
  | { type: "set_preview"; preview: PathPreview }
  | { type: "select_candidate"; index: number }
  | { type: "confirm_preview" }
  | /* Task 1 + existing */;
```

Confirm of `current` or missing preview: no `commit`. Confirm of a new candidate: working copy per spec §5.5 (snap 0.8 m via haversine, `addJunction`, skip existing connections, abort on `node_id_exhausted` / `invalid_coordinate` without committing). One `commit` if the working copy differs.

Connect pick of a second junction **does not** call `addConnection` in the reducer anymore when the pair is valid. The reducer only sets `pendingNodeId` then waits. App decides instant vs preview:

```
on second connect pick:
  if addConnection would fail (cross-floor / existing / same): dispatch pick as today (reducer still performs that rejection for those errors — keep that path in the reducer).
  else {
    const chord = walkableChord(...)
    const dist = haversine
    if (dist < 15 && chord) dispatch pick → reducer addConnection (instant)
    else {
      try {
        const proposal = await proposeNetworkPaths(...)
        if no candidates: notice noWalkable or disconnected (disconnected = no current AND at least one new? wait)
      }
    }
  }
```

Spec split that must be implemented exactly:

- Existing direct edge / cross-floor / same junction: reducer notice, no preview (keep current `applyPick` connect branch for these failures **before** App asks wasm). App can probe with a dry check: if `present` already has that pair → dispatch pick (notice). If ordinals differ → dispatch pick (notice).
- Instant hop: App dispatches pick; reducer `addConnection` as today.
- Else App calls wasm; `set_preview`. If wasm throws: notice `proposeFailed` (new `NetworkMutationError` **or** a toolbar-only string). Prefer **not** widening `NetworkMutationError` — keep a `previewNotice: "no_walkable" | "disconnected" | "propose_failed" | null` on editor state, or reuse `notice` only for mutation errors and pass propose copy from App through existing `saveMessage`-style props. Simplest in-spec: add optional `previewStatus: "disconnected" | "no_walkable" | "propose_failed" | null` on state, set by `{ type: "set_preview_status"; status }`. Empty candidates + no current → `no_walkable`. Empty current + some new → preview shown, status `disconnected`. Wasm throw → `propose_failed`, pending cleared.

Do **not** add a second undo stack.

- [ ] **Step 1: Failing reducer tests for preview/confirm**

```ts
const previewOf = (kind: PathCandidateKind, coords: [number, number][]): PathPreview => ({
  fromId: 0,
  toId: 1,
  candidates: [{ kind, coordinates: coords, nodeIds: kind === "current" ? [0, 1] : null }],
  selectedIndex: 0,
});

it("confirm_preview of current does not commit", () => {
  let s = createNetworkEditorState(twoPoints());
  s = { ...s, preview: previewOf("current", [[139.7, 35.6], [139.7005, 35.6]]) };
  s = reduce(s, { type: "confirm_preview" });
  expect(s.present.paths).toHaveLength(0);
  expect(s.past).toHaveLength(0);
});

it("confirm_preview of a new path is one undo that removes every added junction and connection", () => {
  let s = createNetworkEditorState(twoPoints());
  const mid: [number, number] = [139.70025, 35.6];
  s = reduce(s, {
    type: "set_preview",
    preview: {
      fromId: 0,
      toId: 1,
      candidates: [{ kind: "shorter", coordinates: [[139.7, 35.6], mid, [139.7005, 35.6]], nodeIds: null }],
      selectedIndex: 0,
    },
  });
  s = reduce(s, { type: "confirm_preview" });
  expect(s.present.junctions.length).toBeGreaterThanOrEqual(3);
  expect(s.present.paths.length).toBeGreaterThanOrEqual(4); // two new undirected pairs
  expect(s.past).toHaveLength(1);
  expect(s.preview).toBeNull();
  s = reduce(s, { type: "undo" });
  expect(s.present.junctions).toHaveLength(2);
  expect(s.present.paths).toHaveLength(0);
  expect(s.preview).toBeNull();
});

it("cancel_pending and set_tool drop preview without history", () => {
  let s = createNetworkEditorState(twoPoints());
  s = reduce(s, { type: "set_preview", preview: previewOf("shorter", [[139.7, 35.6], [139.7005, 35.6]]) });
  s = reduce(s, { type: "cancel_pending" });
  expect(s.preview).toBeNull();
  expect(s.past).toHaveLength(0);
});
```

- [ ] **Step 2: Run — fail on unknown actions**

Run: `pnpm exec vitest run src/map/networkEditor.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement preview reducer + confirm working copy**

Snap radius 0.8 m, haversine already in `networkFeatures.ts` (or inspector). Reuse it; do not copy a third Earth radius if one is already exported — if not exported, use the same `6_371_000` constant already in `networkFeatures.ts`.

`addPath(network, coordinates, ordinal): NetworkMutationResult` may live in `networkFeatures.ts` so confirm stays thin. Tests for snap/reuse can be unit tests there if the reducer test is not enough — add `networkFeatures.test.ts` cases:

- consecutive vertices on existing nodes add only the missing connections
- vertex within 0.8 m reuses NODEID
- `existing_connection` on one pair does not fail the whole path

- [ ] **Step 4: Reducer tests PASS**

Run: `pnpm exec vitest run src/map/networkEditor.test.ts src/map/networkFeatures.test.ts`

- [ ] **Step 5: App wiring**

Serialize `present` to two FeatureCollection JSON strings (junctions / paths) using each feature’s `geometry` + `properties`.

On connect’s second junction pick (in `onNetworkPick` / the existing editor pick handler): apply the instant-vs-preview gate with `walkableChord` + haversine. Need the decoded bundle bytes already in the viewer (the same `Uint8Array` `routeBundle` uses). If walkable wasm is unavailable, treat chord as not walkable (fall through to preview) — do not punch a wall.

`set_preview` from the wasm DTO. Map `kind` strings 1:1.

Toolbar (this task): while `preview !== null`, instruction = spec `instructPreview`. Button **Add this path** / `この経路を追加` calls `confirm_preview`. Disabled when the selected candidate is `current` or missing. Escape already `cancel_pending`.

Do not implement Select this route here.

Rebuild wasm (`pnpm core:build:wasm`) before App tests that mock wasm if those tests import the wrapper. Prefer mocking `walkableChord` / `proposeNetworkPaths` in `App.test.tsx` if App tests already mock `@kiriko/wasm`.

- [ ] **Step 6: Run editor + app tests**

Run: `pnpm exec vitest run src/map/networkEditor.test.ts src/map/networkFeatures.test.ts src/components/components.test.tsx src/app/App.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```
git add src/map/networkEditor.ts src/map/networkEditor.test.ts src/map/networkFeatures.ts src/map/networkFeatures.test.ts src/app/App.tsx src/app/App.test.tsx src/components/NetworkEditorToolbar.tsx src/components/components.test.tsx src/bundle/wasm.ts
git commit -m "feat(editor): preview and confirm walkable connect paths"
```

---

### Task 4: Select this route, toolbar copy, map strokes

**Files:**
- Modify: `src/map/networkEditor.ts` (`select_current_route`)
- Modify: `src/map/networkEditor.test.ts`
- Modify: `src/components/NetworkEditorToolbar.tsx`
- Modify: `src/components/components.test.tsx`
- Modify: `src/map/IndoorMap.tsx` + `networkFeatures.ts` (preview GeoJSON)
- Modify: `src/map/IndoorMap.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/app.css` only if existing network/route classes cannot distinguish current vs new vs highlighted

**Interfaces:**
- Consumes: Task 3 `PathPreview`
- Produces:

```ts
| { type: "select_current_route" }
```

`select_current_route`: find the `current` candidate; if none, no-op. Selection = `{ kind: "set", junctionIds: candidate.nodeIds, connectionIds: pairs of consecutive nodeIds that exist as connections }`. `preview = null`. `tool = "select"`. No `commit`.

Toolbar copy (exact spec §6.3): `instructPreview`, `currentRoute`, `alongNetwork`, `shorterPath`, `addPath`, `selectRoute`, `disconnected`, `noWalkable`, `proposeFailed`. Candidate switcher: one control per candidate labeled with those strings. **Select this route** disabled when no current candidate. **Add this path** disabled for `current`.

Map: add a preview source or reuse `ROUTE_SOURCE_ID` only if directions is off during edit (it is — editing replaces directions). Prefer a dedicated `NETWORK_PREVIEW_SOURCE_ID` if adding a source is already patterned; otherwise put preview LineStrings into the network FeatureCollection with `kind: "preview"` and `previewRole: "current" | "along_network" | "shorter" | "highlight"`. Highlight = selected candidate (also keep its role). Paint: current uses the existing directions color; new quieter (lower opacity); highlight louder (existing selected-path width).

Tests:

```ts
it("select_current_route loads graph nodes and edges then closes preview", () => {
  let s = createNetworkEditorState(connected());
  s = reduce(s, {
    type: "set_preview",
    preview: {
      fromId: 0,
      toId: 1,
      candidates: [{ kind: "current", coordinates: [[139.7, 35.6], [139.7005, 35.6]], nodeIds: [0, 1] }],
      selectedIndex: 0,
    },
  });
  s = reduce(s, { type: "select_current_route" });
  expect(s.preview).toBeNull();
  expect(s.tool).toBe("select");
  expect(s.selection).toEqual({
    kind: "set",
    junctionIds: [0, 1],
    connectionIds: [expect.objectContaining({})],
  });
});
```

Toolbar: English **Add this path** disabled when only `current` is selected; **Select this route** present. Japanese locale renders `この経路を追加` / `この経路を選択`. `noWalkable` / `proposeFailed` / `disconnected` appear as `role="status"` text, never as an empty path.

IndoorMap: select-tool drag still does not pan (Task 1); Connect still pans. Preview features appear in the network source data when `networkEditing.preview` is passed through `NetworkEditingMapProps`.

```ts
export interface NetworkEditingMapProps {
  /* Task 1 fields */
  preview: PathPreview | null;
}
```

- [ ] **Step 1: Failing tests** (`select_current_route`, toolbar ja/en, preview features in network source)

- [ ] **Step 2: Run — fail**

`pnpm exec vitest run src/map/networkEditor.test.ts src/components/components.test.tsx src/map/IndoorMap.test.tsx`

- [ ] **Step 3: Implement action, toolbar, preview paint**

- [ ] **Step 4: Tests PASS**

`pnpm exec vitest run src/map/networkEditor.test.ts src/map/networkFeatures.test.ts src/map/IndoorMap.test.tsx src/components/components.test.tsx src/app/App.test.tsx`

- [ ] **Step 5: Commit**

```
git commit -m "feat(editor): select current route and preview strokes"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| §4.1 Instant hop / already connected / preview gate | 3 |
| §4.2 Preview candidates + absence copy | 3, 4 |
| §4.3 Select this route | 4 |
| §4.4 Box select + bulk delete | 1 |
| §4.5 Undo | 1, 3 |
| §5 propose_paths algorithm + constants | 2 |
| §5.5 Confirm working copy | 3 |
| §6 Selection set + preview state | 1, 3 |
| §6.3 Copy table | 4 (Add in 3) |
| §7 Architecture / wasm | 2, 3 |
| §8 Error table | 3, 4 |
| §9 Tests | all |
| Cross-floor / no fifth tool / no generate / no new WarningCode | all (by omission) |

## Self-review

- No TBD/TODO. `open_hall` fixture in Task 2 Step 1 is described enough to build: wide hall, detour graph, assert Shorter present and distinct from Current.
- Types: `NetworkSelection` set form is produced in Task 1 and consumed by 3–4. `PathPreview` produced in Task 3, `select_current_route` in Task 4. Wasm DTO kinds are `current` / `along_network` / `shorter` everywhere.
- Task 3 toolbar Add vs Task 4 Select this route is an intentional split so Task 3 is testable without paint.
