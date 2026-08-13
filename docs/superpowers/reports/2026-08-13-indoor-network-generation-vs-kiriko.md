# Indoor network generation vs Kiriko

**Date:** 2026-08-13
**Status:** Research + comparison. No code changes.
**Scope:** How professional indoor products *generate* a pedestrian routing graph from floor geometry, how the current literature does it, and where Kiriko's `synth_medial` + `kiriko-route` sit against that. Query-time A* is in scope only where it is a documented alternative to a stored graph.

A vendor-only primary-source dump (no Kiriko) is being written in parallel to `docs/superpowers/reports/2026-08-13-indoor-network-generation-research.md`. This file is the one that answers "what should we change?"

---

## 1. Two products, two different jobs

Kiriko already has two routing sources. They must not be collapsed.

| Path | When | What it is |
|---|---|---|
| **Imported GDB** | Tokyo `network_WebMercator.gdb` (`net_junction` + `net_path`) | Hand-authored professional graph. Costs already encode passage penalty. Quality work is *import + query*, not generation. |
| **Generated (`synth_medial`)** | `POST /api/gdb/generate-network` with `synthesizeNetwork: true` | CDT medial-axis centerline of walkable IMDF units, plus doorway stubs, blob bridges, open-space chords, vertical transit matching. |

This report is about the generated path. The imported Tokyo graph is the quality ceiling the generator is trying to approach, not something to regenerate.

The 2026-07-20 route-slice design originally deferred generation ("explicit network only"). Generation shipped later as the `netgen` feature in `kiriko-bundle`. The crate header still says "ArcGIS-Indoors-style pipeline" — that claim is only half true. Esri's *current* published generator is not a medial axis.

---

## 2. What Esri actually publishes (2026, ArcGIS Pro 3.7)

Primary sources: [Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm), [Generate Indoor Network Features](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-indoor-network-features.htm), [Classify Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/classify-indoor-pathways.htm), [ArcGIS Indoors Information Model](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm).

### Pipeline (current)

1. **Create Indoor Network Dataset** — empty Pathways / Transitions / Landmarks schema.
2. **Generate Indoor Network Features** — one tool, three methods:
   - **Lattice** (default). Fishnet over walkable space, spacing 0.25–2.9 m (default **0.6 m**), rotation from the level's minimum bounding rectangle or a user angle. Cut by **obstacle polylines** (walls, windows, columns) plus an **obstacle buffer** (lattice default 0.05 m; must be ≤ half the narrowest doorway). Then **thinned to connectivity between routable locations**.
   - **Universal Circulation Network**. Shortest walking-like paths between routable locations. Cited as [Lee, Eastman, Lee, Kannala, Jeong 2010, *Environment and Planning B* 37(4)](https://journals.sagepub.com/doi/10.1068/b35124) (`10.1068/b35124`). Intended for curved / multi-orientation buildings.
   - **Transitions Only**. Snap verticals onto an existing pathway set.
3. **Classify Indoor Pathways** — split pathways at selected unit polygons; rank the interior portion **secondary** so hallways win over conference rooms.
4. **Manual outdoor links** between facilities. The tools **do not** connect buildings.
5. **Create Network Dataset From Template** + **Build Network**. Walking and wheelchair travel modes ship in the template. Extra modes are a producer decision.
6. Landmarks within 4 m of a route become turn-by-turn callouts.

Older **Generate Indoor Pathways / Generate Floor Transitions / Thin Indoor Pathways** are **deprecated**. Thinning still exists, but it is folded into Generate Indoor Network Features. The PrelimPathways / PrelimTransitions classes were removed from the model in Pro 3.7.

### What Esri generates *to*

Not a "centerline of the corridor." Lattice is a dense grid that is then **reduced to the Steiner tree / spanning set that connects routable locations**. Default routable locations: **unit centroids** + **transition endpoints**. Optional extra points: POIs, exterior entryways (`Generate Facility Entryways` is recommended so later outdoor links snap cleanly).

**Search Radius** grows the candidate set of nearby routable locations. Larger radius → more pathways, longer runtime, better open-hall connectivity.

### Verticals

- Stair / elevator / escalator **unit polygons** selected by SQL expressions.
- A vertical line is created between floors at the **closest pathway vertex to the unit center**.
- Endpoints **must snap vertex-to-vertex** onto pathways. Disconnected vertices are a documented routing failure mode.
- Elevator delay (seconds) is written onto pathway segments that intersect the elevator polygon.
- Stair flights with landings are **manual vertex edits** after generation. Not automatic.

### What is explicitly not automatic

- Inter-building outdoor paths.
- Stair geometry that follows the walking line (landings).
- Travel modes beyond the two template modes.
- Pathway rank (hallway vs room) unless Classify is run on a selection.
- Anything the obstacle layer / restricted-unit expression missed.

### Attribute model Esri keeps and Kiriko does not

Pathways / Transitions carry:

| Field | Meaning |
|---|---|
| `PATHWAY_RANK` / `TRANSITION_RANK` | 1 primary, 2 secondary, 3 tertiary |
| `PATHWAY_TYPE` / `TRANSITION_TYPE` | hallway, stairs, ramp, elevator, escalator, moving walkway |
| `TRAVEL_DIRECTION` | both / from-to / to-from |
| `DELAY` | elevator wait (seconds) |
| `LENGTH_3D` | 3D length is the network cost |

Kiriko's generated graph stores `(from, to, weight_metres_as_cost, ordinal, interior)`. No rank, no type, no direction, no delay. Verticals are ordinary edges whose weight is `horizontal_m + floor_cost(category)`.

---

## 3. What Mappedin actually publishes

Primary sources: [Mappedin JS Wayfinding](https://developer.mappedin.com/web-sdk/wayfinding), [`TGetDirectionsOptions`](https://docs.mappedin.com/web/v6/latest/types/TGetDirectionsOptions.html), [MVF v3 overview](https://developer.mappedin.com/docs/mvf/v3/mvf-v3-specification/mvf-overview), [NodeProperties](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.nodes.NodeProperties.html), [NodeNeighbor](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.nodes.NodeNeighbor.html), [Connection](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.connections.Connection.html), [Mappedin Maker](https://developer.mappedin.com/docs/maker), [Editor marketing](https://www.mappedin.com/editor/).

### Generation internals: unpublished

Mappedin does **not** document an algorithm that turns floor polygons into a centerline. Maker accepts PNG / JPEG / WebP / PDF / DXF / DWG and markets AI detection of doors, windows, walls. That is **floorplan vectorization**, not a published routing-network generator. Treat any claim about "Mappedin uses Voronoi / lattice / medial axis" as **[INFERENCE]** — there is no first-party algorithm page.

### What they *do* publish, and it is the interesting part

They ship a **query-time pathfinder over map geometry**, plus an optional stored node graph in MVF.

**Query API (`MapData.getDirections`)**

- Origin / dest are `TNavigationTarget` (space, coordinate, location). Arrays pick the **closest pair** (nearest washroom).
- A Space **requires an entrance** to be a target.
- Options:
  - `accessible: true` — avoid stairs / escalators, prefer ramps / elevators.
  - `smoothing` — default **on** for Maker maps, **off** for enterprise/CMS maps. Methods: `greedy-los` (default, O(n) line-of-sight), `rdp` (Ramer–Douglas–Peucker + LOS + door buffer nodes), `dp-optimal` (O(n²) globally optimal). Configurable `radius` in metres.
  - `zones[]` — extra cost 0…∞ over a polygon (spill / closure). Stacking adds. ∞ is a hard block.
  - `connectionIdWeightMap`, `excludedConnections` (enterprise), `includeNonPublic`.
- Multi-floor connections render as interactive tooltips (elevator / stairs icon).
- Multi-destination and Blue-Dot path tethering are first-class.

The wayfinding guide is explicit: raw directions "may appear jagged… due to the SDK attempting to find the shortest path through the map's geometry." Smoothing is a **query-time string-pull**, not a build-time chord pass.

**Stored model (MVF Nodes + Connections)**

Two different objects, which Kiriko currently smashes into one `RouteEdge`:

- **Nodes** — same-floor walkable graph. Neighbor cost = straight-line metres + `extraCost` (metres you would walk *out of your way* to avoid that edge). Flags include accessible / outdoors / `public`.
- **Connections** — doors, elevators, escalators, stairs, ramps, travelators, ladders. Cost is **`entryCost` + `|Δelevation| × floorCostMultiplier`**. Straight-line entrance→exit is **not** part of the cost. Same-floor connection cost is *only* `entryCost` (so a travelator can be cheaper than walking). Official note: **you cannot naively A\* through Connections** because a Euclidean heuristic is not admissible.

That split is the single most useful Mappedin artifact for Kiriko. Our verticals are "a slightly more expensive ordinary edge." Theirs are a different primitive with a different cost model.

---

## 4. What IMDF / IndoorGML actually give you

These are **not generators**. They are the topology the generator is allowed to trust.

### IMDF ([Opening](https://register.apple.com/resources/imdf/types/opening), [Relationship](https://register.apple.com/resources/imdf/types/relationship), [overview](https://register.apple.com/resources/imdf/))

- An Opening is a **LineString across a doorway**, length ≈ physical width. Category, accessibility, access_control, door hardware live here.
- Elevator / escalator / stairs / movingwalkway / steps units **must** have openings. That is the official connectivity signal.
- Directed / one-way / hours / vertical elevator stacking are **Relationship** features (`category: traversal`), not implied by shared boundaries.
- IndoorGML 2.0's preface is blunt: IMDF "provides a comprehensive model to compute path(s)… but the derived network is application specific" ([OGC 22-045r5](https://docs.ogc.org/is/22-045r5/22-045r5.html)).

Kiriko already uses openings as the doorway signal. It ignores `accessibility`, `access_control`, `door`, and Relationship direction / hours.

### IndoorGML 1.1 / 2.0 ([19-011r4](https://docs.ogc.org/is/19-011r4/19-011r4.html), [22-045r5](https://docs.ogc.org/is/22-045r5/22-045r5.html))

- Poincaré duality: room = node, shared navigable surface (door) = edge. That is a **logical** connectivity graph (NRG), not a metric centerline.
- Separate adjacency vs connectivity vs accessibility graphs. Multi-layered space model for topographic / sensor / security overlays.
- IndoorGML is the right *abstraction* for "which spaces touch through a door." It is the wrong *geometry* for "walk down the middle of the corridor." Kiriko's unused centroid-hub synthesizer (`synth.rs`) is closer to IndoorGML than `synth_medial` is.

---

## 5. Generation methods in the literature (when vendors go quiet)

| Method | Input | Output | Strength | Indoor failure mode |
|---|---|---|---|---|
| **Lattice + thin** (Esri) | Walkable polygon, obstacle lines, POI/centroid set | Sparse grid subset connecting targets | Predictable, orthogonal buildings, easy to edit | Wrong rotation; too-coarse spacing misses doors; open halls need a large search radius |
| **UCN / door-to-door shortest paths** (Lee et al. 2010; Esri's second method) | Spaces + doors | Walking-like polylines between routable locations | Looks like a person; good on curves | Dense complete graph unless thinned; needs a target set |
| **CDT medial axis** (Chin–Snoeyink–Wang 1999, *DCG* 21:405–420, [doi:10.1007/PL00009429](https://doi.org/10.1007/PL00009429); Kiriko) | Walkable polygon | Corridor centerline | Stays off walls; one graph serves any origin | Spurs into corners; rings obstacles; no diagonal across a concourse |
| **Voronoi / GVD / Explicit Corridor Map** (van Toll et al. 2017, [arXiv:1701.05141](https://arxiv.org/abs/1701.05141)) | Walkable surfaces + obstacles | Medial axis *annotated with clearance* | Any-radius characters; multi-layer in O(n log n log k) | Projected (not 3D) lengths; needs a clean walkable environment |
| **Visibility graph** | Obstacle vertices | Shortest geometric paths | Optimal length | O(n²); hugs walls; ugly for pedestrians unless combined with clearance |
| **Visibility–Voronoi complex** (Wein, van den Berg, Halperin 2007) | Obstacles + radius | Clearance-aware shortest paths | Natural-looking (short + smooth + off walls) | Heavy; more robotics than GIS |
| **IndoorGML dual / portal graph** | Cells + doors | Logical graph | Tiny; accessibility overlays | No metric geometry; routes are room-to-room teleports unless a second metric layer is added |
| **IFC / BIM extraction** (survey: Diakité & Zlatanova / related Automation in Construction 2021, [S0926580520310165](https://www.sciencedirect.com/science/article/abs/pii/S0926580520310165)) | IFC spaces, doors, stairs | Mixed | Rich semantics | Survey finding: *no robust automation*; most papers are conversions, not generators |

The commercially winning pattern in 2026 is **not** "pick one skeleton." It is:

1. Build a **metric walkable graph** (lattice *or* medial *or* door-to-door).
2. **Thin / classify** it against the destinations that matter.
3. Keep **verticals as a different primitive** with entry cost + per-floor cost.
4. **String-pull at query time** against walkable polygons (Mappedin smoothing; Esri does less of this because lattice+thin already aims at destinations).
5. Leave a **producer editor** for the residual (Esri's Create/Split/Move with auto attributes; Mappedin Maker).

Kiriko does (1) as a medial axis, a limited form of (4) as build-time chords, and almost none of (2)/(3)/(5) as first-class product surfaces.

---

## 6. Kiriko today

### 6.1 Build (`core/crates/kiriko-bundle/src/synth_medial.rs`)

Per floor, in order:

1. Union walkable unit polygons. Walkable categories: `walkway`, `walkway.island`, `movingwalkway`, `footbridge`, `ramp`, `steps`, `lobby`, `platform`, `corridor`, `sidewalk`. **`unenclosedarea` excluded** (shop interiors). Transit (`elevator` / `escalator` / `stairs`) is *not* part of the navigable area.
2. **Obstacle subtraction is implemented (`navigable_area`) and unused** — always `navigable_area(&walk, &[])`.
3. Densify rings (~0.9 m / `8e-6` deg, coarsened to stay under 24 000 CDT vertices) and extract an approximate Chin–Snoeyink–Wang medial axis from interior CDT faces.
4. Drop edges whose endpoints/midpoint have clearance < 0.4 m (`MIN_PASSAGE_M / 2`).
5. Prune short spurs (< 3 m) and narrowing wedges (< 8 m, tip clearance < 50% of junction).
6. Protect nearest valid snap targets, then straighten degree-2 chains whose detour ≥ 1.15× and whose chord stays passable.
7. **Plan doorways** before emit: score line vs normal as passage axis; attach per blob by axis-ray → perpendicular projection → nearest node; split the centerline so the attach is a T-junction.
8. Emit skeleton, then **eager 1.2 m stubs** on both valid sides of every opening, then attach.
9. Bridge distinct blobs within 2 m if the segment is full-width passable.
10. Add open-space chords (10–40 m, ≥ 5 m clearance, save ≥ 15 m and beat graph path by 0.7, ≤ 2 chords/node). Doorway-only unions are excluded from eligibility so chords cannot skip a door.
11. Attach each transit centroid through its boundary opening (1.5 m), else nearest walkable node.
12. After all floors: **greedy nearest** same-category transit on the next ordinal, if centroid ≤ 5 m **or** footprints overlap. Weight = `horiz_m + {elevator:3, escalator:4, stairs:5}`.
13. Convert metres → cost once (`COST_UNITS_PER_METER = 1000`).

Floors over the vertex budget emit `synth_floor_too_complex` and are skipped. Openings with no walkable attach emit `synth_opening_no_walkway`.

### 6.2 Query (`core/crates/kiriko-route/src/query.rs`)

Already better than the original slice:

- Snap to up to **3** nearest same-floor edges (not nodes).
- Multi-source / multi-goal A* including connector-leg cost in *selection*.
- Same-edge walk is a candidate, not a forced shortcut.
- Reported `total_weight` is graph-only (connectors excluded from the DTO).

Still missing versus Mappedin / Esri:

- No accessibility profile.
- No one-way / barrier / hours (imported fields exist on Tokyo GDB and are dropped).
- No query-time string-pull against walkable polygons (explicitly deferred in the 2026-07-31 design).
- No hallway-vs-room rank.
- Heuristic is planar haversine; fine while verticals are cheap additives, **wrong** if Connections-style entry costs appear.

### 6.3 Known defects that are already designed, not shipped

`docs/superpowers/specs/2026-08-12-generated-network-offshoot-remediation-design.md` is **approved and not in the tree**. Confirmed absent: `materialize_doorway_side`, `DoorwaySide`, `minimum_cost_maximum_matching`, `synth_opening_geometry_review`. Current code still:

- Emits unused doorway stubs (Shibuya evidence in that spec: 61 of 62 high-tortuosity foldbacks are stub chains).
- Matches verticals greedy-nearest (fan-in: 6 duplicate targets on that venue).
- Does not warn on 10–54 m "openings" that are really corridor centerlines mis-typed.

Do not reinvent those four items. Implement that spec first.

### 6.4 What the crate comment gets wrong

> "ArcGIS-Indoors-style pipeline producing real corridor centerlines"

Esri's default 2026 tool is **lattice + thin-to-POIs**. Centerlines are Kiriko's choice (and a legitimate one — ECM / robotics literature prefers them). The shared ideas are: per-floor walkable area, obstacle-aware passages, doorway connectivity, verticals from transit units, a producer review overlay. The algorithm is not Esri's.

---

## 7. Side-by-side

| Concern | Esri Indoors 3.7 | Mappedin (published) | Kiriko generated |
|---|---|---|---|
| Horizontal generator | Lattice (default) or UCN; then thin to targets | Unpublished; query walks map geometry | CDT medial axis of walkway union |
| Who the graph is *for* | Unit centroids + extra POIs | Spaces with entrances + coordinates | Anyone who snaps to an edge |
| Obstacles | Detail/obstacle **lines** + buffer | Geometry itself | Unused `navigable_area` subtract; width prune only |
| Open space | Search radius between targets | Inherent (geometry walk + smoothing) | Optional chords, 5 m clearance / 15 m savings — concourses only |
| Doorways | Lattice cells that fit through the gap | Space must have an entrance; door buffer nodes in smoother | Midpoint + 1.2 m stubs + T-junction split |
| Verticals | Separate Transitions layer; snap to pathway vertex; optional elevator delay | `Connection` primitive: `entryCost + Δz × multiplier` | Ordinary edge, +3/+4/+5 m, greedy 1:N match |
| Rank / prefer hallways | `Classify Indoor Pathways` | Unpublished / flags on nodes | None. Any walkway is equal |
| Accessibility | Wheelchair travel mode in template | `accessible: true` | None |
| One-way / hours | `TRAVEL_DIRECTION` | Relationship-like via connections + zones | Deferred (imported fields dropped) |
| Query polish | Network Analyst + landmarks | LOS / RDP / DP-optimal smoothing; zones; nearest-of-N | Top-3 edge snap; no string-pull |
| Producer residual | Required (outdoor links, stair landings, rank) | Maker editor | Network review overlay + export GDB; no rank/type tools |
| Inter-building | Always manual | Unpublished | Same-venue only; outdoor units not walkable unless categorized |

---

## 8. What is actually worth changing

Ranked by leverage on generated-network quality. Imported Tokyo networks only benefit from the query-time items.

### P0 — Ship the already-approved remediation

Spec: `2026-08-12-generated-network-offshoot-remediation-design.md`.

1. **Lazy doorway stubs.** Stops the 2.4 m foldback / unused-stub topology. This is a real graph defect, not paint.
2. **Min-cost max-cardinality vertical matching.** Stops elevator fan-in. Esri generates *one* transition per stacked unit; Mappedin models *one* Connection with many entrances. Greedy nearest is the worst of the three.
3. **Opening-geometry review warnings.** Shibuya has openings > 50 m. Those poison passage-axis detection. Advisory only.

Do this before any new generator. Otherwise you will be thinning / ranking / string-pulling a graph that still contains junk.

### P1 — Query-time string-pull (Mappedin's actual advantage)

The 2026-07-31 design deferred this: "needs §2 geometry at query time; revisit only if 1+2 prove insufficient." Chords were the build-time substitute. They are gated so hard (5 m clearance, 15 m savings) that corridor-only venues gain **zero** chords by design (JR Takanawa measurement in that spec).

Mappedin is explicit that the stored path is jagged and that **line-of-sight simplification against walkable polygons** is how you make it look walked. Their default `greedy-los` is O(n) and is the boring option.

**Proposal:** at the end of `route()`, optional funnel / greedy-LOS against the floor's walkable MultiPolygon (already compiled into the bundle as unit geometry). Preserve doorway nodes as mandatory vertices (Mappedin's "door buffer nodes"). Do not add more build-time chords to paper over this.

This also fixes the "route rings a kiosk / follows the medial around an island" class of complaints without exploding cyclomatic complexity.

Risk: wasm payload must expose walkable polygons per ordinal, or the router has to decode §2. That is a real contract change. Prototype in native tests first.

### P2 — Separate Connection from Path (Mappedin cost model)

Kiriko vertical weight `horiz + {3,4,5}` m is too small against a long concourse walk and too crude for "wait for the elevator." Tokyo's *imported* graph already does this properly (`cost` ~32k for a floor change vs ~2k for 2 m). Generated networks do not.

Steal Mappedin's published numbers, not their unpublished generator:

- `entryCost` (metres-equivalent wait): elevator high (10–20), stairs/escalator 0.
- `floorCostMultiplier`: stairs ≫ elevator (they suggest ~10 vs ~1 per floor of elevation).
- Do **not** add horizontal displacement of a stacked elevator into the cost.
- Accessibility profile = "edges/connections flagged non-accessible are removed," not a second graph.

This needs a typed edge kind (`horizontal` | `vertical {category}`) so the viewer can stop drawing verticals as floor-plane slashes — also already designed in the 2026-08-12 spec §7.

Until this exists, generating "better centerlines" will not make multi-floor choice look like Tokyo.

### P3 — Thin-to-destinations, or rank, not a denser skeleton

Esri's important idea is not the lattice. It is **the graph exists to connect routable locations**, then everything else is deleted.

Kiriko's medial axis exists to cover *space*, then A* snaps to the nearest edge. That is why open concourses wander and why unused stubs look like real corridors.

Two compatible options:

- **Classify (cheap, Esri-shaped).** After synthesis, mark edges whose midpoint lies in a non-walkway unit (room, shop) as secondary and multiply weight (e.g. ×3). Hallways win. Needs unit polygons at build time — we already have them.
- **Thin (dearer, Esri-shaped).** Keep the medial as `Prelim`, then retain only edges that appear on a shortest path between (opening midpoints ∪ transit nodes ∪ facility anchors). Everything else becomes optional coverage or is dropped. Neighbor-solve-count is Esri's knob (default 50).

I would do classify first. Thinning without a destination set will delete legitimate dead-end corridors that a reviewer still wants to route into.

### P4 — Turn obstacle subtraction on

`navigable_area(walkables, obstacles)` already exists. It is called with an empty obstacle list. Detail/drawing lines and non-walkable units (columns, kiosks, track beds, `unenclosedarea`) are the Esri Details layer.

Turning this on is the correct fix for "centerline threads a furniture island / track strip" **if** the IMDF actually has those polygons. JR GDB `*_Drawing` is linework, not polygons — same problem Esri solves with obstacle **lines** + buffer. A line-obstacle buffer (Esri: 0.05 m lattice / 0.4 m UCN; max half the narrowest door) is the missing primitive. Do not invent a second medial algorithm for this.

### P5 — Do not replace the medial axis with a lattice

Lattice is the right default for orthogonal office floorplates with a known destination set. Kiriko's venues are stations: curved concourses, platforms, non-90° links, many unnamed walkable blobs. That is exactly the case Esri documents for **UCN**, and the case the ECM / medial-axis literature is built for.

A lattice would also fight the existing doorway T-junction / stub / chord machinery.

If a second generator is ever added, the useful one is **UCN / visibility-to-openings** as an *overlay* of destination-to-destination chords, not a replacement spine. That is P1 + P3, not a new crate.

### P6 — Producer attributes the generator should start writing

Even without new algorithms, emit on each edge (and keep them through export):

- `kind`: skeleton | doorway | stub | bridge | chord | vertical
- `category` for verticals
- `rank` once P3 exists
- `clearance_m` at the edge midpoint (ECM annotation; unlocks any-radius / wheelchair later)

The review overlay already exists. It cannot show what the graph does not store. The 2026-08-12 client work for vertical points is blocked on `HFLAG` / kind more than on new geometry.

---

## 9. What not to do

- **Do not regenerate Tokyo.** The imported GDB is the professional network. Generation is the fallback for venues that do not have one.
- **Do not implement Chin–Snoeyink–Wang "for real."** The 1999 linear-time algorithm depends on Chazelle's triangulation and is widely cited as unimplemented. The CDT approximation is the industry practice. van Toll's ECM is the modern multi-layer formalization if the CDT approximation ever becomes the bottleneck.
- **Do not add ML generation.** There is no high-trust 2018–2026 paper that ships a production indoor pedestrian generator this way. BIM→graph surveys say the opposite: conversion is active, robust automation is not.
- **Do not treat Mappedin marketing ("AI draws the map") as a routing algorithm.**
- **Do not string-pull in paint only.** The 2026-08-12 spec's first principle stands: fix topology in synthesis.

---

## 10. Suggested sequence

1. Implement 2026-08-12 remediation (stubs, matching, opening warnings, vertical presentation).
2. Add edge `kind` + vertical cost model (P2 + P6). Re-generate Shibuya / Takanawa and re-run the offshoot detector.
3. Query-time greedy-LOS string-pull with doorway locks (P1). Measure against the 2026-07-31 "routes visibly longer" fixtures before touching chords.
4. Hallway rank from unit category (P3 classify).
5. Obstacle-line buffer + actually call `navigable_area` (P4), gated by whether the source has Details-equivalent geometry.

---

## References

### Esri (first-party)

- [Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm) (ArcGIS Pro 3.7, updated 2026-06-22)
- [Generate Indoor Network Features](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-indoor-network-features.htm)
- [Generate Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-indoor-pathways.htm) (deprecated)
- [Thin Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/thin-indoor-pathways.htm) (deprecated)
- [Classify Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/classify-indoor-pathways.htm)
- [Update the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/update-the-indoors-network.htm)
- [ArcGIS Indoors Information Model](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm)

### Mappedin (first-party)

- [Wayfinding (Mappedin JS v6)](https://developer.mappedin.com/web-sdk/wayfinding)
- [`TGetDirectionsOptions`](https://docs.mappedin.com/web/v6/latest/types/TGetDirectionsOptions.html)
- [MVF v3 overview](https://developer.mappedin.com/docs/mvf/v3/mvf-v3-specification/mvf-overview)
- [NodeProperties](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.nodes.NodeProperties.html) / [NodeNeighbor](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.nodes.NodeNeighbor.html)
- [Connection](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.connections.Connection.html)
- [Mappedin Maker](https://developer.mappedin.com/docs/maker)
- [Editor](https://www.mappedin.com/editor/)

### Standards

- [Apple IMDF 1.0.0](https://register.apple.com/resources/imdf/)
- [IMDF Opening](https://register.apple.com/resources/imdf/types/opening)
- [IMDF Relationship](https://register.apple.com/resources/imdf/types/relationship)
- [OGC IndoorGML 1.1 (19-011r4)](https://docs.ogc.org/is/19-011r4/19-011r4.html)
- [OGC IndoorGML 2.0 Part 1 (22-045r5)](https://docs.ogc.org/is/22-045r5/22-045r5.html)

### Academic

- Lee, Eastman, Lee, Kannala, Jeong (2010). Computing walking distances within buildings using the Universal Circulation Network. *Environment and Planning B* 37(4). [doi:10.1068/b35124](https://doi.org/10.1068/b35124)
- Chin, Snoeyink, Wang (1999). Finding the medial axis of a simple polygon in linear time. *Discrete & Computational Geometry* 21:405–420. [doi:10.1007/PL00009429](https://doi.org/10.1007/PL00009429)
- van Toll, Cook, van Kreveld, Geraerts (2017). The medial axis of a multi-layered environment and its application as a navigation mesh. [arXiv:1701.05141](https://arxiv.org/abs/1701.05141)
- Wein, van den Berg, Halperin (2007). The visibility–Voronoi complex and its applications. *Computational Geometry* 36(1). [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S0925772106000496)
- Indoor navigation supported by IFC: a survey (2021). *Automation in Construction*. [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0926580520310165)

### Kiriko (this repo)

- `core/crates/kiriko-bundle/src/synth_medial.rs`
- `core/crates/kiriko-bundle/src/synth.rs`
- `core/crates/kiriko-route/src/query.rs`
- `server/src/gdb/routes.ts` (`POST /api/gdb/generate-network`)
- `docs/gdb-data-reference.md`
- `docs/superpowers/specs/2026-07-31-routing-quality-and-overlay-sync-design.md`
- `docs/superpowers/specs/2026-08-12-generated-network-offshoot-remediation-design.md`
- `docs/superpowers/specs/2026-07-20-kiriko-route-slice-design.md`
