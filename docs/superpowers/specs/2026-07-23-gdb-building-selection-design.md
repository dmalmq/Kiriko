# GDB Building Selection — Design

**Date:** 2026-07-23
**Status:** Approved (brainstorm), pending spec review

## Problem

A GDB dataset can contain **several buildings** in one geodatabase. Example: `C:\cesium\Takanawa Gateway\JRTokyoSta_3857.gdb` holds `JRShinagawaSta` (floors 1–4), `JRTakanawaGatewaySta` (floors 1–3), and a `LinkPillar1` connector, each encoded as feature-class name prefixes (`<Building>_<Floor>_<Category>`, e.g. `JRTakanawaGatewaySta_2_Space`), alongside shared base-map layers (roads, water, footprints).

Today the review dialog auto-detects those buildings and lets you include/exclude **individual layers**, but there is no way to import **just one building**. Doing so means manually unchecking every layer of every other building (~30+ rows). We want a one-click way to import a chosen subset of buildings.

## Goal

In the GDB review dialog, let the user include or exclude a whole building with a single checkbox, so importing one building from a multi-building GDB (e.g. only `JRTakanawaGatewaySta`) is one action. Default behavior is unchanged: all buildings included.

## Non-Goals

- No server, API-schema, or Rust changes. The building grouping already exists in the plan.
- Base-map / unprefixed layers (no `buildingId`) are out of scope — they remain governed by their own per-layer Include toggles.
- No single-select restriction: any subset (one or more) may be chosen. (User decision.)
- No change to the "Edit mapping" re-open flow beyond what it inherits for free (it uses the same dialog).

## Current State (grounding)

- **Server** `server/src/gdb/mapping.ts` `suggestGdbMapping()` derives, from a GDB inspection, a `GdbMappingPlan`:
  - `buildings: [{ id, name }]` — one per detected name prefix (via the `STRUCTURED_NAME` regex, capture group 1).
  - `layers: [{ key, included, targetType, buildingId, levelRule, … }]` — each structured layer assigned a `buildingId`; unprefixed layers get `buildingId: null`.
- **Client** `src/gallery/GdbImportDialog.tsx`:
  - Owns the edited plan: `const [plan, setPlan] = useState<GdbMappingPlan>(initialPlan)`.
  - **Buildings section** (`plan.buildings.map`) renders one row per building with a name input and a **Delete** button; `assigned = plan.layers.some((l) => l.included && l.buildingId === building.id)` and Delete is disabled while `assigned`.
  - **Layers table** with a per-row Include checkbox → `updateRow(row.key, { included })`.
  - Import submits `onImport(pruneUnusedBuildings(plan))`. `pruneUnusedBuildings()` already **drops any building that no included layer assigns** from the published `buildings[]`.
  - `updateRow(key, patch)` maps over `plan.layers` updating one row by key.

## Design

### Component change (`src/gallery/GdbImportDialog.tsx`)

1. **New bulk handler:**
   ```ts
   function setBuildingIncluded(buildingId: string, include: boolean): void {
     setPlan((current) => ({
       ...current,
       layers: current.layers.map((row) =>
         row.buildingId === buildingId ? { ...row, included: include } : row,
       ),
     }));
   }
   ```
2. **Buildings section:** each building row gains an Include checkbox before the name input:
   - `checked = assigned` (the row already computes `assigned` = building has ≥1 included layer).
   - `onChange` → `setBuildingIncluded(building.id, event.target.checked)`.
   - Labeled for a11y (e.g. `aria-label={`${ui.includeBuilding[locale]} ${building.name || building.id}`}`).
3. **New localized `ui` string** `includeBuilding: { ja: "取り込む", en: "Include" }` (column/label wording finalized in the plan).

### Behavior

- **Exclude a building:** uncheck → all its layers `included=false`. At import, `pruneUnusedBuildings` removes it from `buildings[]`, so it is absent from the compiled venue and building-polygon synthesis. Importing only `JRTakanawaGatewaySta` = uncheck the other buildings.
- **Re-include a building:** check → all its layers `included=true`. (A bulk convenience; it re-includes layers a user may have individually excluded earlier — acceptable, and rare in the primary "exclude the ones I don't want" flow.)
- **Default:** all buildings start with included layers (from `suggestGdbMapping`), so every box is checked and behavior matches today.
- **Per-layer toggles** remain fully functional and independent after a bulk toggle.
- **Base-map/unprefixed layers** (`buildingId: null`) are unaffected — no checkbox governs them.

### Data flow

`suggestGdbMapping` (server) → `initialPlan` → dialog `plan` state → building checkbox bulk-toggles `layers[].included` → Import → `pruneUnusedBuildings(plan)` drops empty buildings → `publishGdb(plan)` (existing) → server compiles only the retained buildings' layers.

### Error handling / guardrails (all existing)

- Uncheck **every** building → no included layers → Import already disabled / `no_included_layers`.
- A layer whose `buildingId` points to a dropped building can never reach conversion, because that building is only dropped when it has **no included layers** (`pruneUnusedBuildings` invariant).
- Retryable conversion errors preserve the edited `plan` (dialog owns state) — unchanged.

## Testing

Extend `src/gallery/GdbImportDialog.test.tsx`:

1. **Bulk exclude:** render a two-building plan (`b1` with an included layer, `b2` with an included layer). Uncheck `b2`'s building checkbox; click Import. Assert `onImport` received a plan whose `layers` for `b2` are `included:false` and whose `buildings[]` contains only `b1` (pruned).
2. **Checkbox reflects state:** a building whose layers are all excluded renders its checkbox unchecked; one with an included layer renders checked.
3. Existing tests (per-layer include, blocking issue when a layer lacks a building) must stay green.

## Files touched

- `src/gallery/GdbImportDialog.tsx` — bulk handler, checkbox in Buildings section, one `ui` string.
- `src/gallery/GdbImportDialog.test.tsx` — two new tests.

No other files.
