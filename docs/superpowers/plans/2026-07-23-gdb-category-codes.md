# GDB Category Codes + Walkable Set + Empty-Graph UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make GDB-imported venues generate routing by (1) translating the company's internal A/B/C category codes to IMDF categories at import, (2) broadening the generator's walkable set (incl. `platform`), and (3) failing loudly when synthesis yields no network.

**Architecture:** (1) new `server/src/gdb/categoryCodes.ts` (copied A/B/C tables + `mapCategoryCode`) applied at the single category site in `mapping.ts`. (2) `is_walkway` widened in both Rust synth modules. (3) `publish.ts` fails a synth job whose compiled bundle has no §5 graph, surfaced via a new client error string.

**Tech Stack:** TypeScript (Fastify server, React client), Rust (`kiriko-bundle`), Vitest + `cargo test`.

## Global Constraints

- The A/B/C tables are **copied verbatim** from `C:\Repositories\shp2imdf-converter\backend\config\{a,b,c}-codes.json` into `categoryCodes.ts`. They are a **manual copy** kept in sync (separate repo) — note this in a file comment.
- Table selection is by the **value's prefix letter** (`A`→venue, `B`→unit, `C`→fixture/detail). Non-code values pass through unchanged; unknown codes fall back to the table's `default_category`.
- The walkable set change goes in **both** `synth_medial.rs` and `synth.rs` (identical bodies).
- The empty-graph guard runs **only when `synthesizeNetwork === true`**; normal publishes/augments/imports are untouched.
- Run scoped tests during work. The pre-existing `golden_fixture` Windows-CRLF failure is unrelated — ignore it. Rebuild the native addon + full suites in the final task only.

---

## File Structure

- **Create** `server/src/gdb/categoryCodes.ts` — `A_CODES`, `B_CODES`, `C_CODES` tables + `mapCategoryCode(raw)`.
- **Create** `server/test/categoryCodes.test.ts`.
- **Modify** `server/src/gdb/mapping.ts` — one call at the category site (~:1187).
- **Modify** `core/crates/kiriko-bundle/src/synth_medial.rs` + `src/synth.rs` — `is_walkway`.
- **Modify** `server/src/jobs/publish.ts` — empty-graph guard + error class.
- **Modify** `server/test/gdbFacilities.test.ts` — empty-graph failure test.
- **Modify** `src/gallery/api.ts` — `no_routable_network` copy; `src/gallery/api.test.ts` — assertion.

---

## Task 1: Internal code → IMDF category mapping

**Files:** Create `server/src/gdb/categoryCodes.ts`, `server/test/categoryCodes.test.ts`; Modify `server/src/gdb/mapping.ts:1187`.

**Interfaces:**
- Produces: `mapCategoryCode(raw: string): string`.
- Consumes: called in `mapping.ts` on the raw category string.

- [ ] **Step 1: Write the failing test** — `server/test/categoryCodes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapCategoryCode } from "../src/gdb/categoryCodes";

describe("mapCategoryCode", () => {
  it("maps B-codes to unit categories", () => {
    expect(mapCategoryCode("B021")).toBe("stairs");
    expect(mapCategoryCode("B022")).toBe("elevator");
    expect(mapCategoryCode("B023")).toBe("escalator");
    expect(mapCategoryCode("B024")).toBe("walkway");
    expect(mapCategoryCode("B029")).toBe("walkway");
    expect(mapCategoryCode("B028")).toBe("platform");
    expect(mapCategoryCode("B001")).toBe("retail");
    expect(mapCategoryCode("B019")).toBe("room");
  });
  it("maps C-codes to fixture categories and A-codes to venue categories", () => {
    expect(mapCategoryCode("C010")).toBe("wall");
    expect(mapCategoryCode("C008")).toBe("obstruction");
    expect(mapCategoryCode("C104")).toBe("ticketgate");
    expect(mapCategoryCode("A001")).toBe("transitstation");
  });
  it("falls back to the table default for unknown codes and passes non-codes through", () => {
    expect(mapCategoryCode("B999")).toBe("unspecified");
    expect(mapCategoryCode("A999")).toBe("other");
    expect(mapCategoryCode("room")).toBe("room");
    expect(mapCategoryCode("walkway")).toBe("walkway");
    expect(mapCategoryCode("")).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && pnpm exec vitest run categoryCodes 2>&1 | tail -6`
Expected: FAIL — module `../src/gdb/categoryCodes` not found.

- [ ] **Step 3: Create `server/src/gdb/categoryCodes.ts`** (tables verbatim from the converter config):

```ts
// Company internal category codes → IMDF categories. Copied verbatim from
// shp2imdf-converter/backend/config/{a,b,c}-codes.json. This is a MANUAL COPY
// (the converter is a separate repo); keep in sync if those tables change.
// The value's prefix letter selects the table: A → venue, B → unit,
// C → fixture/detail. Non-code values pass through unchanged.

interface CodeTable {
  default_category: string;
  mappings: Record<string, string>;
}

const A_CODES: CodeTable = {
  default_category: "other",
  mappings: {
    A001: "transitstation", A002: "airport", A003: "stadium", A004: "shoppingcenter",
    A005: "conventioncenter", A006: "governmentfacility", A007: "medicalfacility",
    A008: "welfare", A009: "communitycenter", A010: "hotel", A011: "parkingfacility",
    A012: "university", A013: "theater", A014: "aquarium", A015: "museum", A016: "other",
    A017: "retailstore", A018: "shoppingcenter", A019: "resort", A020: "themepark",
    A021: "casino", A022: "other", A023: "businesscampus", A024: "publictoilet", A999: "other",
  },
};

const B_CODES: CodeTable = {
  default_category: "unspecified",
  mappings: {
    B001: "retail", B002: "office", B003: "publicfacility", B004: "waitingroom",
    B005: "tickets", B006: "information", B007: "restroom.male", B008: "restroom.female",
    B009: "restroom.unisex", B010: "restroom", B011: "restroom", B012: "restroom",
    B013: "restroom", B014: "restroom", B015: "smokingarea", B016: "mothersroom",
    B017: "firstaid", B018: "room", B019: "room", B020: "opentobelow", B021: "stairs",
    B022: "elevator", B023: "escalator", B024: "walkway", B025: "walkway", B026: "nonpublic",
    B027: "parking", B028: "platform", B029: "walkway",
  },
};

const C_CODES: CodeTable = {
  default_category: "unspecified",
  mappings: {
    C001: "column", C002: "bench", C003: "reception", C004: "cubicle", C005: "rubbishbin",
    C006: "furniture", C007: "kiosk", C008: "obstruction", C009: "vegetation", C010: "wall",
    C011: "water", C012: "locker", C013: "vendingmachine", C014: "atm", C015: "stage",
    C016: "fence", C017: "twsi.hazard", C018: "twsi.guidance", C019: "twsi.crossing",
    C101: "platform.screen", C102: "platform.gate", C103: "ticket.vending", C104: "ticketgate",
    C201: "baggage.carousel", C202: "checkin.kiosk", C999: "unspecified",
  },
};

/**
 * Translate a company internal category code to its IMDF category. The prefix
 * letter (A/B/C) selects the table; unknown codes fall back to that table's
 * default; a value that is not an A/B/C code is returned unchanged.
 */
export function mapCategoryCode(raw: string): string {
  const m = /^([ABC])(\d+)$/.exec(raw.trim());
  if (m === null) return raw;
  const table = m[1] === "A" ? A_CODES : m[1] === "B" ? B_CODES : C_CODES;
  const key = raw.trim().toUpperCase();
  return table.mappings[key] ?? table.default_category;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && pnpm exec vitest run categoryCodes 2>&1 | grep -E "Tests |FAIL"`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into `mapping.ts`**

At `server/src/gdb/mapping.ts:1187`, insert the mapping call so it runs before the unit-null default. Current lines:
```ts
      let category = coerceString(layer.categoryField ? props[layer.categoryField] : undefined);
      if (targetType === "unit" && category === null) category = "room";
```
Change to:
```ts
      let category = coerceString(layer.categoryField ? props[layer.categoryField] : undefined);
      if (category !== null) category = mapCategoryCode(category);
      if (targetType === "unit" && category === null) category = "room";
```
Add the import at the top of `mapping.ts` (beside the other `./` imports):
```ts
import { mapCategoryCode } from "./categoryCodes";
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd server && pnpm exec tsc --noEmit 2>&1 | tail -3; echo "exit ${PIPESTATUS[0]}"` → `exit 0`.
```bash
git add server/src/gdb/categoryCodes.ts server/test/categoryCodes.test.ts server/src/gdb/mapping.ts
git commit -m "feat(gdb): map internal A/B/C category codes to IMDF categories on import"
```

---

## Task 2: Broaden the generator's walkable set

**Files:** Modify `core/crates/kiriko-bundle/src/synth_medial.rs` (`is_walkway`, ~:261) and `src/synth.rs` (`is_walkway`, ~:56); Test in `synth_medial.rs` `mod tests`.

**Interfaces:** behavioral — `synthesize_network_medial` produces a non-empty graph for a `platform`/`walkway` venue and empty for a `room`-only venue.

- [ ] **Step 1: Write the failing test** — append to `synth_medial.rs` `mod tests` (uses existing `document`, `feature`, `square`, `rect`, `component_count` helpers):

```rust
    #[test]
    fn platform_units_are_walkable() {
        // A floor whose only navigable unit is a platform must still synthesize
        // a centerline network.
        let features = vec![
            feature("p", FeatureType::Unit, "l0", Some("platform"),
                rect(139.70000, 35.60000, 0.00060, 0.00003)),
        ];
        let doc = document(&[("l0", 0.0)], features);
        let build = synthesize_network_medial(&doc);
        assert!(!build.graph.nodes.is_empty(), "platform is walkable → non-empty graph");
    }

    #[test]
    fn rooms_only_yield_no_network() {
        let features = vec![
            feature("r", FeatureType::Unit, "l0", Some("room"),
                square(139.70000, 35.60000, 0.00040)),
        ];
        let doc = document(&[("l0", 0.0)], features);
        let build = synthesize_network_medial(&doc);
        assert!(build.graph.nodes.is_empty(), "non-walkable rooms → empty graph");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd core && cargo test -p kiriko-bundle --features netgen platform_units_are_walkable 2>&1 | grep -E "test result|FAILED"`
Expected: FAIL — `platform` not yet walkable → empty graph.

- [ ] **Step 3: Widen `is_walkway` in both modules**

In `core/crates/kiriko-bundle/src/synth_medial.rs` (~:261) and `core/crates/kiriko-bundle/src/synth.rs` (~:56), replace the body:
```rust
fn is_walkway(category: &str) -> bool {
    matches!(
        category,
        "walkway"
            | "walkway.island"
            | "movingwalkway"
            | "footbridge"
            | "ramp"
            | "steps"
            | "lobby"
            | "platform"
            | "unenclosedarea"
            | "corridor"
            | "sidewalk"
    )
}
```
Leave `is_transit` unchanged.

- [ ] **Step 4: Run to verify it passes (both tests + suite)**

Run: `cd core && cargo test -p kiriko-bundle --features netgen 2>&1 | grep -E "test result|FAILED" | grep -v golden_fixture`
Expected: all `synth_medial` unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/crates/kiriko-bundle/src/synth_medial.rs core/crates/kiriko-bundle/src/synth.rs
git commit -m "feat(synth): treat platform + circulation categories as walkable"
```

---

## Task 3: Fail loudly when synthesis yields no network

**Files:** Modify `server/src/jobs/publish.ts`, `src/gallery/api.ts`; Tests in `server/test/gdbFacilities.test.ts`, `src/gallery/api.test.ts`.

**Interfaces:**
- Produces: a synth job whose compiled bundle has no §5 graph ends as version `status='failed'`, `error` code `no_routable_network`.
- Consumes: existing `exportVenueNetwork` + `CoreExportError` from `../core/native`; `fake.exportThrowsNoGraph` in the test harness.

- [ ] **Step 1: Write the failing test** — in `server/test/gdbFacilities.test.ts`, inside the `describe("POST /api/gdb/generate-network", …)` block, add:

```ts
  it("fails with no_routable_network when synthesis produces no graph", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await publishBaseWithFacilities(app, cookie);
    fake.exportThrowsNoGraph = true; // simulate an empty synthesized graph
    fake.compileCalls.length = 0;

    const res = await app.inject({
      method: "POST", url: "/api/gdb/generate-network", headers: { cookie },
      payload: { venueId },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { versionId: number };
    await app.queue.idle();

    const row = app.db
      .prepare("SELECT status, error FROM versions WHERE id = ?")
      .get(body.versionId) as { status: string; error: string | null };
    expect(row.status).toBe("failed");
    expect(JSON.parse(row.error!).code).toBe("no_routable_network");
  });
```

(`publishBaseWithFacilities` is the existing helper in that describe block.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && pnpm exec vitest run gdbFacilities -t "no_routable_network" 2>&1 | grep -E "Tests |FAIL|published|failed"`
Expected: FAIL — the version currently publishes (status `published`), not `failed`.

- [ ] **Step 3: Add the guard to `publish.ts`**

Extend the import (line ~3):
```ts
import { compileVenueBundle, CoreCompileError, exportVenueNetwork, CoreExportError, type CompileVenueMetadata } from "../core/native";
```
Add the error class near `StaleVersionError`:
```ts
/** Thrown when a synthesize request compiles a bundle with no §5 graph. */
class NoRoutableNetworkError extends Error {}
```
Add a branch in `toStructuredError` (before the final return):
```ts
  if (error instanceof NoRoutableNetworkError) {
    return {
      code: "no_routable_network",
      message: "No routable space found. Check that walkable units (walkway, platform, …) are mapped.",
    };
  }
```
In the runner's `try`, immediately after `const { bundle, stats } = await compile(source, metadata);` and before `blobs.put(bundle)`:
```ts
      if (synthesizeNetwork === true) {
        try {
          await exportVenueNetwork(bundle);
        } catch (error) {
          if (error instanceof CoreExportError && error.code === "no_graph") {
            throw new NoRoutableNetworkError("synthesized graph is empty");
          }
          throw error;
        }
      }
```
This lands in the existing `catch`, which records `status='failed'` with the structured `no_routable_network` error under the same identity predicate.

- [ ] **Step 4: Add client error copy** — in `src/gallery/api.ts`, add to `gdbErrorCopy` (after `gdb_network_extraction_failed`, before the closing `}` at ~:115):
```ts
  no_routable_network: {
    ja: "経路網を生成できませんでした。歩行可能なユニット（walkway / platform など）が割り当てられているか確認してください。",
    en: "No routable network could be generated. Check that walkable units (e.g. walkway, platform) are mapped.",
  },
```

- [ ] **Step 5: Add the client copy test** — in `src/gallery/api.test.ts`, in the `gdbErrorMessage` describe:
```ts
  it("maps no_routable_network to actionable copy", () => {
    expect(gdbErrorMessage({ code: "no_routable_network", message: "x" }, "en")).toContain("walkable");
  });
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd server && pnpm exec vitest run gdbFacilities -t "no_routable_network" 2>&1 | grep -E "Tests |FAIL"` → PASS.
Run: `pnpm exec vitest run src/gallery/api.test.ts -t "no_routable_network" 2>&1 | grep -E "Tests |FAIL"` → PASS.
Run: `cd server && pnpm exec tsc --noEmit 2>&1 | tail -2; echo "srv ${PIPESTATUS[0]}"` and `pnpm exec tsc --noEmit 2>&1 | tail -2; echo "client ${PIPESTATUS[0]}"` → both exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/jobs/publish.ts server/test/gdbFacilities.test.ts src/gallery/api.ts src/gallery/api.test.ts
git commit -m "feat(gdb): fail generate-routing with no_routable_network when synthesis is empty"
```

---

## Task 4: Rebuild addon + full verification + real-data smoke

**Files:** none (build + verify).

- [ ] **Step 1: Rebuild the native addon** (Rust `is_walkway` changed):
```bash
cd core/crates/kiriko-node && pnpm run build 2>&1 | tail -1; \
cp -f ../../target/x86_64-pc-windows-msvc/release/kiriko_node.dll kiriko-node.win32-x64-msvc.node 2>/dev/null && echo copied; \
pnpm run build 2>&1 | tail -1
```
(The second `pnpm run build` exits 1 at the napi copy step after the DLL is already copied — expected on Windows.)

- [ ] **Step 2: Rust suite**

Run: `cd core && cargo test --features netgen 2>&1 | grep -E "test result: FAIL|FAILED" | grep -v golden_fixture; echo done`
Expected: only the known `golden_fixture` CRLF failure (filtered).

- [ ] **Step 3: Server + client suites + typecheck**

Run: `cd server && pnpm exec vitest run 2>&1 | grep -E "Test Files|Tests |FAIL "`
Run: `pnpm exec vitest run 2>&1 | grep -E "Test Files|Tests |FAIL "`
Run: `pnpm exec tsc --noEmit 2>&1 | tail -2; echo "client ${PIPESTATUS[0]}"`
Expected: all pass; client `exit 0`.

- [ ] **Step 4: Real-data smoke** — recompile the Takanawa source IMDF with synthesis and confirm a non-empty graph (proves the code-mapping + walkable-set fix end-to-end):
```bash
cd core/crates/kiriko-node && node --input-type=module -e '
import * as a from "./index.js"; import { readFileSync } from "node:fs";
const SRC="../../../server/data/blobs/sha256/e6/e6cdc33152508b4f204b47687cb04df84c01a834550c62dbf4590c8ad395e83d";
const r = await a.compileImdf(readFileSync(SRC),"t/v",1,undefined,undefined,undefined,true);
try { const n = await a.exportNetwork(r.bundle); const j = JSON.parse(n.junctions); console.log("junctions:", j.features.length); }
catch (e) { console.log("still no graph:", String(e).slice(0,120)); }
'
```
> Note: this source IMDF was imported **before** the code-mapping fix, so its units still carry raw `B###` codes — it will still show no graph. The true end-to-end check is: **re-import Takanawa through the fixed importer, then Generate routing** and confirm the network renders in Review. If a pre-mapped fixture is available, use it here instead.

- [ ] **Step 5: Commit the rebuilt addon note (if tracked) / finish**

The `.node` is git-ignored, so nothing to commit. Confirm the working tree is clean apart from ignored artifacts, then this branch is ready for PR.

## Self-Review

- **Spec coverage:** Part A (Task 1), Part B (Task 2), Part C (Task 3), rebuild+verify (Task 4). ✓
- **No placeholders:** all tables transcribed in full; every step has code + commands.
- **Type consistency:** `mapCategoryCode(raw: string): string` matches its call in `mapping.ts`; `NoRoutableNetworkError` handled in `toStructuredError`; error code `no_routable_network` matches between `publish.ts`, the server test, and the client copy/test. ✓
- **Scope:** three cohesive parts, one plan. ✓
- **Ambiguity:** Step-4 real-data caveat spelled out (old blob still shows empty; re-import is the true check).
