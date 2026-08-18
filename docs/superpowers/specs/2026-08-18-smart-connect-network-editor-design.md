# Smart Connect and multi-select in the network editor

**Date:** 2026-08-18
**Status:** Approved for implementation planning
**Depends on:** network editor (`src/map/networkEditor.ts`, `src/map/networkFeatures.ts`, `src/components/NetworkEditorToolbar.tsx`), `kiriko-route` (`route_with`, `smooth_route`, `WalkableFloor`), wasm route/export bindings, walkable floors from `kiriko-bundle::walkable`
**Does not depend on:** generate-network changes, KVB §11 findings UI, cross-floor editor connect, edge-attribute editing

## 1. Purpose

The network editor can add and delete single points and straight same-floor edges. That is the right primitive for a doorway hop and the wrong primitive for “this ticket gate to that platform.”

This design extends Connect so a producer can pick two same-floor points and see:

- the **current** graph route, when one exists (inspect);
- up to two **new** walkable paths that are not already in the graph (gap-fill, join disconnected islands, or a shortcut generation refused).

Confirm **adds** the chosen new path. It never deletes. Removing a bad old route is a separate, explicit multi-select delete (box drag, or “Select this route” from the preview).

Undo stays the existing `Ctrl+Z` / toolbar stack. One confirmed path is one history entry.

## 2. Jobs (locked)

One gesture covers four jobs:

| Job | Graph state | Confirm |
|---|---|---|
| Inspect how A\* currently goes | Connected | No write |
| Fill a missing corridor / join two islands | Disconnected | Add joiner |
| Add a shortcut generation missed | Connected, a distinct walkable path exists | Add shortcut |
| Remove a whole route after adding a better one | After an add, or from inspect | Multi-select delete (not confirm) |

## 3. Non-goals

- A fifth toolbar tool. Connect stays Connect.
- Cross-floor Connect. The existing `cross_floor_connection` notice stays. Vertical editing is a later tool.
- Auto-delete or replace of the old path.
- Changing `synth_medial`, adding generate-time chords, or regenerating Tokyo.
- New `WarningCode`s or TS allowlist changes.
- Shift-click additive select, lasso, or select-across-floors.
- Editing edge rank / type / one-way / accessible (still a later editor gap).
- A second undo stack.
- Cloning the graph per travel profile. Preview uses the walking profile (`RouteProfile::walking()`).

## 4. Interaction

### 4.1 Connect

Click A, then B, same floor, same as today. What happens next:

1. **Already a direct edge** — existing “already connected” notice. No preview.
2. **Instant hop** — no existing direct edge, great-circle length **< 15.0 m**, and the straight chord is walkable under the same test as `kiriko_route::smooth` (`chord_ok`: samples ≤ 0.5 m, `SEGMENT_OUTSIDE_TOL_M = 0.3`, door locks at 0.4 m). Apply today’s `addConnection`. One undo step.
3. **Preview** — every other same-floor pair.

A still-pending first click is unchanged (`pendingNodeId`). Escape / tool switch already runs `cancel_pending` and must also drop any preview.

### 4.2 Preview

Drawn on the map, not in a wizard.

- **Current route** — present only when `route_with` on the **in-progress edited graph** finds a path. Drawn in the existing directions stroke. Confirming it writes nothing. “Add this path” is disabled while it is highlighted.
- **Along the network** — a new walkable path that prefers cells near existing same-floor edges. Hidden when it is not distinct from the current route (or from the other new candidate).
- **Shorter path** — a new walkable path with uniform walkable cost (the open-hall diagonal generation refused). Hidden when it is not distinct. This spec does not search a second atrium homotopy.

If A and B are disconnected, there is no current-route candidate. The toolbar says the network is in two parts. The new candidates are joiners.

If there is a current route and no distinct new candidate, the preview is inspect-only: current route + **Select this route**. **Add this path** stays disabled.

If there is no current route and no walkable joiner, there is no preview overlay. The toolbar says there is no walkable path. The graph is unchanged.

Escape or switching tools cancels. Confirm of a new candidate inserts its geometry as one undo step.

### 4.3 Select this route

Enabled only when a current route exists. Loads that route’s **graph** nodes and the connections between consecutive route nodes into the selection, then closes the preview. Smoothed extra vertices that are not graph nodes are not selected.

The producer then hits Delete / Backspace / inspector Delete to remove that set as one undo step.

### 4.4 Multi-select and bulk delete

Select tool only:

- Click-drag draws a screen-space rectangle. `dragPan` is off only while the Select tool is active. Other tools keep today’s pan.
- Every junction on the **active floor** whose point lies inside the rectangle is selected.
- Every logical connection whose **both** endpoints are in that junction set is selected with them.
- Click a single junction or connection replaces the set (today’s behaviour).
- Click empty map clears the selection.
- Inspector: one object → today’s detail; many → bilingual count and a single Delete.

`delete_selection` already exists. It must delete every selected junction (and thus their incident paths) and every selected connection that survives, in **one** `commit`. Deleting a junction already drops its incident paths; do not emit a mutation error mid-set and leave a half-applied delete.

Box-select of nothing leaves the selection unchanged.

### 4.5 Undo

The existing history (`HISTORY_LIMIT = 50`, `Ctrl+Z` / `Cmd+Z`, Shift for redo, toolbar buttons) is the only stack.

| Action | Undo |
|---|---|
| Still in preview | Escape — no graph write |
| Confirmed a new path | One undo removes the whole path |
| Instant hop | One undo (already) |
| Bulk delete | One undo restores the whole set |

## 5. Candidate computation

Rust owns geometry. TypeScript does not invent polylines.

### 5.1 Inputs

`kiriko_route::propose_paths` (new) takes:

- `graph: &RouteGraph` built from the editor’s **present** `ParsedNetwork` (not the last saved bundle);
- `floors: &[WalkableFloor]` from the already-decoded venue (`kiriko-bundle::walkable::walkable_floors`) — empty floors make every new candidate absent (identity / inspect-only, same rule as `smooth_route`);
- `from` / `to` node ids on the same ordinal;
- walking `RouteProfile`.

Wasm exposes this as `proposeNetworkPaths`, taking the present junctions/paths GeoJSON (the same shape `build_route_graph` already reads) plus the two node ids. Walkable floors come from the document already resident in the wasm decoder, matching `route_bundle`.

App calls this after the second Connect click when the pair is not an instant hop. The reducer only stores the result.

### 5.2 Current route

`route_with(graph, from_point, to_point, walking)`. If `None`, the current-route candidate is absent. Display coordinates are `smooth_route` of that result. **Select this route** uses the A\* node sequence (graph `NODEID`s in visit order), not the smoothed vertices. `Route` today carries no node ids — `propose_paths` must return that sequence itself.

`from_point` / `to_point` are the two junctions’ coordinates and ordinals — exact nodes, not a map snap.

### 5.3 New walkable paths

Same-floor only. Search lives on a local-metre grid of the active floor’s walkable union (the existing `walkable()` test, including holes).

| Constant | Value | Role |
|---|---|---|
| Grid cell | 1.0 m | 8-connected A\* |
| Instant-hop length | 15.0 m | Matches generate `CHORD_MIN_SAVINGS_M` as the “short enough to not preview” line |
| Near-graph radius | 2.0 m | “Along the network” cells |
| Near-graph cost | 1.0× | Cell cost when a same-floor edge is within 2.0 m |
| Off-graph cost | 3.0× | Same factor as hallway `SECONDARY_RANK_FACTOR` |
| Search cap | 50 000 cells or 400 m from the origin, whichever first | Failure → no new candidate, not a partial path |
| Snap-to-node | 0.8 m | `MIN_PASSAGE_M`; reuse an existing same-floor junction |
| Distinct Hausdorff | 4.0 m | Below this, two polylines are the same shape |
| Distinct length | 5 % | Length ratio inside 0.95…1.05 plus Hausdorff < 4.0 m → hide |

**Along the network.** Grid A\* with the near-graph / off-graph costs above, then greedy-LOS (`chord_ok` / the same pull as `smooth_segment`) on the resulting polyline.

**Shorter path.** Grid A\* with uniform walkable cost (every walkable cell 1.0×), then the same greedy-LOS. If this is not distinct from “along the network,” it is omitted. Do not run a blocked-corridor second search to force the other side of an atrium.

A cell whose center fails `walkable()` is blocked. A candidate that cannot be string-pulled without leaving walkable space is dropped.

Imported Tokyo graphs are valid inputs. Empty `floors` (legacy / no geometry) yields no new candidates; current-route inspect still works.

### 5.4 Distinctness

Polyline A hides polyline B when **both** hold:

- `0.95 ≤ length(A) / length(B) ≤ 1.05`;
- discrete Hausdorff distance (sample ≤ 1.0 m) < 4.0 m.

Compare each new candidate to the current route (if any) and to the other new candidate. Current route is never hidden by this rule.

### 5.5 Commit of a new candidate

Build the next `ParsedNetwork` on a **working copy**. Only `commit` that copy if every step is non-fatal:

1. Take the candidate’s polyline (post-LOS).
2. For each vertex, reuse a same-floor junction within 0.8 m; otherwise `addJunction` at that coordinate and the active ordinal.
3. Collapse consecutive vertices that resolved to the same node id.
4. `addConnection` between each consecutive pair. Skip a pair that already has a connection (`existing_connection` is not a failure of the whole commit).
5. If the working copy equals the pre-confirm graph (every segment already existed), do not push history.
6. On `node_id_exhausted` or `invalid_coordinate`, discard the working copy, leave `present` unchanged, and surface `rejected`.

New edges use today’s `addConnection` defaults. This spec does not stamp `EdgeKind::Chord` or new §12/§13 rows.

The whole path is one undo step even when it added many junctions.

## 6. Editor state

No new `NetworkEditTool`. Preview is session state.

### 6.1 Selection

`NetworkSelection` becomes a set:

```ts
export type NetworkSelection =
  | {
      kind: "set";
      junctionIds: number[];
      connectionIds: NetworkConnectionId[];
    }
  | null;
```

A single click stores a one-element set. The inspector treats `junctionIds.length + connectionIds.length === 1` as today’s single-object view. Render highlights every id in the set. `NetworkRenderState` grows from one selected junction/connection to arrays.

`delete_selection` iterates the set as specified in §4.4.

### 6.2 Preview

```ts
export type PathCandidateKind = "current" | "along_network" | "shorter";

export interface PathCandidate {
  kind: PathCandidateKind;
  coordinates: [number, number][]; // lon, lat; same-floor
  nodeIds: number[] | null; // graph nodes for "current"; null for new geometry
}

export interface PathPreview {
  fromId: number;
  toId: number;
  candidates: PathCandidate[];
  selectedIndex: number;
}
```

`NetworkEditorState.preview: PathPreview | null`. `cancel_pending`, `set_tool`, `undo`, `redo`, and `reset` clear it.

New actions:

- `{ type: "set_preview"; preview: PathPreview }` — App writes the wasm result. Does not `commit`.
- `{ type: "select_candidate"; index: number }`
- `{ type: "confirm_preview" }` — applies §5.5 for a new candidate; no-op for `current` or a missing preview.
- `{ type: "select_current_route" }` — §4.3.
- `{ type: "box_select"; nodeIds: number[] }` — Select tool; replaces the set with those junctions plus connections whose both ends are included.

Async lives in App (same pattern as directions). The reducer stays pure. A propose failure dispatches no preview and sets a notice (see §8).

### 6.3 Map and toolbar

- Select tool: click-drag reports a box; App hit-tests active-floor junctions and dispatches `box_select`.
- Preview strokes: current route uses the directions paint; new candidates a quieter stroke; the highlighted candidate a louder stroke. Endpoints stay the pending/selected junctions.
- Connect instruction while previewing: choose a route or Escape.
- Preview actions on the toolbar: **Add this path** (disabled for `current` and when no new candidate is highlighted), **Select this route** (disabled when no current-route candidate).

Locked copy (`ui` pairs):

| Key | ja | en |
|---|---|---|
| instructPreview | 経路を選ぶか、Escapeで取り消します。 | Choose a route, or press Escape to cancel. |
| currentRoute | 現在の経路 | Current route |
| alongNetwork | ネットワークに沿う | Along the network |
| shorterPath | より短い経路 | Shorter path |
| addPath | この経路を追加 | Add this path |
| selectRoute | この経路を選択 | Select this route |
| disconnected | これらの点はつながっていません。 | These points are not connected. |
| noWalkable | これらの点の間に歩ける経路がありません。 | No walkable path between these points. |
| proposeFailed | 経路を計算できませんでした。 | Could not calculate a path. |
| multiSelected | {n}件選択 | {n} selected |

“These points are not connected” is the disconnected-with-joiners case (preview still shown). “No walkable path” is absence of every new candidate and of a current route.

## 7. Architecture

```
Select tool drag ──▶ IndoorMap box ──▶ App ──▶ box_select ──▶ set of junctions/connections
                                                                      │
Connect A, B ──▶ instant hop? ──yes──▶ addConnection + commit
                 │
                 no
                 ▼
        serialize present ParsedNetwork
        wasm proposeNetworkPaths(from, to)
                 │
                 ├─ graph: build_route_graph(present GeoJSON)
                 ├─ floors: walkable_floors(decoded document)
                 └─ kiriko_route::propose_paths
                          │
                          ▼
                 set_preview (no history)
                          │
            confirm new ──▶ addJunction* + addConnection* + one commit
            confirm current ──▶ no-op
            select this route ──▶ selection = route graph nodes/edges; preview = null
            Escape ──▶ cancel_pending
```

`kiriko-route` gains `propose_paths`. `kiriko-wasm` / `@kiriko/wasm` bind it. `kiriko-node` does not need the bind for this feature (editor is the browser). Do not add a crate. Do not bump a KVB section version.

## 8. Errors

Absence is never rendered as success. No current route and no new candidate is a sentence, not an empty polyline.

| Situation | Result |
|---|---|
| Cross-floor pair | Existing `cross_floor_connection`. No preview. |
| Direct edge exists | Existing `existing_connection`. No preview. |
| Instant hop walkable | Today’s `addConnection`. |
| Instant hop not walkable | Fall through to preview (do not punch a 14 m wall chord). |
| Disconnected, walkable joiner | Preview without current route. Copy: disconnected. |
| Disconnected, no walkable path | No overlay. Copy: noWalkable. Graph unchanged. |
| Connected, no distinct new candidate | Inspect-only preview. Add disabled. |
| Empty walkable floors | New candidates absent. Current route still computed. |
| Propose / wasm throw | Copy: proposeFailed. Pending connect clears. |
| Confirm while save-locked | Controls already disabled. |
| Confirm `current` | No `commit`. |
| Box selects nothing | Selection unchanged. |
| Delete with empty selection | No-op. |
| Mid-commit `addConnection` already exists | Skip that pair; continue. |
| `node_id_exhausted` / `invalid_coordinate` mid-commit | Abort the confirm, do not `commit`, notice `rejected`. Present graph unchanged. |

A confirmed path the producer did not want is Undo, not a new error state.

## 9. Testing

TDD. One logical commit per slice. Bilingual `ui` pairs for every new string.

**Rust (`kiriko-route`, `propose_paths`):**

- Connected corridor: current route present; along-network hidden if it matches current; shorter present only when a walkable diagonal is distinct (open-hall fixture).
- Disconnected islands with a walkable gap: no current route; along-network (or shorter) is a joiner that stays inside walkable polygons.
- Disconnected with a wall between: no candidates; function returns the absence, not an empty polyline.
- Through-shop / through-hole: never emitted.
- Distinctness: two polylines within 4.0 m Hausdorff and 5 % length → one dropped.
- Search cap: a pair farther than the cap with no path inside the cap → absence.
- Empty `floors`: no new candidates; current route still `Some` when the graph connects.

**Reducer (`networkEditor`):**

- Instant hop still one history entry.
- `confirm_preview` of a new candidate is one undo that removes every added junction and connection.
- `confirm_preview` of `current` does not `commit`.
- `cancel_pending` / `set_tool` / Escape path drops preview without history.
- `box_select` builds the junction set plus both-ends connections.
- Bulk `delete_selection` is one undo.
- Undo/redo after a confirmed path restores preview-cleared state (preview stays null).

**Toolbar / inspector:**

- Preview copy ja/en; Add disabled on current-only; Select this route absent without a current route.
- Multi-select count ja/en + one Delete.
- `noWalkable` / `proposeFailed` / `disconnected` render as words.

**Map:**

- Select drag draws a box and does not pan; Connect / Add / Delete still pan.
- Preview strokes distinguish current vs new vs highlighted.

No new `WarningCode`. No generate-network golden change.

## 10. Sequencing

One implementation plan, four tasks, each mergeable:

1. Multi-select + box drag + bulk delete + inspector count (no wasm).
2. `propose_paths` + wasm bind + fixture tests.
3. Connect preview / instant-hop gate / confirm / Escape / undo.
4. Select this route + toolbar copy + map strokes.

Task 1 is independently useful and unblocks “remove a whole route” before Smart Connect lands.

## 11. Decision register

| Decision | Choice | Revisit if |
|---|---|---|
| Tool | Enhance Connect, no fifth button | Producers keep firing instant hops by mistake |
| Confirm | Add only | Replace is requested after add-only ships |
| Floor | Same-floor only | Cross-floor Connect is designed |
| Instant hop | < 15.0 m and walkable straight chord | Corridor stitching feels too clicky or too eager |
| New path search | Walkable grid A\* + existing greedy-LOS | Search is too slow on a large concourse |
| Profiles | Walking only | Wheelchair preview is requested |
| Old path removal | Box select + Select this route | Findings-driven “select this component” ships |
