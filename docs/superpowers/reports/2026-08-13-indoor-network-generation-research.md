# Indoor pedestrian routing-network generation — primary-source research

**Date:** 2026-08-13  
**Scope:** How professional indoor-navigation products *automatically generate* pedestrian routing networks from floor geometry (floorplan / BIM / IMDF), as distinct from (a) importing a pre-authored network and (b) query-time pathfinding on an existing graph. The later parent session will compare this material against Kiriko; this file does not.

**Method.** Official vendor documentation, official specifications, first-party product pages, and publisher-hosted academic papers were read directly. Searches started at Esri ArcGIS Indoors (`pro.arcgis.com` / `doc.esri.com`), then Mappedin (`developer.mappedin.com`, `docs.mappedin.com`), Apple IMDF (`register.apple.com/resources/imdf`), then other vendors with a published product surface (HERE Indoor Map, IndoorAtlas, MazeMap, Google Indoor Maps, Mapbox Indoor, MapsIndoors), then IndoorGML / ISO / academic generation methods (2018–2026 plus canonical pre-2018 algorithms still used by vendors).

**Excluded.** Secondary recaps (Medium, SEO blogs, ResearchGate-only PDFs when a publisher page existed). Invented pipeline steps. Vendor marketing that does not describe *how* a graph is built. Query-time A\* / Dijkstra documentation unless it also describes how the graph is authored. Comparison to Kiriko.

**Classification used throughout.** Every product claim is tagged as one of:

- **(a) Automatic generation** from floorplan / BIM / IMDF geometry.
- **(b) Import** of a pre-authored network (or vendor-authored map delivered as a finished product).
- **(c) Query-time pathfinding** on an existing graph.

Anything not verified against a primary source is marked **[UNVERIFIED]**. Interpretive remarks that go beyond a cited sentence are marked **[INFERENCE]**.

---

## 1. Esri ArcGIS Indoors

Esri is the only major indoor GIS vendor that publishes a complete, parameterised, automatic indoor-pathway pipeline. The current (ArcGIS Pro 3.6 / 3.7, docs last-modified 2026-06-22) pipeline is documented on the [Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm) help topic and the [Indoors Network toolset](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/an-overview-of-the-indoors-network-toolset.htm) overview.

### 1.1 Network dataset model

The [ArcGIS Indoors Information Model](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm) stores indoor GIS in three feature datasets. Floor-plan geometry lives in the **Indoors** dataset; the routable network lives in the **Network** dataset.

**Floor-plan layers used as generation input**

| Layer | Role in generation |
| --- | --- |
| [Facilities](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm) | Building footprints. Used by the deprecated Generate Floor Transitions tool as the facility filter; current Generate Indoor Network Features uses Levels. |
| [Levels](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm) | Per-floor footprints. Required input. `VERTICAL_ORDER` is a continuous 0-based integer (ground = 0). |
| [Units](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm) | Non-overlapping functional polygons (rooms, amenities, elevators, stairways). Unit centroids are default routable locations. `USE_TYPE` selects stairway / elevator / restricted spaces. |
| [Details](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm) | Linear assets (walls, doors, windows, columns). Used as obstacle / barrier polylines. “Details lines must be contained in a Levels feature.” |

**Network layers (output)**

| Layer | Role |
| --- | --- |
| [Pathways](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm) | Horizontal network polylines on a single level. |
| [Transitions](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm) | Vertical network polylines between levels. |
| [Landmarks](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm) | Optional callout points for turn-by-turn directions. Not generated automatically. |

**Pathways fields that affect routing** ([model page](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm)):

- `LENGTH_3D` — 3D length used as path cost.
- `PATHWAY_RANK` — 1 = Primary, 2 = Secondary, 3 = Tertiary.
- `PATHWAY_TYPE` — 1 Hallway/Sidewalk, 2 Stairs/Curb, 3 Ramp/Curb Ramp, 4 Elevator/Wheelchair Lift, 5 Escalator, 6 Moving Walkway.
- `TRAVEL_DIRECTION` — 1 Both, 2 From-To, 3 To-From.
- `DELAY` — elevator wait, seconds.
- `LEVEL_NAME_FROM` / `LEVEL_NAME_TO`, `VERTICAL_ORDER`, `FACILITY_ID`.

**Transitions fields:** `TRANSITION_TYPE` and `TRANSITION_RANK` use the same domains as pathways; `VERTICAL_ORDER_FROM` / `VERTICAL_ORDER_TO` and `HEIGHT_FROM` / `HEIGHT_TO` encode the vertical span; `LENGTH_3D` is the travel-time cost.

At ArcGIS Pro 3.7 the **PrelimNetwork** feature dataset (`PrelimPathways`, `PrelimTransitions`) is deprecated. The [model changelog](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm) states it was used by tools deprecated in Pro 3.6 (Generate Indoor Pathways, Generate Floor Transitions, Thin Indoor Pathways) and that “the schema is now simplified to only include final network artifacts generated by the Indoors Network tools.”

### 1.2 Published pipeline stages

Creating a routable network is documented as seven high-level steps ([Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm)):

1. **Create the indoor network dataset** — [Create Indoor Network Dataset](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/create-indoor-network-dataset.htm) (or the Network dataset created by [Create Indoors Database](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/create-indoors-database.htm)). Schema only: Landmarks, Pathways, Transitions. Requires a horizontal *and* vertical coordinate system.
2. **Generate pathways and transitions** — [Generate Indoor Network Features](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-indoor-network-features.htm). This is the automatic-generation step.
3. **Create landmark points** — manual (Append from POIs, or digitise). Any landmark within 4 m of a route is named in directions.
4. **Rank pathways** — [Classify Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/classify-indoor-pathways.htm).
5. **Connect facilities** — **not automatic.** “The Indoors tools do not connect facilities in the network.” Outdoor sidewalks between buildings must be digitised by hand.
6. **Create the final network dataset** — [Create Network Dataset From Template](https://pro.arcgis.com/en/pro-app/latest/tool-reference/network-analyst/create-network-dataset-from-template.htm) using `FinalNetworkTemplate_Meters.xml` at `<installation>\Program Files\ArcGIS\Pro\Resources\Indoors\NetworkTemplates`, then [Build Network](https://pro.arcgis.com/en/pro-app/latest/tool-reference/network-analyst/build-network.htm). This is **(c) query-time pathfinding infrastructure**, not generation.
7. **Optionally add travel modes** — the shipped template includes walking and wheelchair-accessible modes; more can be added.

An auxiliary tool, [Generate Facility Entryways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-facility-entryways.htm), creates doorway points on the facility perimeter so later outdoor connections have something to snap to. It is automatic *point* generation, not pathway generation.

### 1.3 Generate Indoor Network Features — current automatic generator

Tool page: [Generate Indoor Network Features (Indoors)](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-indoor-network-features.htm). Help narrative: [Create the indoor network — Pathways and transitions](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm).

**What it does (a).** Generates horizontal pathways through walkable space and, optionally, vertical floor transitions, in a single run. Existing pathways / transitions for the selected levels are overwritten.

**Required inputs**

- Input Level Features — Levels polygons (selection honoured).
- Input Unit Features — Units polygons. Unit centroids are default routable locations. “Units and Transitions feature endpoints are automatically considered as routable locations.”
- Input Obstacle Features — polylines (typically Details) with a `LEVEL_ID` field or configured as floor-aware. Walls, windows, columns.
- Target Indoor Pathways — Pathways layer.

**Optional inputs that change generation**

- Target Indoor Transitions — if omitted, only horizontal pathways are written. If provided, at least two levels must be selected, and a Stairway Unit Expression and/or Elevator Expression is required.
- Obstacle Expression — SQL subset of obstacle polylines that actually block (e.g. `USE_TYPE = 'Interior Wall'`).
- Routable Locations — extra point layers (POIs, occupants, entryways). Floor-aware or with `LEVEL_ID`.
- Pathway Generation Method — `Lattice` (default), `Universal Circulation Network`, or `Transitions Only`.
- Stairway Unit Expression / Elevator Expression — SQL against Units.
- Elevator Delay — wait in seconds, ≥ 0. Splits pathways that intersect elevator polygons and writes the delay onto them.
- Obstacle Buffer — 0.25–2.9 m (or 0.6–9.5 international feet). Defaults: Lattice 0.05 m, UCN 0.4 m. “The obstacle buffer should be a maximum of half the width of the narrowest entryway to ensure pathway connectivity between units.” Routable locations inside the buffer are not routed to.
- Search Radius — distance assessed for nearby routable locations. Larger radius → more pathways, longer runtime. Needed for large open spaces and long hallways.
- Lattice Spacing — longest allowed distance between adjacent lattice nodes. Default 0.6 m. Range 0.25–2.9 m (or 0.6–9.5 ft). “Tight enough to pass through the narrowest doorways.”
- Lattice Rotation — degrees clockwise from due west, 0–180. If blank, computed from the minimum bounding rectangle of each facility’s level.

**Doors / openings.** There is no dedicated “Opening” input. Connectivity through doorways is produced by *not* treating door polylines as obstacles (the Detail / Obstacle Expression typically lists walls and columns, not doors) and by using a lattice spacing / obstacle buffer small enough to pass the opening. The help inspection checklist is explicit: “Generated pathways extend into all rooms and are not cut by doorways.”

**Vertical transitions.** Created automatically when multiple levels and a target Transitions layer are provided. Vertices of generated transitions snap to pathway vertices. The deprecated predecessor ([Generate Floor Transitions](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-floor-transitions.htm)) described the geometric construction more precisely: the tool “finds the closest vertex of a Pathway Feature on each floor to the center of polygons with selected types. A vertical line is created between levels at this vertex. The z-values of the start and end vertex of the generated Target Transitions feature will match the z-values for the pathways feature.” `LENGTH_3D` for stairway-type transitions is “increased by a factor of three to reflect travel time of walking stairs.” **[INFERENCE]** The replacement tool is documented as creating the same class of vertical lines snapped to pathway vertices; Esri does not republish the “closest vertex to polygon centre” sentence on the new tool page.

**Multivertex stairs** (landings, angled flights) are **not** automatic. After generation, operators optionally edit transition vertices so the line follows the pedestrian path and any landing; `LENGTH_3D` must then be recalculated (`=!shape.length3d!`).

**Inter-facility routing is not automatic.** Outdoor pathway features between buildings must be digitised with the Create Features tools, snapped vertex-to-vertex, typically at entryway points produced by Generate Facility Entryways.

**Verification expected after a run** (help): pathways reach every room and are not cut by doorways; lattice orientation matches the units; vertical transitions exist where expected and their endpoints snap to pathway vertices. Specific editing tools (Create, Split, Move) auto-populate required attributes and z.

### 1.4 The two published generation algorithms

Esri documents two horizontal algorithms ([Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm)):

#### Lattice (default)

“Creates a fishnet across the walkable spaces of the level with a density determined by the value entered for the Lattice Spacing parameter.” The tool “attempts to align the lattice of pathways with the primary direction of travel in each facility.” Help illustrations distinguish:

- *Preliminary / unthinned* lattice — connected through specified doorways.
- *Finalized / thinned* lattice — “ensures connectivity between all routable locations.”

The current combined tool both creates and thins. The deprecated [Thin Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/thin-indoor-pathways.htm) page is the only place Esri publishes the thinning *parameters*:

- Search Tolerance — default 5 m. Routable locations farther than this are ignored. Must be ≥ 0.
- Neighbor Solve Count — default 50, must be ≥ 1. Number of closest neighbouring routable locations to solve routes between. Raise it for more-direct routes at higher cost; lower it if many points sit close together.

Thinning “removes preliminary network pathways that are not needed for routing between selected locations on each floor, reducing the network dataset size and improving its route-solving performance.” **[INFERENCE]** The modern Generate Indoor Network Features tool performs an equivalent keep-the-routes-between-routable-locations prune; Esri no longer exposes Neighbor Solve Count as a user parameter on the combined tool.

#### Universal Circulation Network

“Generates pathways based on shortest paths between routable locations, more closely resembling the walking path that a person might take in a space.” Best for buildings with “multiple orientations or lots of curves or non-90 degree angles.” Esri’s tool page cites the UCN paper as [Lee, Eastman, Lee, Kannala, Jeong 2010, *Environment and Planning B* 37(4) 628–645, doi:10.1068/b35124](https://journals.sagepub.com/doi/abs/10.1068/b35124).

The paper’s own abstract (read on the Sage page) defines UCN as “a computational method for measuring walking distances within buildings based on a length-weighted graph structure for a given building model,” implemented as a Solibri Model Checker plug-in over BIM. It “takes into consideration people-movement patterns, reflecting that people tend to walk along the shortest, easiest, and most visible paths,” and “returns consistent and accurate scalar quantities.” Esri does not republish the UCN construction algorithm; the published claim is the *behavioural* one (shortest paths between routable locations, organic walking).

### 1.5 Deprecated tools still documented (and still the best source for lattice/thin parameters)

These remain on the Pro 3.7 tool reference as **Legacy / deprecated**, replaced by Generate Indoor Network Features.

**[Generate Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-indoor-pathways.htm).** “Generates preliminary pathways that are cut according to obstructions, such as walls or columns.” Writes `PrelimPathways`. Lattice Rotation 0–180° (blank → MBR). Lattice Density / Spacing 0.25–2.9 (dataset units; default 0.6, historically documented as metres). Restricted Unit Features + expression exclude atria, landscaping, shafts. Detail Expression selects barrier polylines. Existing prelim pathways for the selected levels are overwritten.

**[Thin Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/thin-indoor-pathways.htm).** See Search Tolerance / Neighbor Solve Count above. Requires at least one routable-location layer. Deletes any existing Network_ND in the same feature dataset before running.

**[Generate Floor Transitions](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-floor-transitions.htm).** Vertical lines from the closest pathway vertex to the centre of selected stair/elevator unit polygons. Elevator Delay = “one-half the time in seconds that an elevator passenger can expect to spend waiting to enter and exit the elevator.” Default attributes on output: `TRANSITION_RANK`, `TRANSITION_TYPE`, `TRAVEL_DIRECTION`. Stair `LENGTH_3D` × 3.

### 1.6 Classify Indoor Pathways

Tool page: [Classify Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/classify-indoor-pathways.htm).

Not generation — a post-process. The operator *selects* unit polygons (conference rooms, service areas). Pathways that intersect those polygons are split at the intersection; the interior portion is ranked Secondary (`PATHWAY_RANK = 2`). Primary pathways are preferred at solve time (“travel along primary pathways will have a lower cost than travel along secondary pathways”). A selection on the Units layer is required. The existing network dataset must be rebuilt afterwards.

### 1.7 Generate Facility Entryways

Tool page: [Generate Facility Entryways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-facility-entryways.htm).

Automatic *point* generation: identifies exterior edges of the facility from Units, then places points on selected door Details within a buffer (default 0.5 m, range (0, 10) m) inside and outside that edge, to catch in-swing and out-swing doors. Handles single-swing, double-swing, and revolving-door representations. Adjacent doorways may collapse to a single point; per-door routing requires manual duplication. Z comes from the level. These points are recommended as Routable Locations so later outdoor connections snap cleanly.

### 1.8 Build Network / travel modes / what is explicitly not automatic

**Build Network** ([tool](https://pro.arcgis.com/en/pro-app/latest/tool-reference/network-analyst/build-network.htm)) compiles Pathways + Transitions into `Network_ND` from the Indoors template. Default units are metres; changeable under Travel Attributes → Costs → Length. This is **(c)**, not generation.

The shipped template includes walking and wheelchair-accessible travel modes ([Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm)). Additional modes can be created ([Create a travel mode](https://pro.arcgis.com/en/pro-app/latest/help/analysis/networks/create-travel-mode.htm)). Restriction attributes ([Restriction attributes](https://pro.arcgis.com/en/pro-app/latest/help/analysis/networks/restriction-attributes.htm)) implement prohibit / avoid / prefer, which is how wheelchair mode avoids stairs and how Classify Indoor Pathways’ primary/secondary ranks become solve-time costs.

**Explicitly not automatic**

| Task | Source |
| --- | --- |
| Connecting separate facilities / outdoor campus sidewalks | [Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm) |
| Multivertex stair / landing geometry | same |
| Landmark creation | same (manual Append / digitise; 4 m callout radius) |
| Pathway rank (primary vs secondary) | [Classify Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/classify-indoor-pathways.htm) — operator selects units |
| Travel-mode authoring beyond the two shipped modes | template + manual |
| One-way / temporal restrictions beyond `TRAVEL_DIRECTION` | fields exist; population is not described as automatic |
| BIM / IFC / CAD → *network* | [Import BIM To Indoor Dataset](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/import-bim-to-indoor-dataset.htm) imports Revit categories to Facilities / Levels / Units / Details (and optional 3D multipatch). The help says the output “can be used … to generate an indoor network for routing” — i.e. BIM import is **floor-plan load**, after which Generate Indoor Network Features still has to run. Same pattern for Import IFC / Import CAD. |

**Update behaviour** ([Update the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/update-the-indoors-network.htm)): re-running Generate Indoor Network Features on a subset of Levels deletes matching `FACILITY_ID`/`LEVEL_ID` pathways and regenerates. Transitions that spatially intersect transition units are deleted and re-created. Geometry edits require [Build Network](https://pro.arcgis.com/en/pro-app/latest/tool-reference/network-analyst/build-network.htm). VB Script evaluators in pre-3.5 templates cannot rebuild on Pro 3.5+ until converted to Python.

### 1.9 Esri patents / DevSummit / extra algorithm detail

A targeted patents.google.com search for an Esri lattice-then-thin indoor-pathways patent did not surface a first-party Esri filing that describes this pipeline. The US filings that the search engine associated with “automatically generate paths for indoor navigation” (e.g. US 11,346,669) are **not** Esri documents and are not cited here. No Esri DevSummit talk transcript describing lattice construction more precisely than the tool reference was located as a primary page. **[UNVERIFIED]** internal lattice-node topology (4-connected vs 8-connected), exact thinning objective, and UCN geometric construction beyond “shortest paths between routable locations.”

---

## 2. Mappedin

Mappedin publishes a rich *data model* for an already-built wayfinding graph and a rich *query-time* directions API. It does **not** publish an algorithm that turns floor polygons into that graph.

### 2.1 Product surface

[Mappedin Developer Overview](https://developer.mappedin.com/docs/overview): Maker (create/edit/publish), SDKs (JS, React, React Native, Android, iOS), Web Embed, enterprise apps (Mappedin Web with search / blue-dot / multi-destination wayfinding, Leasing, Minimap, Directory), MVF GeoJSON export, REST APIs.

[Mappedin Maker](https://developer.mappedin.com/docs/maker) accepts PNG, JPEG, WebP, PDF, DXF, DWG. Maps export as MVF or PDF.

The [Editor product page](https://www.mappedin.com/editor/) and [Features page](https://www.mappedin.com/features/) state: “Upload any floor plan and let Mappedin automatically detect and draw any doors, windows, walls and much more.” The same claim appears on the [developer overview](https://developer.mappedin.com/docs/overview) Web Embed section. This is **(a) automatic *geometry* extraction** (walls/doors/windows), **not** a published centerline / node-graph generator.

The editor also supports draw-from-scratch and iPhone/iPad LiDAR room scan ([Editor](https://www.mappedin.com/editor/)).

### 2.2 Venue data model — MVF v3

[MVF v3 Getting Started](https://developer.mappedin.com/docs/mvf/v3/getting-started) and the [MVF v3 specification overview](https://developer.mappedin.com/docs/mvf/v3/mvf-v3-specification/mvf-overview): GeoJSON bundle, one geometry file per floor. Core = manifest + floors + per-floor geometry. Locations attach rich POI data to geometry. **Connections, Nodes, and Navigation Flags “are mostly used by the Mappedin SDK.”**

**Nodes** ([`NodeProperties`](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.nodes.NodeProperties.html)):

- `id`: `n_…`
- `neighbors[]`: `{ id, extraCost, flags[] }`. `extraCost` is “the extra cost to traverse to the node, above the straight-line distance.”
- `geometryIds[]`: if non-empty, “this node [is] (one of the) destination nodes for that geometry.”

This is a **geometric walkable graph on a floor**. How those nodes are placed is unpublished.

**Connections** ([`Connection`](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.connections.Connection.html)):

> “A Connection is a direct connection between two or more points in space. They can connect different floors, or the same floor. They can be used to represent elevators, escalators, stairs, doors, ramps, etc. They are different from Nodes, which generally represent a connected graph of walkable spaces on the same floor, whose cost includes the distance between the nodes. With a connection, the cost to traverse it is a combination of the static entry cost plus another cost per floor transitioned.”

- `type`: `unknown | elevator | escalator | travelator | stairs | door | ramp | ladder`
- `entrances[]` / `exits[]`: `{ floorId, geometryId, flags[] }`
- `entryCost` ≥ 0 — “equivalent to the number of meters a person should walk out of their way to avoid entering the connection.” Elevator example: 10–20 m of wait; stairs/escalators may be 0. Straight-line entrance–exit distance is **not** used. Same-floor use costs *only* `entryCost`. “You cannot naively use A\* with Connections, because the straight line distance heuristic will not be admissible.”
- `floorCostMultiplier` ≥ 1 — multiplied by the absolute elevation difference (in floors) and added to `entryCost`. Example: elevator multiplier 1 vs stairs 10, so it is worth walking 10 m extra per floor to take the elevator.

**Navigation flags** ([MVF Navigation Flags](https://docs.mappedin.com/mvf/v3/latest/modules/_mappedin_mvf-navigation-flags.html)): bitfield on nodes and connection anchors. Well-known keys: `accessible`, `outdoors`, `public`. `accessible` “includes appropriate width for doorways, paths taking ramps instead of stairs, and elevators instead of escalators.” Consumers should not route through non-public components when the `public` flag is present. Custom flags are allowed; well-known flags are optional per bundle.

### 2.3 MVF v2 (beta, superseded) — additional published fields

[MVF v2 Data Model](https://developer.mappedin.com/docs/mvf/v2/data-model) is more explicit about the authored objects, even though v2 “will remain in a beta state”:

- **Connection** (`connection.json`): `type` stairs or elevator; `nodes[]`; optional `accessible`.
- **Entrance** (`entrance/m_*.geojson`): LineString openings; optional `node`.
- **Node** (`node.geojson`): point + `neighbors`. **“Nodes are not included in an MVFv2 downloaded using Mappedin Maker. They are included when downloaded using the Mappedin REST API.”**
- **Obstruction**: non-traversable (desk, chair); “a path will never be created through an obstruction.” May list `entrances` that punch through.
- **Space**: traversable enclosed area; `kind` includes `hallway`, `connection.stairs`, `connection.elevator`.

The Maker-export omission of nodes is the strongest published signal that the walkable graph is a **server-side artefact**, not something the floorplan editor exposes.

### 2.4 Wayfinding SDK — query-time (c), not generation

[Mappedin JS Wayfinding](https://developer.mappedin.com/web-sdk/wayfinding):

- `MapData.getDirections(origin, destination)` — if either argument is an array, “Mappedin JS will choose the targets that are closest to each other.”
- Directions on Maker maps are **smoothed by default**; CMS maps have smoothing off by default (`TGetDirectionsOptions.smoothing`). “Directions for some maps may appear jagged or not smooth. This is due to the SDK attempting to find the shortest path through the map's geometry.”
- Multi-floor: a `Connection` tooltip (elevator / stairs icon) is drawn; tap switches floor. No extra authoring required at query time.
- Accessible routes: `getDirections(a, b, { accessible: true })`. “By default, the shortest available route is chosen.”
- Dynamic routing: `zones[]` with `cost` 0…Infinity, optional `floor`, and a Polygon / MultiPolygon. Infinity blocks; stacked zones add.
- “A Space requires an entrance to be used as a target.”
- Multi-destination: `getDirectionsMultiDestination`.
- Blue-dot path tethering (`trackCoordinate`) is visualisation of progress on an already-computed route.

None of this describes how the node graph is synthesised from polygons.

### 2.5 Automatic centerline generation — unpublished

Mappedin publishes:

- AI detection of doors, windows, walls from an uploaded floor plan ([features](https://www.mappedin.com/features/), [overview](https://developer.mappedin.com/docs/overview)).
- A finished node+connection graph in MVF (REST export).
- Query-time pathfinding, smoothing, accessibility, and zones.

Mappedin does **not** publish: lattice vs medial-axis vs visibility vs UCN; how nodes are placed in corridors; how doors become graph edges; how vertical connections are matched across floors; whether Maker’s AI step also builds the wayfinding graph or only the renderable geometry.

**Classification:** geometry extract **(a, unpublished internals)**; node graph **(a or b, unpublished)**; `getDirections` **(c)**.

---

## 3. Apple Indoor Maps / IMDF

IMDF is a **venue encoding**, not a router and not a network generator. Apple is explicit that a comprehensive routing network is out of scope for Relationship geometries.

### 3.1 What IMDF is

[IMDF 1.0.0](https://register.apple.com/resources/imdf/) (last update 2021-10-19; also an [OGC Community Standard](https://register.apple.com/resources/imdf/)): GeoJSON feature archive for orientation, navigation, and discovery. “Lightweight, mobile friendly.” Used with Apple indoor positioning (Wi-Fi RF survey via the Indoor Survey app; no extra beacons) and rendered via MapKit / MapKit JS ([Indoor Maps Program](https://register.apple.com/indoor); [Displaying an Indoor Map](https://developer.apple.com/documentation/mapkit/displaying-an-indoor-map) is a *rendering* sample, WWDC 2019 session 241).

### 3.2 Features that encode connectivity — and those that do not

**Unit** ([spec](https://register.apple.com/resources/imdf/types/unit)): polygonal space. Categories include `walkway`, `room`, `elevator`, `escalator`, `movingwalkway`, `ramp`, `stairs`, `steps`, `column`, `structure`, `opentobelow`, `nonpublic`. Adjacent units of the same level must not have symmetrical difference; the union of units must equal the Level. An Opening “MUST be covered by a Unit boundary where the modeled entrance exists.” Vertical-traversal units have extra geometric rules (elevator footprints must equal across levels, or overlap &lt; 10%; escalators on adjacent ordinals SHOULD touch and align).

**Opening** ([spec](https://register.apple.com/resources/imdf/types/opening)): **LineString** of the physical entrance width. Categories: `automobile`, `bicycle`, `pedestrian`, `emergencyexit`, `pedestrian.principal`, `pedestrian.transit`, `service`. Properties: `accessibility[]`, `access_control[]`, `door` `{automatic, material, type}`. One Opening = one physical entrance; MUST NOT model two different Units. Elevator / escalator / stairs / moving-walkway / steps units have mandatory or recommended Opening counts.

**Relationship** ([spec](https://register.apple.com/resources/imdf/types/relationship)): optional, often **unlocated** (`geometry: null`). Models origin → (intermediary) → destination. Categories include `traversal`, `ramp`, `escalator`, `elevator`. `direction` is `directed` or `undirected`. `hours` can constrain temporal applicability. Published use cases:

- Unidirectional door: `traversal` + directed + Opening as intermediary + Units as origin/destination.
- Ramp / escalator: Opening as origin and destination, ramp/escalator Units as intermediaries; `hours` captures reversible escalators.
- Elevator: undirected, elevator Units as intermediaries, floor Units as origin/destination. “It is not necessary to describe each destination’s Relationship with other Elevator Units. These Relationships can be systematically derived.”
- Curated path: MAY carry a `LINEAL` geometry.

The curated-path warning is the key generation statement in the whole spec:

> “Curated paths defined in this manner are NOT intended for use in defining a comprehensive routing network within a venue and MUST NOT be assumed to be used by default, or even at all, by existing routing systems. Any curated paths provided in a venue delivery MUST be viewed as ‘hints’ or supplementary information that MAY be used when and where appropriate.”

**Level** ([spec](https://register.apple.com/resources/imdf/types/level)): polygonal floor extent, `ordinal` (ground-floor access = 0, first below-ground = −1), `outdoor` boolean. Adjacent touching levels that share an entrance SHOULD each carry their own Opening, overlapping, same category.

**Amenity / Occupant** ([amenity](https://register.apple.com/resources/imdf/types/amenity), [occupant](https://register.apple.com/resources/imdf/types/occupant)): points / unlocated businesses. Destinations, not graph edges. `correlation_id` links the same amenity/occupant stacked on different levels.

**Accessibility** ([glossary](https://register.apple.com/resources/imdf/glossary)): property of Opening, Unit, Amenity, Section. Categories include `wheelchair`, `braille`, `tdd`, `trs`. Expected to be used “in a manner that is consistent with the spirit of the ADA.”

### 3.3 What a router must synthesise

IMDF therefore encodes:

- Walkable vs non-walkable *cells* (Units).
- *Portals* between cells (Openings) with width, door hardware, access control, accessibility.
- Optional directed / temporal / vertical *hints* (Relationships).
- Optional curated linework that **must not** be treated as the network.

It does **not** encode a node-edge pedestrian graph. Building one is **(a) the consuming router’s job**, unpublished by Apple. IndoorGML 2.0’s preface makes the same observation: “The OGC IMDF Community Standard provides a comprehensive model to compute path(s) between features located on a map, but the derived network is application specific” ([IndoorGML 2.0 Part 1](https://docs.ogc.org/is/22-045r5/22-045r5.html)).

---

## 4. Other professional systems

Only products with a primary or high-trust source are included. Several well-known names publish positioning or display, not network generation.

### 4.1 HERE Indoor Map — (b) vendor-authored maps

[Introduction to HERE Indoor Map](https://docs.here.com/indoor-map/docs/indoor-map-readme) (updated 2026-05-11): “high quality maps modeling indoor spaces, including building geometry and points of interest spanning across multiple floors,” plus web/mobile libraries and a Data API that serves GeoJSON. The Indoor portal is used to *list, view, order, and order updates*. The product note is unambiguous:

> “HERE will create indoor maps and perform indoor map edits for you.”

[Get started](https://docs.here.com/indoor-map/docs/indoor-map-quick-start) is account setup + order. No generation algorithm, no node model, no lattice/medial-axis discussion is published. Classification: **(b) import of a vendor-authored venue**. Query-time use via HERE SDK / JS is **(c)** and is not documented as indoor-graph generation.

### 4.2 IndoorAtlas — (b) manual graph + (c) SDK routing

IndoorAtlas’s public surface is geomagnetic / multi-sensor positioning ([homepage](https://www.indooratlas.com/)). Wayfinding is a separate authored graph:

- [Wayfinding product](https://www.indooratlas.com/solutions/indooratlas-wayfinding/): step 2 is “Use the IndoorAtlas Web App to generate a wayfinding graph for your venue.” “Configurable navigable areas.” Offline routing supported.
- [Wayfinding Overview](https://support.indooratlas.com/support/solutions/articles/36000051251-wayfinding-overview): “A wayfinding graph consists of nodes and edges that define the navigable aisles and floor transitions.” Features: outdoor↔indoor links, floor-to-floor links. Routing: snap to closest edge, then shortest path on the graph.
- [Creating the Wayfinding Graph](https://support.indooratlas.com/support/solutions/articles/36000051250-creating-the-wayfinding-graph): created **in a web editor** (video tutorial). Directed edges (click `+directed`; direction = first-clicked node). Accessibility tags on edges (`inaccessible`, `accessible-only`) from SDK 3.7; testable in the web tool.
- [Using Wayfinding with Android](https://support.indooratlas.com/support/solutions/articles/36000095621-using-wayfinding-with-android): `IARoute` is a list of straight `Leg`s; each leg can point back to original `nodeIndex` / `edgeIndex`. First/last legs may have null indices (off-graph snap). Empty route if the floor does not exist in the graph.

No automatic generation from floor geometry is published. Classification: **(b) manual authoring**, **(c) query-time**.

### 4.3 MazeMap — (a) unpublished AI conversion + (c) routing platform

[MazeMap](https://www.mazemap.com/) markets indoor maps and wayfinding for campuses. [How to get started](https://www.mazemap.com/our-maps/how-to-get-started): customer sends CAD floorplans and a POI list; “Your floorplans are then uploaded to our system, where AI converts them into a 3D map. From there, our diligent Customer Success Technicians will quality check your maps.” Homepage: “we use AI and machine learning to create maps quickly and efficiently”; FMS updates sync into the map; JS APIs for overlays; indoor+outdoor directions.

What the AI actually emits (centerline graph vs display mesh vs both) is **unpublished**. Classification: **(a) claimed, internals unpublished**; technician QA is a human pass; runtime is **(c)**.

### 4.4 Google Indoor Maps — display only, generation unpublished

[Google Maps Help — Use indoor maps to view floor plans](https://support.google.com/maps/answer/2803784): zoom into a participating mall/airport, pick a floor in the level control, search inside the building. Building owners update plans via regional `indoorpartners-*@google.com` addresses. No routing-network model, no generation algorithm, no IMDF/IndoorGML mention. Classification: **unpublished**. MapsIndoors (section 4.6) is a third-party platform that *uses* Google Maps for outdoor legs, not Google’s indoor generator.

### 4.5 Mapbox Indoor — display, experimental, no published graph

[Mapbox Maps SDK for iOS — Indoor mapping](https://docs.mapbox.com/ios/maps/guides/indoor/): experimental (`@_spi(Experimental)`). Enabling `showIndoor` on the Standard style renders floor plans at appropriate zooms and shows a floor-selector ornament. APIs “may change in future releases.” No routing, no node graph, no generation. Classification: **display only**.

### 4.6 MapsIndoors (MapsPeople, on Google Maps / Mapbox) — (c) plus unpublished dynamic graph

[MapsIndoors Wayfinding](https://docs.mapsindoors.com/sdks-and-frameworks/web/directions-and-routing): outdoor-to-indoor turn-by-turn; venue-to-venue via Google Maps or Mapbox public routes; “Dynamic routes — Automated route updates based on obstacles like furniture and changing floor plan layout”; user-profile personalised routes; accessible wayfinding (avoid stairs, use elevators/ramps). How the indoor graph is built from geometry is **unpublished**. Classification: **(c)** documented; **(a)** claimed for dynamic updates, internals unpublished.

### 4.7 Autodesk / Unity / IfcOpenShell

No first-party Autodesk, Unity Indoor, or IfcOpenShell document describing automatic pedestrian-network generation from IFC was located as a readable primary page in this pass. Esri’s [Import BIM To Indoor Dataset](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/import-bim-to-indoor-dataset.htm) is the only vendor BIM path that was fully read, and it stops at Indoors floor-plan layers (see §1.8). ISO/TS 19166 (below) is a BIM↔GIS *conceptual mapping* standard, not a router.

---

## 5. Academic and latest generation methods (2018–2026, plus living classics)

This section is about *building* a graph from geometry. Each method lists input, output graph type, strengths, and documented failure modes.

### 5.1 IndoorGML — Poincaré duality / node-relation graph (standard, not an algorithm)

[IndoorGML 1.1](https://docs.ogc.org/is/19-011r4/19-011r4.html) (OGC 19-011r4, 2020) and [IndoorGML 2.0 Part 1 — Conceptual Model](https://docs.ogc.org/is/22-045r5/22-045r5.html) (OGC 22-045r5, published 2025-06-26) define the *exchange* model for an indoor navigation network. They do not prescribe a unique generator.

Core ideas, from IndoorGML 2.0 Part 1 (PDF, clauses 6–8):

- Indoor space is modelled as a **cellular space** \(S_T = \{c_1,\ldots,c_n\}\): non-overlapping cells of a theme \(T\) (topographic, Wi-Fi, legal, …). Gaps are allowed; overlaps must go to another layer.
- Cell geometry may be (1) embedded (GM_Solid / GM_Surface), (2) an external reference to IFC/CityGML, or (3) absent (identifier only).
- **Poincaré duality** maps a *k*-cell in *N*-D primal space to an *(N−k)*-cell in dual space. In 3D, a room (solid) → a node; a shared 2-face → an edge. The result is an **adjacency graph** \(G_{adj}=(V,E_{adj})\). The **connectivity graph** \(G_{con}\) is the subset of adjacency that is actually traversable (typically via doors).
- Dual space may be a **logical network** (no geometry) or a **geometric network** (nodes as GM_Point, edges as GM_Curve, optional `weight`).
- IndoorGML 2.0 Navigation extension classifies cells as NavigableSpace (GeneralSpace, TransferSpace) vs NonNavigableSpace (ObjectSpace / furniture / walls) and boundaries as NavigableBoundary vs NonNavigableBoundary. A Route is a sequence of Node/Edge.
- Multiple **thematic layers** (visitor vs staff, walking vs flying, topographic vs RFID) are joined by InterLayerConnection using 9-intersection predicates (`contains`, `within`, `covers`, `coveredBy`, `overlaps`, `equals`).
- CellBoundary may be virtual (`isVirtual`); virtual boundaries appear when a space is subdivided.
- If CellBoundary geometries are omitted, “the network may be derived from the cells using geometric operations” — IndoorGML names the possibility and does not specify the operator.

**Input:** cellular subdivision (from BIM, floor plans, or sensors).  
**Output:** primal cells + dual NRG (logical and/or geometric), optional multi-layer.  
**Strengths:** standard interchange; clean vertical/semantic layering; navigable vs non-navigable vocabulary.  
**Failure modes the spec itself flags:** IMDF-style maps do not *be* an NRG (“the derived network is application specific”); geometry-free cells yield only logical networks; virtual-boundary / furniture layers must not violate the non-overlap rule (IndoorGML 2.0 introduces primal-space interlayer connection specifically so furniture can live on a second layer).

IndoorGML 1.1 terms (clause 4): NR Graph, Accessibility / Adjacency / Connectivity NRG, Logical vs Geometric NRG, Multi-Layered Space Model.

### 5.2 Medial axis / MAT, including Chin–Snoeyink–Wang and ECM

**Chin, Snoeyink, Wang (1999), “Finding the Medial Axis of a Simple Polygon in Linear Time,” *Discrete & Computational Geometry* 21:405–420.** Publisher page: [https://link.springer.com/article/10.1007/PL00009429](https://link.springer.com/article/10.1007/PL00009429). Conference precursor: [https://link.springer.com/chapter/10.1007/BFb0015444](https://link.springer.com/chapter/10.1007/BFb0015444). Linear-time MAT of a simple polygon by decomposing into pseudonormal / influence / *xy*-monotone histograms, computing histogram axes, and merging. (The full PDF was not retrieved in this pass — Springer served a client-challenge page — so the algorithm detail above is taken from the publisher abstract / chapter abstract only.)

**Input:** simple polygon (with or without holes, depending on the variant).  
**Output:** a planar graph of straight and parabolic arcs (the set of points with at least two closest boundary points).  
**Strengths:** unique, homotopy-preserving skeleton; clearance is implicit (distance to boundary); O(*n*) size.  
**Classic failure modes** (standard computational-geometry; the 1999 abstracts do not enumerate indoor-specific ones): **spurs** into every convex niche and doorway reveal; sensitivity to boundary noise; parabolic arcs in mixed point/segment sites. Indoor use therefore almost always *prunes* the MAT.

**van Toll, Cook, van Kreveld, Geraerts (2017), “The Medial Axis of a Multi-Layered Environment and its Application as a Navigation Mesh,” arXiv:1701.05141.** Full PDF read. Formalises the **Explicit Corridor Map (ECM)**: a medial axis annotated with nearest-obstacle information, usable as a navigation mesh for *disk-shaped characters of any radius* (the classical retraction method). Extends MAT to a **walkable environment** (orientable 2-manifold with consistent gravity) and a **multi-layered environment** (WE cut into planar layers joined by *k* connections that project to segments). Medial axis of an MLE is defined with **distances projected onto the ground plane**. Size O(*n*); construction O(*n* log *n* log *k*). Paths in milliseconds; supports insert/delete of obstacles.

The paper’s own caveats, used here as failure modes:

- Projected distances **ignore slope / true 3D length**.
- Optimal layer decomposition of a triangle WE is NP-hard; heuristics are used.
- Voxel WE extraction (Recast, NEOGEN, Pettré) does not scale; ECM assumes an already-clean WE.
- Pure graph following looks unnatural; ECM is meant to be a *mesh* (characters may leave the axis inside the annotated corridor).
- Degree-1 / spur structure still exists at convex corners unless pruned (their Definition 1 takes topological closure of the ≥2-nearest-site set and does not run into ≤180° corners).

**Input:** polygonal free space per layer + connection segments.  
**Output:** O(*n*) medial-axis graph + clearance annotation (ECM).  
**Strengths:** any-radius clearance, sparse, multi-floor, dynamic updates.  
**Failure modes:** projected-length bias; layer-cut artefacts; residual spurs; requires a clean walkable surface.

A 2019 MDPI paper, “A Modified Methodology for Generating Indoor Navigation Models” ([https://www.mdpi.com/2220-9964/8/2/60](https://www.mdpi.com/2220-9964/8/2/60)), is widely cited as MAT + Constrained Delaunay for indoor models. The HTML/PDF returned HTTP 403 in this pass, so its algorithmic claims are **[UNVERIFIED]** here beyond the publisher landing-page existence.

### 5.3 Straight skeleton

The straight skeleton (Aichholzer et al., 1995) is the wavefront-propagation skeleton of a polygon: edges move inward at unit speed, vertices trace the skeleton. Unlike the MAT it is piecewise-linear (no parabolas) and is not a Voronoi diagram. No 2018–2026 indoor-routing product documented in this pass claims to use it. **[UNVERIFIED]** as a shipped indoor-router technique. Theoretical failure modes (standard): wavefront events are numerically fragile; reflex chains produce long spokes; not clearance-correct for a disk (offset is *mitered*, not rounded).

### 5.4 Constrained Delaunay triangulation and corridor duals

IndoorGML’s “derive the network from cells using geometric operations,” Esri’s UCN citation trail, and several academic IGNM / MGNM constructions (referenced from secondary listings; primary PDFs 403’d) all sit on **constrained Delaunay triangulation (CDT)** of the walkable polygon with holes, then a dual or mid-edge graph.

Typical recipe **[INFERENCE from the standard computational-geometry construction, not from a 2018–2026 paper successfully retrieved]**:

1. CDT of the free-space polygon; constrained edges = walls and opening jambs.
2. Keep only triangles (or dual edges) whose circumcentre / midpoints lie in free space.
3. Optionally restrict to “corridor” triangles (two constrained edges) vs “junction” triangles (zero or one).

**Input:** polygonal free space + constrained segments.  
**Output:** a straight-edged geometric network, denser than a MAT, sparser than a lattice.  
**Strengths:** robust, all-straight, naturally threads doorways (a constrained edge is a portal).  
**Failure modes:** **open-space diagonals** (the dual of a fat triangle crosses the space on a long diagonal rather than a centreline); **foldbacks** at skinny triangles; sensitivity to Steiner-point density.

Chin–Snoeyink–Wang is sometimes described in secondary literature as “MAT via CDT.” The 1999 publisher abstracts describe a histogram decomposition, not a CDT. **[INFERENCE]** indoor systems that say “CDT medial axis” usually mean “CDT + prune to a centreline,” which is related to but not identical with Chin–Snoeyink–Wang.

### 5.5 Visibility graphs

Canonical reference, cited by the UCN paper: Lozano-Pérez & Wesley (1979), “An algorithm for planning collision-free paths among polyhedral obstacles,” *CACM* 22:560–570 ([doi:10.1145/359156.359164](https://doi.org/10.1145/359156.359164)). Nodes = vertices of obstacles (plus start/goal); edges = mutually visible pairs. IndoorGML 2.0 explicitly allows Edges with no dual CellBoundary “for logical networks or **visibility graphs** where two CellSpaces connected by visibility may not share a CellBoundary.”

**Input:** polygonal obstacles.  
**Output:** geometric graph, O(*n*²) edges worst case.  
**Strengths:** true shortest path for a *point* robot; natural doorway diagonals.  
**Failure modes:** looks “corner-hugging” (not human); no clearance; quadratic size; a disk requires Minkowski expansion first (one expansion per radius). The Visibility-Voronoi Complex (cited in van Toll et al. 2017 as [69]) encodes all radii implicitly.

### 5.6 Grid / lattice + thinning (Esri-style)

Documented as a *shipped product algorithm* in §1.4. Academic relatives: morphological thinning / generalised Voronoi graph from a raster of free space. A 2023 MDPI paper “Automatic Generation of 3D Indoor Navigation Networks from Building Information Modeling Data Using Image Thinning” ([https://www.mdpi.com/2220-9964/12/6/231](https://www.mdpi.com/2220-9964/12/6/231)) exists; HTML/PDF 403 in this pass, so method detail is **[UNVERIFIED]** beyond the title and the landing-page existence.

**Input:** walkable polygon + obstacle polylines; lattice spacing / rotation.  
**Output:** dense orthogonal (or rotated) polyline fishnet, then a thinned subgraph that still connects all routable locations.  
**Strengths:** simple; predictable; good for rectilinear buildings; spacing is a direct “fits through this door” knob; thinning is parameterised (search tolerance, neighbour-solve count).  
**Failure modes (from Esri’s own docs):** wrong rotation → pathways fight the architecture; spacing too coarse → missed doors; spacing too fine → disk and runtime blow-up; open atria fill with a grid unless marked restricted; outdoor links and stair landings stay manual. **[INFERENCE]** residual grid artefacts (staircase jaggies, diagonal travel forced onto Manhattan edges) are the reason Esri added UCN.

### 5.7 Door-to-door / portal graphs

IMDF’s Unit + Opening model (§3) and IndoorGML’s CellSpace + NavigableBoundary model (§5.1) are portal graphs: nodes are spaces (or space centroids), edges exist when a navigable opening joins two spaces.

**Input:** space polygons + opening / door segments.  
**Output:** (usually logical) adjacency/connectivity NRG; optionally a geometric embedding via centroids or opening midpoints.  
**Strengths:** matches how buildings are *named*; trivial vertical matching (same elevator Unit stacked by `ordinal` / `correlation_id`); one-way and access-control sit naturally on the portal.  
**Failure modes:** **no interior geometry** — a 200 m concourse becomes one node, so routes cannot stay on the right side of a kiosk; doorway *approach angle* is undefined; open-plan “walkway” units that IMDF tells you to merge become huge cells. This is why every production router that starts from IMDF still has to synthesise a *metric* network *inside* walkway units (IndoorGML 2.0 preface; IMDF Relationship warning).

### 5.8 BIM / IFC extraction

What is actually standardised:

- **IFC** describes constructed elements (walls, slabs, `IfcSpace`, `IfcDoor`). It is not a navigation network. IndoorGML 1.1/2.0 treat IFC as an *external geometry reference*.
- **ISO/TS 19166:2025** [Geographic information — BIM to GIS conceptual mapping (B2GM)](https://www.iso.org/standard/90943.html) (ed. 2, 2025-11; replaces [ISO/TS 19166:2021](https://www.iso.org/standard/78899.html)): three mapping mechanisms (B2G Perspective Definition, Element Mapping, LOD Mapping). Explicitly **out of scope**: physical schema mapping, coordinate-system mapping, relationship mapping, any particular application mechanism, bidirectional mapping. So it does **not** specify a pedestrian graph.
- **Esri Import BIM To Indoor Dataset** (§1.8): Revit categories → Facilities / Levels / Units / Details. Network generation is a later, separate tool.

Academic BIM→graph work (UCN 2010 is the one Esri actually cites; Kannala 2005 escape-route MSc is cited by UCN) typically: read `IfcSpace` + `IfcDoor` → indoor cellular space → one of MAT / CDT / UCN / lattice. Primary 2018–2026 BIM-to-graph PDFs were not successfully retrieved (MDPI/ScienceDirect 403). **[UNVERIFIED]** as to which of those four skeletons current BIM papers prefer.

**Failure modes** that *are* documented on the Esri BIM importer: ungeoreferenced or mismatched CRS (including linked models) cause 3D scale errors; Revit design options can produce extra or missing Units/Details; roof / ground-floor elevation conventions must be chosen explicitly.

### 5.9 Universal Circulation Network (Lee et al. 2010)

[Lee, Eastman, Lee, Kannala, Jeong, “Computing Walking Distances within Buildings Using the Universal Circulation Network,” *Environment and Planning B* 37(4):628–645, 2010, doi:10.1068/b35124](https://journals.sagepub.com/doi/abs/10.1068/b35124). Abstract and references read on Sage. Length-weighted graph on a BIM; Solibri plugin; “shortest, easiest, and most visible paths”; used for GSA spatial-program validation and NFPA 101 travel-distance checks. Esri’s current Indoors tool offers UCN as the non-rectilinear alternative to lattice (§1.4). The *construction* (how vertices are placed, how visibility is discretised) is behind the Sage paywall and is not restated by Esri. **[UNVERIFIED]** beyond the abstract and Esri’s “shortest paths between routable locations” paraphrase.

### 5.10 Learned / ML generation

No primary paper from 2018–2026 that trains a model to emit a pedestrian routing graph (as opposed to detecting walls/doors, or converting a raster floor plan to polygons) was successfully retrieved and read. Mappedin and MazeMap claim AI for *geometry* extraction; neither publishes a learned *network* generator. **[UNVERIFIED]** as a production method. If such papers exist, they were not reachable as publisher PDFs in this pass.

---

## 6. Quality criteria used in the field

Criteria below are those that at least one primary source names as a routing or generation concern — not an invented rubric.

| Criterion | Who states it | What they actually do |
| --- | --- | --- |
| **Naturalness / “walking path a person might take”** | Esri UCN vs lattice ([create indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm)); UCN paper abstract; Mappedin default smoothing on Maker maps ([wayfinding](https://developer.mappedin.com/web-sdk/wayfinding)) | Choose organic shortest-path generation (UCN) or post-hoc smooth the geometric shortest path. ECM paper: characters should *not* be glued to the axis. |
| **Shortness vs topology** | IndoorGML connectivity ⊂ adjacency; Esri Classify Indoor Pathways; Mappedin `extraCost` / `entryCost`; IMDF Relationship “hints” | A geometrically shorter path through a conference room is *legal* but *ranked secondary* (Esri) or given extra cost (Mappedin). Topological / semantic cost overrides Euclidean length. |
| **Doorway approach / not cutting doors** | Esri inspection checklist; Esri lattice spacing “tight enough to pass the narrowest doorways”; IMDF Opening length “MUST approximate the actual width”; Mappedin “Space requires an entrance” | Generation must put a graph edge *through* the opening, not across the leaf; buffer ≤ half the narrowest entryway (Esri). IMDF stores width so a consumer *can* enforce clearance; it does not generate the approach path. |
| **Vertical transit matching** | Esri Generate Indoor Network Features / (deprecated) Generate Floor Transitions; IMDF elevator/escalator equality-and-alignment rules + Relationship; Mappedin Connection `floorCostMultiplier`; IndoorGML TransferSpace | Match by overlapping transition *units* (stairs/elevators), snap to pathway vertices, optional elevator delay. IMDF requires stacked elevator footprints to be equal (or &lt;10 % overlap). Mappedin prices multi-floor legs as `entryCost + Δfloors × multiplier`. |
| **Accessibility profiles** | Esri wheelchair travel mode in the shipped template; Mappedin `{accessible:true}` and well-known `accessible` flag; IndoorAtlas edge tags `inaccessible` / `accessible-only` (SDK 3.7); IMDF `accessibility[]` on Opening/Unit/Amenity; MapsIndoors accessible wayfinding | Separate solve profile that prefers ramps/elevators and avoids stairs/escalators. IndoorAtlas also supports *accessible-only* edges (wheelchair lifts). |
| **One-way** | Esri `TRAVEL_DIRECTION` {Both, From-To, To-From}; IMDF directed Relationship through an Opening or escalator; IndoorAtlas directed edges; IndoorGML `isDirected` on DualSpaceLayer | Encoded on the edge / relationship; generation usually emits bidirectional and a human marks the exception (IndoorAtlas editor `+directed`). |
| **Temporal** | IMDF Relationship `hours` (reversible escalators; curated path variants); Esri Reservations / indoor events are *not* network attributes; Mappedin zones are runtime, not schedule | Only IMDF publishes a first-class temporal constraint on traversal. Mappedin runtime `zones` can model a spill or a closed wing, not a weekly timetable, unless the application feeds them. |
| **Clearance / width** | Esri obstacle buffer + lattice spacing; IMDF Opening width; Mappedin `accessible` “appropriate width for doorways”; ECM nearest-obstacle annotation (any disk radius); IndoorGML NonNavigableSpace for furniture | Two schools: (1) bake a single assumed body width into the graph (Esri buffer, IndoorAtlas drawn aisles); (2) keep clearance on the mesh and query per agent radius (ECM). |

Additional operational criteria that sources name without calling them “quality”:

- **Snapping / connectivity integrity** — Esri: pathways and transitions must snap vertex-to-vertex; disconnected vertices “may lead to issues with routing.” IndoorAtlas: off-graph query snaps to closest edge.
- **Landmark sparsity** — Esri: only “relatively sparse and easily recognizable” landmarks; 4 m corridor.
- **Public vs restricted** — Mappedin well-known `public` flag; IMDF Unit `restriction` (`employeesonly`, `restricted`); Esri Restricted Unit Features at generation time (those spaces never receive pathways).
- **Outdoor/indoor join** — Esri: manual; IndoorAtlas: graph edges that leave the building; IMDF `pedestrian.principal` / `pedestrian.transit` openings; Mappedin `outdoors` flag.

---

## 7. Open questions / unpublished internals

1. **Esri lattice internals.** 4- vs 8-connected fishnet; whether thinning is a multi-source Dijkstra tree, a set of *k*-nearest routes (the deprecated Neighbor Solve Count suggests the latter), or a Steiner-tree approximation; how UCN places intermediate vertices between unit centroids. No Esri patent describing this pipeline was found.

2. **Mappedin graph synthesis.** Maker AI is documented for walls/doors/windows, not for nodes. REST-exported MVF contains a full node graph that Maker-exported MVF v2 omitted. Whether the server runs MAT, CDT, lattice, visibility, or a learned tracer is unpublished.

3. **Apple / IMDF reference router.** IndoorGML 2.0 says IMDF’s derived network is “application specific.” Apple MapKit indoor sample is rendering-only. The Indoor Maps Program does not publish the graph that Apple Maps itself uses inside participating venues.

4. **HERE, MazeMap, MapsIndoors generators.** HERE authors maps for the customer. MazeMap and MapsIndoors claim AI / dynamic updates. None publish a skeleton algorithm.

5. **IndoorAtlas “generate a wayfinding graph” wording** on the product page vs the support article that describes a *manual editor*. Whether the Web App offers any automatic first-draft (and if so, from what) is unpublished; the support article the product page’s “step 2” resolves to is the editor.

6. **Stair / escalator 3D matching beyond footprint overlap.** Esri emits a vertical line (optionally hand-reshaped). IMDF asks for aligned half-length escalator units and leaves the metric path to the consumer. No vendor publishes an automatic landing-aware centreline of a stair flight.

7. **Learned generation.** No primary 2018–2026 paper that emits a routing graph from a neural model was retrieved. Door/wall *detection* (Mappedin, MazeMap) is not the same problem.

8. **ISO 19166** maps BIM concepts to GIS concepts and explicitly refuses to specify relationship mapping or any application mechanism. There is still no ISO algorithm for “IFC → pedestrian NRG.”

9. **Quality metrics with numbers.** Esri, Mappedin, and IndoorGML describe *preferences* (primary vs secondary, entryCost in metres, accessible flag). None of the vendor docs retrieved publish a numeric naturalness metric, a maximum spur length, a maximum foldback angle, or a doorway-approach-angle tolerance.

---

## References

### Esri ArcGIS Indoors

- [Create the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/create-the-indoors-network.htm) (also served from `https://doc.esri.com/en/arcgis-pro/latest/help/data/indoors/create-the-indoors-network.html`; last-modified 2026-06-22, Pro 3.7)
- [Update the indoor network](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/update-the-indoors-network.htm)
- [ArcGIS Indoors Information Model](https://pro.arcgis.com/en/pro-app/latest/help/data/indoors/arcgis-indoors-information-model.htm)
- [An overview of the Indoors Network toolset](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/an-overview-of-the-indoors-network-toolset.htm)
- [Generate Indoor Network Features](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-indoor-network-features.htm) (3.5 tool-reference URL also live)
- [Generate Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-indoor-pathways.htm) (deprecated)
- [Thin Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/thin-indoor-pathways.htm) (deprecated)
- [Generate Floor Transitions](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-floor-transitions.htm) (deprecated)
- [Classify Indoor Pathways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/classify-indoor-pathways.htm)
- [Create Indoor Network Dataset](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/create-indoor-network-dataset.htm)
- [Generate Facility Entryways](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/generate-facility-entryways.htm)
- [Import BIM To Indoor Dataset](https://pro.arcgis.com/en/pro-app/latest/tool-reference/indoors/import-bim-to-indoor-dataset.htm)
- [Create a travel mode](https://pro.arcgis.com/en/pro-app/latest/help/analysis/networks/create-travel-mode.htm)
- [Restriction attributes](https://pro.arcgis.com/en/pro-app/latest/help/analysis/networks/restriction-attributes.htm)
- [Create Network Dataset From Template](https://pro.arcgis.com/en/pro-app/latest/tool-reference/network-analyst/create-network-dataset-from-template.htm)
- [Build Network](https://pro.arcgis.com/en/pro-app/latest/tool-reference/network-analyst/build-network.htm)

### Mappedin

- [Developer Overview](https://developer.mappedin.com/docs/overview)
- [Mappedin Maker](https://developer.mappedin.com/docs/maker)
- [Editor product](https://www.mappedin.com/editor/)
- [Features](https://www.mappedin.com/features/)
- [MVF v3 Getting Started](https://developer.mappedin.com/docs/mvf/v3/getting-started)
- [MVF v3 specification overview](https://developer.mappedin.com/docs/mvf/v3/mvf-v3-specification/mvf-overview)
- [MVF v3 NodeProperties](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.nodes.NodeProperties.html)
- [MVF v3 Connection](https://docs.mappedin.com/mvf/v3/latest/types/_mappedin_mvf.connections.Connection.html)
- [MVF Navigation Flags](https://docs.mappedin.com/mvf/v3/latest/modules/_mappedin_mvf-navigation-flags.html)
- [MVF v2 Data Model](https://developer.mappedin.com/docs/mvf/v2/data-model)
- [Mappedin JS Wayfinding](https://developer.mappedin.com/web-sdk/wayfinding)

### Apple IMDF

- [IMDF Overview 1.0.0](https://register.apple.com/resources/imdf/)
- [Opening](https://register.apple.com/resources/imdf/types/opening)
- [Relationship](https://register.apple.com/resources/imdf/types/relationship)
- [Unit](https://register.apple.com/resources/imdf/types/unit)
- [Level](https://register.apple.com/resources/imdf/types/level)
- [Amenity](https://register.apple.com/resources/imdf/types/amenity)
- [Occupant](https://register.apple.com/resources/imdf/types/occupant)
- [Glossary](https://register.apple.com/resources/imdf/glossary)
- [Indoor Maps Program](https://register.apple.com/indoor)
- [Displaying an Indoor Map (MapKit)](https://developer.apple.com/documentation/mapkit/displaying-an-indoor-map)

### Other vendors

- [HERE Indoor Map — Introduction](https://docs.here.com/indoor-map/docs/indoor-map-readme)
- [HERE Indoor Map — Get started](https://docs.here.com/indoor-map/docs/indoor-map-quick-start)
- [IndoorAtlas homepage](https://www.indooratlas.com/)
- [IndoorAtlas Wayfinding product](https://www.indooratlas.com/solutions/indooratlas-wayfinding/)
- [IndoorAtlas Wayfinding Overview](https://support.indooratlas.com/support/solutions/articles/36000051251-wayfinding-overview)
- [IndoorAtlas Creating the Wayfinding Graph](https://support.indooratlas.com/support/solutions/articles/36000051250-creating-the-wayfinding-graph)
- [IndoorAtlas Using Wayfinding with Android](https://support.indooratlas.com/support/solutions/articles/36000095621-using-wayfinding-with-android)
- [MazeMap](https://www.mazemap.com/)
- [MazeMap — How to get started](https://www.mazemap.com/our-maps/how-to-get-started)
- [Google Maps Help — Indoor maps](https://support.google.com/maps/answer/2803784)
- [Mapbox iOS SDK — Indoor mapping](https://docs.mapbox.com/ios/maps/guides/indoor/)
- [MapsIndoors Wayfinding](https://docs.mapsindoors.com/sdks-and-frameworks/web/directions-and-routing)

### Standards and academic

- [OGC IndoorGML 1.1 (19-011r4)](https://docs.ogc.org/is/19-011r4/19-011r4.html)
- [OGC IndoorGML 2.0 Part 1 — Conceptual Model (22-045r5)](https://docs.ogc.org/is/22-045r5/22-045r5.html) and [PDF](https://docs.ogc.org/is/22-045r5/22-045r5.pdf)
- [OGC IndoorGML standard landing page](https://www.ogc.org/standards/indoorgml/)
- [ISO/TS 19166:2025 BIM to GIS conceptual mapping](https://www.iso.org/standard/90943.html)
- [ISO/TS 19166:2021 (withdrawn)](https://www.iso.org/standard/78899.html)
- Lee, Eastman, Lee, Kannala, Jeong (2010), “Computing Walking Distances within Buildings Using the Universal Circulation Network,” *Environment and Planning B* 37(4):628–645. [doi:10.1068/b35124](https://doi.org/10.1068/b35124) — [Sage page](https://journals.sagepub.com/doi/abs/10.1068/b35124)
- Chin, Snoeyink, Wang (1999), “Finding the Medial Axis of a Simple Polygon in Linear Time,” *Discrete & Computational Geometry* 21:405–420. [https://link.springer.com/article/10.1007/PL00009429](https://link.springer.com/article/10.1007/PL00009429)
- van Toll, Cook, van Kreveld, Geraerts (2017), “The Medial Axis of a Multi-Layered Environment and its Application as a Navigation Mesh.” [arXiv:1701.05141](https://arxiv.org/pdf/1701.05141)
- Lozano-Pérez & Wesley (1979), “An algorithm for planning collision-free paths among polyhedral obstacles,” *CACM* 22:560–570. [doi:10.1145/359156.359164](https://doi.org/10.1145/359156.359164)
- “A Modified Methodology for Generating Indoor Navigation Models” (2019), *ISPRS Int. J. Geo-Inf.* — landing page [https://www.mdpi.com/2220-9964/8/2/60](https://www.mdpi.com/2220-9964/8/2/60) (full text not retrieved; HTTP 403)
- “Automatic Generation of 3D Indoor Navigation Networks from Building Information Modeling Data Using Image Thinning” (2023), *ISPRS Int. J. Geo-Inf.* — landing page [https://www.mdpi.com/2220-9964/12/6/231](https://www.mdpi.com/2220-9964/12/6/231) (full text not retrieved; HTTP 403)
