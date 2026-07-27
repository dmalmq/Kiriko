# GDB Building Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-building **Include** checkbox to the GDB review dialog's Buildings section so a user can import a subset of buildings (e.g. only `JRTakanawaGatewaySta`) from a multi-building GDB in one click.

**Architecture:** Client-only change in `src/gallery/GdbImportDialog.tsx`. The plan already carries `buildings[]` and each layer's `buildingId` (from the server's `suggestGdbMapping`). A building checkbox bulk-toggles `included` on that building's layers; the existing `pruneUnusedBuildings(plan)` at import drops buildings with no included layers. No server, schema, or Rust changes.

**Tech Stack:** React + TypeScript, Vitest + Testing Library.

## Global Constraints

- Client-only. Do NOT change `server/`, the API schema, `src/gdb/types.ts`, or Rust.
- Default behavior unchanged: with `suggestGdbMapping`'s output every building has included layers, so every checkbox starts checked and import-everything still works.
- Reuse the existing per-row `assigned = plan.layers.some((l) => l.included && l.buildingId === building.id)` as the checkbox `checked` state; do not add new plan/schema fields.
- Follow the file's existing patterns: `setPlan((current) => …)` updates, `ui` localization object (ja/en), `gdb-dialog__*` classNames.
- Run only the touched suite during work: `pnpm exec vitest run src/gallery/GdbImportDialog.test.tsx`; full suites at the end.

---

## File Structure

- **Modify** `src/gallery/GdbImportDialog.tsx`:
  - one `ui` string (`includeBuilding`);
  - one handler `setBuildingIncluded(buildingId, include)` beside `updateRow`;
  - an Include `<input type="checkbox">` as the first child of each building `<li>`.
- **Modify** `src/gallery/GdbImportDialog.test.tsx`: two tests (bulk exclude prunes the building; checkbox reflects `assigned`).

---

### Task 1: Per-building Include checkbox

**Files:**
- Modify: `src/gallery/GdbImportDialog.tsx` (`ui` object ~line 25-61; handlers ~line 348-356; Buildings `<li>` ~line 467-485)
- Test: `src/gallery/GdbImportDialog.test.tsx`

**Interfaces:**
- Produces (module-internal): `setBuildingIncluded(buildingId: string, include: boolean): void` — sets `included` on every `plan.layers` row whose `buildingId === buildingId`.
- Consumes: existing `setPlan`, `plan`, per-row `assigned`, `pruneUnusedBuildings` (unchanged), and the `GdbImportDialogProps.onImport` contract.

- [ ] **Step 1: Write the failing tests**

Add to `src/gallery/GdbImportDialog.test.tsx`. This mirrors the existing render call (`inspection`, `initialPlan`, `locale`, `busy`, `error`, `onImport`, `onCancel`) but uses a two-building fixture:

```tsx
it("excludes a whole building's layers and prunes it from the imported plan", async () => {
  const user = userEvent.setup();
  const twoBuildingInspection: GdbInspection = {
    sourceName: "Multi.gdb",
    databases: [{ id: "gdb-1", name: "Multi.gdb" }],
    layers: [
      { key: { databaseId: "gdb-1", layerName: "Takanawa_1_Floor" }, databaseName: "Multi.gdb", featureCount: 3, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
      { key: { databaseId: "gdb-1", layerName: "Shinagawa_1_Floor" }, databaseName: "Multi.gdb", featureCount: 3, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
    ],
    warnings: [],
  };
  const twoBuildingPlan: GdbMappingPlan = {
    venueName: "Multi",
    buildings: [
      { id: "b1", name: "Takanawa" },
      { id: "b2", name: "Shinagawa" },
    ],
    layers: [
      { key: { databaseId: "gdb-1", layerName: "Takanawa_1_Floor" }, included: true, targetType: "level", buildingId: "b1", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
      { key: { databaseId: "gdb-1", layerName: "Shinagawa_1_Floor" }, included: true, targetType: "level", buildingId: "b2", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
    ],
  };
  const onImport = vi.fn();
  render(<GdbImportDialog inspection={twoBuildingInspection} initialPlan={twoBuildingPlan} locale="en" busy={false} error={null} onImport={onImport} onCancel={() => {}} />);

  // Uncheck the Shinagawa building.
  await user.click(screen.getByRole("checkbox", { name: "Include Shinagawa" }));
  await user.click(screen.getByRole("button", { name: /import/i }));

  expect(onImport).toHaveBeenCalledTimes(1);
  const submitted = onImport.mock.calls[0]![0] as GdbMappingPlan;
  // Shinagawa's layer excluded; its building pruned; Takanawa retained.
  expect(submitted.layers.find((l) => l.buildingId === "b2")!.included).toBe(false);
  expect(submitted.buildings.map((b) => b.id)).toEqual(["b1"]);
});

it("shows a building's Include checkbox checked when it has an included layer", () => {
  const inspectionOne: GdbInspection = {
    sourceName: "Station.gdb",
    databases: [{ id: "gdb-1", name: "Station.gdb" }],
    layers: [{ key: { databaseId: "gdb-1", layerName: "Station_1_Floor" }, databaseName: "Station.gdb", featureCount: 3, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] }],
    warnings: [],
  };
  const planOne: GdbMappingPlan = {
    venueName: "Station",
    buildings: [{ id: "b1", name: "Station" }],
    layers: [{ key: { databaseId: "gdb-1", layerName: "Station_1_Floor" }, included: true, targetType: "level", buildingId: "b1", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null }],
  };
  render(<GdbImportDialog inspection={inspectionOne} initialPlan={planOne} locale="en" busy={false} error={null} onImport={vi.fn()} onCancel={() => {}} />);
  expect((screen.getByRole("checkbox", { name: "Include Station" }) as HTMLInputElement).checked).toBe(true);
});
```

Ensure the test file imports `userEvent` (add `import userEvent from "@testing-library/user-event";` if not already present) and `screen`, `render` from `@testing-library/react`, plus `GdbInspection`/`GdbMappingPlan` types (already imported in the file).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/gallery/GdbImportDialog.test.tsx -t "Include" 2>&1 | tail -20`
Expected: FAIL — `Unable to find an accessible element with the role "checkbox" and name "Include Shinagawa"` (no building checkbox yet).

- [ ] **Step 3: Add the `ui` string**

In the `ui` object (around line 28, beside `buildings`/`addBuilding`), add:

```ts
  includeBuilding: { ja: "取り込む", en: "Include" },
```

- [ ] **Step 4: Add the bulk handler**

Immediately after `updateRow` (after line 356), add:

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

- [ ] **Step 5: Render the checkbox in each building row**

In the Buildings section, insert the checkbox as the first child of the `<li>` (before the name `<input>` at line 468):

```tsx
                <li key={building.id} className="gdb-dialog__building-row">
                  <input
                    type="checkbox"
                    className="gdb-dialog__checkbox"
                    aria-label={`${ui.includeBuilding[locale]} ${building.name || building.id}`}
                    checked={assigned}
                    onChange={(event) => setBuildingIncluded(building.id, event.target.checked)}
                  />
                  <input
                    type="text"
                    className="gdb-dialog__input"
                    aria-label={`${ui.buildingNamePlaceholder[locale]} ${building.id}`}
                    placeholder={ui.buildingNamePlaceholder[locale]}
                    value={building.name}
                    onChange={(event) => renameBuilding(building.id, event.target.value)}
                  />
```

(Leave the existing Delete button and the rest of the `<li>` unchanged.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/gallery/GdbImportDialog.test.tsx 2>&1 | grep -E "Tests |FAIL"`
Expected: all pass (the two new tests plus the pre-existing ones).

- [ ] **Step 7: Typecheck**

Run: `pnpm exec tsc --noEmit 2>&1 | tail -3; echo "exit ${PIPESTATUS[0]}"`
Expected: `exit 0`.

- [ ] **Step 8: Commit**

```bash
git add src/gallery/GdbImportDialog.tsx src/gallery/GdbImportDialog.test.tsx
git commit -m "feat(gdb): per-building Include checkbox to import a subset of buildings"
```

---

## Verification (final)

- `pnpm exec vitest run src/gallery` — gallery suite green.
- `pnpm exec vitest run` + `pnpm exec tsc --noEmit` — full client suite + typecheck green.
- Manual smoke (optional): import `C:\cesium\Takanawa Gateway\JRTokyoSta_3857.gdb`, uncheck every building except `JRTakanawaGatewaySta`, import → the published venue contains only Takanawa's floors/units/openings.

## Self-Review

- **Spec coverage:** per-building checkbox (Steps 3-5), bulk exclude + prune verified (Step 1 test 1), checkbox-reflects-state (Step 1 test 2), default-all-checked (unchanged, covered by existing tests staying green). ✓
- **No placeholders:** all steps carry exact code and commands.
- **Type consistency:** `setBuildingIncluded(buildingId: string, include: boolean)` matches its callsite in Step 5; checkbox `checked={assigned}` uses the row's existing `assigned` boolean; `onImport` receives `pruneUnusedBuildings(plan)` (unchanged code path). ✓
- **Scope:** one component + its test; no server/schema/Rust. ✓
