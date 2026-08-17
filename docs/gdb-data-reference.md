# GDB Data & Routing Reference

Durable reference for the JR East Tokyo Station source data (three File Geodatabases), the routing network, point facilities, and how Kiriko turns them into a published bundle with routing. Captured 2026-07-20 from direct `ogrinfo`/`ogr2ogr` probing of the real datasets. Read this before touching GDB import, `kiriko-route`, `kiriko-facilities`, or the KVB section layout.

## Source dataset layout

The Tokyo dataset is three sibling File Geodatabases (all **EPSG:3857 / WebMercator**; Kiriko reprojects to **EPSG:4326 / WGS84** on import via `ogr2ogr -t_srs EPSG:4326`):

```
tokyo station/
  JRTokyoSta_3857.gdb                 ← venue geometry (IMDF-shaped)
  network_WebMercator.gdb             ← routing graph (nodes + edges)
  point_facility_WebMercator_202006.gdb  ← POIs, wifi, beacons, floor outlines
```

A File Geodatabase is a **directory**; upload/inspection expects it zipped as `<name>.gdb.zip`. gdal3.js's OpenFileGDB driver sniffs the `.gdb.zip`/`.zip` extension, so a blob with no extension must be staged to a `*.gdb.zip` path first (`server/src/gdb/staging.ts`).

## 1. Venue GDB — `JRTokyoSta_3857.gdb`

- **318 layers.** Geometry families: **139 line / 170 polygon / 9 point**.
- Per-building/per-floor layers named `<Building>_<Floor>_<Kind>`:
  - `*_Drawing` (MultiLineString) — walls / detail linework, **not routable**.
  - `*_Opening` (MultiLineString) — IMDF openings (doorway connections); the standard IMDF connectivity signal. Fields: `id, floor_id, name, source, Shape_Length`.
  - `*_detail`, `*_opening` (lowercase variants for some buildings, e.g. `TOFROM_YAESU_*`) carry `category, level_id, access_con, door, …`.
  - Polygon layers are the walkable spaces / fixtures (units).
- Also outdoor/context lines: `軌道の中心線_*` (rail track centerlines), `道路縁`/`道路構成線` (road edges), `Free_shuttle_bus_*ルート` (outdoor shuttle bus routes). **None of these is an indoor pedestrian routing network** — the venue GDB alone has no routing graph.
- This GDB is what the existing GDB import converts into synthesized IMDF (`server/src/gdb/*`), compiled to KVB by the Rust core.

## 2. Network GDB — `network_WebMercator.gdb` (routing graph)

- **68 layers.** The canonical graph is two layers; the rest are per-floor / inter-floor slices of it.
- **`net_junction`** — Point, **10,118 nodes**. Fields:
  - `NODEID` (unique node id), `FLOOR` (`F1`/`B1`/`F36`/`M2`…), `altitude`, `relative_height`, `PATH_COUNT` (degree), `BARRIER`, `GATE`, `STARTTIME`/`ENDTIME` (time windows, `-1` = none), `NAME`.
- **`net_path`** — MultiLineString, **25,625 edges**. Fields:
  - `FNODEID`→`TNODEID` (endpoint NODEIDs), `cost` (integer edge weight — **already encodes passage penalty**: a 2 m walk ≈ 2k, a floor change ≈ 32k), `passage_type`, `direction` (one-way hint; often null/0 = bidirectional), `FLOOR`, `PATHID`/`RPATHID` (forward/reverse ids), `BARRIER`, `RFLAG`, `HFLAG`, `STARTTIME`/`ENDTIME`, altitudes.
- **`*_link` layers** (e.g. `JRTokyoSt_1_link`, `TokyoSt_F5_to_F6_link`) — per-floor and inter-floor decompositions of the same graph, with `node1`/`node2`/`path_cost`/`FLOOR1`/`FLOOR2`/`passage_type`/`start_altitude`/`end_altitude`. **Not the canonical source** — use `net_junction` + `net_path`.

## 3. Point-facility GDB — `point_facility_WebMercator_202006.gdb`

- **8 layers:**
  | layer | geom | feats | use |
  |---|---|---|---|
  | `point_facility_network` | Point | 2426 | POIs with **routing linkage** (`nodeid1`) but **no icon field** |
  | `point_facility` | Point | 2426 | POIs (routing linkage; also **no icon field**) |
  | `Facility_Merge` | Point | 2591 | **icon-bearing POIs** (`image` field) — the layer Kiriko imports for markers; incl. building/area overlays |
  | `Facility_Merge_tap` | Point | 135 | tappable/labeled subset |
  | `wifi` | Point | 288 | WiFi APs (positioning — Phase 6) |
  | `beacon` | Point | 540 | beacons (positioning — Phase 6) |
  | `floor_all` | MultiPolygon | 16 | per-floor outline polygons |
  | `not_ar` | MultiPolygon | 5 | (non-AR regions) |
- **`Facility_Merge` fields** (the imported icon layer): `name`, `category` (`movement`, `Tickets`, `area`, …), `floor`, `image` (icon path like `/marker/escalator.png`; empty for named-store/`.svg` icons), `symbol_id` (e.g. `1039_0300`), `pict_scale` (0.08–0.48), `min_zoom_level`/`max_zoom_level`, `color`. **No routing linkage.**
- **`point_facility_network` fields** (routing layer, **not** imported — it has **no `image`**): `name`, `symbol_id`, `floor`, `w3` (location description), and **routing linkage** `nodeid1`/`nodeid2` (net_junction NODEIDs, `-1` = none), `node1_len`/`node2_len`, `pathid`, `node_index`. The two layers do **not** join cleanly (id/symbol_id/exact-coords all mismatch), so Kiriko draws markers from `Facility_Merge` and derives each route anchor by proximity instead of `nodeid1`.

## Floor labels → ordinals

Network and facility `FLOOR`/`floor` labels map to venue level ordinals via `kiriko_route::floor_to_ordinal`, kept in lockstep with the venue importer's `parseFloorToken` (`server/src/gdb/mapping.ts`) so points land on the venue's floors:

- `F<n>` → `n - 1`  (F1 = ground = ordinal 0; F36 → 35)
- `B<n>` → `-n`     (B1 → -1; B5 → -5)
- `M<n>` (mezzanine) → `n`  — matches the venue, whose `M2F` levels are ordinal 2 (the venue has **no** fractional ordinals; do not use `n-0.5`)
- `<letters>B<n>` deep basements (`KB3`, `SB4` — Keiyo/Sobu lines) → `-n`; a single trailing `F` is tolerated (`SB4F` → -4)
- case-insensitive; roof (`R`/`RF`), empty, or junk → unmapped → node/facility dropped with a warning.

**Both parsers must stay aligned.** When they diverged, facilities on `KB*/SB*` floors were silently dropped and `M2` facilities landed on a phantom ordinal `1.5` the venue never has. `parseFloorToken` was also 1-based (`F1` → 1) against `floor_to_ordinal`'s 0-based `F1` → 0 until it was corrected; a level parser that is off by one puts whole floors on the wrong ordinal.

**Level ordinals come from the floor label, not the source `ordinal` attribute.** `resolveLevelOrdinal` tries `levelRule` (the `floor` field) → `short_name` → `name` → **then** the layer's `ordinal` field, which is a last resort only for rows whose labels do not parse. The source attribute cannot be trusted: across the JR East databases it mixes conventions — `F2` is `ordinal` 2 in `JRTakanawaGatewaySta_2_Floor` but `ordinal` 1 in `LinkPillar1_2_Floor`, while the `floor` field is a consistent `F<n>` everywhere. Trusting the attribute merged Takanawa 1F and LinkPillar 2F onto ordinal 1, and because the floor selector and the network-review overlay both filter by ordinal alone, they drew two different physical floors at once.

## Icons

- 34 generic facility PNGs are staged at `src/map/icons/marker/` (elevator, escalator, stairs_up/down, ticket, locker, bus, taxi, male/female/unisex, info, smoking, …).
- Facilities reference icons via the `Facility_Merge` `image` field basename (`/marker/escalator.png` → `escalator`). **Named-store/building images (e.g. `marunouchi_bldg.png`) and `.svg` entries are NOT in the staged set** — those facilities fall back to a generic **pin** marker.

## Kiriko pipeline (how it all comes together)

**Boundary rule:** GDAL runs in TypeScript (gdal3.js, server-side, `server/src/gdb/`). **All interpretation of venue/network/facility data is Rust** (`kiriko-*` crates). The server extracts layers to WGS84 GeoJSON and moves bytes; it never parses geometry.

**Combined GDB import** (one publish → one bundle → one `source_kind='gdb'` version):
- `POST /api/gdb/inspect` — venue GDB → layer summary + suggested plan (`blobHash`).
- `POST /api/gdb/inspect-network` — network GDB → `{ networkBlobHash, nodeCount, edgeCount, floors }`.
- `POST /api/gdb/inspect-facilities` — point-facility GDB → `{ facilitiesBlobHash, facilityCount, floors }` (extracts the `Facility_Merge` layer).
- `POST /api/gdb/publish` — `{ venueId, blobHash, plan, networkBlobHash?, facilitiesBlobHash? }`. Server converts venue layers → synthesized IMDF, extracts `net_junction`/`net_path` and `Facility_Merge` → GeoJSON, and threads all of it into `compileImdf` (napi). The Rust core builds the graph and facilities and embeds them in the bundle.

**Building-scoped import.** The review dialog (`src/gallery/GdbImportDialog.tsx`) groups
layers by building: each building gets a tri-state checkbox (checked/unchecked/
indeterminate over its layers) plus included/total/feature counts, and a
building-filter dropdown narrows the layer table to one building at a time.
The checkbox derives its intent from the group's own state, not from the DOM
event: a group with anything included becomes fully excluded, and a group with
nothing included is restored. (This matters because a partially-included group
renders unchecked+indeterminate, and clicking an unchecked box always reports
`checked === true` — trusting the event would make partial buildings, which is
most of them on a real dataset, impossible to deselect.) So unchecking a
building sets every one of its layers to excluded; re-checking it restores the
*server's originally suggested* inclusion per layer (frozen at dialog mount)
rather than blanket-including everything, so heuristic exclusions (zero-feature
layers, `_to_` cross-floor layers) don't come back as junk. Layers with no `buildingId` — outdoor/site-wide layers such as rail
centerlines or road edges — sit in an **Unassigned / outdoor** group with the
same checkbox/counts treatment. Selecting exactly one building prefills the
venue-name field with that building's name (until the user types their own).
Selecting a subset imports one venue containing just those buildings; to split
a GDB into several venues, re-run the import once per building — the source
blob is content-addressed by hash, so re-running costs no re-upload.

Because the network and point-facility GDBs carry no building field, a subset
import can also **clip** them to the imported venue. The dialog has a clip
checkbox that starts unchecked and auto-enables the first time any **building**
is deselected (a sensible default once the network no longer matches the whole
venue); unticking the Unassigned / outdoor bucket does not trigger it, since
dropping outdoor layers doesn't change which buildings the venue covers. Once
the user touches the checkbox explicitly, their choice sticks and further
building toggles don't override it.

That choice is `clipToSelection` on the persisted mapping plan
(`versions.gdb_plan_json`). Persisting it is not enough on its own: the
compiler reads the **job payload**, not the version row, so every re-publish
path has to lift the flag out of the stored plan and pass it to
`enqueuePublication`'s third argument. All three do —
`/api/gdb/augment` (attaching a network/facility GDB later via **Add data**,
which has no clip checkbox of its own), `/api/gdb/generate-network`, and
`/api/gdb/import-network` — via `storedPlanClipsToSelection`
(`server/src/gdb/routes.ts`). The deciding reason on the latter two is §7
rather than §5: `facilities_blob_hash` points at the *raw, unclipped*
extraction and is re-clipped at compile time, so carrying it forward without
the flag would silently widen a clipped venue's facilities back to the whole
site. (For a synthesized graph the §5 clip is a near no-op — synthesis derives
the network from the same level/unit polygons the region is built from.)

At the publish bridge the flag becomes
`clipToVenue` on `CompileVenueMetadata` (`server/src/core/native.ts`), and
Rust's `compile_imdf_with_network` (`core/crates/kiriko-bundle/src/codec.rs`)
builds a `ClipRegion` (`core/crates/kiriko-bundle/src/clip.rs`) from the
imported venue's **level and unit polygons only** — the synthesized
**building** polygons are skipped because they are bounding rectangles that
overlap heavily for adjacent structures like Tokyo Station's, which would leak
a neighbour's nodes wholesale. Note this is a difference of degree, not kind:
*synthetic* levels (`resolveOrCreateLevel` in `server/src/gdb/mapping.ts`, for
ordinals with no source level feature) also get a `rectanglePolygon` over their
assigned features, so the region is not purely real geometry and can
over-include. See the outstanding-verification bullet under Known follow-ups.
Polygons are bucketed by level ordinal (matched via `level.ordinal` for
level features, `level_id → ordinal` for unit features); a node or facility
counts as inside its own ordinal's region if it falls within the polygon, or
within a `CLIP_BUFFER_M` = 2 m tolerance of its boundary (network nodes sit on
corridor centrelines digitized independently of the venue polygons, so a node
can land up to about a metre outside the unit it belongs to). A graph edge
survives clipping only if both endpoints do.

There are no new `WarningCode` variants for this — clipping reuses the
existing `route_build` (`WarningCode::RouteBuild`) and `facility_build`
(`WarningCode::FacilityBuild`) codes, with the detail riding in the message
text. `codec.rs` emits, when clipping is enabled: `clip_region_empty: …` (up
front, once, if the imported venue has no level/unit polygons to clip
against at all) under `route_build`; `network_clipped: dropped N nodes and M
edges outside the imported venue` under `route_build` whenever the graph
build or synth branch drops anything, immediately followed by
`network_clip_empty: clipping removed every routable edge; no routing graph
was embedded` under `route_build` if clipping empties the graph entirely (in
which case §5 is omitted from the bundle); and `facilities_clipped: dropped N
facilities outside the imported venue` under `facility_build` whenever
facility clipping drops anything.

**The clip depends on correct ordinals.** It matches nodes and facilities to
polygons purely by ordinal, so `buildFloorSynonyms`/`parseFloorToken`
(`server/src/gdb/mapping.ts`) and `kiriko_route::floor_to_ordinal` must stay
aligned — an off-by-one there tests every node against the wrong floor's
polygons.

**KVB bundle sections** (`kiriko-bundle`, `core/crates/kiriko-bundle/src/format.rs`):
- `1 manifest`, `2 geometry`, `3 stores` — always (IMDF).
- `5 graph` — routing graph, present when a network GDB was imported. §5 edges carry per-edge `interior` polyline geometry + `ordinal`.
- `7 facilities` — point facilities, present when a point-facility GDB was imported.
- `8 spatial context` — one shared WGS84 local east-north-up frame per venue version (anchored at the canonical venue horizontal-bounds centre, with ECEF/world transforms, declared units, and the vertical normalisation offset) plus the typed evidence registries (artifacts, locators, datums, transforms, registration evidence, assumptions, confidence, manual provenance), bounded source-property preservation, and a floor-plane record per level: resolved scene Z as checked integer millimetres, the resolution method (explicit elevation / preserved network altitude / nominal spacing), a confidence value, and evidence references. Resolution precedence: the level feature's `elevation` source property (key configurable via the versioned `ResolutionProfile`), then a trustworthy preserved `net_junction.altitude` median (≥3 junctions within 1.0 m), then configurable nominal floor spacing (default 4.0 m) off the lowest real plane. A network altitude that disagrees with an imported elevation is recorded as a difference — never overwrites either value. Network altitudes ride on `RouteGraphBuild` only; the §5 byte schema is unchanged. A producer may override any level's resolved plane (`compile_imdf_with_network` overrides): the override moves the effective plane, is marked with manual provenance (`actor`/`reason` in the `manual_provenance` registry), and never touches the original source elevation, the resolution method/evidence, other levels, or the frame — so an overridden plane may sit below the automatic minimum (negative scene Z). An override naming a level the venue lacks warns with code `floor_override`. Removing the override returns the level to automatic resolution from the unchanged source value.

**Legacy bundles (pre-§8, e.g. `tests/fixtures/legacy-minimal.kvb`, the real artifact published before 3D Stage 0).** A bundle with no §8 row decodes exactly as before — capability `absent` (never `invalid`), content and routing untouched, nothing rewritten or republished. `level_elevations` (Rust) / `levelElevations` (wasm) answer every level with `legacyUnknown`/`LegacyUnknown`: no confidence and no number are ever fabricated — the absence is structural, so a reviewer sees "we do not know this" rather than a value that looks measured.

**Stage 0 verification (fixtures in `tests/fixtures/`).** `stage0.kvb` is the final-shape bundle (required sections + graph + facilities + §8) frozen as bytes and pinned by sha256 + an exact recompile comparison; `stage0-unsupported/invalid/disabled.kvb` freeze the remaining capability outcomes. Rust integration tests strip §8 from `stage0.kvb` and prove the content and routing are identical to the §8-less equivalent; the server suite's `crossAdapter.test.ts` proves the native addon and the browser module report identical capabilities per outcome on the same bytes. The registered JR East Tokyo dataset is a data-gated acceptance (`server/test/stage0Tokyo.test.ts`, `KIRIKO_TOKYO_FIXTURES`, default `<repo>/../tokyo station/`) — it skips when the registered data is not present.
- `4 style`, `6 beacons` — reserved, not emitted.
- `12 graph attrs` (`SECTION_GRAPH_ATTRS`; TS capability field `graphAttrs`) — **implemented** (generated-network quality): per-edge `EdgeAttrs` for the §5 graph, encoded as a postcard `GraphAttrsSectionDto { edges: Vec<GraphEdgeAttrDto> }` in the **same order and length as §5 edges**. Each row carries `kind` (`imported` / `skeleton` / `doorway` / `stub` / `bridge` / `chord` / `vertical` / `transit_attach`), `rank` (`1` primary / `2` secondary), `clearance_m` (midpoint half-width in metres when known; `null` when unknown — never `0.0`), and `vertical` (`elevator` / `escalator` / `stairs`; `null` unless the edge is a vertical). Dependency: **requires §5** — with §5 absent or unreadable, §12 reports `disabledByDependency`. Emitted only when at least one edge is non-default, so imported Tokyo bundles and every pre-attrs bundle stay byte-identical on §5. A length mismatch or any invalid row — unknown discriminant, non-finite clearance, or a row violating the invariant `vertical.is_some()` iff `kind == vertical` — reports §12 `invalid` and leaves **every** edge at `EdgeAttrs::default()`; the §5 graph itself always loads. `clip_graph` copies attrs with the edge; `export_network` writes them as `EDGE_KIND` / `PATHWAY_RANK` / `CLEARANCE_M` / `TRANSITION_CATEGORY` (with `HFLAG`/`passage_type` = 1 iff `kind == vertical`, endpoint-ordinal mismatch kept as the legacy fallback), and `build_route_graph` reads the properties back when present, defaulting when missing.
- `13 graph traversal` (`SECTION_GRAPH_TRAVERSAL`; TS capability field `graphTraversal`) — **implemented**: one `EdgeFlags` row per §5 edge (direction, barrier, gate, start/end minute, wheelchair, accessible_only). Requires §5. Emitted only when at least one edge's flags differ from the default (bidirectional, open, wheelchair-ok). An unknown `direction` discriminant or a length mismatch reports §13 `invalid` and leaves flags at default; §5 still loads. `export_network` writes `direction` (`null` / `1` / `2`), `BARRIER`/`GATE` (`1`/`0`), and `STARTTIME`/`ENDTIME` (stored i32; `-1` = none) onto `net_path` features; `build_route_graph` reads them back from the kept (smaller PATHID) feature.
- Sections `9` (scene sources), `10` (canonical graph), `11` (network QA) are declared format ids with dependency edges onto §8. **§9 is implemented** (3D Stage 1): the compile path emits a generated scene for every venue with computable geometry — one slab per level and one navigable surface + ceiling per unit (unit `height` source property overrides the versioned nominal wall/ceiling height), one wall per unique unit-boundary edge (shared edges dedupe to the minimum of the two heights; `Drawing` lines are detail linework unless they corroborate a boundary), explicit portal topology from openings on boundaries (unit-to-unit or unit-to-slab), and neutral conveyance forms (kind `neutral`, never fabricated machinery) from vertical graph connections and transit-category footprints. Geometry is venue-local checked integer millimetres projected through the §8 ENU frame onto the resolved planes; every primitive references §8's registries for evidence, confidence, and assumptions. The typed tiles descriptor slot (hashes, activation state, floor mappings, source-object associations, contextual classifications — never a URL or GLB bytes) is part of the section but unused until Stage 3. **Scene-source adapter contract.** The Generated scene is exposed through one renderer-neutral contract (`kiriko-model::scene_projection`, `SceneSource`): identity/provenance, the venue-local frame and world transform from §8, canonical level groups with resolved planes and scene bounds, primitives with semantic role/occlusion/confidence/associations/evidence, typed capability state (ready/absent/invalid/unsupported/disabled-by-dependency), and pick results that can never let an unassociated source object impersonate a canonical feature. Tiles (Stage 3) implements the same contract. The wasm `sceneProjection` and the native addon's `sceneProjection` report identical typed projections for the same bytes; TypeScript mirrors the types and never decodes section bytes, interprets source-property keys, or resolves elevation. **Stage 1 verification (fixtures in `tests/fixtures/`).** `stage0.kvb` is the final-shape scene-carrying bundle (required sections + routing graph + facilities + §8 + generated §9 scene) frozen as bytes, sha256-pinned and recompile-exact; the libm geodesy keeps the golden byte-stable across platforms. Rust integration tests strip the §9 row and prove every other field (including §8 and the graph) decodes identically with routing equal and the scene capability `absent`; the crafted `stage0-unsupported/invalid/disabled` fixtures pin the scene's dependency outcomes. Cross-adapter parity (five outcome fixtures, six report fields + typed scene projections) lives in the server suite; the registered JR East Tokyo dataset is a data-gated acceptance (`server/test/stage1Tokyo.test.ts`). §10 and §11 remain declared-only: a present row is never interpreted by a decoder that predates them.
- Sections 5, 7, 8, 12, and 13 are **optional and backward compatible**: older decoders read 1–3 and ignore unknown ids. Directory rows are id-ascending. Availability of every optional/declared section is reported through the capability model (available / absent / unsupported version / invalid / disabled by dependency), so one unreadable optional section never costs a reader the venue.

**Routing (`kiriko-route`):**
- `build_route_graph(junctions_geojson, paths_geojson, level_ordinals)` → `RouteGraphBuild { graph, warnings, node_ids }`. Nodes carry `(lon, lat, ordinal)`; edges carry `(from, to, weight = net_path.cost, ordinal, interior)` where `interior` is the `net_path` polyline's bend points with the two endpoint vertices stripped (empty for the ~97% straight edges). Full edge polyline = `[from node, …interior…, to node]`. `node_ids[i]` is the source NODEID of `graph.nodes[i]`.
- Query-time `RouteProfile` honours imported `direction` (one-way relative to the kept `from → to`), `BARRIER` (skipped unless `allow_barriers`), and `STARTTIME`/`ENDTIME` (when `at_minutes` is set; wrap if start > end). `GATE` is stored and not yet a restriction. Reciprocal `PATHID`/`RPATHID` pairs still collapse to one graph edge; one-way is a flag on the kept (smaller PATHID) feature. `passage_type` is not re-penalized on top of `cost`.
- `route(graph, origin, dest)` **projects** each endpoint onto the nearest same-floor edge (`snap_to_edge`, not just the nearest node), runs A\* between the four virtual endpoints (partial-edge cost proportioned by polyline length; same-edge case shortcut), and returns `Route { segments, total_weight, origin_projected, dest_projected }`. `segments` are the reconstructed corridor polyline split into maximal same-ordinal runs, so the route **traces the real `net_path` geometry** instead of straight node-to-node chords.
- WASM: `routeBundle(bundle, oLon,oLat,oOrd, dLon,dLat,dOrd)` decodes §5, runs A\*, then **smooths the raw polyline against the venue's own walkable floors** (greedy-LOS string-pull, next bullet) and returns the floor-grouped `segments` + projected endpoints. The viewer draws each segment's polyline (floor-filtered) plus a dashed **connector** from each raw click to its projected point.
- **Query-time greedy-LOS** (`kiriko_route::smooth_route`, built in `kiriko-bundle` as `walkable_floors(document)`): `route()` stays graph-only; after A\* a separate pass string-pulls each `RouteSegment`'s polyline — from vertex `i`, take the farthest `j > i` whose chord `i→j` stays inside the floor's walkable union (sampled ≤ 0.5 m, endpoints included; `SEGMENT_OUTSIDE_TOL_M` = 0.3 m exterior tolerance, holes never shrink) and does not skip a **lock** (opening midpoint or transit centroid) within `DOOR_LOCK_M` = 0.4 m of an intermediate vertex (degree-2-only skips; a lock on a kept vertex stays). No smoothing across floor changes; no segment is added, removed, or merged; `total_weight` is **unchanged** — smoothing is geometry, the graph cost stands. `WalkableFloor { ordinal, polygons, locks }` comes from the document's walkway units + openings + transit centroids; empty `floors` → identity, so imported-network callers that pass no geometry are unaffected. Hand-rolled PIP/segment math — no `geo` in wasm.

**Generated network (`synth_medial`, `POST /api/gdb/generate-network` with `synthesizeNetwork: true`):** walkable IMDF units → CDT medial-axis centerline graph, plus doorway stubs, blob bridges, open-space chords, and vertical transit matching. All of this affects **newly generated** networks only; published versions are unchanged until the producer re-runs Generate routing, and a new generate writes §5 + optional §12.
- **Lazy doorway stubs:** each opening gets candidate 1.2 m stub sides (`DOORWAY_STUB_M`) along the detected passage axis at its midpoint, but a side node + midpoint edge is **materialized only when a skeleton or transit attachment actually uses it** — a direct midpoint attachment or a thin-walkway door leaves no synthetic out-and-back leaf. A materialized side is reused (idempotent) by every later consumer.
- **1-1 verticals:** transit units (`elevator`/`escalator`/`stairs`) on adjacent floor pairs are matched by **minimum-cost maximum-cardinality matching** on horizontal centroid distance, so no upper unit ever receives fan-in from two lower ones; unmatched transit units do not become vertical edges.
- **Connection costs:** a vertical edge's weight is `vertical_cost_m(kind, lower_ord, upper_ord)` = a fixed entry (elevator 15.0 m, escalator/stairs 0.0 m) plus the ordinal span × per-floor charge (elevator 1.0 m, escalator 4.0 m, stairs 10.0 m), then the single metres → cost conversion (`× 1000`) applies once. Horizontal centroid displacement is deliberately excluded — a floor change costs like a Connection, not a slightly-more-expensive hallway, and the A\* heuristic stays admissible.
- **Hallway rank:** after a floor's edges are emitted (skeleton, doorway, bridge, chord, transit attach) and before verticals, any horizontal `Skeleton`/`Bridge`/`Chord` edge whose midpoint falls inside a non-walkway, non-transit unit polygon (rooms etc.) is demoted to `rank = Secondary` and charged `SECONDARY_RANK_FACTOR` = 3× its metre length, applied **before** the global metres-to-cost conversion. Doorway, stub, transit-attach, and vertical edges are never ranked secondary; imported graphs are not classified.
- **Obstacles:** `navigable_area(walkables, obstacles)` subtracts, per floor: unit polygons whose category is neither walkway nor transit (including `unenclosedarea`), `Fixture`/`Kiosk` polygons, and `Detail` linework buffered to `OBSTACLE_BUFFER_M` = 0.4 m stadiums (degenerate segments skipped; never fails the floor) — so the medial axis routes around real obstacles and buffered walls. The `MIN_PASSAGE_M` prune remains.

**Facilities (`kiriko-facilities`):**
- `build_facilities(geojson, graph)` → `Facilities`. Each `Facility` has `(lon, lat, ordinal, name, icon, anchor?)` — position is the **verbatim GDB coordinate**, `icon` is the `image` basename. `anchor` is that same position used as the **route-to-facility** destination (the A\* router snaps it to the nearest node at query time), set only when the facility's floor carries a route-graph node; `None` otherwise.
- WASM: `facilities(bundle)` decodes §7; viewer renders a floor-filtered GL symbol layer (icon by `image` basename, pin fallback) and offers **Route here** on tap.

**Rendering the scene (`kiriko-scene` + `src/map/scene/`):**
- `compile_generated_scene(scene, spatial, features)` turns §9 primitives plus §8's resolved planes and confidence registry into the **KSC1 render document** — the same container the GLB deriver produces for a Tiles package (Stage 3), so one renderer serves both sources (#23 D4). Levels mirror §8 in order (that order is the document's level index space); features are pickable objects (`source_object_id` = the §9 primitive id); geometry is merged into one **batch per `(level, role)`** with `u16` positions quantized inside per-batch bounds, octahedral `i16` normals, and a `u32` feature index per vertex.
- Semantic roles come from the canonical feature's **IMDF category** (a closed vocabulary, matched exactly), never a guess: an unevidenced conveyance stays the untyped `Conveyance` role, and a level slab is `Context` — the floor plate, not a navigability claim, and a distinct role because it is coplanar with the finishes on it.
- WASM: `generatedScene(bundle)` compiles and describes the document (JSON meta + packed payload) in the **bundle worker**; `decodeScene(kscene)` is the Tiles entry. `readScene` builds typed array views without copying the payload.
- The layer (`sceneLayer.ts`) is one WebGL2 `CustomLayerInterface` (`renderingMode: "3d"`). Quantization is folded into a model matrix composed in `f64` **relative to the venue anchor**; the mercator scale is per-axis from the WGS84 radii of curvature, because MapLibre's `meterInMercatorCoordinateUnits` is mean-radius spherical and drifts 2.26 m per kilometre against the venue's own 2D features. Paint order and depth bias (`scenePolicy.ts`) resolve coplanar indoor geometry: contextual mass first and biased back, openings biased forward of their walls.
- The viewer opts in with `?scene` and raises `maxPitch` to 60 only while a scene is attached; the capability preflight and 2D fallback are #62, the rest of the visual language #63.
- **Picking** (`scenePick.ts` + the layer's `pickAt`) renders one scissored pixel of a multi-target pass — attachment 0 the feature id as RGBA8, attachment 1 the venue-local position as RGBA32F — so the depth buffer that resolved the picture also resolves the pick. Requires `EXT_color_buffer_float`; the spike's RGBA8 depth approximation is **not** promoted. The id is stored shifted by one so a cleared target (all zero) stays "no hit". Only fully visible batches are drawn into the pass: a hidden floor or ceiling can never intercept a click. First pick per session is warmed during load (~20 ms of driver validation against ~2 ms warm), and hover picking stands aside while the camera moves — a synchronous readback mid-drag waits out the in-flight frame (30 ms measured) — then re-picks on `moveend`.
- A pick's position is the **placement authority in 3D**: MapLibre's `lngLat` unprojects onto the map plane at zero elevation, so on a pitched camera a click on an upper floor lands metres away. `localToLngLat` inverts the scene's own world transform, and issue placement, directions point-picking, and network editing coordinates all use it when a pick hit.
- Selection semantics: a surface with no canonical feature (wall, opening) and contextual mass (`Context` — a level's floor plate) both select **nothing**, matching 2D where bare floor clears. Selection and hover render in Ai Indigo only, and panel/keyboard selection drives the same highlight.
- **Capability floor** (`sceneCapability.ts`): WebGL2 + at least two draw buffers whose two-output program actually links with explicit `layout(location = N)` + `EXT_color_buffer_float` whose `RGBA32F` attachment reports framebuffer-complete. Probed on a throwaway context before anything is fetched, so a device that cannot render 3D never downloads a scene. One tier, no partial 3D; the notice tells the reviewer what they get, never which extension is missing.
- **Fallback machine** (`sceneSource.ts`): one active source at a time — the type-level form of "no frame contains two sources". A quality fallback (floor unmet, load failed, reviewer chose 2D) is one-way until an explicit Retry; a **lost context** recovers automatically, bounded by `MAX_3D_RETRIES`, so a failing GPU settles on the view that works. Swaps show a brief canvas-coloured veil, suppressed entirely under reduced motion. Route, floor, and selection are untouched by a swap because they live in app state, not in the renderer.
- **Labels** (`sceneLabels.ts` + `useSceneLabels.ts`): the 3D view has its own DOM overlay, placed from the renderer's projection (`projectLocal`) so a label sits on the floor it names — MapLibre's `project` answers for the map plane at zero elevation, which is metres wrong on a pitched camera. Capped at 4 in guidance and 6 in overview, ordered `nextAction → destination → selection → conveyance → exit → landmark` (the first two reserved for Stage 5), displaced along a deterministic ladder when boxes collide, with a leader line once a label leaves its resting place by more than 18 px. The viewer's own chrome is measured each layout and treated as taken space. The flat marker overlay stands down while the scene renders: two overlays would print every name twice.
- **Conveyance badges** reuse the JIS pictograms (`markerIconFor`). The set has no ramp pictogram, so `ramp`/`movingwalkway` get the neutral inclined plane with one static slope chevron (`conveyanceGlyphs.ts`) rather than a borrowed pictogram or nothing at all.
- **Floor handoff**: changing floors shows the floors just left as low-opacity context for `CONTEXT_HANDOFF_MS` (160 ms, inside #32's 140–180 ms window), and a context floor's ceilings fade further (15%) because they are the protected-corridor occluders between the camera and the active floor. Nothing else in the scene dissolves for the camera. Reduced motion skips the context pass: same floor states, in the same order, nothing interpolated. During a handoff more than one floor draws, which is the all-levels budget (≤320), not the per-level one (≤8).
- **Proof surfaces** (#64). Runtime budgets live in the single-worker performance project (`e2e/viewer.scene-performance.spec.ts`): decode ≤ 1,200 ms measured as a `performance.measure` span across fetch + worker compile + reader, upload ≤ 200 ms reported as `SceneLayerStats.uploadMs`, draw calls per level and across the venue, plus stability and pick identity at high zoom and pitch. The capture requirement needs the drawing buffer readable, which costs frame time, so it is opt-in: `?capture=1` sets `preserveDrawingBuffer` and every pixel assertion first proves two different scenes produce different bytes through that same path. The station-scale property — ≥ 15× primitive collapse, which is what makes the draw-call budget reachable and is meaningless on a three-floor fixture — is asserted on the registered dataset:

  ```bash
  KIRIKO_TOKYO_FIXTURES=/path/to/tokyo\ station pnpm --dir server exec vitest run test/stage2Tokyo.test.ts
  ```

- **Context loss**: the canvas listeners live for the map's lifetime, not the layer's — the layer unmounts the instant the context dies, so a restore listener owned by the layer would never be heard. `webglcontextlost` is `preventDefault`ed (without it the browser never restores), the layer is torn down, and re-attachment happens when the machine puts the scene back in props. MapLibre drops custom layers itself on loss and nulls its style, so every call into it during that window is guarded (`styleReady`) — an unguarded `getLayer` in effect cleanup crashed the React tree.

**Tile serving (`server/src/serve/tiles.ts`, #73):**
- `GET /v/:tenant/:venue/tiles` — latest scene descriptor: `{ versionId, seq,
  baseUrl, rootTileset, totalBytes }`, revalidating (`must-revalidate`), ETag =
  the package source hash. It answers "what should I load now?", so it must not
  cache immutably.
- `GET /v/:tenant/:venue/tiles@<versionPublicId>/<member path>` — pinned bytes:
  hash ETag, `immutable` for a year, the member's recorded content type,
  `Accept-Ranges: bytes`, and 206/416 range handling (`server/src/serve/range.ts`).
- **Member URLs are paths, not hashes.** A tileset's `content.uri` values are
  relative, so path-addressed members let Kiriko serve the producer's tileset
  JSON byte-for-byte instead of rewriting URIs — which would break the hash its
  own ETag promises.
- **Access is inherited, not restated.** Both bundle and tile routes resolve
  through `findPublishedVersion` (`server/src/serve/version.ts`); "private" today
  means "not published". A member is reachable only through a version whose own
  package contains that path, so a hash in the store is never a capability and no
  URL reaches across versions or venues.
- Ranges stream in place via `BlobStore.stream(hash, range)`; serving never
  writes a derived copy, so a 200 MiB member costs no extra disk and a 1 MiB
  resume reads 1 MiB.
- Multi-range and malformed `Range` headers are answered whole (RFC 9110 permits
  ignoring a range): a confident 206 of the wrong bytes is worse than a complete
  response, because the client believes it.

**Tile member lifecycle and collection (`server/src/tiles/storage.ts`, #72):**
- Members live in the shared content-addressed store (`blobs/sha256/`), *not*
  inside the KVB — a 172 MiB package must not be copied into every bundle.
- Two tables, two jobs. `tile_blobs` is a **registry**: it records that a blob
  holds tile content, and collection only ever considers blobs listed there. A
  bundle, GDB source, or network export is therefore never a candidate, so a
  reference class nobody remembered to check cannot be swept away.
  `version_tile_packages` is a **reference**: it binds an immutable version to
  the package it renders, so published and archived versions keep their scene.
- **Registration is committed in the same transaction as the rows that
  reference it.** No committed state ever reads "tile content, referenced by
  nothing", which is what a sweep in another process would delete out from under
  an in-flight upload. Bytes are written to disk before that transaction; an
  unregistered file is not collectable, so the crash window leaks waste, never a
  dangling reference.
- Collection deletes rows in one transaction, then unlinks files. That order is
  deliberate: a failed unlink leaves an unreferenced file (waste), while the
  reverse could leave a row pointing at missing bytes (a venue serving 404s).
- There is **no age heuristic**. Blobs are released when a package record is
  discarded (`DELETE /api/venues/:id/tiles/:packageId`, refused with `409
  package_in_use` while a version references it) or when a venue is deleted —
  both sweep immediately. The hourly janitor pass is only a safety net for a
  crash between those steps.
- `BlobStore.remove` exists solely for collection; the store is otherwise
  append-only because blobs are immutable and shared.

**Tile packages (`kiriko-scene::package` + `server/src/tiles/`):**
- `validate_tile_package(zip)` resolves an uploaded package's tileset URI graph **inside the archive** and refuses everything else: `..` traversal (checked on both archive entry names and resolved references), absolute paths, `http(s)`/`file`/`//` references, dangling members, unsupported `asset.version` (1.0 and 1.1 are supported), extensions outside the allowlist (`3DTILES_content_gltf`, `EXT_mesh_features`, `EXT_structural_metadata`), `implicitTiling`, non-`.glb` content, content that fails to decode, and archive entries whose declared size disagrees with their bytes. Bounded at 10,000 members / 512 MiB per member / 2 GiB per package / 8 levels of tileset nesting.
- The validator is a **pure function of the package bytes** — no network, no filesystem — so the same package always produces the same record, which is what lets a later version reuse content hashes. Members are the paths the graph references; unreferenced entries are reported as `ignored` and never stored.
- `POST /api/venues/:venueId/tiles/inspect` (producer session) validates in Rust, then stores each accepted member in the shared content-addressed blob store and records it in `tile_packages` / `tile_package_members`. Ingestion **changes no published state**: no version is created or touched. Re-uploading identical bytes is idempotent (`UNIQUE (venue_id, source_hash)`), and a member already in the store reports `reused: true`.
- Member bytes are extracted server-side rather than returned across the native boundary: the validator already reported which paths the graph references, and moving a 172 MiB package's bytes back through FFI to store them would double its peak memory for nothing.
- **`NORMAL` is optional in glTF** and the deriver computes flat facet normals when a primitive omits it — refusing such a package would reject spec-valid content over an attribute Kiriko can derive. `_FEATURE_ID_0` is **not** optional: it is the source-object identity picking resolves against, so content without it cannot be a tiles source.
- Producer-facing refusal copy lives in `src/gallery/tileErrors.ts`, mirroring `gdbErrorCopy`; a test pins every validator code to copy in both languages.

**Tile registration and activation (`kiriko-scene::registration` + `server/src/tiles/activation.ts`, #74):**
- A tile level's **floor plane comes from its own walkable surfaces**, area-weighted (1 cm bins, dominant bin wins), never from `levelElevationMeters` — the KITTE floors disagree with their metadata by 3.02 m repeatably (#31). The metadata is kept as provenance and the disagreement is reported.
- **Composite level identity** is `asset version | sourceDocument | sourceLinkName | levelKey | quantized elevation (dm)`. `levelKey` is never a join key: 11 of the Tokyo asset's 90 keys occur at several elevations, and generic keys like `b1fl` appear in four linked models.
- **Residuals** are measured #31's way: sample the boundary edges of each level's walkable surfaces (0.5 m spacing, welded to the millimetre **across content members**, so the seam between two `.glb` files is interior geometry rather than two facing boundaries), take the distance to the nearest unit edge on the canonical floor that level maps to, then apply the **coverage carve-out** — a sample more than a metre from every unit edge *and* inside no unit is a model-coverage difference, not misregistration.
- **Coherent clusters** are computed over the samples that already exceed the floor's p90 band, grouped into 40 m cells: a venue-wide median hides exactly the spatially separated agreement the Yaesu pockets were.
- The **profile is versioned and stored with the activation** (`tile_activations.profile_json`), so a later profile change cannot re-judge a published version. Defaults: p90 ≤ 0.50 m (per-floor overrides via `floorP90MaxM` — Tokyo measured 0.433–0.608 m carved), median coherent shift ≤ 0.15 m, no coherent residual > 1.0 m, level match tolerance 1.5 m.
- **`verticalOffsetM` is a producer decision, never inferred.** The venue GDB proves no floor elevation (every exported Z was 0), so the two sides can sit on different datums. Aligning the ladders automatically would map every level *somewhere*, which is the guess the gate exists to refuse; without an offset a mismatched datum fails as `levelNotMapped`.
- Venue geometry comes from `kiriko_bundle::venue_floor_geometry`: unit polygons in the §8 ENU frame on each level's **source** plane. `scene_z = source − offset`, so recovering the source plane **adds** the normalisation offset back.
- Gates (typed, bilingual copy in `src/gallery/tileGates.ts`): `integrityUnresolved`, `capabilityProfileMissing`, `registrationOutOfBand`, `coherentShiftOutOfBand`, `coherentResidual`, `levelPlaneUnresolved`, `levelNotMapped`, `unclassifiedOpaqueContent`. A level with no `levelKey` is site mass, exempt from the plane/mapping gates but required to be classified contextual; a level whose every object is contextual is exempt entirely.
- `POST /api/venues/:id/tiles/:packageId/registration` evaluates and records; a blocked package stays inspectable. `POST …/activate` refuses `not_evaluated`, `evaluation_stale` (the venue published since — the evaluation is keyed to a version *and* its bundle hash), and `activation_blocked` (with the gates), then **publishes a new version** reusing the previous one's retained inputs plus the §9 descriptor, and binds `version_tile_packages` in the publishing transaction.
- **Activation publishes rather than rewrites** because #30 §6 makes correcting or replacing tiles a new venue version, and because #73 serves pinned bundles and members as `immutable` for a year. Recompiling in place would change bytes under a URL that promised it never would.
- The renderer reads activation state from §9 alone: `sceneProjection` reports `tiles` (activation state, `profileId@version`, package/manifest hashes) and fills each level's `sourceLevels` with the composite levels floor filtering must use.

**Tiles as a rendered source (`kiriko-scene::derive_package_scene`, `server/src/serve/tiles.ts`, `src/map/scene/sceneSource.ts`, #75):**
- An activated package is derived into the **same KSC1 document** the generated source compiles to, so one reader, one layer, one picking path, and one visual language serve both. Only identity differs: levels carry the canonical floor they were registered to, source objects carry their canonical association (or nothing — an unassociated object stays inspectable and impersonates no venue feature), and producer-classified context carries the occlusion the producer chose rather than its Revit category's.
- **Derived once, at activation**, not per request: a 172 MiB package cannot be re-derived per viewer load, and bytes fixed at activation are what let the pinned URL promise they never change. Stored in the shared blob store, registered as tile content so collection counts it (`tile_activations.scene_blob_hash`).
- **Geometry is placed into the venue frame during derivation**, and the header states the venue's own §8 ENU frame — identical to the generated source's. A renderer that had to apply a per-source transform would be a renderer that knows which source it is drawing. The placement transform (tile → venue, through the tileset root transform applied unchanged) is *not* the header's world transform.
- `GET /v/:tenant/:venue/scene` (revalidating) and `…/scene@<versionPublicId>` (immutable) serve it; a version with no activated package answers **404 `no_tile_scene`**, which is an absent source, not a failure. The client asks for the package document first — that request is also how it learns whether this version has one.
- **The ladder is Tiles → Generated → 2D.** A tile scene that will not start costs one rung (the venue always retains a generated scene, #30 §1) with one bounded retry; a lost context goes straight to 2D because the next rung needs the same GPU. Fallback is one-way — nothing climbs back to tiles on its own.
- **Floor filtering takes the canonical floor's whole registered set** of composite source levels (`levelIndicesOf` / `setActiveLevels`), because a floor maps to one or more of them. The generated source passes a set of one.
- Equivalence is asserted, not inspected: `core/crates/kiriko-bundle/tests/render_scene.rs` compares the two sources' documents for one venue on frame, canonical level groups, and the role→occlusion table. Its GLB fixture builder is `#[path]`-included from the scene crate's tests — two builders would drift into describing two different "valid GLB"s.

**The producer surface (`src/gallery/TilePackageDialog.tsx`, `GET /api/venues/:id/tiles`, #80):**
- Everything above was reachable only by `curl` until this shipped. The dialog opens from a dataset card's **3D Tiles** action; the card chips `3D Tiles live` only when the *latest published version* renders a package, and `3D Tiles inactive` when the venue merely holds one — activation is explicit, so that second state lasts as long as the producer takes to decide.
- `GET /api/venues/:id/tiles` lists each package with its stored evaluation, `current` (the same version-and-bundle-hash comparison `activate` refuses with `evaluation_stale`, computed **server-side** — a second copy of that rule would be a second answer to "may this activate"), and `serving`. Without it a `packageId` lived only in client state and a reload orphaned an upload whose recovery was re-sending 172 MiB.
- **Registration is a loop, not a step.** Gates name subjects; the three levers the contract accepts are `verticalOffsetM` (the datum decision #74 refuses to infer), per-floor `floorP90MaxM`, and `contextualSourceObjects`. Re-evaluating replaces the stored evaluation rather than accumulating one.
- A widened band shows the floor's **measured** p90 beside the band it must clear. Overriding a threshold is a producer's call; hiding the number they are overriding is not. No justification is recorded — considered and declined, since it needs a column and a policy.
- The mapping table is the report's centrepiece, not the residuals: each level sits beside the canonical floor it matched, both planes, and the gap. Every residual below it was measured *against that floor*, so if a level is on the wrong one, a small residual is agreement with the wrong geometry. `resolvedPlaneM` beside `metadataElevationM` also puts #31's 3.02 m KITTE disagreement in front of the person who exported it.
- **Nothing can prove a mapping right, so a producer confirms it.** `level_match_tolerance_m` (1.5 m) picks the nearest floor within tolerance, per level, independently. A stack offset by roughly a storey therefore maps every level to its neighbour — and where footprints repeat (stacked platforms, repeated concourses) the residuals against the wrong floor measure as small as against the right one. That case is undecidable from geometry, which is exactly why #74 makes the datum a producer decision. `POST …/activate` requires `mappingConfirmed: true` and refuses `mapping_unconfirmed`; the confirmer and time land in `tile_activations.mapping_confirmed_{by,at}`, because the question later is not whether a box was ticked but who checked, against which report. Enforced server-side: a guarantee living in a checkbox is one anything with `curl` can skip.
- The decidable mapping failures *are* gated: `levelMappingAmbiguous` (two floors inside the tolerance — nearest-wins would be a guess), `levelMappingScrambled` (levels sorted by their own plane mapping to floors out of that order; a stack cannot interleave), and `levelMappingCollapsed` (levels further apart than the tolerance claiming one floor). These narrow the hazard; only the confirmation addresses the undecidable residue.
- **The label is the one check that does not come from altitude** (`core/crates/kiriko-scene/src/floor_label.rs`, #81). A level's own name is compared against every venue floor's name, not only the matched one, because the question is not "do these strings agree" but "does this level's name belong to a *different* floor" — the shape a whole-storey offset takes. `levelLabelContradiction` fires when exactly one venue floor answers to the level's name and it is not the matched one. Never a join key (#30 §3 settles that `levelKey` cannot identify a floor alone): a label agrees with the mapping altitude chose, contradicts it, or says nothing, and it never selects one.
- `floor_label_candidates` reduces a label to a comparable form and offers the whole string plus its first token, since labels here are often `<code> <place>` ("B1F Yaesu" names the floor "B1F" does). Every rule exists for a form that occurs: full-width `Ｂ１Ｆ`, Japanese `地下1階`, Revit `L1` against IMDF `1F`, Revit `b1fl` against `B1F`. A storey suffix is stripped only after a digit and a level prefix only before one, so `Roof` does not become `Roo` and `Lobby` does not become `obby`. Nothing parses an ordinal — `b1` and `1` stay different strings, and deciding which is lower is the inference #74 refuses.
- **`unknown` is the absence of a check, not a passed one.** Two exports sharing no naming convention corroborate nothing, and the mapping table says "not comparable" rather than showing a tick. A label naming several floors is also `unknown` — ambiguity is not evidence.
- **Absence is in the type.** `stats` and `venueWide` are `Option<ResidualStats>`; `stats_of` returns `None` for an empty sample set rather than `ResidualStats::default()`. Zeroes read exactly like perfect agreement, and returning them let an unmeasured registration print as a clean one all the way to the producer's screen. The audit for other instances found none — `NetworkInspectorPanel` and `DatasetCard` already render absence as absence — so this was the one surface that manufactured a zero. The standing rule is in `AGENTS.md`.
- `e2e/tiles.producer.spec.ts` drives the loop in a browser and ends on the viewer's badge reading `3D Tiles`. Its package is built at a plane **no venue level sits near**: a few metres off passed every gate, because it mapped to whichever floor happened to sit there — wrongly and undetectably. Package builders live in `tests/fixtures/` so the server and browser suites build the same bytes.

**Stage 3 verification (#76).** `server/test/stage3Proof.test.ts` carries one package built in this repository through the whole path in one test — ingest → pin to an immutable version → gates → activate → the served document decoded through the same reader the generated scene uses — and proves the guarantees that only hold once the steps compose: members stored once and released only when nothing references them (deleting the venue is the release path), pinned members served with hash ETags, immutable caching, content type, ranges, and cross-version isolation, and a control venue with no package whose bundle is byte-identical to a fresh compile with no descriptor.

The registered assets are a data-gated acceptance (`server/test/stage3Tokyo.test.ts`) and skip when absent. Both are needed — the venue GDB registration is measured against, and the tile package:

```bash
KIRIKO_TOKYO_FIXTURES=/path/to/tokyo\ station \
KIRIKO_TOKYO_TILES=/path/to/tokyo\ 3dtiles \
pnpm --dir server exec vitest run test/stage3Tokyo.test.ts
```

It holds every floor to #31's **widest** certified band (0.70 m, M2F's) and the venue as a whole to the combined carved figure (0.65 m), printing each floor's measured p90, sample count, and carve-out on failure. Deliberately not a per-floor band table: #31 measured bands per floor *label*, and mapping a label to the canonical level id a profile keys on takes knowledge of the import that the test cannot check — a wrong mapping would apply the wrong band and still pass. A producer setting a real profile reads the printed numbers and sets `floorP90MaxM` per canonical id.

## Gotchas

- **Total route weight is in `cost` units, not metres**, though the viewer currently labels it `m` (known follow-up).
- **`cost` already models stairs/elevator penalty** — do not re-penalize passage types.
- Reproject EPSG:3857 → 4326 on every GDB read (`-t_srs EPSG:4326`).
- Network/facility floor labels must line up with the venue's converted levels; mismatches drop nodes/facilities with warnings surfaced in the review dialog.
- **Rust changes need the addon rebuilt before server tests and the wasm rebuilt before browser checks** (`pnpm core:build:node`, `pnpm core:build:wasm`). A stale artifact fails in ways that look like product bugs — a deriver fix that "didn't take", a role mapping that "reverted". CI always rebuilds; local runs do not.
- New Rust warning codes (e.g. `route_build`, `facility_build`) MUST be added to the TS bridge allowlist (`server/src/core/native.ts`) **and** the client type (`src/imdf/types.ts`) or publish fails with `bridge_error`.

## Known follow-ups

- **Real-dataset verification of building-scoped import is outstanding.** The
  building-scoped import and network/facility clipping described above (see
  "Building-scoped import" under Kiriko pipeline) are covered by fixture-based
  unit and integration tests only. Nobody has yet run the real ~15-building JR
  East Tokyo Station venue GDB through the review dialog with a single
  building selected, attached the network and point-facility GDBs, and
  published. Still to check against that dataset: which unprefixed/outdoor
  layers (rail centerlines `軌道の中心線_*`, road edges `道路縁`/`道路構成線`,
  `Free_shuttle_bus_*ルート`) actually reach publish — i.e. have a non-null
  target type and are included by default in `suggestLayerPlan`
  (`server/src/gdb/mapping.ts`) — since only those matter for whether they
  need explicit exclusion; whether the 2 m `CLIP_BUFFER_M`
  (`core/crates/kiriko-bundle/src/clip.rs`) is the right tolerance for that
  data's node-to-polygon offsets, or needs raising; and **how much
  over-inclusion the synthetic-level rectangles cause**. `ClipRegion` indexes
  every `FeatureType::Level` polygon, and a synthetic level (one created for an
  ordinal with no source level feature) carries a bounding rectangle over its
  assigned features — the same shape objection that keeps building polygons out
  of the region. The effect is over-inclusion (a neighbour's nodes kept), never
  corruption, so the behaviour is deliberately left as-is: measure the real
  drop counts on the Tokyo data first — how many of that venue's levels are
  synthetic, and how many extra nodes/facilities their rectangles retain —
  before deciding whether to restrict the region to non-synthetic levels plus
  units. Do all of this before relying on building-scoped import for that venue
  in production.
- **One-shot fan-out to N venues was deliberately deferred.** Selecting a
  subset of buildings imports one venue containing just that subset; there is
  no mode where a single publish creates a separate venue per building.
  Splitting a multi-building GDB into several venues means re-running the
  import once per building — the source blob is content-addressed by hash, so
  each re-run costs no re-upload, only a repeat of the review-and-publish
  steps.
- **Floor merge (viewer):** GDB import synthesizes one IMDF level per `(building, ordinal)` (`resolveOrCreateLevel` in `server/src/gdb/mapping.ts`, keyed by `buildingUuid\0ordinal`). This is correct IMDF modeling (a level belongs to one building), but a multi-building venue like Tokyo Station (~15 buildings) yields ~15 separate `1F` entries. The **viewer floor selector should group levels by ordinal** and show one floor per ordinal, rendering every building's geometry at that ordinal together. Fix belongs in the viewer/level model, not the importer. (Next phase after point-facility POIs.)
- **Route total units:** viewer labels the A\* total `m` though it is `net_path.cost` units.
- Remaining routing semantics: do not re-penalize `passage_type` (cost already in `cost`); accessibility profiles on **imported** Tokyo GDB (generated IMDF openings are a later phase). Honoured at import, §13 persist, export, and query: `direction`/one-way, `barrier` (skip), `gate` (stored, not a restriction), time windows (`STARTTIME`/`ENDTIME`).
- **Unit `color2` fills (viewer/import):** venue GDB `unit`/`space` features carry a `color2` field holding a Japanese color *name*, not a hex. The source system (cesium `src/main.js` `COLOR2_LOOKUP`) maps names → hex. Kiriko currently colors unit fills by IMDF category (theme colors), not `color2`, and the field is dropped on import. To honor it: pass `color2` through GDB conversion into a feature property, carry it in the bundle, and paint unit fills by the resolved hex (fallback to category color when absent). Palette (name → hex): `橙 #FFC090`, `トイレ #E5E6E6`, `薄紅 #FFECE6`, `緑 #DDF5D9`, `濃空 #C2E5F2`, `濃鼠 #C8C9CA`, `白 #FFFFFF`, `薄空 #C0E0EA`, `薄鼠 #A0A1A2`, `黄 #F5F5C0`, `濃紅 #F2CFC2`, `ラチ外白 #FFFFFF`, `進入制限あり #E5E6E6`. (Own phase — separate from floor-merge.)

## Specs & plans

- `docs/superpowers/specs/2026-07-17-kiriko-platform-architecture-design.md` — platform architecture, phasing, KVB format.
- `docs/superpowers/specs/2026-07-20-kiriko-route-slice-design.md` + `docs/superpowers/plans/2026-07-20-kiriko-route-slice.md` — routing.
- `docs/superpowers/specs/2026-07-20-point-facility-poi-design.md` + `docs/superpowers/plans/2026-07-20-point-facility-poi.md` — facilities.
- `docs/superpowers/specs/2026-07-20-gdb-*` — GDB import frontend, harden, version-on-existing-venue.
