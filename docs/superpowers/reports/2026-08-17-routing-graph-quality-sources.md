# Routing-graph quality next — primary-source dump

**Date:** 2026-08-17
**Author:** PrimarySources (research subagent)
**For:** parent report `docs/superpowers/reports/2026-08-17-routing-graph-quality-next.md`
**Scope:** Indoor pedestrian routing graph quality *after* a medial-axis generator + greedy-LOS smoother already exist. Kiriko already ships the 2026-08-13 quality pass listed below. Do not regenerate Tokyo imported graphs. Do not replace the medial-axis spine with a lattice.

**Method.** Official vendor docs, official specs, publisher-hosted papers, and first-party product/API pages were read directly. Interpretive remarks beyond a cited sentence are marked **[INFERENCE]**. Anything not verified against a primary source is **[UNVERIFIED]**.

**Kiriko already ships (do not re-propose):** lazy doorway stubs; 1-1 vertical matching; opening-geometry warnings; greedy-LOS smoothing; hallway rank baked into weight (×3); obstacle subtraction; Connection-style vertical costs; §12 edge attrs (`kind` / `rank` / `clearance_m` / `vertical`). Query still uses only `weight`. Imported GDB `direction` / `BARRIER` / `GATE` / hours / `passage_type` dropped. IMDF accessibility unused. KVB §11 network QA has no decoder.

---

## 0. What is NOT a graph generator

These product methods produce *floor geometry* or *authored maps*, not a published centerline / lattice / dual-graph synthesizer. Kiriko must not treat them as generation algorithms to copy.

| Method | Owning claim | Why it is not a generator |
| --- | --- | --- |
| Mappedin AI wall / door / window detection | “Upload any floorplan and let Mappedin automatically detect and draw any doors, windows, walls and much more.” ([Mappedin Features](https://www.mappedin.com/features/); same claim on [Editor](https://www.mappedin.com/editor/)) | Vectorizes uploaded CAD/PDF/PNG into drawable geometry. No published lattice / medial-axis / UCN / visibility construction. |
| Mappedin LiDAR room scan | “Start by scanning a room with your iPhone or iPad. Apple’s built-in LiDAR captures accurate 3D layouts…” ([Editor](https://www.mappedin.com/editor/)) | Captures room geometry. Not a routing-network algorithm. |
| Mappedin Maker draw-from-scratch | “No floor plan? No problem. Use our built-in tools to draw walls, add rooms…” ([Editor](https://www.mappedin.com/editor/)) | Manual authoring. |
| Esri Import BIM / IFC / CAD To Indoor Dataset | BIM/IFC/CAD import writes Facilities / Levels / Units / Details; output “can be used … to generate an indoor network for routing” ([Indoors Information Model](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm)) | Floor-plan load. `Generate Indoor Network Features` still has to run. |
| Apple IMDF 1.0 | “generalized, yet comprehensive model for any indoor location, providing a basis for orientation, navigation and discovery” ([IMDF overview](https://register.apple.com/resources/imdf/)). Curated Relationship paths “MUST NOT be assumed to be used by default, or even at all, by existing routing systems” ([Relationship](https://register.apple.com/resources/imdf/types/relationship)). | Venue encoding. IndoorGML 2.0: “the derived network is application specific” ([OGC 22-045r5](https://docs.ogc.org/is/22-045r5/22-045r5.html)). |
| OGC IndoorGML 1.1 / 2.0 | “IndoorGML intentionally focuses on modeling indoor spaces for navigation purposes” and “contains only a minimum set of geometric and semantic modelling of construction components” ([IndoorGML 1.1](https://docs.ogc.org/is/19-011r4/19-011r4.html)). | Topology / duality encoding. Not a metric centerline generator. |
| IndoorAtlas wayfinding editor | “you first need to create the wayfinding graph using the editor available in the IndoorAtlas web application” ([Creating the Wayfinding Graph](https://support.indooratlas.com/support/solutions/articles/36000051250-creating-the-wayfinding-graph)) | Manual graph authoring + tags. No published auto-generator. |
| Esri Landmarks / outdoor sidewalks / stair landings | Landmarks are appended or digitised; “The Indoors tools do not connect facilities”; stair landings are vertex-edited after generation ([Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm)) | Residual *producer* work, not generation. |

---

## 1. Esri ArcGIS Pro 3.7 Indoors

Docs last-modified 2026-06-22, version 3.7. Primary pages:

- [Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm)
- [Generate Indoor Network Features](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-indoor-network-features.htm)
- [Classify Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/classify-indoor-pathways.htm)
- [Update the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/update-the-indoors-network.htm)
- [ArcGIS Indoors Information Model](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm)
- [Create a travel mode](https://pro.arcgis.com/en/pro-app/latest/help/analysis/networks/create-travel-mode.htm)

### 1.1 Published pipeline (do not re-invent the stages already shipped)

Seven high-level steps ([Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm)):

1. Create Indoor Network Dataset (schema: Pathways, Transitions, Landmarks).
2. Generate Indoor Network Features (horizontal + optional verticals).
3. Create landmark points (manual Append / digitise). Any landmark within **4 m** of a route is named in directions.
4. Rank pathways via Classify Indoor Pathways.
5. Connect facilities — **not automatic.** “The Indoors tools do not connect facilities in the network.”
6. Create Network Dataset From Template (`FinalNetworkTemplate_Meters.xml`) + Build Network.
7. Optionally add travel modes. Template includes **walking** and **wheelchair-accessible**.

PrelimNetwork (`PrelimPathways` / `PrelimTransitions`) is deprecated in Pro 3.7; “the schema is now simplified to only include final network artifacts” ([Information Model](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm)).

### 1.2 Generate Indoor Network Features — residual knobs Kiriko should not copy as a new spine

Cited from the [tool page](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-indoor-network-features.htm) and [help narrative](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm):

- **Lattice (default).** “Creates a fishnet across the walkable spaces of the level.” Spacing 0.25–2.9 m (default **0.6 m**). Rotation 0–180° or MBR of each facility’s level. “Tight enough to pass through the narrowest doorways.” **Do not adopt.** Kiriko already has a medial-axis spine; replacing it with a lattice is out of scope.
- **Universal Circulation Network.** “Generates pathways based on shortest paths between routable locations, more closely resembling the walking path that a person might take.” Cited as [Lee et al. 2010, *Environment and Planning B* 37(4)](https://journals.sagepub.com/doi/abs/10.1068/b35124). Best for “multiple orientations or lots of curves or non-90 degree angles.”
- **Transitions Only.** Snap verticals onto existing pathways.
- **Routable locations.** Default = unit centroids + Transitions endpoints. Extra POI / entryway points optional. Search Radius grows candidate pairs; larger → more pathways, longer runtime; needed for large open spaces and long hallways.
- **Obstacles.** Polyline Details (walls, windows, columns) + Obstacle Expression + Obstacle Buffer. Buffer max = **half the width of the narrowest entryway**. Defaults: Lattice 0.05 m, UCN 0.4 m. Routable locations inside the buffer are not routed to. Kiriko already subtracts obstacles.
- **Doors.** No Opening input. Connectivity through doorways is produced by *not* treating door polylines as obstacles. Post-run checklist: “Generated pathways extend into all rooms and are not cut by doorways.”
- **Elevator Delay.** Wait in seconds, ≥ 0. “Splits the pathways intersecting with the elevator space polygon and adds the custom delay to them.”
- **Lattice thinning.** Combined tool both creates and thins. Deprecated Thin Indoor Pathways still documents Search Tolerance (default 5 m) and Neighbor Solve Count (default 50). Thinning “removes preliminary network pathways that are not needed for routing between selected locations.”

### 1.3 Attribute model query still does not use

From [Information Model — Pathways / Transitions](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm):

| Field | Domain / meaning | Build vs query |
| --- | --- | --- |
| `LENGTH_3D` | 3D length used as path cost | Build writes; query cost |
| `PATHWAY_RANK` / `TRANSITION_RANK` | 1 Primary, 2 Secondary, 3 Tertiary | Classify writes; query prefers primary |
| `PATHWAY_TYPE` / `TRANSITION_TYPE` | 1 Hallway/Sidewalk, 2 Stairs/Curb, 3 Ramp, 4 Elevator/Wheelchair Lift, 5 Escalator, 6 Moving Walkway | Build / edit; query restrictions |
| `TRAVEL_DIRECTION` | 1 Both, 2 From-To, 3 To-From | Field exists; population is **not** described as automatic |
| `DELAY` | Elevator wait, seconds | Build writes onto elevator-intersecting pathways |
| `VERTICAL_ORDER` / `VERTICAL_ORDER_FROM` / `_TO` | 0-based floor order | Topology |

Kiriko already bakes hallway rank into weight (×3) and stores §12 `kind`/`rank`/`clearance_m`/`vertical`, but **query still uses only `weight`.** Esri’s wheelchair mode is a **query-time travel mode** over restriction attributes, not a second generated graph ([Create a travel mode](https://pro.arcgis.com/en/pro-app/latest/help/analysis/networks/create-travel-mode.htm); template ships walking + wheelchair).

### 1.4 Classify Indoor Pathways

[Classify Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/classify-indoor-pathways.htm): operator *selects* unit polygons (conference rooms, service areas). Pathways intersecting those polygons are split; the interior portion is ranked Secondary. “Travel along primary pathways will have a lower cost than travel along secondary pathways.” Selection on Units is **required**. Network must be rebuilt. This is a post-process, not generation. Kiriko already bakes hallway rank ×3 at synth — Classify is the Esri analogue, already shipped in spirit.

### 1.5 Verticals and the post-run checklist

From [Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm) and [Update](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/update-the-indoors-network.htm):

- Transitions created when ≥2 levels + target Transitions layer + Stairway and/or Elevator SQL.
- “The vertices of transition features created by the tool will be snapped to pathway features to ensure a connected network.”
- Inspection: pathways into every room and not cut by doorways; lattice orientation matches units; verticals exist where expected; **endpoints snap vertex-to-vertex**. “Disconnected vertexes may lead to issues with routing and navigation.”
- **Multivertex stairs / landings are manual.** “To create multivertex floor transitions, such as a stairway with a landing, features can be manually updated after generation. This is not required for generating routable directions.” After vertex edits, recalculate `LENGTH_3D` (`=!shape.length3d!`).
- Update: re-run on a subset of Levels deletes matching `FACILITY_ID`/`LEVEL_ID` pathways and regenerates. Transitions that spatially intersect transition units are deleted and re-created. Geometry edits require Build Network.

### 1.6 Esri residual work Kiriko MUST NOT invent

These are still **manual in Esri 3.7**. Copying Esri does not mean automating them.

| Residual | Source quote | Kiriko implication |
| --- | --- | --- |
| Campus sidewalks / inter-facility links | “The Indoors tools do not connect facilities in the network.” Outdoor pathways “must [be] create[d] … using ArcGIS Pro feature editing tools.” ([Create](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm)) | Leave outdoor campus links as producer residual. Do not auto-weave sidewalks between buildings. |
| Stair landings / angled flights | “manually updated after generation. This is not required for generating routable directions.” | Do not synthesise walking-line stair geometry. Connection-style vertical cost already covers choice; 3D stair polylines are editor work. |
| Landmarks | Manual Append / digitise; 4 m callout radius | Directions polish, not graph quality. |
| Pathway rank selection | Operator must select Units before Classify | Kiriko already bakes hallway ×3. Do not add a second Classify UI unless a producer asks. |
| Travel modes beyond walking + wheelchair | Template ships two; “You can create more travel modes” ([Create](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm), [Create a travel mode](https://pro.arcgis.com/en/pro-app/latest/help/analysis/networks/create-travel-mode.htm)) | Extra modes (bike, emergency) are producer / query profiles, not synth. |
| Generate Facility Entryways collapse | Adjacent doorways may collapse to a single point; per-door routing requires manual duplication ([prior Esri read; tool page not re-fetched this pass — treat adjacent-door collapse as [UNVERIFIED] against the live 3.7 entryways page]) | Do not invent a second doorway generator. |
| One-way / hours | `TRAVEL_DIRECTION` field exists; automatic population is not documented | Populate from IMDF Relationship / imported GDB at **import or query**, not by inventing direction from geometry. |

### 1.7 Implications for Kiriko / what NOT to do

- **NOT:** replace medial axis with Lattice or UCN. Esri’s commercially winning idea is *thin-to-routable-locations + classify + query travel modes*, not the fishnet itself.
- **NOT:** auto-connect campus sidewalks or auto-draw stair landings. Esri leaves both manual.
- **DO (query):** decode §12 attrs and imported `TRAVEL_DIRECTION` / wheelchair restrictions. Esri’s wheelchair mode is a travel-mode restriction, not a second graph.
- **DO (build, cheap):** keep writing `DELAY`-like wait onto elevator Connections (already shipped as entryCost). Keep `LENGTH_3D`-style 3D length as the horizontal cost.
- **DO (QA):** reuse Esri’s post-run checklist as a decoder for KVB §11: pathways into every room, not cut by doors, verticals vertex-to-vertex.

---

## 2. Mappedin JS v6

Primary pages (read 2026-08-17):

- [`TGetDirectionsOptions`](https://docs.mappedin.com/web/v6/latest/types/TGetDirectionsOptions.html) (Mappedin JS **v6.24.0**)
- [`TDirectionZone`](https://docs.mappedin.com/web/v6/latest/types/TDirectionZone.html)
- [Wayfinding guide](https://developer.mappedin.com/web-sdk/wayfinding)
- [MVF `Connection`](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.connections.Connection.html)
- [MVF `NodeProperties`](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.nodes.NodeProperties.html)
- [MVF Navigation Flags](https://docs.mappedin.com/mvf/v3/latest/modules/_mappedin_mvf-navigation-flags.html)
- [Editor](https://www.mappedin.com/editor/), [Features](https://www.mappedin.com/features/)

### 2.1 Generation internals: unpublished

Mappedin does **not** publish lattice vs medial-axis vs visibility vs UCN. Maker AI detects doors/windows/walls ([Features](https://www.mappedin.com/features/)). That is geometry extraction, not a published routing-network generator.

### 2.2 `TGetDirectionsOptions` — query-time surface

From the [v6.24.0 type page](https://docs.mappedin.com/web/v6/latest/types/TGetDirectionsOptions.html):

| Option | Owning claim | Build vs query |
| --- | --- | --- |
| `accessible?: boolean` | “If true directions will only take accessible routes.” Default `false`. | **Query.** Filter / restrict. |
| `zones?: TDirectionZone[]` | Extra cost 0…Infinity over a Polygon/MultiPolygon; optional `floor`. “A additional cost of Infinity will make the zone impossible to navigate through.” Stacking adds. ([TDirectionZone](https://docs.mappedin.com/web/v6/latest/types/TDirectionZone.html)) | **Query.** Dynamic overlay. Do not bake spill/closure into synth. |
| `smoothing` | Boolean or `{ enabled, radius, __EXPERIMENTAL_METHOD }`. Default **true for non-enterprise / Maker, false for enterprise / CMS**. “When enabled, the path is simplified using line-of-sight checks to provide a more visually appealing route and shorter instructions.” | **Query.** Kiriko already ships greedy-LOS. |
| `connectionIdWeightMap` | “Override the default weights for specific connection ids.” | **Query.** |
| `excludedConnections` | Enterprise. “If there is no path that does not include these connections, the directions will be undefined.” | **Query.** |
| `includeNonPublic` | “When true, routing may traverse nodes that do not have the MVF `public` flag set.” Default `false`. No effect if MVF has no `public` flag. | **Query.** |

Smoothing methods, quoted:

- `'greedy-los'` (default): “Greedy forward scan with line-of-sight validation. Fastest, O(n) time complexity. Good default choice.”
- `'rdp'`: “Ramer-Douglas-Peucker preprocessing + line-of-sight validation + door buffer nodes. Better for paths with doors and complex geometry.”
- `'dp-optimal'`: “Dynamic Programming for globally optimal simplification. Slowest but highest quality, O(n²). Best when path quality is critical.” Optional `__EXPERIMENTAL_INCLUDE_DOOR_BUFFER_NODES`.

[Wayfinding guide](https://developer.mappedin.com/web-sdk/wayfinding): “Directions for some maps may appear jagged or not smooth. This is due to the SDK attempting to find the shortest path through the map's geometry.” Arrays of targets pick the closest pair. “A Space requires an entrance to be used as a target.”

**Implication:** Mappedin’s visible quality advantage after a stored graph exists is **query-time LOS + door-buffer nodes + accessible/zones/flags**, not a better skeleton. Kiriko already has greedy-LOS. Next Mappedin-shaped work is **using** `accessible` / zones / flags / Connection weights at A*, and optionally RDP or dp-optimal with mandatory doorway vertices. **NOT** more build-time chords.

### 2.3 `Connection` — already shipped in spirit; query still ignores the split

Quoted from [Connection](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.connections.Connection.html):

> “They are different from Nodes, which generally represent a connected graph of walkable spaces on the same floor, who's cost includes the distance between the nodes. With a connection, the cost to traverse it is a combination of the static entry cost plus another cost per floor transitioned.”

- `type`: `unknown | elevator | escalator | travelator | stairs | door | ramp | ladder`
- `entryCost` ≥ 0: “Equivalent to the number of meters a person should walk out of their way to avoid entering the connection.” Elevator example **10–20 m** wait; stairs/escalators may be **0**. “The straight line distance between entrance and exit is NOT used.” Same-floor connection cost is **only** `entryCost`.
- `floorCostMultiplier` ≥ 1: multiplied by `|Δfloors|` and added to `entryCost`. Example: elevator multiplier **1**, stairs **10** — “it's worth walking 10 meters further to get to an elevator instead of stairs for every floor change.”
- “You cannot naively use A* with Connections, because the straight line distance heuristic will not be admissible.”
- Same-floor multi-entrance Connections “will probably not be [costed] correct[ly].”

Kiriko already ships Connection-style vertical costs. **Query still uses only `weight`.** The remaining Mappedin gap is: (a) expose `entryCost` / multiplier as first-class at A* so a Euclidean heuristic stays admissible (or switch heuristic); (b) do not add horizontal stacked-elevator displacement into cost (already their rule).

### 2.4 `NodeProperties`

From [NodeProperties](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.nodes.NodeProperties.html):

- `id`: `n_…`
- `neighbors[]`: `{ id, extraCost, flags[] }`. `extraCost` is “the extra cost to traverse to the node, above the straight-line distance.”
- `geometryIds[]`: if non-empty, “this node [is] (one of the) destination nodes for that geometry.”

Neighbor cost = straight-line metres + `extraCost`. Flags live on neighbors and on Connection anchors.

### 2.5 Navigation flags

From [MVF Navigation Flags](https://docs.mappedin.com/mvf/v3/latest/modules/_mappedin_mvf-navigation-flags.html):

Well-known keys: `accessible`, `outdoors`, `public`.

- `accessible`: “designed to be accessible to people using mobility aids such as wheelchairs. This includes appropriate width for doorways, paths taking ramps instead of stairs, and elevators instead of escalators.”
- `public`: “By default, consumers of MVF should not route through non-public things when the public flag is present.”
- `outdoors`: component “is or goes outside.”

“When a consumer of MVF data wants to find a path with specific flags, they can check that each component along the path has the required flags set or not, and use it to change the weight or block that part of the path entirely.”

This is **query-time filtering**, not a second generated graph.

### 2.6 Maker residual

Maker is a producer editor (draw, AI-detect, LiDAR, collaborate, georeference). No published “auto-fix the wayfinding graph” algorithm. Residual work stays in the editor: doors, public/accessible flags, Connection costs. Kiriko’s analogue is the network review overlay — do not invent an AI wall detector as a routing-quality project.

### 2.7 Implications / what NOT to do

- **NOT:** treat Maker AI as a graph generator.
- **NOT:** add RDP / dp-optimal at synth. Those are query smoothers. Greedy-LOS already shipped.
- **NOT:** bake `zones` (spill, closure) into the stored graph.
- **DO (query):** `accessible`, `includeNonPublic`, `excludedConnections`, `connectionIdWeightMap`, zone overlays; decode §12 `kind`/`rank`/`vertical`/`clearance_m`.
- **DO (query):** fix A* heuristic if Connection entry costs make Euclidean inadmissible (Mappedin states this explicitly).
- **DO (build):** keep writing flags / extraCost / entryCost onto edges so query can filter. IMDF accessibility is the source Kiriko currently ignores.

---

## 3. Apple IMDF 1.0

Primary pages:

- [Overview](https://register.apple.com/resources/imdf/) (v1.0.0, last update 2021-10-19)
- [Opening](https://register.apple.com/resources/imdf/types/opening)
- [Unit](https://register.apple.com/resources/imdf/types/unit)
- [Relationship](https://register.apple.com/resources/imdf/types/relationship)
- [Categories](https://register.apple.com/resources/imdf/reference/categories)

### 3.1 Opening

Quoted / required rules from [Opening](https://register.apple.com/resources/imdf/types/opening):

- Geometry **MUST** be a LineString. “An Opening's length **MUST** approximate the actual width of the entrance.”
- Properties: `category`, `accessibility[]`, `access_control[]`, `door` `{automatic, material, type}`, `name`, `level_id`.
- Example accessibility values: `"wheelchair"`, `"tactilepaving"`. Example access_control: `"badgereader"`.
- “A single Opening feature is analogous to a single physical entrance.” “The same Opening **MUST NOT** model entrances to spaces modeled as different Units.”
- Elevator / escalator / stairs Units **MUST** have at least one Opening when they model vertical traversal to a different Level. Steps **MUST** have at least one, **SHOULD** have two (bottom and top riser). Moving walkway on one floor **MUST** have an Opening on each end.

Accessibility categories from [Categories](https://register.apple.com/resources/imdf/reference/categories): `assisted.listening`, `braille`, `hearing`, `hearingloop`, `signlanginterpreter`, `tactilepaving`, `tdd`, `trs`, `volume`, `wheelchair`.

Access-control categories: `badgereader`, `fingerprintreader`, `guard`, `keyaccess`, `outofservice`, `passwordaccess`, `retinascanner`, `voicerecognition`.

Door types: `door`, `movablepartition`, `open`, `revolving`, `shutter`, `sliding`, `swinging`, `turnstile`, `turnstile.fullheight`, `turnstile.waistheight`, `unspecified`.

**Kiriko today:** openings are the doorway signal; `accessibility`, `access_control`, `door`, and width-as-physical-width are unused. Opening length is the official clearance / wheelchair-width signal. That is **build-time attribute** (write `clearance_m` / accessible flag from LineString length + `accessibility[]`) and **query-time filter** (wheelchair profile drops edges whose opening is non-wheelchair or too narrow).

### 3.2 Unit

From [Unit](https://register.apple.com/resources/imdf/types/unit):

- `accessibility[]` “Indicates the type of accessibility provided by the Unit to a pedestrian that experiences disabilities.”
- `restriction` for employees-only / restricted subsets of the public. `"nonpublic"` Units **SHOULD NOT** possess a restriction; Openings **SHOULD NOT** lie within a `nonpublic` boundary.
- Symmetrical difference **MUST NOT** exist among Units on the same Level; union of Units **MUST** equal the Level. “An Opening **MUST** be covered by a Unit boundary where the modeled entrance exists.”
- Elevator footprints **MUST** equal across levels, or overlap < 10%. Escalators on adjacent ordinals **SHOULD** touch and align.

Unused by Kiriko: Unit `accessibility`, `restriction`. These are query-profile inputs (staff / public / wheelchair), not a reason to regenerate the spine.

### 3.3 Relationship

From [Relationship](https://register.apple.com/resources/imdf/types/relationship):

- Models origin → (intermediary) → destination. `direction` is `"directed"` or `"undirected"`. `hours` constrains temporal applicability.
- “Restrictions, access control and temporal constraints associated with a declared intermediary **MUST** be considered applicable to a traversal path.”
- Unidirectional door: `category: traversal`, directed, Opening as intermediary, Units as origin/destination.
- Ramp / escalator: Openings as origin/destination, ramp/escalator Units as intermediaries; `hours` captures reversible escalators (separate Relationship per time window).
- Elevator: undirected, elevator Units as intermediaries, floor Units as origin/destination. “It is not necessary to describe each destination’s Relationship with other Elevator Units. These Relationships can be systematically derived.”
- Curated path **MAY** carry LINEAL geometry, with the warning:

> “Curated paths defined in this manner are NOT intended for use in defining a comprehensive routing network within a venue and MUST NOT be assumed to be used by default, or even at all, by existing routing systems. Any curated paths provided in a venue delivery MUST be viewed as ‘hints’ or supplementary information that MAY be used when and where appropriate.”

IndoorGML 2.0 preface repeats: IMDF “provides a comprehensive model to compute path(s) between features located on a map, but the derived network is application specific” ([OGC 22-045r5](https://docs.ogc.org/is/22-045r5/22-045r5.html)).

### 3.4 Implications / what NOT to do

- **NOT:** treat Relationship LINEAL curated paths as the network.
- **NOT:** infer one-way from shared Unit boundaries. Direction lives on Relationship.
- **DO (build):** copy Opening `accessibility` / `access_control` / LineString width onto edge attrs; copy Relationship `direction` / `hours` onto the doorway or vertical edge.
- **DO (query):** wheelchair profile reads Opening/Unit accessibility; hours filter at request time (do not bake “now” into synth); directed edges honour Relationship.
- This is the unused IMDF surface the 2026-08-13 pass left on the table.

---

## 4. OGC IndoorGML 1.1 / 2.0

Primary pages:

- [IndoorGML 1.1 (19-011r4)](https://docs.ogc.org/is/19-011r4/19-011r4.html) — published 2020-11-05
- [IndoorGML 2.0 Part 1 (22-045r5)](https://docs.ogc.org/is/22-045r5/22-045r5.html) — published 2025-06-26

### 4.1 IndoorGML 1.1 — primal / dual, cell vs navigable

From [19-011r4](https://docs.ogc.org/is/19-011r4/19-011r4.html) §1 Scope and §4 / §7:

- IndoorGML “aims to establish a common schema for indoor navigation applications. It models topology and semantics of indoor spaces… IndoorGML contains only a minimum set of geometric and semantic modelling of construction components to avoid duplicated efforts with other standards, such as CityGML and IFC.”
- Defines: navigation context and constraints; space subdivisions and types of connectivity; geometric and semantic properties; **navigation networks (logical and metric) and their relationships.**
- **NR (Node-Relation) Graph:** nodes = cells; edges = topological relationship (connectivity or adjacency).
- Separate **Accessibility NRG**, **Adjacency NRG**, **Connectivity NRG**.
- **Logical NRG:** no geometric properties. **Geometric NRG:** nodes and edges have geometry.
- **Multi-Layered Space Model:** multiple layers of connectivity graphs plus inter-layer connections (topographic / sensor / security overlays).
- Cellular space: every cell has an identifier; cells may share a boundary but **do not overlap**; position can be specified by cell id.
- Poincaré duality is the construction of the dual graph: 3D cells → 0D nodes; shared 2D surfaces → 1D edges. **[INFERENCE from standard’s well-known duality section; the HTML extract of §7.1.2 duality paragraphs was truncated in this pass — treat detailed Poincaré wording as confirmed in the 2026-08-13 dump which quoted 19-011r4 directly.]** Confirmed in this pass: NRG definitions above and “IndoorGML is a complementary standard to CityGML, KML, and IFC.”

Navigable vs non-navigable classification is described in the 1.1 extensions / 2.0 terms. IndoorGML 2.0 §4 defines:

- **Indoor Space:** “A space within one or multiple buildings.”
- **Cellular Space:** cells grouped by theme *T*.
- **Adjacency Graph** vs **Connectivity Graph**.
- **Logical Network** vs **Geometric Network**.
- **Multi-Layered Space Model.**

### 4.2 IndoorGML 2.0 on IMDF

Quoted from [22-045r5 Preface](https://docs.ogc.org/is/22-045r5/22-045r5.html):

> “The OGC IMDF Community Standard provides a comprehensive model to compute path(s) between features located on a map, but the derived network is application specific.”

IndoorGML 2.0 “aims to provide a unified, standardized and flexible approach for indoor spatial information required for space-graph based applications such as indoor navigation.” Core = topological connectivity + contexts; Navigation module extends the core.

### 4.3 Implications / what NOT to do

- IndoorGML’s dual (room = node, door = edge) is a **logical** connectivity graph. Kiriko’s unused centroid-hub `synth.rs` is closer to IndoorGML than `synth_medial`. **Do not replace the medial-axis metric spine with a dual/portal graph.** Use IndoorGML thinking for *which* spaces connect (accessibility / adjacency overlays), not for *where people walk*.
- Separate adjacency vs connectivity vs accessibility graphs ⇒ Kiriko should keep one metric graph and attach accessibility as **flags**, not clone the graph.
- Multi-layered space model ⇒ security / public / wheelchair are layers over the same cells, decoded at query time.

---

## 5. van Toll, Cook, van Kreveld, Geraerts 2017 — Explicit Corridor Map

Paper: [arXiv:1701.05141](https://arxiv.org/abs/1701.05141) (v2 2017-07-26). PDF/HTML read directly.

### 5.1 Owning claims

- “The Explicit Corridor Map (ECM) is a navigation mesh based on the medial axis. It enables path planning for disk-shaped characters of any radius.”
- Multi-layer medial axis of a walkable environment (WE) / multi-layered environment (MLE), distances **projected onto the ground plane**. Size **O(n)**; construct in **O(n log n log k)** for *n* boundary vertices and *k* connections.
- “The medial axis can be annotated with nearest-obstacle information to obtain the ECM navigation mesh.”
- “Our implementations show that the ECM can be computed efficiently … and that it can be used to compute paths within milliseconds.”
- “Path planning for disks can be solved by inflating the obstacles … This approach requires a separate inflation process for each distinct radius.” ECM avoids that by storing clearance.
- “A consequence of splitting a walkable environment into layers … is that height differences along the surface are ignored. … path lengths are effectively projected onto the ground plane.”
- “Purely graph-based techniques are not ideal for crowd simulation: characters would need to follow the edges of the graph exactly … or they would have to perform expensive geometric tests to check how they can deviate from an edge.”
- ECM Definition 5: undirected graph of true medial-axis vertices; each edge is a sequence of bending points; each bending point stores nearest obstacle points left and right. “One advantage is that the clearance (the distance to the nearest obstacle) is known at each bending point. This enables path planning for characters of any radius; that is, we do not have to inflate the obstacles using Minkowski sums for a particular radius.”
- Indicative route on the mesh is then “traversed smoothly in real-time” (crowd-sim framing, §2.5).

### 5.2 Query-time funnel vs stored axis

The paper’s split:

| When | What |
| --- | --- |
| **Build** | Medial axis + nearest-obstacle annotations (clearance at every bending point). Multi-layer connections opened incrementally. |
| **Query** | Plan a path for a *specific* disk radius using stored clearance (no per-radius rebuild). Indicative route along / near the axis; local deviation / smooth following is a later stage. |

They explicitly contrast this with “inflate then shortest-path,” which is per-radius build-time.

**[INFERENCE]** The ECM “funnel / corridor” follow is query-time path *extraction from the annotated axis*, not a second stored lattice. This matches Kallmann’s r-funnel (below) and Mappedin’s LOS smoother. Kiriko already stores `clearance_m` and already runs greedy-LOS. The ECM lesson that is still unused: **query must read `clearance_m`** (wheelchair width / any-radius), instead of baking one radius into the spine.

### 5.3 Implications / what NOT to do

- **NOT:** rebuild the medial axis per wheelchair radius. Store clearance (already in §12); filter at A*.
- **NOT:** treat projected-length ignorance of stair slope as a bug to “fix” by regenerating Tokyo or replacing the spine. van Toll call this an accepted simplification.
- **NOT:** force agents to walk the stored axis exactly — that is the failure mode they name. Greedy-LOS is the already-shipped correction.
- **DO (query):** any-radius / wheelchair = `clearance_m >= r` (plus IMDF accessibility flags).
- **DO (build):** keep annotating nearest-obstacle clearance. Already shipped.

---

## 6. Kallmann 2010 — Local Clearance Triangulation / r-funnel

Paper: Marcelo Kallmann, “Shortest Paths with Arbitrary Clearance from Navigation Meshes,” SCA 2010. Author manuscript read from [http://graphics.ucmerced.edu/papers/10-sca-tripath.pdf](http://graphics.ucmerced.edu/papers/10-sca-tripath.pdf).

### 6.1 Owning claims

- “Key to the proposed method is a new type of triangulated navigation mesh, called a Local Clearance Triangulation, which enables the efficient and correct determination if a disc of arbitrary size can pass through any narrow passages of the mesh.”
- “first computing high-quality locally shortest paths efficiently in optimal time. Only in case global optimality is needed, an extended search will gradually improve the current path.”
- “The presented method represents the first solution correctly extracting shortest paths of arbitrary clearance directly from a triangulated environment.”
- LCT = CDT refined until every triangle traversal has *local clearance* (no “disturbances”). Refinement keeps vertex count O(n).
- Two clearance values stored **per edge** (of four possible distinct traversal clearances). “This reduces the local clearance test to a simple value comparison per traversal.”
- **Channel search** (A* over triangle adjacencies, accept traversal iff `2r < cl(a,b,c)`) finds a channel *Cr* in O(n log n). Then **r-funnel** extracts the locally shortest path of clearance *r* inside that already-triangulated channel **in linear time**.
- r-funnel: “whenever path p_r has to make a turn inside the channel it will follow a circle of radius *r* centered at one vertex of the channel. Therefore the final obtained path will be a sequence of straight segments and circle arcs.” Extends the classical funnel ([Hershberger & Snoeyink 1994](http://graphics.ucmerced.edu/papers/10-sca-tripath.pdf) citation HS94).
- Global optimum is a later, slower overlapping-front search. Table 1: local paths in ~3 ms on 63k segments; global is much slower and only slightly shorter. “These results demonstrate that locally optimal paths are perfectly suitable for character navigation.”

### 6.2 Build vs query

| Build (LCT) | Query |
| --- | --- |
| Refine CDT; store 2 clearance values per edge | Channel search filtered by `2r < cl` |
| Independent of any one radius | r-funnel string-pulls the channel for that *r* |

### 6.3 Implications / what NOT to do

- Kiriko already has a CDT medial axis + `clearance_m` + greedy-LOS. Kallmann’s remaining gift is **query-time clearance filtering + optional r-funnel** (clearance-aware string-pull), not a new triangulation.
- **NOT:** switch the spine from medial axis to LCT. Different mesh, same *idea* (store clearance, decide radius at query).
- **NOT:** run the global-optimum extended search as default. Kallmann’s own table says local is enough for characters.
- **DO (query):** honour `clearance_m` in A*; if LOS still hugs corners for wide agents, r-funnel on the walkable polygon is the next smoother — still query-time.
- Door-buffer / opening vertices stay mandatory (Mappedin RDP flag; Kallmann departure/arrival tests).

---

## 7. Lee, Eastman, Lee, Kannala, Jeong 2010 — Universal Circulation Network

Primary: Sage abstract of [Lee et al., *Environment and Planning B* 37(4) 628–645, doi:10.1068/b35124](https://journals.sagepub.com/doi/abs/10.1068/b35124). Full PDF is paywalled; Esri cites this paper as the UCN algorithm behind Generate Indoor Network Features.

Quoted abstract:

> “In this paper we define a computational method for measuring walking distances within buildings based on a length-weighted graph structure for a given building model. We name it the universal circulation network (UCN) and it has been implemented as plug-in software in Solibri Model Checker using building information modeling technologies. … The UCN is determined mainly by the spatial topology and geometry of a given building, and it returns consistent and accurate scalar quantities. It takes into consideration people-movement patterns, reflecting that people tend to walk along the shortest, easiest, and most visible paths.”

Esri’s behavioural restatement ([Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm)): “Generates pathways based on shortest paths between routable locations, more closely resembling the walking path that a person might take in a space.”

### Implications / what NOT to do

- UCN is **shortest paths between a destination set**, not a space-covering skeleton. That is Esri’s “thin-to-routable-locations” idea.
- **NOT:** replace Kiriko’s medial axis with UCN. The medial axis already covers space for arbitrary snaps; UCN needs a closed destination set and will drop dead-end corridors a reviewer still wants.
- **DO:** if a quality metric is needed, UCN’s “consistent scalar walking distance” is closer to **stretch / detour** (network / Euclidean) than to a new generator.
- Full geometric construction beyond the abstract is **[UNVERIFIED]** (paywall). Esri does not republish it.

---

## 8. IndoorAtlas — first-party graph docs

First-party pages read:

- [Creating the Wayfinding Graph](https://support.indooratlas.com/support/solutions/articles/36000051250-creating-the-wayfinding-graph) (modified 2025-02-27)
- [Accessible (Wheelchair compatible) Wayfinding Routes](https://support.indooratlas.com/support/solutions/articles/36000551564-accessible-wheelchair-compatible-wayfinding-routes) (modified 2025-02-27)
- [Using Wayfinding with Cordova and React Native](https://support.indooratlas.com/support/solutions/articles/36000558617-using-wayfinding-with-cordova-and-react-native) (modified 2025-03-19)

### Owning claims

- Graph is **manually created** in the IndoorAtlas web editor. No published auto-generator.
- Edges between floors can be **directed** (`+directed`); direction = which node was clicked first.
- SDK 3.7+: edges tagged **inaccessible** (“not suitable for e.g. wheelchairs”) or **accessible-only** (“intended only for e.g. wheelchairs, such as special elevators”).
- Built-in request tags:
  - `EXCLUDE_INACCESSIBLE` == use accessible / wheelchair-compatible routes
  - `EXCLUDE_ACCESSIBLE_ONLY` == avoid accessible-only edges (special elevators)
- `IAWayfindingRequest` applies tag filtering. For single-shot `requestWayfindingRoute`, “the tags are **only** used from the **destination parameter**.”
- Prerequisite: tags must be defined on the graph in the web app before request-time filtering works.

### Implications / what NOT to do

- IndoorAtlas is **(b) authored graph + (c) query-time tag filter**. Same split as Mappedin flags / Esri travel modes.
- **DO (query):** two profiles, not one graph: default (exclude accessible-only special lifts) vs wheelchair (exclude inaccessible stairs). Kiriko currently has neither.
- **DO (build):** write inaccessible / accessible-only from IMDF Opening/Unit accessibility + stairs vs elevator `kind`. Do not invent a third tag vocabulary.
- **NOT:** auto-generate an IndoorAtlas-style editor graph.

---

## 9. MazeMap / Google Indoor — absence of first-party algorithm docs

Searches this pass:

- `site:mazemap.com OR site:docs.mazemap.com indoor routing graph algorithm pedestrian` → **no results** on those hosts; provider relaxed to generic pedestrian-graph papers and patents. No MazeMap first-party algorithm page was retrieved.
- `site:developers.google.com OR site:support.google.com indoor maps routing algorithm pedestrian graph` → **no results** on those hosts. No Google Indoor Maps first-party path-generation or graph-construction document was retrieved.

**Conclusion:** MazeMap and Google Indoor have **no cited first-party algorithm docs** in this research pass. Do not infer their skeleton (lattice / medial / visibility) from secondary blogs or patents that are not Google/MazeMap-authored algorithm manuals.

USPTO patents that mention indoor skeletons (e.g. straight-skeleton link-node graphs) are **not** MazeMap or Google first-party docs and are not used as product evidence here.

---

## 10. Stretch / detour index — quality metric, not a generator

Primary sources read:

- Aldous & Shun, “Connected Spatial Networks over Random Points and a Route-Length Statistic,” *Statistical Science* 25(3) 275–288, 2010. [arXiv:1003.3700](https://arxiv.org/abs/1003.3700)
- Barthelemy, “Spatial Networks,” *Physics Reports* review, [arXiv:1010.0302](https://ar5iv.labs.arxiv.org/html/1010.0302) / Berkeley course copy [barthelemy_survey.pdf](https://www.stat.berkeley.edu/~aldous/206-SNET/Papers/barthelemy_survey.pdf)

### Aldous & Shun owning claims

- `r(i,j) = ℓ(i,j)/d(i,j) − 1` where `ℓ` is network route length and `d` is Euclidean.
- `R_max := max r(i,j)` is *stretch* (spanner literature). They reject it as a sole real-world descriptor (“unreasonable to characterize the UK rail network as inefficient simply because there is no very direct route between Oxford and Cambridge”).
- `R_ave := average r(i,j)` is biased toward far pairs; a Steiner tree plus sparse random long lines can drive `R_ave → 0` while nearby pairs have terrible routes.
- Their preferred `R := max_d ρ(d)` where `ρ(d)` is mean `r` over pairs at Euclidean distance `d`. “`R = 0.2` means that on every scale of distance, route lengths are on average at most 20% longer than straight line distance.”
- Characteristic shape: `ρ(d)` small for `d < 1` (normalized units), **maximum between 2 and 3**, then slowly decreasing. “It is city pairs at normalized distance 2 − 3 specifically that enforce the constraints on efficient network design.”
- MST on random points: `R = ∞`. Relative neighborhood: `R ≈ 0.38`. Gabriel: `R ≈ 0.15`. Delaunay: `R ≈ 0.07` (their Table 1, n = 2500 Monte Carlo).

### Barthelemy owning claims

- Spatial networks mix topology and metric; “there is a cost associated to the length of edges.”
- Planar graphs are sparse (`E ≤ 3N − 6`).
- Betweenness on a lattice peaks at the barycenter; shortcuts create “anomalies.”
- Distance-strength `s_i^d = Σ d_E(i,j)` over neighbors; if `s^d(k) ∝ k^{β}` with `β > 1`, typical connection length grows with degree.
- Review is outdoor / infrastructure / mobility. Indoor application is **[INFERENCE]**.

### Implications / what NOT to do

- Stretch / detour is a **QA metric** for KVB §11 (currently no decoder), not a reason to regenerate graphs.
- Prefer Aldous `R = max_d ρ(d)` or a binned `network / Euclidean` over raw `R_ave` or `R_max`.
- Indoor analogue: same-floor pairs only (vertical Connections break Euclidean). Normalise by typical corridor width or use metres and bin 10–40 m (open-hall / concourse scale), not Aldous’s unit-density “2–3.”
- **NOT:** add long-range chords just to drive `R_ave` down (their Figure 5 failure mode). Kiriko already learned this with gated open-space chords.
- **DO:** decode §11 with: (1) Esri checklist (rooms reached, not cut by doors, verticals snapped); (2) stretch `ρ(d)` on same-floor OD samples; (3) unused IMDF accessibility coverage.

---

## 11. Query-time vs build-time split

What still improves quality **after** medial-axis + greedy-LOS + the 2026-08-13 pass.

### 11.1 Belongs at A* / query (`kiriko-route`)

| Improvement | Why query | Primary warrant |
| --- | --- | --- |
| Honour §12 `kind` / `rank` / `clearance_m` / `vertical` | Already stored; query ignores them | Esri travel modes; Mappedin flags; ECM any-radius; Kallmann `2r < cl` |
| Wheelchair / accessible profile | Filter inaccessible stairs; prefer ramps/elevators; drop narrow openings | Esri wheelchair mode; Mappedin `accessible`; IndoorAtlas `EXCLUDE_INACCESSIBLE`; IMDF Opening `accessibility` + width MUST |
| Default profile excludes accessible-only special lifts | IndoorAtlas built-in opposite tag | [IndoorAtlas accessible routes](https://support.indooratlas.com/support/solutions/articles/36000551564-accessible-wheelchair-compatible-wayfinding-routes) |
| One-way / `TRAVEL_DIRECTION` | Imported GDB + IMDF Relationship `directed` | Esri field; IMDF Relationship; IndoorAtlas directed edges |
| Hours / reversible escalators | Temporal; do not bake “now” into synth | IMDF Relationship `hours` |
| Zones / closures / spill | Dynamic overlay cost 0…∞ | Mappedin `TDirectionZone` |
| `includeNonPublic` / staff profile | Flag filter | Mappedin `public`; IMDF Unit `restriction` / `nonpublic` |
| Connection weight overrides / excluded connections | Per-request | Mappedin `connectionIdWeightMap`, `excludedConnections` |
| A* heuristic fix when `entryCost` exists | Euclidean may be inadmissible | Mappedin Connection page, explicit |
| Smoothing beyond shipped greedy-LOS | RDP / dp-optimal / r-funnel; door-buffer nodes mandatory | Mappedin smoothing; Kallmann r-funnel |
| Stretch / detour QA | Evaluation, not routing | Aldous & Shun; Esri checklist |

### 11.2 Belongs at synth / import (`synth_medial` / GDB import)

| Improvement | Why build | Primary warrant |
| --- | --- | --- |
| Write Opening width → `clearance_m`; `accessibility[]` / `access_control[]` → flags | Query cannot filter what was dropped | IMDF Opening MUST approximate physical width |
| Write Relationship `direction` / `hours` onto doorway & vertical edges | Currently dropped | IMDF Relationship |
| Restore imported GDB `direction` / `BARRIER` / `GATE` / hours / `passage_type` | Tokyo quality ceiling lives here; do not regenerate Tokyo | Prior Kiriko comparison; Esri `TRAVEL_DIRECTION` |
| Keep annotating `clearance_m` on medial edges | ECM / LCT any-radius | van Toll; Kallmann |
| Keep Connection-style vertical costs | Already shipped | Mappedin `entryCost` + `floorCostMultiplier` |
| Keep hallway rank baked (×3) | Already shipped Classify analogue | Esri Classify |
| Keep obstacle subtraction | Already shipped | Esri Details + buffer |
| KVB §11 decoder | QA harness, not a new generator | Esri post-run checklist + stretch |

### 11.3 Explicitly do NOT do

1. **Do not replace the medial-axis spine with an Esri lattice** (or UCN, or IndoorGML dual, or visibility graph). Constraint + Esri’s own default is orthogonal to Kiriko’s already-chosen ECM-class spine.
2. **Do not regenerate Tokyo imported graphs.** Quality work there is import + query of already-authored costs.
3. **Do not invent campus sidewalks or stair-landing geometry.** Still manual in Esri 3.7.
4. **Do not treat Mappedin AI / LiDAR / ML-from-image as a graph generator.**
5. **Do not add more build-time open-space chords** to paper over smoothness. Greedy-LOS already shipped; next smoother is query-time r-funnel / RDP with door nodes.
6. **Do not bake zones, hours, or “now” into weight.** Those are request-time.
7. **Do not clone the graph per profile.** IndoorGML / Mappedin / IndoorAtlas / Esri all use one graph + flags / travel modes.
8. **Do not naively A\* with a Euclidean heuristic once Connection `entryCost` is live** (already shipped costs; heuristic still planar haversine). Mappedin: heuristic “will not be admissible.”
9. **Do not use IMDF curated Relationship LINEAL as the comprehensive network.**
10. **Do not invent MazeMap / Google Indoor internals.** No first-party algorithm docs found.

---

## 12. Highest-leverage leftovers (for the parent’s ranking)

Ordered by primary-source density × unused-by-Kiriko, given the 2026-08-13 pass already shipped:

1. **Query decodes §12 + IMDF accessibility + imported direction/hours** (Esri travel modes, Mappedin flags, IndoorAtlas tags, IMDF Opening/Relationship). This is the unused surface. One graph, several profiles.
2. **A* heuristic / Connection admissibility** (Mappedin, explicit). Vertical choice will stay wrong while query only sees `weight` and a planar heuristic.
3. **KVB §11 decoder** using Esri’s post-run checklist + Aldous-style `ρ(d)` on same-floor pairs. No new geometry.
4. **Optional query r-funnel / RDP** with mandatory doorway vertices if greedy-LOS still looks wrong for wide agents (Kallmann, Mappedin). Still not a new generator.
5. **Producer residual stays residual:** outdoor campus links, stair landings, landmarks, extra travel modes, Maker-style flag editing.

---

## 13. Source list (URLs actually read)

- https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm
- https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-indoor-network-features.htm
- https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/classify-indoor-pathways.htm
- https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/update-the-indoors-network.htm
- https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm
- https://pro.arcgis.com/en/pro-app/latest/help/analysis/networks/create-travel-mode.htm
- https://docs.mappedin.com/web/v6/latest/types/TGetDirectionsOptions.html
- https://docs.mappedin.com/web/v6/latest/types/TDirectionZone.html
- https://developer.mappedin.com/web-sdk/wayfinding
- https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.connections.Connection.html
- https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.nodes.NodeProperties.html
- https://docs.mappedin.com/mvf/v3/latest/modules/_mappedin_mvf-navigation-flags.html
- https://www.mappedin.com/editor/
- https://www.mappedin.com/features/
- https://register.apple.com/resources/imdf/
- https://register.apple.com/resources/imdf/types/opening
- https://register.apple.com/resources/imdf/types/unit
- https://register.apple.com/resources/imdf/types/relationship
- https://register.apple.com/resources/imdf/reference/categories
- https://docs.ogc.org/is/19-011r4/19-011r4.html
- https://docs.ogc.org/is/22-045r5/22-045r5.html
- https://arxiv.org/abs/1701.05141 and https://arxiv.org/pdf/1701.05141
- http://graphics.ucmerced.edu/papers/10-sca-tripath.pdf
- https://journals.sagepub.com/doi/abs/10.1068/b35124
- https://support.indooratlas.com/support/solutions/articles/36000051250-creating-the-wayfinding-graph
- https://support.indooratlas.com/support/solutions/articles/36000551564-accessible-wayfinding-routes-and-other-special-wayfinding-routes
- https://support.indooratlas.com/support/solutions/articles/36000558617-using-wayfinding-with-cordova-and-react-native
- https://arxiv.org/pdf/1003.3700
- https://www.stat.berkeley.edu/~aldous/206-SNET/Papers/barthelemy_survey.pdf
