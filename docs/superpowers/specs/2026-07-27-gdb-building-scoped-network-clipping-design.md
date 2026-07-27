# Building-Scoped GDB Import — Network Clipping & Selection UX

**Date:** 2026-07-27
**Status:** Approved (brainstorm), pending spec review
**Follows:** `2026-07-23-gdb-building-selection-design.md` (per-building Include checkbox — implemented, merged forward onto this branch)

## Problem

The 2026-07-23 slice gave the review dialog a per-building Include checkbox, so a multi-building venue GDB can be imported one building at a time. It deliberately scoped out everything beyond the dialog — its non-goals read "no server, API-schema, or Rust changes."

That leaves the other half of the use case unmet. The routing network and point facilities live in **separate GDBs that carry no building field** — only floor labels and coordinates — and are extracted whole, with no spatial or attribute filtering anywhere in the pipeline (`server/src/gdb/gdalWorker.mjs` issues one fixed `ogr2ogr` call with no `-where`/`-spat`/`-clipsrc`). So importing a single building still pulls in all 10,118 junctions, 25,625 edges, and 2,591 POIs of Tokyo Station. "Create network data for just this building" is not currently possible.

Three smaller gaps in the shipped checkbox also surfaced during design and are folded in here.

## Scope decisions

**One import run produces one venue.** Ticking a subset yields a single venue containing exactly those buildings. Splitting a GDB into several venues is done by **re-running the import once per building**: the GDB blob is content-addressed and cached, so a second run is pick-buildings → name → publish, with no re-upload. A one-shot fan-out (one publish, N venues) is **out of scope** — it needs N bundles, N venue records, and a partial-failure story to replace something already achievable by publishing twice. It stays a thin wrapper to add later if re-running proves tedious.

**Selection granularity stays buildings-only.** No per-floor or per-layer-kind sub-toggles; the existing per-layer table already covers that need.

## Architecture

### 1. Clipping (Rust) — the substance of this slice

Per the project boundary rule, GDAL stays in TypeScript and all data interpretation is Rust. Clipping is geometry interpretation, so it belongs in the core — and needs no new geometry input, because the IMDF archive handed to `compileImdf` **already contains only the selected buildings**. The clip region derives from the archive itself.

New `ClipRegion` in `kiriko-model` (the crate that already owns IMDF geometry, and the shared dependency of both `kiriko-route` and `kiriko-facilities`), built from the parsed archive's **level and unit polygons**, bucketed by ordinal, with a bounding-box prefilter ahead of point-in-polygon.

Applied in the compile path before graph and facility construction:

- **Junctions** — keep when the point falls inside the region **at the node's own ordinal**, resolved via `kiriko_route::floor_to_ordinal`, within a **2 m** buffer. A node on a floor that was not imported is dropped.
- **Paths** — keep only when *both* endpoints survived. Edges to dropped nodes are discarded rather than left dangling.
- **Facilities** — the same point-in-region test.

The buffer is a named constant expressed in metres and converted to degrees at the region's latitude.

Counts of dropped nodes, edges, and facilities surface as new warning codes `network_clipped` and `facilities_clipped`. **Both must be added to the TS bridge allowlist (`server/src/core/native.ts`) and the client type (`src/imdf/types.ts`)** — a Rust warning code missing from either fails publish with `bridge_error`.

If the clip removes every node, the compiler emits a loud warning and **omits section 5** rather than embedding an empty graph. Section 5 is already optional and backward-compatible, so an omitted graph decodes cleanly. This mirrors the existing `no_routable_network` handling for empty synthesis.

#### Dependency on correct ordinals

The clip matches nodes to the region by ordinal, so it is only as correct as the floor parser. The in-flight fix to `buildFloorSynonyms` (made 0-based, matching `floor_to_ordinal`) and to `resolveLevelOrdinal` (source `ordinal` attribute demoted below floor labels, because JR East databases mix conventions) is a **prerequisite**, not an optional companion. With the old 1-based synonyms, every node would test against the wrong floor's polygons and the clip would drop almost everything.

### 2. Wiring the clip flag

`clipToSelection?: boolean` goes **on `GdbMappingPlan`**, not on the publish request. The plan is already persisted verbatim in `versions.gdb_plan_json`, so the flag survives re-edit, `POST /api/gdb/augment`, and `POST /api/gdb/generate-network` with **no migration and no new job column**.

Touch points:

- `src/gdb/types.ts` and `server/src/gdb/types.ts` — the hand-synced plan type, both copies.
- The inline TypeBox `GdbMappingPlanSchema` at `server/src/gdb/routes.ts:89`. A plan field absent here is stripped or rejected by Fastify.
- `normalizeGdbPlan` in `server/src/gdb/mapping.ts` — carry the flag through normalization.
- Publish reads `plan.clipToSelection` → job payload → `CompileVenueMetadata` → `compileImdf`.

UI: a checkbox "Clip routing and POIs to selected buildings", **auto-ticked the first time a building is deselected**, manually overridable thereafter. Default off, so full imports keep today's exact behaviour and nothing regresses.

### 3. Selection UX gaps carried over from the 2026-07-23 slice

All in `src/gallery/GdbImportDialog.tsx`, building on the existing `setBuildingIncluded` handler.

**Tri-state checkbox.** Today `checked` is `assigned` — true when *any* layer in the group is included — so a partially-included building renders identically to a fully-included one. It becomes ticked when every layer in the group is included, and indeterminate when only some are.

**Re-tick restores suggested inclusion.** Today re-ticking blanket-sets `included: true` across the group, which resurrects layers the server heuristic deliberately excluded — zero-feature layers and `_to_` cross-floor layers. The 2026-07-23 spec called this out as "acceptable, and rare"; with the network clip in play, resurrecting cross-floor layers is more costly. Re-ticking instead restores each layer's *originally suggested* inclusion, which requires the dialog to retain the untouched `suggestedPlan` alongside the edited one.

**Per-building counts.** Each building row shows its included/total layer count and feature count, so the effect of a toggle is visible without scrolling the table.

**Building filter on the layer table.** A dropdown filtering the existing table to one building's rows, for drilling in after a bulk toggle.

**Unassigned / outdoor group.** Layers with `buildingId: null` collect into a pseudo-group rendered last, with its own checkbox. This is presentation, not a default change: the unprefixed context layers (`軌道の中心線_*` rail centerlines, `道路縁`/`道路構成線` road edges, shuttle routes) match none of the ~17 category suffixes `inferTargetType` recognizes, so their `targetType` is `null` and publish already drops them (`server/src/gdb/routes.ts:421` filters on `included && targetType !== null`). Excluding them is therefore already the effective behaviour — it is merely invisible. Changing suggestion defaults would be wrong, because the same `buildingId: null` bucket also holds legitimate in-building POI layers that are correctly included. Implementation includes a **verification step against the real Tokyo venue GDB** to confirm which unprefixed layers actually reach publish; any outdoor linework that does get through is turned off there, by name pattern.

**Venue name suggestion.** When exactly one building is selected and the venue name has not been hand-edited, prefill it with that building's name. The first keystroke in the field stops auto-fill permanently for that dialog session. The field stays read-only in `version` and `edit-mapping` modes, where `venueNameLocked` already applies.

## Testing

TDD throughout, tests written per section before implementation.

**Rust** — `ClipRegion` unit tests: point inside a unit polygon, point outside, point within the buffer band, point inside geometry but at a non-imported ordinal, empty region. Then `kiriko-route` tests asserting junction filtering and both-endpoints edge retention, and `kiriko-facilities` tests for POI filtering. Verify with `cargo test --manifest-path core/Cargo.toml --workspace`.

**Server** — `server/test/gdbMapping.test.ts` for `normalizeGdbPlan` carrying `clipToSelection`, and `suggestGdbMapping` output unchanged. `server/test/gdbNetwork.test.ts` and `gdbFacilities.test.ts` for publish with the flag set, asserting node/edge/facility counts drop against the fixture, and that an all-clipped network omits section 5 with a warning.

**Client** — `src/gallery/GdbImportDialog.test.tsx` (13 tests currently green, including the two from the 2026-07-23 slice): tri-state rendering, restore-suggested-inclusion on re-tick, per-building counts, building filter, venue name prefill and its stop-on-edit behaviour, and clip checkbox auto-tick on first deselection.

**UI strings** — every new user-facing string needs both ja and en, per project convention.

## Known constraints carried into implementation

- `src/gdb/planValidation.ts` duplicates `GEOMETRY_REQUIREMENT`, `buildFloorSynonyms`, `parseFloorToken`, `extractGdbFloorOrdinal`, `STRUCTURED_NAME`, `structuredFloorOrdinal`, and `layerNameFloorOrdinal` from `server/src/gdb/mapping.ts`, with no shared module and no drift test. This design does not widen that duplication and does not attempt to fix it — but note the in-flight 0-based `buildFloorSynonyms` fix must land in **both** copies.
- Building identity is purely the layer-name prefix (`STRUCTURED_NAME` capture group 1, matched case-insensitively), and building UUIDs are freshly generated on every publish. Two imports of the same station produce different building ids. Selection is by prefix name, not by any stable source identity.
- Building polygons are **synthesized rectangles** over each building's levels and units, never imported. The clip therefore uses level and unit polygons directly, not building geometry — building rectangles for adjacent, interlocking structures like Tokyo Station's overlap heavily and would leak neighbours' nodes.
- Floor fragmentation — one IMDF level per `(building, ordinal)`, giving ~15 separate `1F` entries for Tokyo Station — is a separate documented issue whose fix belongs in the viewer (`docs/superpowers/specs/2026-07-20-floor-merge-design.md`). Importing a single building incidentally reduces the symptom but is not the fix.

## Out of scope

- Per-floor and per-layer-kind selection toggles.
- A single publish producing multiple venues.
- Attribute-based (rather than spatial) network filtering.
- Any change to the floor-merge viewer work.
- Fixing the `planValidation.ts` / `mapping.ts` duplication.
