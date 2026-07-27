# Phase Zero Stabilization Implementation Plan

> **For agentic workers:** Execute tasks in order with test-driven development. Each task requires focused spec and quality review before the next task. Do not begin Phase 1 deployment work in this plan.

**Goal:** Close the six approved release-gate actions from the Phase 0 whole-repository review: critical provenance/data-integrity defects, network round-trip and save semantics, durable/cancellable server work, graph safety and grouped-floor correctness, mandatory graph-bearing browser acceptance, and the complete release matrix.

**Architecture:** Keep the existing React/MapLibre client, Fastify/SQLite server, Rust core, KVB format, and native/WASM boundaries. Correct contracts at their source instead of adding compatibility shims. Published work remains immutable and every post-load operation stays pinned to the admitted version. Jobs remain SQLite-backed but gain atomic version/job creation, restart reconciliation, and graceful draining. GDAL operations move behind a serial child-process boundary so a timeout can terminate the actual work and safely admit the next request.

**Tech stack:** TypeScript 7, React 19, Fastify 5, better-sqlite3, Vitest, Playwright, Rust 1.97, napi-rs, wasm-bindgen, gdal3.js.

---

## Task 1: Make routing graphs and network round-trips lossless

**Files:**
- Modify: `core/crates/kiriko-route/src/graph.rs`
- Modify: `core/crates/kiriko-route/src/build.rs`
- Modify: `core/crates/kiriko-route/src/query.rs`
- Modify: `core/crates/kiriko-bundle/src/sections.rs`
- Modify: `core/crates/kiriko-bundle/src/export.rs`
- Modify: `core/crates/kiriko-bundle/src/synth.rs`
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs`
- Modify: `core/crates/kiriko-wasm/src/lib.rs`
- Modify: `src/map/networkFeatures.ts`
- Test: colocated Rust tests and `src/map/networkFeatures.test.ts`

**Contract:**
- A routable graph has at least one valid edge; nodes alone never advertise Directions or Network Review.
- Every edge weight is finite, non-negative, and expressed in canonical `net_path.cost` units (millimetre-scale source cost). Generated geometric costs convert metres to cost units exactly once.
- Browser/Rust routing rejects non-finite endpoint coordinates with a controlled result/error; no panic or WASM trap.
- Network export canonicalizes each reciprocal `PATHID`/`RPATHID` pair into one logical undirected edge, preserves legitimate parallel edges, emits one reciprocal pair per logical edge, and writes the stored cost without another ×1,000 conversion.
- Export/re-import/export is stable for edge count, costs, geometry, and integer floor ordinals. Fractional ordinals are rejected explicitly because the accepted GDB floor-label grammar cannot represent them losslessly.
- KVB decode validates every known section version, including optional graph and facilities sections.

**TDD sequence:**
1. Add failing Rust tests for negative weights, nodes-only routability, non-finite route endpoints, known optional-section version mismatch, reciprocal-pair canonicalization, parallel-edge preservation, unchanged costs across two export/build cycles, generated-cost units, and fractional-ordinal rejection.
2. Add failing TypeScript tests for reciprocal edit serialization and non-finite inputs at the browser adapter boundary.
3. Run only the affected Rust crate tests and `networkFeatures.test.ts`; confirm failures match the defects.
4. Implement the minimal invariants and canonicalization. Do not add format aliases or legacy branches.
5. Re-run the focused tests and the golden KVB fixture test. Normalize the checksum file line ending rather than weakening byte/hash assertions.

## Task 2: Pin every viewer operation to one immutable version

**Files:**
- Modify: `src/app/viewerParams.ts`
- Modify: `src/gallery/api.ts`
- Modify: `src/gallery/DatasetCard.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/bundle/loadKirikoBundle.ts`
- Modify: `src/bundle/routeKirikoBundle.ts`
- Modify: `src/bundle/loadNetworkOverlay.ts`
- Modify: `server/src/serve/routes.ts`
- Test: `src/app/viewerParams.test.ts`
- Test: `src/gallery/api.test.ts`
- Test: `src/app/App.test.tsx`
- Test: `src/bundle/loadKirikoBundle.test.ts`
- Test: `server/test/serve.test.ts`

**Contract:**
- Viewer links may carry a positive sequence parameter. Gallery links include the latest published sequence they display.
- Bundle responses identify both the permanent public version and exact sequence. Admission records both values; Directions and network overlay fetch `/bundle@<seq>`, never mutable latest.
- A failed replacement load leaves the previously rendered venue and its pinned provenance active.
- Review identity, facilities, routing, and network geometry always describe the same admitted KVB.

**TDD sequence:**
1. Add failing URL/parser tests for sequence-pinned links and bundle URLs.
2. Add a failing loader/server-header test that proves latest admission receives its exact sequence.
3. Add a failing App test where latest changes after initial admission and assert route/overlay still request the admitted sequence.
4. Implement the optional sequence parameter and propagate it from the response header/gallery to admission and every subsequent bundle consumer.
5. Run the focused viewer/API/loader/App and server serve-route tests.

## Task 3: Isolate asynchronous GDB workflows by request generation

**Files:**
- Modify: `src/gallery/GalleryPage.tsx`
- Modify: `src/gallery/GdbImportDialog.tsx` only if the dialog contract needs an explicit request identity
- Test: `src/gallery/GalleryPage.test.tsx`

**Contract:**
- Each inspect, inspect-network, inspect-facilities, import, augment, and generate request captures a monotonically increasing generation plus target venue identity.
- Cancel, sign-out, flow replacement, venue switch, or opening another request invalidates prior generations.
- A late completion may not attach data, errors, progress, or busy state to a newer flow or another venue.
- The active request retains current localized error behavior.

**TDD sequence:**
1. Add deferred-promise tests for cancel/reopen, venue A→B, add-data reset, sign-out, and out-of-order completion.
2. Confirm each test fails because the stale completion mutates the current flow.
3. Add one reusable request-generation guard following existing React state/ref patterns.
4. Run `GalleryPage.test.tsx`.

## Task 4: Make edited-network save wait for publication

**Files:**
- Modify: `src/app/App.tsx`
- Modify: `src/gallery/api.ts`
- Test: `src/app/App.test.tsx`
- Test: `src/gallery/api.test.ts`

**Contract:**
- Save serializes the edited graph, submits import-network, polls the returned job, and navigates only after terminal `done`.
- Navigation targets the returned venue sequence, not mutable latest.
- Terminal publication failure keeps the edited graph in memory, re-enables Save, and shows the structured localized server error.
- Client polling timeout is non-terminal: it reports that processing continues and permits a later status check; it never fabricates a server job failure.
- No polling request or state update survives viewer unmount/venue replacement.

**TDD sequence:**
1. Add a failing deferred-job App test proving no navigation occurs on HTTP 202 or while queued/running.
2. Add failing done/error/timeout tests, including structured `no_routable_network` job errors.
3. Change `waitForJob` to distinguish terminal error from local timeout and support cancellation.
4. Update Save to await the complete lifecycle and preserve edit state on failure.
5. Run the focused App/API tests.

## Task 5: Make jobs durable and GDAL work truly cancellable

**Files:**
- Create: `server/src/db/migrations/005_job_lifecycle.sql`
- Modify: `server/src/jobs/queue.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/venues/uploadRoute.ts`
- Modify: `server/src/gdb/routes.ts`
- Modify: `server/src/gdb/gdal.ts`
- Create: `server/src/gdb/gdalProcess.ts`
- Modify: `server/src/gdb/convert.ts`
- Modify: `server/src/gdb/network.ts`
- Modify: `server/src/gdb/facilities.ts`
- Modify: `server/src/gdb/exportGdb.ts`
- Test: `server/test/app.test.ts`
- Test: `server/test/gdbRoutes.test.ts`
- Test: focused new/colocated queue and GDAL process tests following server conventions

**Contract:**
- `jobs.version_id` forms an explicit lifecycle relation. Version row and queued job row are committed atomically for IMDF and every GDB publication path.
- Startup requeues persisted `queued` jobs. It marks interrupted `running` jobs and their versions failed with a structured restart error; it never blindly replays work whose side effects may have completed.
- Draft versions with no live job are reconciled to failed rather than remaining permanent drafts.
- Shutdown stops admission, waits for accepted work, closes issue/SSE resources, then closes SQLite.
- Each GDAL operation runs in a dedicated child process behind a parent-side serial queue. Abort/timeout kills the child and waits for exit before releasing the staged file or starting the next operation.
- A queued operation whose deadline expires never starts. A killed/hung operation cannot block the queue or touch a deleted staged path later.
- gdal3.js `useWorker` is not treated as cancellation: installed source states it does not work on Node and exposes no public Node terminate API.

**TDD sequence:**
1. Add failing migration/restart tests covering a persisted draft without job, queued job, running job, and graceful close during a deferred runner.
2. Add a failing atomicity test that injects job insertion failure and proves no draft version remains.
3. Add failing process-queue tests using a real helper child: queued expiry, running abort, child exit before resolution, and next-job progress after termination.
4. Add a route test proving staged input remains until the underlying child exits.
5. Implement the migration and queue lifecycle with transactions and deterministic recovery.
6. Implement the child-process protocol with an operation allowlist, structured results/errors, bounded IPC payloads, abort handling, and no shell invocation.
7. Run the focused server tests and server typecheck.

## Task 6: Bound graph synthesis and fix grouped-floor issue placement

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs`
- Modify: `src/map/IndoorMap.tsx`
- Modify: `src/map/IndoorMap.test.tsx`
- Test: colocated synthesis tests

**Contract:**
- The medial-network budget counts original exterior and interior coordinates plus generated triangulation vertices before constructing the CDT. A structurally valid under-archive-cap IMDF cannot bypass the aggregate ceiling with dense source rings.
- Over-budget geometry fails with the established controlled synthesis warning/error; it cannot monopolize the native worker or server process.
- Feature-bound issue placement uses the clicked feature’s exact `__level_id`/venue level. Coordinate-only placement uses the representative selected level as fallback.
- Same-ordinal multi-building tests prove feature-bound issues are accepted on the correct building level.

**TDD sequence:**
1. Add a failing dense-ring budget test that exceeds the aggregate cap before triangulation.
2. Add a failing grouped-floor placement test clicking a feature from a non-representative same-ordinal level.
3. Implement source-vertex accounting and exact feature-level selection.
4. Run the focused Rust and IndoorMap tests.

## Task 7: Add mandatory graph-bearing browser acceptance and enforce the release matrix

**Files:**
- Modify: `tests/fixtures/buildMinimalImdfZip.ts` or add the smallest deterministic graph-bearing fixture through existing fixture conventions
- Modify: `e2e/gallery.spec.ts` and/or add a focused routing/network Playwright spec under `e2e/`
- Modify: `server/test/gdbSmoke.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json` only where a non-locking release command is required

**Contract:**
- Browser acceptance uses a real Fastify server, real SQLite/blob/job lifecycle, native Rust addon, WASM KVB decode/route, MapLibre interaction, and a graph-bearing publication.
- The scenario publishes/imports a graph-bearing venue, opens the sequence-pinned viewer, computes a route, opens Network Review, edits an edge, saves, waits for publication, reopens the returned sequence, and verifies stable connectivity/edge count/cost.
- Real GDAL smoke is mandatory in CI with a repository-controlled compact fixture or an explicit workflow artifact setup; it is not silently skipped by a missing environment variable.
- CI runs web and server typechecks, web/server/Rust suites, native and WASM builds, Chromium acceptance, WebKit acceptance, and deterministic visual baselines. Commands avoid rebuilding an in-use native addon.

**TDD/acceptance sequence:**
1. Add the graph-bearing acceptance and run it against the existing code to observe the provenance/save failure.
2. Make fixture/setup changes only as required for the real end-to-end path.
3. Remove the optional GDB-smoke skip by supplying the fixture in CI.
4. Extend CI with server typecheck, WebKit, and visual projects using the existing Playwright configuration.
5. Run the focused browser scenario in Chromium and WebKit.

## Task 8: Run the complete Phase Zero release matrix

Run from a workspace with no competing dev server using the native addon:

1. `pnpm typecheck`
2. `pnpm --filter kiriko-server typecheck`
3. `pnpm exec vitest run`
4. `pnpm --filter kiriko-server exec vitest run`
5. `cargo test --manifest-path core/Cargo.toml --workspace`
6. `pnpm core:build:node`
7. `pnpm core:build:wasm`
8. `pnpm build`
9. `pnpm exec playwright test --project=chromium`
10. `pnpm exec playwright test --project=firefox`
11. `pnpm exec playwright test --project=webkit`
12. `pnpm exec playwright test --project=chromium-visual`
13. Run the mandatory real-GDAL smoke in the same form used by CI.

**Release gate:** Zero failures, zero skipped mandatory acceptance, no unresolved diagnostics, no stale draft/running jobs after process restart, stable two-cycle network round-trip, and no navigation before network publication completes. Update the platform specification/roadmap only if an implemented contract materially differs from the approved documents.