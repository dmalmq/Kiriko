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

**KVB bundle sections** (`kiriko-bundle`, `core/crates/kiriko-bundle/src/format.rs`):
- `1 manifest`, `2 geometry`, `3 stores` — always (IMDF).
- `5 graph` — routing graph, present when a network GDB was imported. §5 edges carry per-edge `interior` polyline geometry + `ordinal`.
- `7 facilities` — point facilities, present when a point-facility GDB was imported.
- `4 style`, `6 beacons` — reserved, not emitted.
- Sections 5 and 7 are **optional and backward compatible**: older decoders read 1–3 and ignore unknown ids. Directory rows are id-ascending.

**Routing (`kiriko-route`):**
- `build_route_graph(junctions_geojson, paths_geojson, level_ordinals)` → `RouteGraphBuild { graph, warnings, node_ids }`. Nodes carry `(lon, lat, ordinal)`; edges carry `(from, to, weight = net_path.cost, ordinal, interior)` where `interior` is the `net_path` polyline's bend points with the two endpoint vertices stripped (empty for the ~97% straight edges). Full edge polyline = `[from node, …interior…, to node]`. `node_ids[i]` is the source NODEID of `graph.nodes[i]`.
- Edges are traversed **bidirectionally** this phase (`direction`/one-way/barriers/time-windows deferred).
- `route(graph, origin, dest)` **projects** each endpoint onto the nearest same-floor edge (`snap_to_edge`, not just the nearest node), runs A\* between the four virtual endpoints (partial-edge cost proportioned by polyline length; same-edge case shortcut), and returns `Route { segments, total_weight, origin_projected, dest_projected }`. `segments` are the reconstructed corridor polyline split into maximal same-ordinal runs, so the route **traces the real `net_path` geometry** instead of straight node-to-node chords.
- WASM: `routeBundle(bundle, oLon,oLat,oOrd, dLon,dLat,dOrd)` decodes §5 and returns the floor-grouped `segments` + projected endpoints. The viewer draws each segment's polyline (floor-filtered) plus a dashed **connector** from each raw click to its projected point.

**Facilities (`kiriko-facilities`):**
- `build_facilities(geojson, graph)` → `Facilities`. Each `Facility` has `(lon, lat, ordinal, name, icon, anchor?)` — position is the **verbatim GDB coordinate**, `icon` is the `image` basename. `anchor` is that same position used as the **route-to-facility** destination (the A\* router snaps it to the nearest node at query time), set only when the facility's floor carries a route-graph node; `None` otherwise.
- WASM: `facilities(bundle)` decodes §7; viewer renders a floor-filtered GL symbol layer (icon by `image` basename, pin fallback) and offers **Route here** on tap.

## Gotchas

- **Total route weight is in `cost` units, not metres**, though the viewer currently labels it `m` (known follow-up).
- **`cost` already models stairs/elevator penalty** — do not re-penalize passage types.
- Reproject EPSG:3857 → 4326 on every GDB read (`-t_srs EPSG:4326`).
- Network/facility floor labels must line up with the venue's converted levels; mismatches drop nodes/facilities with warnings surfaced in the review dialog.
- New Rust warning codes (e.g. `route_build`, `facility_build`) MUST be added to the TS bridge allowlist (`server/src/core/native.ts`) **and** the client type (`src/imdf/types.ts`) or publish fails with `bridge_error`.

## Known follow-ups

- **Floor merge (viewer):** GDB import synthesizes one IMDF level per `(building, ordinal)` (`resolveOrCreateLevel` in `server/src/gdb/mapping.ts`, keyed by `buildingUuid\0ordinal`). This is correct IMDF modeling (a level belongs to one building), but a multi-building venue like Tokyo Station (~15 buildings) yields ~15 separate `1F` entries. The **viewer floor selector should group levels by ordinal** and show one floor per ordinal, rendering every building's geometry at that ordinal together. Fix belongs in the viewer/level model, not the importer. (Next phase after point-facility POIs.)
- **Route total units:** viewer labels the A\* total `m` though it is `net_path.cost` units.
- Deferred routing semantics: `passage_type`, `direction`/one-way, `barrier`/`gate`, time windows, accessibility profiles.
- **Unit `color2` fills (viewer/import):** venue GDB `unit`/`space` features carry a `color2` field holding a Japanese color *name*, not a hex. The source system (cesium `src/main.js` `COLOR2_LOOKUP`) maps names → hex. Kiriko currently colors unit fills by IMDF category (theme colors), not `color2`, and the field is dropped on import. To honor it: pass `color2` through GDB conversion into a feature property, carry it in the bundle, and paint unit fills by the resolved hex (fallback to category color when absent). Palette (name → hex): `橙 #FFC090`, `トイレ #E5E6E6`, `薄紅 #FFECE6`, `緑 #DDF5D9`, `濃空 #C2E5F2`, `濃鼠 #C8C9CA`, `白 #FFFFFF`, `薄空 #C0E0EA`, `薄鼠 #A0A1A2`, `黄 #F5F5C0`, `濃紅 #F2CFC2`, `ラチ外白 #FFFFFF`, `進入制限あり #E5E6E6`. (Own phase — separate from floor-merge.)

## Specs & plans

- `docs/superpowers/specs/2026-07-17-kiriko-platform-architecture-design.md` — platform architecture, phasing, KVB format.
- `docs/superpowers/specs/2026-07-20-kiriko-route-slice-design.md` + `docs/superpowers/plans/2026-07-20-kiriko-route-slice.md` — routing.
- `docs/superpowers/specs/2026-07-20-point-facility-poi-design.md` + `docs/superpowers/plans/2026-07-20-point-facility-poi.md` — facilities.
- `docs/superpowers/specs/2026-07-20-gdb-*` — GDB import frontend, harden, version-on-existing-venue.
