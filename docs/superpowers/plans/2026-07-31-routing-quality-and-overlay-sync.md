# Routing Quality, Doorway Approach, and Floor Overlay Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three routing defects: non-shortest routes on generated networks (query-time then build-time), diagonal doorway entry, and stale route/network/facility overlays after floor switches.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-31-routing-quality-and-overlay-sync-design.md`. Slice 1 hardens `kiriko-route` query-time (same-edge candidate, top-K snap). Slice 2 improves `synth_medial` network generation (doorway axis stubs, open-space shortcut chords). Slice 3 defers MapLibre overlay updates until the style settles.

**Tech Stack:** Rust workspace (`core/`, cargo test), React 19 + maplibre-gl 5.24 (Vitest + Testing Library).

## Global Constraints

- TDD: failing test first, minimal implementation, then commit per task.
- `cargo test --manifest-path core/Cargo.toml --workspace` is the Rust gate; per-crate runs: `-p kiriko-route`, `-p kiriko-bundle --features netgen` (synth_medial is netgen-gated; kiriko-node enables it, so the workspace gate covers it).
- Client gates: `pnpm exec tsc --noEmit`, `pnpm exec vitest run`. Server gates: `pnpm --dir server exec tsc --noEmit`, `pnpm --dir server exec vitest run`.
- No new Rust `WarningCode`s (TS bridge allowlist stays untouched). No new UI strings (no UI changes).
- Synth edge weights are raw metres until the single `meters_to_cost` conversion loop at the end of `synthesize_network_medial`; new edges must be pushed before it with metre weights.
- Determinism: every pass processes candidates in sorted order; identical input → byte-identical graph.
- `route()`'s public signature and the `Route`/`total_weight` DTO semantics (graph cost only) are unchanged; kiriko-wasm and the TS bridge need no changes.
- Do not touch `synth.rs` (the non-netgen fallback) or imported-network handling in `build.rs`.

## Spec deviations (approved design, refined during planning)

1. ~~**Doorway stubs extend along the opening's line axis, not its normal.**~~ **SUPERSEDED — this planning call was wrong on real data.** It was justified only from hand-written fixtures (e.g. `opening_connected_blobs_skip_the_near_blob_bridge`), which draw openings as connector lines spanning a gap. The JR GDB conversion emits *threshold* lines lying ALONG the wall: measured on JR Takanawa Gateway, offsetting the midpoint 1.2 m along the normal lands inside units 66/66 and in two DIFFERENT units 64/66, while along the line only 20/66 do — so the shipped build placed 160 of 221 stubs sideways along the wall and attached beside doors instead of through them. Fixed in `cc05687`: the passage direction is now **detected per opening** by scoring both candidates (see spec §2a). Both conventions are covered.
2. **`examples/analyze_synth.rs` is not extended.** Chord counts have no public reporting surface (warnings are user-facing and code-gated); the chord pass is fully covered by unit tests on `pub(crate) fn shortcut_chords` instead. *Note:* diagnosing the chord regression still required node/edge-count and crossing-pair measurement over a real archive, done with throwaway scripts against the compiled bundle rather than this example.
3. ~~**No per-node chord cap.**~~ **SUPERSEDED — the self-limiting argument did not hold on real skeletons.** It was verified only on a synthetic 10-node zigzag; on JR Takanawa Gateway observed chord degree reached 7. Worse, the ratio test alone is scale-free and fired between spur tips ~3 m apart with ~10 m graph paths, adding ~1100 chords (cyclomatic 1215, 2491 crossing pairs) to a venue whose maximum walkable half-width is 4.69 m. Fixed in `4ef61d5`: the cap is restored at 2 and joined by minimum chord length 10 m, absolute savings 15 m, and a 5 m clearance open-space test (see spec §2b). That venue now gains zero chords (cyclomatic 104, 17 crossings).

---

### Task 1: Floor-switch overlay sync (`IndoorMap.tsx`)

**Files:**
- Modify: `src/map/IndoorMap.tsx` (refs ~L660-700; four overlay effects ~L1174-1235)
- Test: `src/map/IndoorMap.test.tsx` (FakeMap ~L27-160; top-level `beforeEach` ~L352; directions/network/facilities describes)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: component-internal `applyOverlays` / `syncOverlays`; FakeMap `mapState.setFlipStyleLoadedOnIndoorWrite(value: boolean)` for tests.

**Root cause (verified in maplibre-gl 5.24 source):** indoor `setData`/`updateData` synchronously flips the source to not-loaded, so `map.isStyleLoaded()` is false when the directions/network/facility/layer-visibility effects run immediately after the venue/level effect in the same commit. Their `if (!map.isStyleLoaded()) return;` silently drops the update and nothing re-fires on style-ready.

- [ ] **Step 1: FakeMap learns the real loaded-flip (test harness change)**

In `src/map/IndoorMap.test.tsx`, in the `vi.hoisted` block add the flag (next to `let initialStyleLoaded = true;`):

```ts
let flipStyleLoadedOnIndoorWrite = false;
```

In FakeMap's `getSource(...).setData`, inside the `if (id === INDOOR_SOURCE_ID)` branch after `this.indoorSourceData = ...`, add:

```ts
            if (flipStyleLoadedOnIndoorWrite) {
              this.styleLoaded = false;
            }
```

In `updateData`, after the indoor-source bookkeeping, add the same two lines. In the hoisted return object, add:

```ts
    setFlipStyleLoadedOnIndoorWrite(value: boolean) {
      flipStyleLoadedOnIndoorWrite = value;
    },
```

In the top-level `beforeEach` (next to `mapState.setInitialStyleLoaded(true);`) add `mapState.setFlipStyleLoadedOnIndoorWrite(false);` so the flip is opt-in per test.

- [ ] **Step 2: Write the failing tests**

Add inside `describe("IndoorMap directions")`:

```tsx
  it("defers the route overlay while the style is busy, applying it on styledata", () => {
    mapState.setFlipStyleLoadedOnIndoorWrite(true);
    const { map, rerender } = renderMap(
      baseProps({ levelId: "level-1", directions: directions({ route: CROSS_FLOOR_ROUTE }) }),
    );
    const settle = (): void => {
      act(() => {
        map.styleLoaded = true;
        map.emit("styledata");
      });
    };
    settle();
    expect(segmentsOf(lastRouteData(map)).map((f) => f.geometry)).toEqual([
      { type: "LineString", coordinates: [[139.0, 35.0], [139.001, 35.0]] },
    ]);

    rerender(baseProps({ levelId: "level-2", directions: directions({ route: CROSS_FLOOR_ROUTE }) }));
    // The indoor swap kept the style busy: the overlay still shows floor 1.
    expect(segmentsOf(lastRouteData(map)).map((f) => f.geometry)).toEqual([
      { type: "LineString", coordinates: [[139.0, 35.0], [139.001, 35.0]] },
    ]);

    settle();
    expect(segmentsOf(lastRouteData(map)).map((f) => f.geometry)).toEqual([
      { type: "LineString", coordinates: [[139.001, 35.001], [139.002, 35.002]] },
    ]);
  });
```

Add inside `describe("IndoorMap network review")`:

```tsx
  it("defers the network overlay while the style is busy, applying it on styledata", () => {
    mapState.setFlipStyleLoadedOnIndoorWrite(true);
    const ids = (map: FakeMap) =>
      lastNetworkData(map).features.map((f) => f.properties?.["NODEID"] ?? f.properties?.["FNODEID"]);
    const { map, rerender } = renderMap(baseProps({ network: NETWORK, levelId: "level-1" }));
    const settle = (): void => {
      act(() => {
        map.styleLoaded = true;
        map.emit("styledata");
      });
    };
    settle();
    expect(ids(map)).toEqual([1, 1]);

    rerender(baseProps({ network: NETWORK, levelId: "level-2" }));
    expect(ids(map)).toEqual([1, 1]); // style busy: still floor 1

    settle();
    expect(ids(map)).toEqual([2, 2]);
  });

  it("applies only the newest floor once the style settles", () => {
    mapState.setFlipStyleLoadedOnIndoorWrite(true);
    const ids = (map: FakeMap) =>
      lastNetworkData(map).features.map((f) => f.properties?.["NODEID"] ?? f.properties?.["FNODEID"]);
    const { map, rerender } = renderMap(baseProps({ network: NETWORK, levelId: "level-1" }));
    act(() => {
      map.styleLoaded = true;
      map.emit("styledata");
    });

    rerender(baseProps({ network: NETWORK, levelId: "level-2" })); // busy; deferred
    rerender(baseProps({ network: NETWORK, levelId: "level-1" })); // back before settle
    act(() => {
      map.styleLoaded = true;
      map.emit("styledata");
    });
    expect(ids(map)).toEqual([1, 1]);
  });
```

(The venue/level effect has the same busy-drop race for the *indoor* source on rapid A→B→A switches; it is pre-existing, self-heals on the next switch, and is out of scope — the second test above only asserts overlay data.)

Add inside `describe("IndoorMap facilities")`:

```tsx
  it("defers facility markers while the style is busy, applying them on styledata", () => {
    mapState.setFlipStyleLoadedOnIndoorWrite(true);
    const last = (map: FakeMap) => map.facilitySourceData.at(-1) as GeoJSON.FeatureCollection;
    const { map, rerender } = renderMap(baseProps({ facilities, levelId: "level-1" }));
    const settle = (): void => {
      act(() => {
        map.styleLoaded = true;
        map.emit("styledata");
      });
    };
    settle();
    expect(last(map).features[0]?.properties?.["name"]).toBe("Gate");

    rerender(baseProps({ facilities, levelId: "level-2" }));
    expect(last(map).features[0]?.properties?.["name"]).toBe("Gate"); // busy: stale

    settle();
    expect(last(map).features[0]?.properties?.["name"]).toBe("Upstairs shop");
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm exec vitest run src/map/IndoorMap.test.tsx`
Expected: the four new tests FAIL (overlays show the new floor immediately in the FakeMap because effects apply before the flip is observed... they fail because the current effects drop the deferred update: after `settle()`, data is still the old floor's). Existing tests stay green.

- [ ] **Step 4: Implement deferred overlay sync**

In `src/map/IndoorMap.tsx`, after the ref declarations (after `facilitiesRef`/`onSelectFacilityRef` assignments, ~L700), add:

```tsx
  const overlayStyleWaitingRef = useRef(false);

  // Applies every overlay from the latest refs; each overlay keeps its
  // "update only while active, clear exactly once" guard. Call only when the
  // style is fully loaded.
  const applyOverlays = useCallback((): void => {
    const map = mapRef.current;
    if (map == null || !map.isStyleLoaded()) {
      return;
    }
    const venue = venueRef.current;
    const levelId = levelIdRef.current;

    const dirs = directionsRef.current;
    const routeActive = dirs?.active === true;
    if (routeActive || routeSourceActiveRef.current) {
      setRouteSourceData(map, venue, levelId, dirs);
      routeSourceActiveRef.current = routeActive;
    }

    const net = networkRef.current;
    const editing = networkEditingRef.current;
    const networkActive = net != null || editing != null;
    if (networkActive || networkSourceActiveRef.current) {
      setNetworkSourceData(
        map,
        venue,
        levelId,
        net,
        editing == null ? undefined : networkRenderState(editing),
      );
      networkSourceActiveRef.current = networkActive;
    }

    const facilityActive = facilitiesRef.current.length > 0;
    if (facilityActive || facilitySourceActiveRef.current) {
      setFacilitySourceData(map, venue, levelId, facilitiesRef.current);
      facilitySourceActiveRef.current = facilityActive;
    }

    applyLayerVisibility(map, visibilityRef.current);
  }, []);

  // Applies overlays now when the style is ready, otherwise exactly once when
  // it settles. A floor change keeps the style busy while the indoor source
  // reloads; updates made in that window queue behind a single `styledata`
  // subscription instead of being dropped.
  const syncOverlays = useCallback((): void => {
    const map = mapRef.current;
    if (map == null) {
      return;
    }
    if (map.isStyleLoaded()) {
      applyOverlays();
      return;
    }
    if (!overlayStyleWaitingRef.current) {
      overlayStyleWaitingRef.current = true;
      map.once("styledata", () => {
        overlayStyleWaitingRef.current = false;
        syncOverlays();
      });
    }
  }, [applyOverlays]);
```

Then REPLACE the four overlay effects (directions ~L1174-1189, network ~L1191-1210, facility ~L1212-1227, layer-visibility ~L1229-1235) with one effect:

```tsx
  // Overlays (route, network, facilities, layer visibility): re-filter to the
  // active floor and apply prop changes, deferring to `styledata` while the
  // style is busy (e.g. right after the indoor source swap on a floor
  // change). onLoad initializes every source, so a null map is a no-op.
  useEffect(() => {
    syncOverlays();
  }, [directions, network, networkEditing, facilities, layerVisibility, venue, levelId, syncOverlays]);
```

Delete the now-unused per-effect guards (their logic lives in `applyOverlays`). Keep the venue/level effect and everything else unchanged.

- [ ] **Step 5: Run the full map test file**

Run: `pnpm exec vitest run src/map/IndoorMap.test.tsx`
Expected: PASS — new tests green, all pre-existing tests (including the "exactly once" write-count tests) unchanged and green.

- [ ] **Step 6: Type-check and commit**

Run: `pnpm exec tsc --noEmit`
Expected: PASS

```bash
git add src/map/IndoorMap.tsx src/map/IndoorMap.test.tsx
git commit -m "fix(viewer): apply map overlays once the style settles after floor switches"
```

---

### Task 2: Same-edge walk becomes a candidate, not a shortcut (`kiriko-route`)

**Files:**
- Modify: `core/crates/kiriko-route/src/query.rs` (`route()` ~L160-210 and the goal selection ~L300; tests at bottom)

**Interfaces:**
- Consumes: nothing.
- Produces: `fn same_edge_route(graph: &RouteGraph, o: &EdgeSnap, d: &EdgeSnap) -> Route` (private; Task 3 reuses it).

- [ ] **Step 1: Write the failing test**

Append to `mod tests` in `query.rs`:

```rust
    #[test]
    fn network_detour_beats_same_edge_walk() {
        // U-shaped edge 0→1 (weight 6000): bottom corners at (139,35) and
        // (139.002,35), up 0.002 and across. Both clicks sit ON the U's arms
        // near the bottom, so they snap to the U edge. The 0→2→1 shortcut
        // (1000+1000) is far cheaper than walking the whole U.
        let graph = RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.002, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.001, lat: 35.0005, ordinal: 0.0 },
            ],
            edges: vec![
                RouteEdge {
                    from: 0,
                    to: 1,
                    weight: 6000.0,
                    ordinal: 0.0,
                    interior: vec![[139.0, 35.002], [139.002, 35.002]],
                },
                RouteEdge { from: 0, to: 2, weight: 1000.0, ordinal: 0.0, interior: vec![] },
                RouteEdge { from: 2, to: 1, weight: 1000.0, ordinal: 0.0, interior: vec![] },
            ],
        };
        let r = route(
            &graph,
            Point3 { lon: 139.0, lat: 35.0002, ordinal: 0.0 },
            Point3 { lon: 139.002, lat: 35.0002, ordinal: 0.0 },
        )
        .expect("endpoints route");
        assert!(
            r.total_weight < 3000.0,
            "network detour beats the same-edge U walk: {}",
            r.total_weight
        );
        let coords: Vec<[f64; 2]> = r.segments.iter().flat_map(|s| s.coordinates.clone()).collect();
        assert!(
            coords.contains(&[139.001, 35.0005]),
            "route passes through the shortcut junction"
        );
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-route network_detour_beats_same_edge_walk`
Expected: FAIL — `total_weight` is ~5600 (the along-U walk) and the shortcut junction is absent.

- [ ] **Step 3: Extract `same_edge_route` and compare at the end**

In `query.rs`, move the current same-edge block out of `route()` into:

```rust
/// Direct walk along a single shared edge between two projections (no
/// junctions). `o` and `d` must reference the same edge.
fn same_edge_route(graph: &RouteGraph, o: &EdgeSnap, d: &EdgeSnap) -> Route {
    let e = &graph.edges[o.edge_index];
    let poly = graph.edge_polyline(e);
    let (lo, hi) = (o.along.min(d.along), o.along.max(d.along));
    let mut coords = vec![[o.projected[0], o.projected[1]]];
    let mut acc = 0.0;
    for w in poly.windows(2) {
        acc += haversine_m(w[0][0], w[0][1], w[1][0], w[1][1]);
        if acc > lo && acc < hi {
            coords.push(w[1]);
        }
    }
    coords.push([d.projected[0], d.projected[1]]);
    if o.along > d.along {
        coords.reverse();
    }
    let weight = (e.weight as f64 * (hi - lo) / o.total.max(f64::EPSILON)) as f32;
    Route {
        segments: group_segments(
            coords
                .into_iter()
                .map(|c| TaggedVertex {
                    coord: c,
                    ordinal: e.ordinal,
                })
                .collect(),
        ),
        total_weight: weight,
        origin_projected: [o.projected[0], o.projected[1], o.ordinal],
        dest_projected: [d.projected[0], d.projected[1], d.ordinal],
    }
}
```

In `route()`, replace the entire `if o.edge_index == d.edge_index { ... return ... }` block with:

```rust
    // The along-edge walk is only a candidate: leaving the edge and
    // re-entering through the network can be shorter on long or loopy edges.
    let same_edge = (o.edge_index == d.edge_index).then(|| same_edge_route(graph, &o, &d));
```

Replace the goal-selection `?` with a fallback to the candidate:

```rust
    let Some((goal, total)) = [cand_p, cand_q]
        .into_iter()
        .flatten()
        .min_by(|a, b| a.1.total_cmp(&b.1))
    else {
        // Disconnected projections: only the direct same-edge walk remains.
        return same_edge;
    };
```

At the end of `route()`, wrap the assembled `Route` (keep the existing vertex assembly as-is, bind it to `network`) and return the cheaper option — the network route wins ties:

```rust
    let network = Route {
        segments: group_segments(verts),
        total_weight: total as f32,
        origin_projected,
        dest_projected,
    };
    match same_edge {
        Some(direct) if direct.total_weight < network.total_weight => Some(direct),
        _ => Some(network),
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-route`
Expected: PASS — new test green; `route_from_mid_corridor_click_starts_at_projection` still passes (along-edge walk is cheaper there: 50 < 100 via the endpoint nodes).

- [ ] **Step 5: Commit**

```bash
git add core/crates/kiriko-route/src/query.rs
git commit -m "fix(route): compare same-edge walks against network paths"
```

---

### Task 3: Top-K snap with connector-aware selection (`kiriko-route`)

**Files:**
- Modify: `core/crates/kiriko-route/src/query.rs` (whole `route()`, `snap_to_edge` → `snap_candidates`; tests)

**Interfaces:**
- Consumes: `same_edge_route` (Task 2).
- Produces: `const SNAP_CANDIDATES: usize = 3`, `fn snap_candidates(graph: &RouteGraph, p: &Point3) -> Vec<EdgeSnap>`, `fn connector_cost(p: &Point3, s: &EdgeSnap) -> f64` (all private). `snap_to_edge` is removed; its two tests migrate.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests`:

```rust
    #[test]
    fn second_nearest_edge_wins_when_route_is_shorter() {
        // Corridor 0→1 along y=35 (weight 182_000 ≈ 182 m). A dead-end spur
        // 0→2 climbs north. The origin click sits right next to the spur but
        // the corridor is the far better entry: spur forces walking back to
        // node 0 and the whole corridor.
        let graph = RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.002, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.0005, lat: 35.001, ordinal: 0.0 },
            ],
            edges: vec![
                RouteEdge { from: 0, to: 1, weight: 182_000.0, ordinal: 0.0, interior: vec![] },
                RouteEdge { from: 0, to: 2, weight: 120_000.0, ordinal: 0.0, interior: vec![] },
            ],
        };
        let r = route(
            &graph,
            Point3 { lon: 139.0005, lat: 35.0009, ordinal: 0.0 },
            Point3 { lon: 139.002, lat: 35.0, ordinal: 0.0 },
        )
        .expect("endpoints route");
        assert_eq!(
            r.origin_projected[1], 35.0,
            "origin snapped to the corridor, not the nearer spur"
        );
        assert!(
            r.total_weight < 150_000.0,
            "corridor entry is cheaper overall: {}",
            r.total_weight
        );
    }

    #[test]
    fn multi_candidate_route_is_deterministic() {
        let graph = RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.002, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.0005, lat: 35.001, ordinal: 0.0 },
            ],
            edges: vec![
                RouteEdge { from: 0, to: 1, weight: 182_000.0, ordinal: 0.0, interior: vec![] },
                RouteEdge { from: 0, to: 2, weight: 120_000.0, ordinal: 0.0, interior: vec![] },
            ],
        };
        let o = Point3 { lon: 139.0005, lat: 35.0009, ordinal: 0.0 };
        let d = Point3 { lon: 139.002, lat: 35.0, ordinal: 0.0 };
        assert_eq!(route(&graph, o, d), route(&graph, o, d));
    }

    #[test]
    fn snap_falls_back_to_off_floor_edge_when_no_same_floor() {
        let g = geom_graph();
        let cands = snap_candidates(
            &g,
            &Point3 { lon: 139.001, lat: 35.0009, ordinal: 5.0 },
        );
        assert_eq!(cands.len(), 1, "single off-floor fallback candidate");
        assert_eq!(cands[0].edge_index, 0);
    }
```

Migrate the two existing snap tests to the new API (behavior unchanged — the best candidate is element 0):

```rust
    #[test]
    fn snaps_click_onto_nearest_edge() {
        let g = geom_graph();
        let cands = snap_candidates(
            &g,
            &Point3 { lon: 139.001, lat: 35.0009, ordinal: 0.0 },
        );
        let s = cands.first().expect("snaps to the only edge");
        assert_eq!(s.edge_index, 0);
        assert!((s.projected[0] - 139.001).abs() < 1e-4);
        assert!(s.along > 0.0 && s.along < s.total);
    }

    #[test]
    fn snap_prefers_same_ordinal_edge() {
        let mut g = geom_graph();
        g.nodes.push(RouteNode { lon: 139.001, lat: 35.0, ordinal: -1.0 });
        g.nodes.push(RouteNode { lon: 139.0011, lat: 35.0, ordinal: -1.0 });
        g.edges.push(RouteEdge { from: 2, to: 3, weight: 10.0, ordinal: -1.0, interior: vec![] });
        let cands = snap_candidates(&g, &Point3 { lon: 139.001, lat: 35.0, ordinal: 0.0 });
        assert_eq!(g.edges[cands[0].edge_index].ordinal, 0.0);
        assert!(
            cands.iter().all(|s| g.edges[s.edge_index].ordinal == 0.0),
            "off-floor edges are never same-floor candidates"
        );
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-route`
Expected: FAIL — `snap_candidates` does not exist (compile error); `second_nearest_edge_wins...` would fail on the old single-snap code.

- [ ] **Step 3: Replace `snap_to_edge` with `snap_candidates` and rewrite `route()`**

Add `meters_to_cost` to the `use crate::graph::{...}` import. Delete `snap_to_edge` and add:

```rust
/// Snap candidates evaluated per endpoint click, best first.
const SNAP_CANDIDATES: usize = 3;

/// The up-to-[`SNAP_CANDIDATES`] nearest same-floor edges by projection
/// distance (ties by edge index). When no same-floor edge exists, the single
/// nearest off-floor edge — the fallback for floors the network does not
/// cover.
fn snap_candidates(graph: &RouteGraph, p: &Point3) -> Vec<EdgeSnap> {
    let mut same: Vec<(usize, EdgeSnap, f64)> = Vec::new();
    let mut best_off: Option<(EdgeSnap, f64)> = None;
    for (i, e) in graph.edges.iter().enumerate() {
        let poly = graph.edge_polyline(e);
        let (proj, along, total) = project_point_on_polyline(&poly, p.lon, p.lat);
        let dist = haversine_m(p.lon, p.lat, proj[0], proj[1]);
        let snap = EdgeSnap {
            edge_index: i,
            projected: proj,
            along,
            total,
            ordinal: e.ordinal,
        };
        if e.ordinal == p.ordinal {
            same.push((i, snap, dist));
        } else if best_off.as_ref().is_none_or(|(_, bd)| dist < *bd) {
            best_off = Some((snap, dist));
        }
    }
    if same.is_empty() {
        return best_off.map_or_else(Vec::new, |(s, _)| vec![s]);
    }
    same.sort_by(|a, b| a.2.total_cmp(&b.2).then(a.0.cmp(&b.0)));
    same.truncate(SNAP_CANDIDATES);
    same.into_iter().map(|(_, s, _)| s).collect()
}

/// Off-network connector cost (click → projection) in routing-cost units.
fn connector_cost(p: &Point3, s: &EdgeSnap) -> f64 {
    f64::from(meters_to_cost(haversine_m(
        p.lon,
        p.lat,
        s.projected[0],
        s.projected[1],
    )))
}
```

Replace `route()` entirely with the multi-candidate version:

```rust
/// Route from `origin` to `dest` over the graph: project both endpoints onto
/// their best same-floor edge candidates, then A* between the virtual
/// endpoints of every candidate pair (edges traversed in both directions),
/// choosing the snap pair and path with the lowest total walked cost (graph
/// + connector legs). A shared-edge pair also competes as a direct
/// junction-free walk. Returns floor-grouped corridor polylines that hug the
/// edge geometry, or `None` when the projections are disconnected.
pub fn route(graph: &RouteGraph, origin: Point3, dest: Point3) -> Option<Route> {
    // Reject non-finite endpoint coordinates with a controlled `None` — never
    // a panic or NaN-poisoned comparison (which would trap the WASM instance).
    if !endpoint_is_finite(&origin) || !endpoint_is_finite(&dest) {
        return None;
    }
    let ocands = snap_candidates(graph, &origin);
    let dcands = snap_candidates(graph, &dest);
    if ocands.is_empty() || dcands.is_empty() {
        return None;
    }

    // Direct same-edge candidates: walk straight along the one shared edge.
    let mut best_direct: Option<(Route, f64)> = None; // (route, selection cost)
    for o in &ocands {
        for d in &dcands {
            if o.edge_index != d.edge_index {
                continue;
            }
            let r = same_edge_route(graph, o, d);
            let sel =
                f64::from(r.total_weight) + connector_cost(&origin, o) + connector_cost(&dest, d);
            if best_direct.as_ref().is_none_or(|(_, bs)| sel < *bs) {
                best_direct = Some((r, sel));
            }
        }
    }

    let n = graph.nodes.len();
    let mut adj: Vec<Vec<(usize, usize, f32)>> = vec![Vec::new(); n]; // (next, edge_index, weight)
    let mut k = f64::INFINITY;
    for (ei, e) in graph.edges.iter().enumerate() {
        let (from, to) = (e.from as usize, e.to as usize);
        if from >= n || to >= n {
            continue;
        }
        adj[from].push((to, ei, e.weight));
        adj[to].push((from, ei, e.weight));
        let m = haversine_m(
            graph.nodes[from].lon,
            graph.nodes[from].lat,
            graph.nodes[to].lon,
            graph.nodes[to].lat,
        );
        if m > 0.0 {
            k = k.min(f64::from(e.weight) / m);
        }
    }
    if !k.is_finite() {
        k = 0.0;
    }

    // Heuristic: lower bound toward the nearest destination projection.
    let h = |i: usize| {
        let node = &graph.nodes[i];
        dcands
            .iter()
            .map(|d| k * haversine_m(node.lon, node.lat, d.projected[0], d.projected[1]))
            .fold(f64::INFINITY, f64::min)
    };

    // Multi-source seeds: both endpoints of every origin candidate, with the
    // connector leg folded in so selection accounts for the off-network walk.
    let mut dist = vec![f64::INFINITY; n];
    let mut parent: Vec<Option<(usize, usize)>> = vec![None; n]; // (prev_node, edge_index)
    let mut seed_origin: Vec<Option<usize>> = vec![None; n]; // node → ocand index
    let mut heap = BinaryHeap::new();
    for (oi, o) in ocands.iter().enumerate() {
        let oe = &graph.edges[o.edge_index];
        let conn = connector_cost(&origin, o);
        let o_from_cost = f64::from(oe.weight) * o.along / o.total.max(f64::EPSILON) + conn;
        let o_to_cost =
            f64::from(oe.weight) * (o.total - o.along) / o.total.max(f64::EPSILON) + conn;
        for (node, g0) in [(oe.from as usize, o_from_cost), (oe.to as usize, o_to_cost)] {
            if g0 < dist[node] {
                dist[node] = g0;
                seed_origin[node] = Some(oi);
                heap.push(Open {
                    f: g0 + h(node),
                    g: g0,
                    node,
                });
            }
        }
    }

    // Goals: both endpoints of every destination candidate.
    let mut is_goal = vec![false; n];
    let mut goal_count = 0usize;
    for d in &dcands {
        let de = &graph.edges[d.edge_index];
        for node in [de.from as usize, de.to as usize] {
            if !is_goal[node] {
                is_goal[node] = true;
                goal_count += 1;
            }
        }
    }
    let mut settled = 0usize;
    while let Some(Open { g, node, .. }) = heap.pop() {
        if g > dist[node] {
            continue;
        }
        if is_goal[node] {
            settled += 1;
            if settled == goal_count {
                break;
            }
        }
        for &(next, ei, w) in &adj[node] {
            let ng = g + f64::from(w);
            if ng < dist[next] {
                dist[next] = ng;
                parent[next] = Some((node, ei));
                heap.push(Open {
                    f: ng + h(next),
                    g: ng,
                    node: next,
                });
            }
        }
    }

    // Choose the (destination candidate, endpoint node) minimizing total
    // cost; ties break toward the earlier candidate and lower node index.
    let mut best_goal: Option<(f64, usize, usize)> = None; // (sel cost, dcand index, node)
    for (di, d) in dcands.iter().enumerate() {
        let de = &graph.edges[d.edge_index];
        let conn = connector_cost(&dest, d);
        let d_from_cost = f64::from(de.weight) * d.along / d.total.max(f64::EPSILON);
        let d_to_cost = f64::from(de.weight) * (d.total - d.along) / d.total.max(f64::EPSILON);
        for (node, partial) in [(de.from as usize, d_from_cost), (de.to as usize, d_to_cost)] {
            if !dist[node].is_finite() {
                continue;
            }
            let sel = dist[node] + partial + conn;
            let better = match &best_goal {
                None => true,
                Some((bs, bdi, bnode)) => {
                    sel.total_cmp(bs) == Ordering::Less
                        || (sel.total_cmp(bs) == Ordering::Equal && (di, node) < (*bdi, *bnode))
                }
            };
            if better {
                best_goal = Some((sel, di, node));
            }
        }
    }

    // Assemble the winning network route, if any.
    let network_route = best_goal.map(|(sel, di, goal)| {
        let d = &dcands[di];
        let de = &graph.edges[d.edge_index];
        let mut node_path = vec![goal];
        let mut edge_path = Vec::new(); // edge used to STEP INTO each node
        let mut cur = goal;
        while let Some((prev, ei)) = parent[cur] {
            edge_path.push(ei);
            node_path.push(prev);
            cur = prev;
        }
        node_path.reverse();
        edge_path.reverse();
        let oi = seed_origin[cur].expect("a settled path starts at a seed");
        let o = &ocands[oi];
        let oe = &graph.edges[o.edge_index];
        let origin_projected = [o.projected[0], o.projected[1], o.ordinal];
        let dest_projected = [d.projected[0], d.projected[1], d.ordinal];

        let mut verts: Vec<TaggedVertex> = Vec::new();
        verts.push(TaggedVertex {
            coord: [origin_projected[0], origin_projected[1]],
            ordinal: oe.ordinal,
        });
        let first_node = node_path[0];
        for c in partial_polyline(graph, oe, o.along, first_node == oe.from as usize) {
            verts.push(TaggedVertex {
                coord: c,
                ordinal: oe.ordinal,
            });
        }
        for w in 0..edge_path.len() {
            let e = &graph.edges[edge_path[w]];
            let forward = node_path[w] == e.from as usize;
            let mut poly = graph.edge_polyline(e);
            if !forward {
                poly.reverse();
            }
            for c in poly.into_iter().skip(1) {
                verts.push(TaggedVertex {
                    coord: c,
                    ordinal: e.ordinal,
                });
            }
        }
        let last_node = *node_path.last().unwrap();
        for c in partial_polyline(graph, de, d.along, last_node == de.from as usize)
            .into_iter()
            .rev()
        {
            // partial_polyline returns projection→endpoint; we need endpoint→projection.
            verts.push(TaggedVertex {
                coord: c,
                ordinal: de.ordinal,
            });
        }
        verts.push(TaggedVertex {
            coord: [dest_projected[0], dest_projected[1]],
            ordinal: de.ordinal,
        });

        // Reported weight stays graph-only: strip the connector legs that
        // were folded into the seed/goal costs for selection.
        let graph_cost = sel - connector_cost(&origin, o) - connector_cost(&dest, d);
        (
            Route {
                segments: group_segments(verts),
                total_weight: graph_cost as f32,
                origin_projected,
                dest_projected,
            },
            sel,
        )
    });

    match (network_route, best_direct) {
        (Some((net, nsel)), Some((direct, dsel))) => Some(if dsel < nsel { direct } else { net }),
        (Some((net, _)), None) => Some(net),
        (None, Some((direct, _))) => Some(direct),
        (None, None) => None,
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-route`
Expected: PASS — all new and pre-existing tests (the corridor, cross-floor, non-finite, and Task 2's detour test) green.

- [ ] **Step 5: Commit**

```bash
git add core/crates/kiriko-route/src/query.rs
git commit -m "feat(route): snap to top-K edges with connector-aware selection"
```

---

### Task 4: Doorway axis stubs (`synth_medial`)

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs` (constants ~L258-293; openings collection ~L764-768; protected pre-pass ~L838-864; doorway attach block ~L911-979; transit attach ~L1046-1085; tests)

**Interfaces:**
- Consumes: existing `linestring_midpoint`, `point_within_area`, `segment_within_area`, `uf_find`, `haversine_m`.
- Produces: `const DOORWAY_STUB_M: f64 = 1.2`, `fn opening_axis(geom: &Value) -> Option<([f64; 2], [f64; 2])>` (midpoint + metre-frame unit axis), `struct DoorwayNodes` (both private).

- [ ] **Step 1: Write the failing tests**

Append to `mod tests` in `synth_medial.rs` (uses existing `rect`, `line`, `feature`, `document` helpers):

```rust
    /// Node indices at the doorway midpoint and (when present) its two axis
    /// stubs, located by exact geometry.
    fn doorway_group(g: &kiriko_route::RouteGraph, door: &Value) -> Vec<usize> {
        let mid = linestring_midpoint(door).unwrap();
        let mx = 111_320.0 * mid[1].to_radians().cos();
        // Door axis from the line's first→last vertex (test doors are 2-vertex).
        let coords = door
            .as_object()
            .and_then(|o| o.get("coordinates"))
            .and_then(Value::as_array)
            .unwrap();
        let pt = |i: usize| {
            let p = coords[i].as_array().unwrap();
            [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()]
        };
        let (a, b) = (pt(0), pt(coords.len() - 1));
        let (dx, dy) = ((b[0] - a[0]) * mx, (b[1] - a[1]) * 111_320.0);
        let len = (dx * dx + dy * dy).sqrt();
        let (ux, uy) = (dx / len, dy / len);
        let stub = |sign: f64| {
            [
                mid[0] + sign * ux * DOORWAY_STUB_M / mx,
                mid[1] + sign * uy * DOORWAY_STUB_M / 111_320.0,
            ]
        };
        let want = [mid, stub(1.0), stub(-1.0)];
        g.nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| want.iter().any(|w| (n.lon - w[0]).abs() < 1e-9 && (n.lat - w[1]).abs() < 1e-9))
            .map(|(i, _)| i)
            .collect()
    }

    #[test]
    fn doorway_stubs_align_with_the_opening_axis() {
        // One 36 m × 11 m walkway with a doorway across its middle (axis in
        // latitude): the doorway midpoint must be flanked by two stub nodes on
        // the opening axis, and the centerline must attach through a stub —
        // never directly to the midpoint.
        let walk = rect(139.70000, 35.60000, 0.00040, 0.00010);
        let door = line(139.70000, 35.599995, 139.70000, 35.600005);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature("w", FeatureType::Unit, "l0", Some("walkway"), walk),
                feature("door", FeatureType::Opening, "l0", None, door.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        let dm = linestring_midpoint(&door).unwrap();
        let onode = g
            .nodes
            .iter()
            .position(|n| [n.lon, n.lat] == dm)
            .expect("opening midpoint node exists");
        let group = doorway_group(g, &door);
        assert_eq!(group.len(), 3, "midpoint plus both axis stubs");
        // Midpoint degree is exactly 2: edges to the two stubs, nothing else.
        assert_eq!(same_floor_degree(g, onode), 2, "midpoint touches only its stubs");
        // Both stubs lie on the door axis: same lon as the midpoint, ±δ lat.
        for &s in &group {
            if s == onode {
                continue;
            }
            assert!((g.nodes[s].lon - dm[0]).abs() < 1e-9, "stub on the opening axis");
        }
        // The centerline attaches through a stub: some stub has a non-midpoint edge.
        let attached = group.iter().any(|&s| {
            s != onode
                && g.edges.iter().any(|e| {
                    let (a, b) = (e.from as usize, e.to as usize);
                    (a == s && b != onode) || (b == s && a != onode)
                })
        });
        assert!(attached, "centerline attaches through a stub");
    }

    #[test]
    fn stub_attach_is_side_aware() {
        // Two parallel walkways joined by a doorway (axis in latitude): each
        // blob's centerline attaches to the stub on ITS side of the doorway.
        let door = line(139.70000, 35.600004, 139.70000, 35.600010);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature("wa", FeatureType::Unit, "l0", Some("walkway"), rect(139.70000, 35.600000, 0.00040, 0.00001)),
                feature("wb", FeatureType::Unit, "l0", Some("walkway"), rect(139.70000, 35.600014, 0.00040, 0.00001)),
                feature("door", FeatureType::Opening, "l0", None, door.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        assert_eq!(component_count(g), 1, "doorway connects the two walkways");
        let dm = linestring_midpoint(&door).unwrap();
        let onode = g.nodes.iter().position(|n| [n.lon, n.lat] == dm).unwrap();
        let group = doorway_group(g, &door);
        assert_eq!(group.len(), 3);
        // Every attach edge from the doorway group to the skeleton lands on
        // the side-appropriate stub: a neighbor on the lower walkway's side
        // has lat below the midpoint, and vice versa.
        for e in &g.edges {
            let (a, b) = (e.from as usize, e.to as usize);
            let (inside, outside) = match (group.contains(&a), group.contains(&b)) {
                (true, false) => (a, b),
                (false, true) => (b, a),
                _ => continue,
            };
            assert_ne!(inside, onode, "no direct midpoint attach");
            assert_eq!(
                (g.nodes[inside].lat - dm[1]).signum(),
                (g.nodes[outside].lat - dm[1]).signum(),
                "attach lands on the stub of the same side"
            );
        }
    }

    #[test]
    fn outside_stub_side_is_dropped() {
        // A doorway on the walkway's outer wall: the stub pointing outside
        // the walkable area is dropped; the midpoint and inside stub remain.
        let walk = rect(139.70000, 35.60000, 0.00040, 0.00002);
        let door = line(139.70000, 35.599990, 139.70000, 35.600000);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature("w", FeatureType::Unit, "l0", Some("walkway"), walk),
                feature("door", FeatureType::Opening, "l0", None, door.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        let dm = linestring_midpoint(&door).unwrap();
        assert!(g.nodes.iter().any(|n| [n.lon, n.lat] == dm), "midpoint node exists");
        let group = doorway_group(g, &door);
        assert_eq!(group.len(), 2, "only the inside stub survives");
        assert_eq!(component_count(g), 1);
    }
```

Also update the existing `nearby_openings_share_one_doorway_bridge` assertion — the "leaf" invariant moves from the midpoint to the doorway group. Replace the `degrees` computation and final `assert_eq!(degrees, vec![2, 1], ...)` with:

```rust
        // The doorway group (midpoint + axis stubs) of the first door bridges
        // both spines (two attach edges); the second door's group attaches as
        // a leaf (exactly one attach edge to the skeleton).
        let attach_count = |d: &Value| {
            let group = doorway_group(g, d);
            g.edges
                .iter()
                .filter(|e| {
                    group.contains(&(e.from as usize)) != group.contains(&(e.to as usize))
                })
                .count()
        };
        assert_eq!(attach_count(&door1), 2, "first doorway bridges both spines");
        assert_eq!(attach_count(&door2), 1, "second doorway attaches as a leaf");
```

(Also remove the now-unused `dm`/`node` bindings inside that test's `degrees` closure if the compiler flags them; keep the test's doc comment.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen doorway`
Expected: FAIL — `doorway_group`/`DOORWAY_STUB_M` undefined (compile error), and `nearby_openings_share_one_doorway_bridge` fails on the old midpoint-degree semantics once it compiles.

- [ ] **Step 3: Implement doorway stubs**

3a. Add the constant near the other synth constants (~L262):

```rust
/// Doorway stub length (m) each side of an opening's midpoint, along the
/// opening's axis: routes cross the doorway collinear with the opening line —
/// straight in from the front — instead of entering at the angle of the
/// nearest centerline node.
const DOORWAY_STUB_M: f64 = 1.2;
```

3b. Add the axis parser and node record (near `opening`-related helpers, e.g. above `synthesize_network_medial`):

```rust
/// Vertices of a canonical `LineString` coordinate array as `[lon, lat]`.
fn line_verts(coords: &Value) -> Vec<[f64; 2]> {
    coords
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| {
                    let pair = p.as_array()?;
                    Some([pair.first()?.as_f64()?, pair.get(1)?.as_f64()?])
                })
                .collect()
        })
        .unwrap_or_default()
}

/// An opening's midpoint plus unit axis (metre frame at the midpoint's
/// latitude) from its first→last vertex of the longest part. The axis is the
/// walking direction through the doorway: openings are digitized as connector
/// lines spanning the gap between spaces. `None` for degenerate geometry.
fn opening_axis(geom: &Value) -> Option<([f64; 2], [f64; 2])> {
    let obj = geom.as_object()?;
    let coords = obj.get("coordinates")?;
    let verts: Vec<[f64; 2]> = match obj.get("type")?.as_str()? {
        "LineString" => line_verts(coords),
        "MultiLineString" => coords
            .as_array()?
            .iter()
            .map(|part| line_verts(part))
            .max_by(|a, b| {
                let len = |vs: &Vec<[f64; 2]>| {
                    vs.windows(2).map(|w| haversine_m(w[0], w[1])).sum::<f64>()
                };
                len(a).total_cmp(&len(b))
            })
            .unwrap_or_default(),
        _ => return None,
    };
    let (Some(first), Some(last)) = (verts.first(), verts.last()) else {
        return None;
    };
    let mid = linestring_midpoint(geom)?;
    let mx = 111_320.0 * mid[1].to_radians().cos();
    let (dx, dy) = ((last[0] - first[0]) * mx, (last[1] - first[1]) * 111_320.0);
    let len = (dx * dx + dy * dy).sqrt();
    if len <= f64::EPSILON {
        return None;
    }
    Some((mid, [dx / len, dy / len]))
}

/// One doorway's graph nodes: the opening midpoint plus, when walkable, the
/// two axis stubs. Attach edges land on the stub of the attaching side; a
/// side whose stub fails validation falls back to the midpoint.
struct DoorwayNodes {
    mid: usize,
    fwd: Option<usize>, // midpoint + axis·δ
    bwd: Option<usize>, // midpoint − axis·δ
    mid_pt: [f64; 2],
    axis: [f64; 2], // metre-frame unit vector
}
```

3c. Per-floor openings collection (~L739 and ~L764): change the binding to `let mut openings: Vec<([f64; 2], [f64; 2])> = Vec::new();` and the collection arm to:

```rust
                FeatureType::Opening => {
                    if let Some(ma) = opening_axis(geom) {
                        openings.push(ma);
                    }
                }
```

3d. Protected pre-pass (~L839): change the loop head to destructure:

```rust
        for &(mid, _) in &openings {
            let mut cands: Vec<(usize, usize, f64)> = skeleton
                .nodes
                .iter()
                .enumerate()
                .filter_map(|(local, n)| {
                    let d = haversine_m(*n, mid);
                    (d <= SNAP_MAX_M).then(|| (uf_find(&mut blob, local), local, d))
                })
                .collect();
```

(Use `mid` in place of `*op` in the `segment_within_area(*op, ...)` call below it.)

3e. Replace the entire doorway attach block (from `let mut opening_nodes: Vec<(usize, [f64; 2])> = Vec::new();` through the end of the `for op in &openings { ... }` loop, ~L917-979) with:

```rust
        // Doorways: bridge each opening to the nearest centerline node of every
        // distinct blob within range, merging areas that share the doorway.
        // Blobs connected here are UNIONED as they are processed, so a second
        // doorway into the same area attaches as a leaf instead of fanning out
        // a parallel bridge, and the near-blob pass below never duplicates a
        // doorway path with a direct skeleton-skeleton edge.
        //
        // Each doorway is a midpoint node flanked by two axis stubs (when
        // walkable): attaching blobs and transit units connect through the
        // stub on their side, so routes cross the doorway straight in from
        // the front. A side whose stub fails validation falls back to the
        // midpoint (the previous single-node behavior).
        let mut doorway_nodes: Vec<DoorwayNodes> = Vec::new();
        for &(mid, axis) in &openings {
            // Nearest VALID node per blob: candidates in distance order, the
            // first whose segment from the opening stays within walkable
            // space. Rejecting blocked snaps is what stops doorways from
            // teleporting across track strips and walls.
            let mut cands: Vec<(usize, usize, f64)> = Vec::new();
            for (local, n) in skeleton.nodes.iter().enumerate() {
                let d = haversine_m(*n, mid);
                if d <= SNAP_MAX_M {
                    let root = uf_find(&mut blob, local);
                    cands.push((root, local, d));
                }
            }
            cands.sort_by(|a, b| a.2.total_cmp(&b.2).then(a.1.cmp(&b.1)));
            let mut per_blob: HashMap<usize, (usize, f64)> = HashMap::new();
            for (root, local, d) in cands {
                if per_blob.contains_key(&root) {
                    continue;
                }
                if !segment_within_area(mid, skeleton.nodes[local], &area, SEGMENT_OUTSIDE_TOL_M) {
                    continue;
                }
                per_blob.insert(root, (local, d));
            }
            if per_blob.is_empty() {
                warnings.push(RouteBuildWarning {
                    code: "synth_opening_no_walkway".into(),
                    detail: format!(
                        "opening ({:.6}, {:.6}) on ordinal {ord} has no centerline node reachable \
                         within walkable space (>{SNAP_MAX_M} m away or blocked)",
                        mid[0], mid[1]
                    ),
                });
                continue;
            }

            // Axis stubs: midpoint ± axis·δ, kept only when they and their
            // link to the midpoint stay in walkable space.
            let mx = 111_320.0 * mid[1].to_radians().cos();
            let stub_pt = |sign: f64| {
                [
                    mid[0] + sign * axis[0] * DOORWAY_STUB_M / mx,
                    mid[1] + sign * axis[1] * DOORWAY_STUB_M / 111_320.0,
                ]
            };
            let stub_valid = |pt: [f64; 2]| {
                point_within_area(pt, &area, SEGMENT_OUTSIDE_TOL_M)
                    && segment_within_area(pt, mid, &area, SEGMENT_OUTSIDE_TOL_M)
            };
            let mid_idx = nodes.len();
            nodes.push(RouteNode {
                lon: mid[0],
                lat: mid[1],
                ordinal: ord,
            });
            let mut doorway = DoorwayNodes {
                mid: mid_idx,
                fwd: None,
                bwd: None,
                mid_pt: mid,
                axis,
            };
            for (sign, is_fwd) in [(1.0_f64, true), (-1.0_f64, false)] {
                let pt = stub_pt(sign);
                if !stub_valid(pt) {
                    continue;
                }
                let idx = nodes.len();
                nodes.push(RouteNode {
                    lon: pt[0],
                    lat: pt[1],
                    ordinal: ord,
                });
                edges.push(RouteEdge {
                    from: mid_idx as u32,
                    to: idx as u32,
                    weight: haversine_m(mid, pt) as f32,
                    ordinal: ord,
                    interior: Vec::new(),
                });
                if is_fwd {
                    doorway.fwd = Some(idx);
                } else {
                    doorway.bwd = Some(idx);
                }
            }

            let roots: Vec<usize> = per_blob.keys().copied().collect();
            for &r in &roots[1..] {
                let (ra, rb) = (uf_find(&mut blob, roots[0]), uf_find(&mut blob, r));
                if ra != rb {
                    blob[ra] = rb;
                }
            }
            // Attach each blob through the stub on ITS side of the doorway
            // (deterministic order); the midpoint stays the fallback target.
            let mut attach: Vec<(usize, usize)> =
                per_blob.into_iter().map(|(r, (local, _))| (r, local)).collect();
            attach.sort_unstable();
            for (_, local) in attach {
                let c = skeleton.nodes[local];
                let dot = axis[0] * (c[0] - mid[0]) * mx + axis[1] * (c[1] - mid[1]) * 111_320.0;
                let stub = if dot >= 0.0 { doorway.fwd } else { doorway.bwd };
                let (t_idx, t_pt) = match stub {
                    Some(i) => (i, [nodes[i].lon, nodes[i].lat]),
                    None => (mid_idx, mid),
                };
                let (t_idx, t_pt) = if t_idx != mid_idx
                    && !segment_within_area(t_pt, c, &area, SEGMENT_OUTSIDE_TOL_M)
                {
                    (mid_idx, mid)
                } else {
                    (t_idx, t_pt)
                };
                edges.push(RouteEdge {
                    from: t_idx as u32,
                    to: (base + local) as u32,
                    weight: haversine_m(t_pt, c) as f32,
                    ordinal: ord,
                    interior: Vec::new(),
                });
            }
            doorway_nodes.push(doorway);
        }
```

3f. Transit attach (~L1061-1085): replace the inner `for &(oidx, op) in &opening_nodes { ... }` loop with:

```rust
            for doorway in &doorway_nodes {
                let Some(boundary_d) = point_boundary_dist_m(doorway.mid_pt, geom) else {
                    continue;
                };
                if boundary_d > TRANSIT_OPENING_SNAP_M {
                    continue;
                }
                // The unit's own side of the doorway (toward its centroid).
                let dmx = 111_320.0 * doorway.mid_pt[1].to_radians().cos();
                let dot = doorway.axis[0] * (tp[0] - doorway.mid_pt[0]) * dmx
                    + doorway.axis[1] * (tp[1] - doorway.mid_pt[1]) * 111_320.0;
                let stub = if dot >= 0.0 { doorway.fwd } else { doorway.bwd };
                let (t_idx, t_pt) = match stub {
                    Some(i) => (i, [nodes[i].lon, nodes[i].lat]),
                    None => (doorway.mid, doorway.mid_pt),
                };
                // The stub must be reachable THROUGH the unit itself (its real
                // door); otherwise fall back to the midpoint under the same
                // rule, and skip the opening when neither is reachable.
                let reachable = |pt: [f64; 2]| {
                    unit_area
                        .as_ref()
                        .is_some_and(|u| segment_within_area(*tp, pt, u, SEGMENT_OUTSIDE_TOL_M))
                };
                let (t_idx, t_pt) = if reachable(t_pt) {
                    (t_idx, t_pt)
                } else if t_idx != doorway.mid && reachable(doorway.mid_pt) {
                    (doorway.mid, doorway.mid_pt)
                } else {
                    continue;
                };
                edges.push(RouteEdge {
                    from: idx as u32,
                    to: t_idx as u32,
                    weight: haversine_m(*tp, t_pt) as f32,
                    ordinal: ord,
                    interior: Vec::new(),
                });
                attached = true;
            }
```

(`opening_nodes` no longer exists; the vertical-link code does not reference it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen`
Expected: PASS — new stub tests green; all pre-existing tests green, including `transit_attaches_through_its_opening` (transit on the invalid side still lands on the midpoint) and the updated `nearby_openings_share_one_doorway_bridge`.

- [ ] **Step 5: Commit**

```bash
git add core/crates/kiriko-bundle/src/synth_medial.rs
git commit -m "feat(synth): attach doorways through axis-aligned stubs"
```

---

### Task 5: Open-space shortcut chords (`synth_medial`)

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs` (new pass + integration after the near-blob bridging block ~L1044; tests)

**Interfaces:**
- Consumes: `Skeleton`, `uf_find`, `centerline_chord_passable`, `haversine_m` (all existing); runs after Task 4's doorway/bridging passes (integration point is independent of Task 4's internals — `blob` and `skeleton` are unchanged in shape).
- Produces: `pub(crate) fn shortcut_chords(skeleton: &Skeleton, blob: &[usize], area: &MultiPolygon<f64>) -> Vec<(usize, usize)>`; constants `CHORD_MAX_M = 40.0`, `CHORD_SAVINGS_RATIO = 0.7`.

- [ ] **Step 1: Write the failing tests**

Append to `mod tests`:

```rust
    /// Metre-offset coordinate helper for chord tests (lat 35.6).
    fn xy_at(cx: f64, cy: f64) -> impl Fn(f64, f64) -> [f64; 2] {
        let mx = 111_320.0 * cy.to_radians().cos();
        move |x_m: f64, y_m: f64| [cx + x_m / mx, cy + y_m / 111_320.0]
    }

    fn rect_poly(cx: f64, cy: f64, x0: f64, y0: f64, x1: f64, y1: f64) -> Polygon<f64> {
        let xy = xy_at(cx, cy);
        Polygon::new(
            LineString::from(vec![
                (xy(x0, y0)[0], xy(x0, y0)[1]),
                (xy(x1, y0)[0], xy(x1, y0)[1]),
                (xy(x1, y1)[0], xy(x1, y1)[1]),
                (xy(x0, y1)[0], xy(x0, y1)[1]),
                (xy(x0, y0)[0], xy(x0, y0)[1]),
            ]),
            vec![],
        )
    }

    /// Union-find parent vec with `edges` unioned in (mirrors production,
    /// where `blob` is already unioned by skeleton/doorway/bridge passes).
    fn unioned_blob(n: usize, edges: &[(usize, usize)]) -> Vec<usize> {
        let mut blob: Vec<usize> = (0..n).collect();
        for &(a, b) in edges {
            let (ra, rb) = (uf_find(&mut blob, a), uf_find(&mut blob, b));
            if ra != rb {
                blob[ra] = rb;
            }
        }
        blob
    }

    #[test]
    fn chords_cut_a_detour_but_not_a_straight_spine() {
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let xy = xy_at(cx, cy);
        let area = MultiPolygon::new(vec![rect_poly(cx, cy, -10.0, -45.0, 70.0, 5.0)]);
        // V-detour skeleton: A(0,0) → B(20,-30) → C(40,0) → D(60,0). The A–C
        // chord (40 m) beats the 72 m graph path; everything else is adjacent
        // or out of range.
        let detour = Skeleton {
            nodes: vec![xy(0.0, 0.0), xy(20.0, -30.0), xy(40.0, 0.0), xy(60.0, 0.0)],
            edges: vec![(0, 1), (1, 2), (2, 3)],
        };
        let blob = unioned_blob(4, &detour.edges);
        let chords = shortcut_chords(&detour, &blob, &area);
        assert_eq!(chords, vec![(0, 2)], "A–C chord cuts the V detour");

        let straight = Skeleton {
            nodes: vec![xy(0.0, 0.0), xy(20.0, 0.0), xy(40.0, 0.0)],
            edges: vec![(0, 1), (1, 2)],
        };
        let blob = unioned_blob(3, &straight.edges);
        assert!(
            shortcut_chords(&straight, &blob, &area).is_empty(),
            "straight spine gains no chords"
        );
    }

    #[test]
    fn chords_never_cross_a_hole() {
        // Same V detour, but a non-walkable hole blocks the A–C chord.
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let xy = xy_at(cx, cy);
        let hole = LineString::from(vec![
            (xy(10.0, -5.0)[0], xy(10.0, -5.0)[1]),
            (xy(30.0, -5.0)[0], xy(30.0, -5.0)[1]),
            (xy(30.0, 4.0)[0], xy(30.0, 4.0)[1]),
            (xy(10.0, 4.0)[0], xy(10.0, 4.0)[1]),
            (xy(10.0, -5.0)[0], xy(10.0, -5.0)[1]),
        ]);
        let mut poly = rect_poly(cx, cy, -10.0, -45.0, 70.0, 5.0);
        poly.interiors_push(hole);
        let area = MultiPolygon::new(vec![poly]);
        let detour = Skeleton {
            nodes: vec![xy(0.0, 0.0), xy(20.0, -30.0), xy(40.0, 0.0)],
            edges: vec![(0, 1), (1, 2)],
        };
        let blob = unioned_blob(3, &detour.edges);
        assert!(
            shortcut_chords(&detour, &blob, &area).is_empty(),
            "the chord across the hole is rejected"
        );
    }

    #[test]
    fn zigzag_chain_gains_shortcut_chords_with_feedback() {
        // Ten-node zigzag chain zi = (10·i, −15·(i mod 2)) (18 m hops) in an
        // open area. Two-hop chords (20 m vs 36 m graph) all qualify; three-
        // and four-hop candidates become reachable through the chords already
        // added (the savings test sees them), so only the two-hop set lands.
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let xy = xy_at(cx, cy);
        let area = MultiPolygon::new(vec![rect_poly(cx, cy, -15.0, -25.0, 100.0, 5.0)]);
        let nodes: Vec<[f64; 2]> = (0..10)
            .map(|i| xy(10.0 * i as f64, -15.0 * (i % 2) as f64))
            .collect();
        let edges: Vec<(usize, usize)> = (0..9).map(|i| (i, i + 1)).collect();
        let skeleton = Skeleton { nodes, edges };
        let blob = unioned_blob(10, &skeleton.edges);
        let chords = shortcut_chords(&skeleton, &blob, &area);
        assert_eq!(
            chords,
            vec![
                (0, 2),
                (1, 3),
                (2, 4),
                (3, 5),
                (4, 6),
                (5, 7),
                (6, 8),
                (7, 9),
            ],
            "exact sorted chord set, feedback-aware"
        );
        // Determinism: same input, same chords.
        let again = shortcut_chords(&skeleton, &unioned_blob(10, &skeleton.edges), &area);
        assert_eq!(chords, again);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen chords`
Expected: FAIL — `shortcut_chords` is undefined (compile error).

- [ ] **Step 3: Implement the chord pass**

Add `use std::cmp::Ordering;` to the file's imports if absent. Add constants near the other synth constants:

```rust
/// Maximum chord length (m) considered for an open-space shortcut.
const CHORD_MAX_M: f64 = 40.0;
/// A chord is a real shortcut only when it beats the existing graph path by
/// at least this factor (chord length < ratio × graph distance).
const CHORD_SAVINGS_RATIO: f64 = 0.7;
```

Add the pass (place it above `synthesize_network_medial`):

```rust
/// Min-heap entry for the bounded Dijkstra inside [`shortcut_chords`].
#[derive(Clone, Copy, PartialEq)]
struct Visit(f64, usize);

impl Eq for Visit {}

impl Ord for Visit {
    fn cmp(&self, other: &Self) -> Ordering {
        other.0.total_cmp(&self.0).then(self.1.cmp(&other.1))
    }
}

impl PartialOrd for Visit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Open-space shortcut chords between same-blob skeleton nodes: a straight,
/// fully passable segment that beats the current graph path by
/// [`CHORD_SAVINGS_RATIO`]. This is what lets a route cut diagonally across
/// an open concourse instead of following the centerline's detour. Returns
/// the added `(node_a, node_b)` pairs (skeleton-local), deterministic by
/// construction (pairs processed in sorted order).
pub(crate) fn shortcut_chords(
    skeleton: &Skeleton,
    blob: &[usize],
    area: &MultiPolygon<f64>,
) -> Vec<(usize, usize)> {
    let n = skeleton.nodes.len();
    // Metre-weighted adjacency: skeleton edges plus chords added so far.
    let mut adj: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    for &(a, b) in &skeleton.edges {
        let d = haversine_m(skeleton.nodes[a], skeleton.nodes[b]);
        adj[a].push((b, d));
        adj[b].push((a, d));
    }
    // Candidate pairs: same-blob nodes within CHORD_MAX_M, via grid buckets.
    let cell_deg = CHORD_MAX_M / 111_320.0;
    let cell =
        |p: [f64; 2]| ((p[0] / cell_deg).floor() as i64, (p[1] / cell_deg).floor() as i64);
    let mut buckets: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, np) in skeleton.nodes.iter().enumerate() {
        buckets.entry(cell(*np)).or_default().push(i);
    }
    let mut pairs: Vec<(usize, usize, f64)> = Vec::new();
    let mut uf = blob.to_vec();
    for (i, p) in skeleton.nodes.iter().enumerate() {
        let (cx, cy) = cell(*p);
        for dx in -1..=1 {
            for dy in -1..=1 {
                let Some(cands) = buckets.get(&(cx + dx, cy + dy)) else {
                    continue;
                };
                for &j in cands {
                    if j <= i {
                        continue;
                    }
                    let d = haversine_m(*p, skeleton.nodes[j]);
                    if d > CHORD_MAX_M || uf_find(&mut uf, i) != uf_find(&mut uf, j) {
                        continue;
                    }
                    pairs.push((i, j, d));
                }
            }
        }
    }
    pairs.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));

    // Bounded Dijkstra: true when `dst` is reachable from `src` within `cutoff`.
    let reachable_within = |adj: &[Vec<(usize, f64)>], src: usize, dst: usize, cutoff: f64| {
        let mut dist = vec![f64::INFINITY; adj.len()];
        dist[src] = 0.0;
        let mut heap = std::collections::BinaryHeap::new();
        heap.push(Visit(0.0, src));
        while let Some(Visit(g, u)) = heap.pop() {
            if g > cutoff {
                break;
            }
            if u == dst {
                return true;
            }
            if g > dist[u] {
                continue;
            }
            for &(v, w) in &adj[u] {
                let ng = g + w;
                if ng < dist[v] {
                    dist[v] = ng;
                    heap.push(Visit(ng, v));
                }
            }
        }
        false
    };

    let mut added: Vec<(usize, usize)> = Vec::new();
    for (i, j, c) in pairs {
        // Fully inside walkable space at passage width (rejects chords
        // across kiosks, walls, and track strips).
        if !centerline_chord_passable(skeleton.nodes[i], skeleton.nodes[j], area) {
            continue;
        }
        // Only a real shortcut: the existing graph path (including chords
        // already added) must be longer than c / CHORD_SAVINGS_RATIO.
        if reachable_within(&adj, i, j, c / CHORD_SAVINGS_RATIO) {
            continue;
        }
        adj[i].push((j, c));
        adj[j].push((i, c));
        added.push((i, j));
    }
    added
}
```

Integrate into `synthesize_network_medial` immediately after the near-blob bridging loop (after its closing brace, before the `// Transit units:` comment):

```rust
        // Open-space shortcuts: straight, fully passable chords that beat the
        // centerline path through open areas (concourse diagonals). Same-blob
        // only, so they never merge components or duplicate doorway/bridge
        // paths (the savings test rejects those).
        for (a, b) in shortcut_chords(&skeleton, &blob, &area) {
            edges.push(RouteEdge {
                from: (base + a) as u32,
                to: (base + b) as u32,
                weight: haversine_m(skeleton.nodes[a], skeleton.nodes[b]) as f32,
                ordinal: ord,
                interior: Vec::new(),
            });
        }
```

(The chord edges carry raw metre weights here; the existing `meters_to_cost` loop at the end converts them exactly once.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen`
Expected: PASS — new chord tests green; pre-existing synthesis tests green (chords never merge components, so `component_count` assertions and the determinism assertion are unaffected).

- [ ] **Step 5: Commit**

```bash
git add core/crates/kiriko-bundle/src/synth_medial.rs
git commit -m "feat(synth): add passable open-space shortcut chords"
```

---

### Task 6: Full gates and browser smoke test

**Files:** none (verification only).

**Interfaces:**
- Consumes: Tasks 1-5.

- [ ] **Step 1: Run every gate**

```bash
cargo test --manifest-path core/Cargo.toml --workspace
pnpm exec tsc --noEmit
pnpm --dir server exec tsc --noEmit
pnpm exec vitest run
pnpm --dir server exec vitest run
```

Expected: all PASS.

- [ ] **Step 2: Rebuild the native addon and wasm**

```bash
pnpm core:build
```

Expected: `@kiriko/node` and `@kiriko/wasm` rebuild cleanly (Rust changes in kiriko-route/kiriko-bundle flow into both).

- [ ] **Step 3: Regenerate a venue network and smoke test in the browser**

```bash
KIRIKO_SEED_DEV_USERS=1 pnpm dev:server   # terminal 1
pnpm dev                                  # terminal 2
```

Drive the browser at `http://localhost:5173` (sign in as `admin`/`password`):

1. Gallery → a GDB venue (e.g. JR Shinagawa) → **Generate routing** → wait for the new version (this picks up the new stubs + chords; existing published bundles predate them).
2. Open the venue → **Review network**: shortcut chords are visible as straight diagonal paths across open concourses.
3. Switch floors with the review overlay on: the network for the new floor appears immediately (no tool click needed) — verifies Task 1.
4. **Directions**: route between two points across a concourse — the route uses a chord where the centerline used to detour (Tasks 2/3/5); route to a destination at a doorway — the final approach crosses the doorway collinear with the opening (Task 4).
5. Switch floors with an active route: the route re-segments to the new floor immediately.

Expected: all behaviors as described; no console errors.

- [ ] **Step 4: Final commit (if any smoke-test fixes were needed)**

```bash
git status --porcelain
# commit any residual fixes, one logical change per commit
```

---

## Self-Review Notes

- **Spec coverage:** Slice 1 → Tasks 2-3; Slice 2 → Tasks 4-5; Slice 3 → Task 1; error handling fallbacks are inline in each task; testing requirements map to each task's Step 1; sequencing (3 ∥ 1 → 2) is reflected in task order. The two documented deviations (stub axis along the opening line; no `analyze_synth` extension) are called out above.
- **Type consistency:** `same_edge_route(graph, o, d)` used in Tasks 2-3; `snap_candidates`/`connector_cost` defined and used in Task 3; `opening_axis`/`DoorwayNodes`/`DOORWAY_STUB_M` defined and used in Task 4 (tests reference the same names); `shortcut_chords`/`CHORD_MAX_PER_NODE`/`Visit` defined and used in Task 5; FakeMap `setFlipStyleLoadedOnIndoorWrite` defined and used in Task 1.
- **Watch items:** (a) Task 4 Step 3f transit fallback preserves `transit_attaches_through_its_opening` exactly (invalid-side stub → midpoint). (b) Task 3's tie-breaks rely on strict `<` seeding so the first candidate keeps shared nodes. (c) The venue/level effect's own busy-drop race (rapid A→B→A floor switches on the *indoor* source) is pre-existing and explicitly out of scope.
