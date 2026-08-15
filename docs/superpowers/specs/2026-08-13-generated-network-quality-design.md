# Generated-network quality (P1–P4, P6) — design

**Date:** 2026-08-13
**Status:** approved for implementation planning (follows the research comparison)
**Depends on:** `docs/superpowers/specs/2026-08-12-generated-network-offshoot-remediation-design.md` (P0) landing first
**Research:** `docs/superpowers/reports/2026-08-13-indoor-network-generation-vs-kiriko.md`

## 1. Purpose

After P0 removes unused doorway stubs and fan-in verticals, raise generated-network quality to match the published parts of Esri / Mappedin that Kiriko is missing:

- persist edge provenance so review and re-import do not invent defaults;
- cost verticals as Connections, not slightly-more-expensive paths;
- string-pull routes at query time against walkable polygons;
- prefer hallways over rooms;
- subtract real obstacles from the navigable area.

Do not replace the medial-axis spine with a lattice. Do not regenerate imported Tokyo graphs.

## 2. Contract: `RouteEdge` attributes

`kiriko_route::RouteEdge` gains one field. Every existing constructor sets it to `EdgeAttrs::default()`.

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EdgeKind {
    Imported = 0,
    Skeleton = 1,
    Doorway = 2,
    Stub = 3,
    Bridge = 4,
    Chord = 5,
    Vertical = 6,
    TransitAttach = 7,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum PathwayRank {
    Primary = 1,
    Secondary = 2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum VerticalKind {
    Elevator = 1,
    Escalator = 2,
    Stairs = 3,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EdgeAttrs {
    pub kind: EdgeKind,
    pub rank: PathwayRank,
    pub clearance_m: Option<f32>,
    pub vertical: Option<VerticalKind>,
}

impl Default for EdgeAttrs {
    fn default() -> Self {
        Self {
            kind: EdgeKind::Imported,
            rank: PathwayRank::Primary,
            clearance_m: None,
            vertical: None,
        }
    }
}
```

Invariants:

- `vertical.is_some()` iff `kind == EdgeKind::Vertical`.
- Imported GDB edges stay `Imported` / `Primary` / `clearance_m = None` unless the GeoJSON already carries the new properties.
- `clearance_m` is the midpoint half-width in metres when known; absence is `None`, never `0.0`.

## 3. Wire: optional section 12, not a §5 version bump

Postcard §5 is not self-describing. Adding fields to `GraphEdgeDto` or bumping `SECTION_VERSION` makes old decoders report the graph `unsupportedVersion` and **drop routing**. That is refused.

- §5 v1 is unchanged: `{ from, to, weight, ordinal, interior }`.
- New optional section **id 12** `SECTION_GRAPH_ATTRS`, version 1.
- Dependency: **requires §5**. If §5 is absent / unsupported / invalid, §12 is `disabledByDependency`.
- Payload: postcard `GraphAttrsSectionDto { edges: Vec<GraphEdgeAttrDto> }` in **the same order and length as §5 edges**.
- `GraphEdgeAttrDto { kind: u8, rank: u8, clearance_m: Option<f32>, vertical: Option<u8> }`.
- Length mismatch or unknown discriminant → §12 `invalid`; §5 graph still loads with `EdgeAttrs::default()` per edge.
- Encode §12 only when at least one edge is not `Default`. Tokyo imports therefore stay byte-identical on §5 and emit no §12.
- Unknown section ids remain ignored, so current viewers keep routing on new bundles.

`clip_graph` copies `attrs` with the edge. `export_network` writes:

| GeoJSON property | Source |
|---|---|
| `EDGE_KIND` | `kind` as stable string: `imported` / `skeleton` / `doorway` / `stub` / `bridge` / `chord` / `vertical` / `transit_attach` |
| `PATHWAY_RANK` | `1` primary, `2` secondary |
| `CLEARANCE_M` | number or JSON `null` |
| `TRANSITION_CATEGORY` | `elevator` / `escalator` / `stairs` / JSON `null` |
| `HFLAG` / `passage_type` | unchanged: `1` iff `kind == Vertical` (ordinal mismatch remains the fallback for old graphs) |

`build_route_graph` reads those properties when present; missing → `Default`.

No new `WarningCode`. No TypeScript allowlist change.

## 4. P2 — vertical Connection cost

After P0's one-to-one matcher selects a pair, weight is **not** `horiz_m + {3,4,5}`.

```
cost_m = entry_m(kind) + |ord_upper − ord_lower| × per_floor_m(kind)
```

| kind | `entry_m` | `per_floor_m` |
|---|---|---|
| elevator | 15.0 | 1.0 |
| escalator | 0.0 | 4.0 |
| stairs | 0.0 | 10.0 |

Then the existing single `meters_to_cost` pass. Horizontal centroid displacement is **not** added (stacked elevators must not look like a hallway). Same-floor elevator (restricted to one level) is not a vertical edge.

A\* heuristic stays planar haversine. These verticals are never cheaper than the horizontal distance between their endpoints, so the heuristic stays admissible. Travelators are out of scope.

Both `synth.rs` and `synth_medial.rs` use the same helper `vertical_cost_m(kind, lower_ord, upper_ord)`. P0's "preserve `horiz + floor_cost`" constraint is superseded by this section.

## 5. P1 — query-time greedy-LOS

`kiriko_route::route` stays graph-only. A second function:

```rust
pub struct WalkableFloor {
    pub ordinal: f64,
    pub rings: Vec<WalkablePolygon>, // exterior + holes, lon/lat
    pub locks: Vec<[f64; 2]>,        // opening midpoints + transit centroids
}

pub fn smooth_route(route: Route, floors: &[WalkableFloor]) -> Route
```

- Per `RouteSegment`, greedy forward scan: from vertex `i`, take the farthest `j > i` whose chord `i→j` stays inside the floor's walkable union (sampled ≤ 0.5 m, endpoints included) with `SEGMENT_OUTSIDE_TOL_M = 0.3`, and that does not skip a lock within `DOOR_LOCK_M = 0.4` of any intermediate vertex.
- Degree-2-only skips: a lock that coincides with a kept vertex stays.
- Do not smooth across floor changes. Do not add or remove segments. `total_weight` is **unchanged** (graph cost; smoothing is geometry).
- No `geo` crate (wasm must not grow `netgen`). Hand-rolled PIP / segment test, same numeric helpers as `synth.rs`.
- Built in `kiriko-bundle` from the document's walkway units + openings + transit centroids; called from `route_in_document` (wasm) and any native route helper. Empty `floors` → identity (imported-network tests that do not pass geometry stay valid).

This is Mappedin's published `greedy-los`, not a new chord pass. Existing build-time chord constants stay.

## 6. P3 — hallway rank

After a floor's edges are emitted (skeleton, doorways, bridges, chords, transit attaches) and before verticals:

- For each **horizontal** edge whose `kind` is `Skeleton`, `Bridge`, or `Chord`, test the midpoint against non-walkway, non-transit **unit** polygons on that ordinal.
- Hit → `rank = Secondary` and `weight *= SECONDARY_RANK_FACTOR` (`3.0`) **before** the global metres-to-cost conversion (so the factor is on metres, applied once).
- Doorway, stub, transit-attach, and vertical edges are never ranked secondary.
- Imported graphs are not classified.

Walkway / transit category lists stay the existing `is_walkway` / `is_transit` sets. `unenclosedarea` is not a walkway and therefore ranks as secondary if a skeleton edge crosses it — P4 should have already subtracted it.

## 7. P4 — obstacles

`navigable_area(&walk, &[])` becomes `navigable_area(&walk, &obstacles)`.

Obstacles, per floor:

1. Unit polygons whose category is **not** walkway and **not** transit, including `unenclosedarea`.
2. `FeatureType::Fixture` and `FeatureType::Kiosk` polygons.
3. `FeatureType::Detail` linework, buffered to `OBSTACLE_BUFFER_M = 0.4` (Esri UCN default) as stadium polygons (rectangle + disc end-caps) in the local metre frame, then converted back to lon/lat.

If buffering a detail line fails (degenerate, < 2 vertices), skip that part; do not fail the floor. The existing `MIN_PASSAGE_M` prune remains.

GDB `*_Drawing` lines become IMDF details today; without (3) this change is a no-op on JR venues.

## 8. Regeneration semantics

All of this affects **newly generated** networks only. Published versions are unchanged until the producer runs Generate routing. No migration of old §5 bytes. A new generate writes §5 + optional §12.

## 9. Non-goals

- Lattice generator, UCN replacement spine, travelators, accessibility profile flag, one-way / hours, query-time weight in the DTO, §11 findings, ML generation.
- Changing `route()`'s `total_weight` meaning.
- New user-facing copy (vertical presentation remains P0 §7: language-neutral floor tokens).

## 10. Sequencing

P0 four plans, then: attrs+§12 → P2 costs → P1 smooth → P3 classify → P4 obstacles.

P3/P4 are build-time and independent of P1. P1 is last among query changes so its fixtures do not fight stub/matching churn.
