# GDB Internal Category Codes + Walkable Set + Empty-Graph UX — Design

**Date:** 2026-07-23
**Status:** Approved (brainstorm), pending spec review

## Problem

"Generate routing" on a GDB-imported venue ("Takanawa Gateway Station") finished instantly and produced no network. Root cause (evidence-verified against the stored bundle + source IMDF):

- The venue's source data uses the company's **internal category codes** (`A###` venue, `B###` unit, `C###` fixture/detail), e.g. units categorized `B021`, `B029`, `room`.
- The app's **GDB importer stores the raw code** as the IMDF `unit.category` (`mapping.ts:1187`), never applying the code→category tables that `shp2imdf-converter` uses (`C:\Repositories\shp2imdf-converter\backend\config\{a,b,c}-codes.json`).
- The medial routing generator only treats units with `category ∈ {walkway, corridor, sidewalk, ramp}` as walkable and `{stairs, escalator, elevator}` as transit. Raw codes match neither, so every floor is skipped (`walk.is_empty() → continue`) before openings are even considered → **empty §5 graph**, zero synth warnings.
- Because generation still marked the version `synthesized=1` and published it, the venue showed `hasGraph=true` and offered "Review network" over an empty overlay — a silent, misleading failure.

Decoded evidence: 99 units with categories `B028,B019,B022,B021,B023,B001,B029,room,B008,B007,B014,B016`; **0** matched the walkable set. Under `b-codes.json` these decode to `platform, room, elevator, stairs, escalator, retail, walkway, restroom.*, mothersroom` — i.e. **4 walkway + 2 platform + 48 transit** units plus 66 openings, more than enough for a network.

## Goals

1. **Apply the internal code→IMDF-category mapping during GDB import**, for all mapped feature types, so units/fixtures/etc. carry real IMDF categories (fixes routing generation *and* correct rendering/search).
2. **Broaden the generator's walkable set** to the real IMDF circulation categories (notably `platform`, essential for stations).
3. **Fail loudly** when synthesis produces no routable network, instead of publishing an empty graph that falsely reads as `hasGraph`.

## Non-Goals

- No change to `shp2imdf-converter` (separate repo). We copy its tables into this app.
- No cross-repo runtime dependency.
- No re-mapping of already-imported venues (the user re-imports).
- No new geometry/algorithm work in the generator beyond the category whitelist.

## Design

### Part A — Internal code → IMDF category mapping (server GDB import)

**New module** `server/src/gdb/categoryCodes.ts`: three `Record<string, string>` tables transcribed from `shp2imdf-converter`'s `a-codes.json`, `b-codes.json`, `c-codes.json`, each with its `default_category`, plus:

```ts
// A### → venue, B### → unit, C### → fixture/detail. The prefix letter selects
// the table, matching the converter's scheme. Values that aren't A/B/C codes
// (e.g. a literal "room") pass through unchanged.
export function mapCategoryCode(raw: string): string {
  const m = /^([ABC])(\d+)$/.exec(raw.trim());
  if (m === null) return raw;
  const table = m[1] === "A" ? A_CODES : m[1] === "B" ? B_CODES : C_CODES;
  return table.mappings[raw.trim().toUpperCase()] ?? table.default_category;
}
```

**Injection:** `server/src/gdb/mapping.ts:1187`, immediately after `category` is read from the source field and before it is assigned to `transient.category`:

```ts
let category = coerceString(layer.categoryField ? props[layer.categoryField] : undefined);
if (category !== null) category = mapCategoryCode(category);
if (targetType === "unit" && category === null) category = "room";
```

This single site governs every non-level mapped feature (unit, fixture, detail, amenity, …). Prefix-based table selection means no per-target-type branching. Unknown codes fall back to the table's `default_category` (`unit → "unspecified"`, `fixture → "unspecified"`, `venue → "other"`); non-code values (e.g. `"room"`) pass through.

Tables to copy (verbatim values):
- **B (unit)**: `B001 retail, B002 office, B003 publicfacility, B004 waitingroom, B005 tickets, B006 information, B007 restroom.male, B008 restroom.female, B009 restroom.unisex, B010–B014 restroom, B015 smokingarea, B016 mothersroom, B017 firstaid, B018/B019 room, B020 opentobelow, B021 stairs, B022 elevator, B023 escalator, B024/B025 walkway, B026 nonpublic, B027 parking, B028 platform, B029 walkway` (default `unspecified`).
- **C (fixture/detail)**: `C001 column, C002 bench, … C008 obstruction, C010 wall, C011 water, … C101 platform.screen, C104 ticketgate, …` (default `unspecified`) — full table copied from `c-codes.json`.
- **A (venue)**: `A001 transitstation, …` (default `other`) — full table from `a-codes.json`.

### Part B — Walkable category set (Rust generator)

In **both** `core/crates/kiriko-bundle/src/synth_medial.rs:261` and `synth.rs:56`, replace `is_walkway`:

```rust
fn is_walkway(category: &str) -> bool {
    matches!(
        category,
        "walkway" | "walkway.island" | "movingwalkway" | "footbridge" | "ramp" | "steps"
            | "lobby" | "platform" | "unenclosedarea" | "corridor" | "sidewalk"
    )
}
```

`is_transit` (`stairs | escalator | elevator`) is unchanged. Rationale: these are the IMDF through-circulation categories; `platform` is required or station platform levels have no navigable area. Destinations/obstacles (`room, retail, office, restroom*, waitingroom, nonpublic, parking, opentobelow`) stay non-walkable and are reached via their doorway `opening`.

### Part C — Empty-graph generation fails loudly (server + client)

In `server/src/jobs/publish.ts`, when `synthesizeNetwork === true`: after `compile()` produces the bundle, check whether it actually contains a §5 graph by calling the existing `exportVenueNetwork(bundle)` (from `../core/native`) in a try/catch. If it throws `CoreExportError` with `code === "no_graph"`, do **not** publish; throw a structured failure so the version is marked `status='failed'` with:

```ts
{ code: "no_routable_network",
  message: "No routable space found. Check that walkable units (walkway, platform, …) are mapped." }
```

The existing failure path (`UPDATE versions SET status='failed', error=?`) and job-error surfacing carry it to the UI. Because `service.ts`'s `hasGraph` only considers the latest **published** version, a failed synth version never falsely shows "Review network"; the venue's latest published stays the venue-only base.

**Client** `src/gallery/api.ts`: add a localized entry for `no_routable_network` to the GDB error copy map so the gallery toast reads clearly (ja/en).

## Files touched

- **Create** `server/src/gdb/categoryCodes.ts` (tables + `mapCategoryCode`).
- **Modify** `server/src/gdb/mapping.ts` (one call at :1187).
- **Modify** `core/crates/kiriko-bundle/src/synth_medial.rs` + `synth.rs` (`is_walkway`).
- **Modify** `server/src/jobs/publish.ts` (empty-graph guard for synth jobs).
- **Modify** `src/gallery/api.ts` (error copy).
- Tests: `server/test` (mapping + publish), Rust unit test (`synth_medial`), client api copy.
- **Rebuild** the native addon (Rust change) as a final step.

## Data flow

GDB source field `"B029"` → `mapCategoryCode` → `"walkway"` → `transient.category` → IMDF `unit.category` → Rust importer → `synthesize_network_medial` `is_walkway("walkway")=true` → navigable area → medial graph → §5 → `hasGraph`. If a venue genuinely has no walkable units → empty graph → publish job fails with `no_routable_network` → gallery shows the message.

## Error handling

- Unknown/blank codes → table `default_category` (never crash); non-code strings pass through.
- Empty synthesized graph → explicit `no_routable_network` failure (Part C).
- Real-network imports and non-synth publishes are unaffected (the Part C guard only runs when `synthesizeNetwork === true`).

## Testing

1. **`mapCategoryCode` unit tests**: `B021→stairs`, `B029→walkway`, `B028→platform`, `C010→wall`, `A001→transitstation`, unknown `B999→unspecified`, non-code `"room"→"room"`.
2. **Rust `is_walkway`**: a synthetic doc with `platform` (and `walkway`) units generates a non-empty graph; a doc whose only units are `room`/`retail` generates an empty graph.
3. **Server publish guard**: a synth job whose compile yields no graph marks the version `failed` with `no_routable_network` and does not publish; a synth job that yields a graph publishes normally.
4. **Client**: `gdbErrorMessage({code:"no_routable_network"}, locale)` returns the new copy.
5. **Real-data check** (manual): re-import Takanawa (Takanawa building), Generate routing → a non-empty network appears in Review; confirm via the addon that the bundle has junctions/paths.

## Verification

- `cargo test -p kiriko-bundle --features netgen`; server + client vitest for touched files; `tsc --noEmit` (server + client); rebuild addon and confirm medial + a non-empty graph for the Takanawa source.
