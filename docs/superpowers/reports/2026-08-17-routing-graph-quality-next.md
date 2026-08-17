/# Routing-graph quality next

**Date:** 2026-08-17
**Status:** Research only. No code changes in this pass.
**Scope:** What still improves indoor pedestrian routing *after* Kiriko’s 2026-08-13 generation-quality pass (medial-axis spine + greedy-LOS + Connection-style verticals + hallway rank + obstacle subtract + §12 attrs). Companion primary-source dump: [`2026-08-17-routing-graph-quality-sources.md`](./2026-08-17-routing-graph-quality-sources.md).

**Method.** First-party vendor docs, official specs, and publisher-hosted papers were re-read on 2026-08-17 (Esri ArcGIS Pro 3.7 Indoors, Mappedin JS v6.24 / MVF v3, Apple IMDF 1.0, OGC IndoorGML 1.1/2.0, IndoorAtlas wayfinding, van Toll ECM, Kallmann LCT/r-funnel, Lee et al. UCN abstract, Aldous stretch). Claims below are tagged **[INFERENCE]** when they go past a cited sentence. MazeMap and Google Indoor Maps have **no first-party algorithm docs**; they are not used as evidence.

The 13 August comparison ([`2026-08-13-indoor-network-generation-vs-kiriko.md`](./2026-08-13-indoor-network-generation-vs-kiriko.md)) is **stale in §6 and §8**: it still describes unused obstacle subtract, eager stubs, greedy verticals, and unshipped P0–P4. Trust this file, [`docs/gdb-data-reference.md`](../../gdb-data-reference.md), and the code.

---

## Verdict

Further graph quality is **not another generator rewrite**. The 13 August pass already shipped the build-time spine vendors actually publish (ECM-class medial axis, doorway stubs, obstacle subtract, hallway rank, Connection-style vertical costs). What is still unused is the **query-time surface**: A* in `kiriko-route/src/query.rs` reads only `e.weight`. §12 already stores `kind` / `rank` / `clearance_m` / `vertical`. IMDF `accessibility[]` is normalized into the bundle and then dropped. Imported Tokyo GDB `direction` / `BARRIER` / `GATE` / hours are not honoured.

Highest leverage: **one stored graph + travel-mode flags at request time**, plus cheap import of attrs Tokyo already has. Do not regenerate Tokyo. Do not replace the medial axis with an Esri lattice, UCN, or IndoorGML dual.

---

## 1. Two graphs, two ceilings

These must not be collapsed.

| Path | When | Quality work from here |
|---|---|---|
| **Imported GDB** | Tokyo `network_WebMercator.gdb` (`net_junction` + `net_path`) | Import + query. `cost` already encodes passage (~2k walk vs ~32k floor change). Do **not** regenerate. Restore dropped `direction` / `BARRIER` / `GATE` / `STARTTIME`/`ENDTIME`. |
| **Generated `synth_medial`** | `POST /api/gdb/generate-network` with `synthesizeNetwork: true` | CDT medial axis of walkable IMDF units + lazy stubs / bridges / chords / 1-1 verticals. Next work is write Opening width + accessibility onto §12, then decode those attrs at A*. |

---

## 2. Already shipped — do not re-propose

Code as of 2026-08-17:

| Pass | Where | What |
|---|---|---|
| P0 | `synth_medial.rs`, `transit_match.rs` | Lazy doorway stubs (`DOORWAY_STUB_M = 1.2`); 1-1 vertical matching; opening-geometry warnings |
| P1 | `kiriko-route/src/smooth.rs`, `kiriko-bundle/src/walkable.rs` | Query-time greedy line-of-sight smoothing |
| P2 | `synth.rs` `vertical_cost_m` | Connection-style verticals: elevator 15 + 1/floor, escalator 0 + 4/floor, stairs 0 + 10/floor; **no** horizontal shaft displacement in cost |
| P3 | `synth_medial.rs` | Hallway rank: Secondary ×3 on Skeleton/Bridge/Chord midpoints inside rooms |
| P4 | `navigable_area` | Obstacle subtract (units, fixtures/kiosks, Detail stadiums at 0.4 m) |
| §12 | `kiriko-route/src/graph.rs` | `EdgeKind`, `PathwayRank`, `clearance_m: Option<f32>` (never `0.0` for unknown), `VerticalKind` |

Synth constants already tuned on JR Takanawa/Shibuya: `MIN_PASSAGE_M = 0.8`, `CHORD_MIN_CLEARANCE_M = 5.0`, `CHORD_MIN_SAVINGS_M = 15.0`. Corridor-only venues get **zero** open-space chords. Do not add more build-time chords to paper over smoothness.

---

## 3. Unused seams in current code

Verified against `query.rs` / `graph.rs` / `build.rs` / `synth.rs` / `synth_medial.rs` / `export.rs` / `docs/gdb-data-reference.md`:

1. **A* uses only `e.weight`.** The non-test body of `query.rs` never reads `e.attrs`. Adjacency is bidirectional. Heuristic is `k * haversine` with `k = min(weight / endpoint-straight)` over edges with `m > 0`. Snap is top-3 same-floor. `total_weight` is graph cost only (viewer still mislabels it `m` — known follow-up, do not silently change the meaning).
2. **IMDF `accessibility[]` is dropped.** Normalized in `kiriko-model`, then `accessibility: Vec::new()` in both synth paths, `walkable.rs`, and `codec.rs`.
3. **Imported GDB attrs dropped.** `net_path.direction`, `BARRIER`, `GATE`, `STARTTIME`/`ENDTIME` exist on Tokyo. Export writes `direction: null`, `BARRIER: 0`, `GATE: 0`, `STARTTIME: -1`. `passage_type` is re-derived as “is vertical”, not restored from source. Do **not** re-penalize `passage_type` on top of already-encoded `cost`.
4. **KVB §10 / §11** are declared format ids with no decoder. §12 is implemented. Stage 6 network QA (findings, validation profiles, accepted exceptions) is still missing.
5. **Opening width is unused as clearance.** IMDF: an Opening’s LineString length **MUST** approximate the physical width of the entrance. Kiriko uses openings as doorway *topology*, not as `clearance_m` / wheelchair width.

---

## 4. Query vs build from here

### 4.1 Belongs at A* / query (`kiriko-route`)

| Improvement | Why query | Warrant |
|---|---|---|
| Decode §12 `kind` / `rank` / `clearance_m` / `vertical` | Already stored | Esri travel modes; Mappedin flags; ECM any-radius; Kallmann `2r < cl` |
| Wheelchair / accessible profile | Skip stairs/escalators; optional min `clearance_m`; later IMDF `accessibility[]` | Esri wheelchair travel mode; Mappedin `accessible?: boolean`; IndoorAtlas `EXCLUDE_INACCESSIBLE`; IMDF Opening width **MUST** approximate physical width |
| Default profile excludes accessible-only special lifts | Opposite filter of wheelchair | IndoorAtlas `EXCLUDE_ACCESSIBLE_ONLY` |
| One-way / `TRAVEL_DIRECTION` | Imported GDB + IMDF Relationship `directed` | Esri field exists (population is **not** documented as automatic); IndoorAtlas `+directed` |
| Hours / reversible escalators | Temporal; do not bake “now” into weight | IMDF Relationship `hours` |
| Zones / closures / spill | Dynamic cost 0…∞ | Mappedin `TDirectionZone` |
| `includeNonPublic` / staff | Flag filter | Mappedin `includeNonPublic`; IMDF Unit `restriction` / `nonpublic` |
| Connection weight overrides / excluded connections | Per-request | Mappedin `connectionIdWeightMap`, `excludedConnections` |
| A* heuristic when Connection `entryCost` is live | Euclidean may become inadmissible | Mappedin Connection page, quoted below |
| Optional RDP / dp-optimal / r-funnel | Smoothing; keep doorway vertices mandatory | Mappedin smoothing methods; Kallmann r-funnel |
| Stretch / detour QA | Evaluation, not routing | Aldous `ρ(d)`; Esri post-run checklist |

**One graph, several profiles.** Esri, Mappedin, IndoorAtlas, and IndoorGML all put accessibility on flags / travel modes / layers over the same metric graph. Do not clone the graph per profile.

### 4.2 Belongs at synth / import (cheap attribute writes)

| Improvement | Why build | Warrant |
|---|---|---|
| Write Opening LineString length → `clearance_m`; `accessibility[]` / `access_control[]` → flags | Query cannot filter what was dropped | [IMDF Opening](https://register.apple.com/resources/imdf/types/opening) |
| Write Relationship `direction` / `hours` onto doorway and vertical edges | Currently unused | [IMDF Relationship](https://register.apple.com/resources/imdf/types/relationship) |
| Restore imported GDB `direction` / `BARRIER` / `GATE` / hours | Tokyo quality ceiling | `docs/gdb-data-reference.md` Known follow-ups: “Deferred routing semantics” |
| Keep annotating `clearance_m` on medial edges | Already shipped | van Toll ECM; Kallmann LCT |
| Keep Connection-style verticals, hallway ×3, obstacle subtract | Already shipped | Mappedin Connection; Esri Classify / Details |

### 4.3 A* heuristic (do not ignore)

Mappedin, [Connection](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.connections.Connection.html):

> You cannot naively use A* with Connections, because the straight line distance heuristic will not be admissible.

Kiriko today: vertical cost is the *only* cost of a vertical edge (no shaft displacement); heuristic is **2D** haversine scaled by `k ≈ COST_UNITS_PER_METER` from walking edges. Stacked elevator endpoints make remaining Euclidean ~0, which **underestimates**, so A* stays admissible **today**. It stops being safe if any of these land:

- 3D Euclidean heuristic (atrium height > elevator `entryCost`)
- Connection cost stacked on top of a geometric edge
- Zones of Infinity / `excludedConnections` that forbid the Euclidean shortcut

**[INFERENCE]** Keep 2D haversine until those land; if they land, drop A* for Dijkstra on vertical queries or use a heuristic that ignores forbidden shortcuts.

---

## 5. Ranked next work

Ordered by unused-by-Kiriko × primary-source density × quality of routes a pedestrian actually sees.

### 1. Query travel modes (do this first)

Skip `VerticalKind::Stairs` / `Escalator` on an accessible profile; optional `clearance_m >= r`. Later: IMDF `accessibility[]` once synth stops dropping it. IndoorAtlas’s default also excludes accessible-only special lifts — Kiriko currently has neither profile.

Esri’s wheelchair mode is a **restriction over the same network**, not a second generate. Mappedin: `accessible?: boolean` default `false`.

### 2. Use stored `clearance_m` (ECM any-radius)

van Toll et al. 2017 ([arXiv:1701.05141](https://arxiv.org/abs/1701.05141)): the ECM exists so you **do not** inflate obstacles per radius. Kallmann 2010: accept a traversal iff `2r < cl`. Filter at A*; do not rebuild the medial axis per wheelchair width.

### 3. Honour imported GDB direction / barrier / gate / hours

This is the Tokyo ceiling. `docs/gdb-data-reference.md` already lists these as deferred routing semantics. Do not rewrite `cost`. Do not re-penalize `passage_type`.

### 4. Write IMDF Opening / Relationship onto §12 (build, then query)

Opening length → `clearance_m`. `accessibility[]` / `access_control[]` → flags. Relationship `direction` / `hours` onto doorway and vertical edges. Curated Relationship LINEAL geometry **MUST NOT** be treated as the network ([IMDF Relationship](https://register.apple.com/resources/imdf/types/relationship)).

### 5. Clearance-aware funnel / Mappedin RDP (still query)

Greedy-LOS already shipped. Next smoother, only if wide agents still hug corners: Mappedin `'rdp'` (door buffer nodes) or `'dp-optimal'`, or Kallmann r-funnel. Doorway vertices stay mandatory. **Do not** add more build-time open-space chords.

### 6. Routable-location attach, then cautious thin

Esri’s commercially winning idea is thin-to-POIs **after** a covering network, not the fishnet itself. Thinning can delete dead-end corridors a reviewer still wants. Attach openings / transit / POIs first. UCN (Lee et al. 2010) is shortest paths among a closed destination set — same caveat.

### 7. Runtime zones

Mappedin `TDirectionZone` extra cost `0…Infinity` over a polygon, optional floor. Query overlay. Do not bake spill/closure into weight.

### 8. KVB §11 decoder + editor flags

Esri post-run checklist as findings: pathways into every room and not cut by doorways; verticals vertex-to-vertex; lattice/spine orientation matches units. Editor already has connectivity / add-delete; missing rank / type / one-way / accessible tools. Stage 6: persistent findings, validation profiles, accepted exceptions.

### 9. Eval harness

Same-floor stretch: Aldous & Shun prefer `R = max_d ρ(d)` over `R_ave` / `R_max` ([arXiv:1003.3700](https://arxiv.org/abs/1003.3700)). Indoor analogue: metres, bins around concourse scale (10–40 m), **same-floor only** (vertical Connections break Euclidean). Also: opening coverage, doorway angle, components, generated-vs-Tokyo goldens. `analyze_synth.rs` is a diagnostic example, not product CI. **Do not** add long-range chords just to drive `R_ave` down (Aldous’s named failure mode; Kiriko already gated chords for this reason).

---

## 6. Leave manual — Esri 3.7 is explicit

Copying Esri does **not** mean automating these.

| Residual | Source quote | Kiriko |
|---|---|---|
| Campus sidewalks / inter-facility | “The Indoors tools do not connect facilities in the network.” | Producer residual. Do not auto-weave outdoor sidewalks. |
| Stair landings / angled flights | “manually updated after generation. This is not required for generating routable directions.” Recalculate `LENGTH_3D` after vertex edits. | Connection-style cost already covers *choice*. 3D stair polylines are editor work. |
| Landmarks | Manual Append/digitise; **4 m** callout radius | Directions polish, not graph quality. |
| Classify unit selection | Operator *must* select Units | Hallway ×3 already shipped. No second Classify UI unless a producer asks. |
| Travel modes beyond walking + wheelchair | Template ships two; more are created by the producer | Query profiles, not synth. |
| `TRAVEL_DIRECTION` population | Field exists; automatic fill is **not** documented | Populate from IMDF Relationship / imported GDB, not from geometry. |

Mappedin AI wall/door/window detection, LiDAR room scan, and draw-from-scratch are **geometry authoring**, not published graph generators. IndoorAtlas’s graph is **manually drawn** in their web editor.

---

## 7. What not to do

1. **Do not replace the medial-axis spine** with an Esri lattice, UCN, IndoorGML dual, or visibility graph. Esri’s default lattice is orthogonal to the already-chosen ECM-class spine.
2. **Do not regenerate Tokyo imported graphs.** Quality work there is import + query of already-authored costs.
3. **Do not invent campus sidewalks or stair-landing geometry.** Still manual in Esri 3.7.
4. **Do not treat Mappedin AI / LiDAR / ML-from-image as a graph generator.**
5. **Do not add more build-time open-space chords.** Greedy-LOS already shipped.
6. **Do not bake zones, hours, or “now” into weight.**
7. **Do not clone the graph per profile.**
8. **Do not use Euclidean A* naively** once Connection `entryCost` / Infinity zones make the 2D heuristic inadmissible.
9. **Do not use IMDF curated Relationship LINEAL as the comprehensive network.**
10. **Do not invent MazeMap / Google Indoor internals.** No first-party algorithm docs found this pass.
11. **Do not implement Chin–Snoeyink–Wang “for real.”**
12. **Do not string-pull in paint only.**
13. **Do not change `route()` `total_weight` meaning** as a side effect (viewer already mislabels it `m`).
14. **Do not re-penalize `passage_type`** on imported Tokyo edges.

---

## 8. What is not a graph generator

These produce floor geometry or authored maps. Kiriko must not copy them as synthesizers.

- Mappedin AI detect walls/doors/windows; LiDAR scan; Maker draw-from-scratch
- Esri Import BIM/IFC/CAD To Indoor Dataset (then you still run Generate Indoor Network Features)
- Apple IMDF 1.0 venue encoding
- OGC IndoorGML 1.1/2.0 topology/duality (“the derived network is application specific”, [OGC 22-045r5](https://docs.ogc.org/is/22-045r5/22-045r5.html))
- IndoorAtlas web editor (manual graph + tags)

---

## 9. Suggested sequence

1. **Query wheelchair + default profiles** over existing §12 `vertical` / `clearance_m` (no synth change). Add IndoorAtlas’s accessible-only exclusion on the default profile.
2. **Import Tokyo `direction` / `BARRIER` / `GATE` / hours** into edge flags; honour at A*. Do not touch `cost`.
3. **Stop dropping IMDF `accessibility[]`**; write Opening width into `clearance_m`; write Relationship direction/hours.
4. **§11 QA decoder** (Esri checklist + same-floor `ρ(d)`). Wire into Network Review; do not block publish on stretch alone.
5. **Optional r-funnel / RDP** if greedy-LOS still looks wrong for wide agents. Mandatory doorway vertices.
6. **Runtime zones** when a producer has a spill/closure story.
7. Producer residual stays residual: outdoor links, stair landings, landmarks, extra travel modes.

---

## References

Full quotes and per-source tables: [`2026-08-17-routing-graph-quality-sources.md`](./2026-08-17-routing-graph-quality-sources.md).

- [Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm)
- [Generate Indoor Network Features](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-indoor-network-features.htm)
- [Classify Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/classify-indoor-pathways.htm)
- [Update the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/update-the-indoors-network.htm)
- [ArcGIS Indoors Information Model](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm)
- [Create a travel mode](https://pro.arcgis.com/en/pro-app/latest/help/analysis/networks/create-travel-mode.htm)
- [Mappedin `TGetDirectionsOptions`](https://docs.mappedin.com/web/v6/latest/types/TGetDirectionsOptions.html)
- [Mappedin `TDirectionZone`](https://docs.mappedin.com/web/v6/latest/types/TDirectionZone.html)
- [Mappedin MVF Connection](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.connections.Connection.html)
- [IMDF Opening](https://register.apple.com/resources/imdf/types/opening), [Unit](https://register.apple.com/resources/imdf/types/unit), [Relationship](https://register.apple.com/resources/imdf/types/relationship)
- [IndoorGML 1.1](https://docs.ogc.org/is/19-011r4/19-011r4.html), [IndoorGML 2.0](https://docs.ogc.org/is/22-045r5/22-045r5.html)
- van Toll et al., Explicit Corridor Map, [arXiv:1701.05141](https://arxiv.org/abs/1701.05141)
- Kallmann, LCT / r-funnel, [10-sca-tripath.pdf](http://graphics.ucmerced.edu/papers/10-sca-tripath.pdf)
- Lee et al. 2010 UCN, [doi:10.1068/b35124](https://journals.sagepub.com/doi/abs/10.1068/b35124) (abstract only; full PDF paywalled)
- [IndoorAtlas wayfinding graph](https://support.indooratlas.com/support/solutions/articles/36000051250-creating-the-wayfinding-graph), [accessible routes](https://support.indooratlas.com/support/solutions/articles/36000551564-accessible-wheelchair-compatible-wayfinding-routes)
- Aldous & Shun, [arXiv:1003.3700](https://arxiv.org/abs/1003.3700)
