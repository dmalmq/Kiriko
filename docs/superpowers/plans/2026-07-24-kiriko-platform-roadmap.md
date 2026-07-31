# Kiriko Platform Roadmap

> **For agentic workers:** This is the strategic application plan, not an executable feature checklist. Before implementing a future workstream, use the brainstorming workflow to approve its design and the writing-plans workflow to create a task-by-task implementation plan. Do not implement a later phase before its entry gate is satisfied.

**Goal:** Evolve the implemented Kiriko web application into a dependable indoor-GIS platform that supports internal production, public web distribution, mobile routing SDKs, and evidence-gated positioning.

**Architecture:** Preserve the current split: Fastify/SQLite/disk storage for service orchestration, a React/MapLibre web application for gallery/viewer/review workflows, and Rust as the portable source of truth for venue data, bundles, routing, facilities, and future positioning. Scale through stable HTTP and KVB contracts rather than by replacing proven components prematurely.

**Tech Stack:** React 19, MapLibre GL JS 5, TypeScript 7, Vite 8, Fastify 5, SQLite via better-sqlite3, Rust, N-API, WebAssembly, KVB1, Playwright, and Vitest. Future mobile phases add UniFFI and MapLibre Native only after their platform specifications are approved.

**Roadmap status:** Approved 2026-07-24  
**Current-state contract:** `docs/superpowers/specs/2026-07-17-kiriko-platform-architecture-design.md`

## Global constraints

- Published venue versions and KVB bundles remain immutable and content-addressed.
- Rust remains the single source of truth for portable venue interpretation and routing behavior.
- The TypeScript server owns HTTP, sessions, persistence, uploads, and job orchestration; it does not duplicate Rust domain logic.
- The same KVB contract serves the Kiriko viewer, embeds, future web SDK, and future mobile SDKs.
- Japanese and English remain first-class; WCAG AA, visible focus, keyboard operation, and reduced-motion behavior are release requirements.
- One office-server deployment is the operational baseline. No Redis, Postgres, S3, Kubernetes, or cloud-only dependency without measured need.
- Every stored or public identity must be tenant-safe, non-reusable, and explicit about version provenance.
- Future SDK/API contracts must be versioned before external adoption; breaking changes require a migration path and compatibility test.
- Positioning remains exploratory until representative fingerprint/device data supports a written go/no-go decision.
- Detailed implementation plans are one workstream each. This roadmap never authorizes broad multi-phase implementation in one change.

---

## 1. Planning model

### 1.1 Status vocabulary

| Status | Meaning |
|---|---|
| **Complete** | Implemented in the repository and represented in the current architecture specification |
| **Next** | Highest-priority phase; design work may begin after its listed entry gate |
| **Planned** | Accepted direction, sequenced behind earlier release gates |
| **Exploratory** | Evidence-gathering program; not a delivery commitment |

### 1.2 Phase order

```text
Shipped web baseline
        ↓
Production-ready shared web platform
        ↓
Public platform API + @kiriko/web
        ↓
Mobile map + routing SDKs
        ↓
Positioning research → go/no-go → optional productization
```

A phase can conduct discovery for the next phase, but production implementation does not overlap across an unsatisfied release gate. This keeps external contracts from being built on an unstable operational or domain foundation.

### 1.3 Release definition

A phase is complete only when:

1. its user outcome works end to end;
2. permissions, failures, and version/provenance behavior are explicit;
3. its changed contract has executable coverage;
4. a representative smoke scenario succeeds;
5. operational and migration instructions exist where the phase changes deployment or persisted data; and
6. the platform specification and this roadmap are reconciled with the shipped result.

---

## 2. Phase 0 — Shipped web baseline

**Status:** Complete  
**Outcome:** Producers can publish and reprocess indoor GIS data; reviewers can inspect and discuss exact published versions; users can navigate explicit or generated indoor networks in the web viewer.

### 2.1 Delivered product

- Session-authenticated, bilingual dataset gallery.
- Venue creation/deletion and immutable version publication.
- IMDF create/version uploads and strict deterministic KVB compilation.
- Local, dropped, source-URL, latest-dataset, pinned-version, and embed viewing.
- GDB validation, inspection, suggested/reviewed mapping, conversion, category-code mapping, and publication.
- Retained GDB source/mapping for editing and reprocessing.
- Optional routing-network and point-facility imports with input inheritance across versions.
- Generated routing from walkable venue geometry with explicit empty-graph failure.
- KVB1 required sections 1–3 and optional graph/facilities sections 5 and 7.
- Floor-aware routing, route-to-facility, network connectivity review, edge editing, and network import/export.
- Version-pinned issues, replies, assignment, due dates, status, permissions, optimistic concurrency, and SSE revision synchronization.
- Viewer search, layers, warnings, feature inspection, responsive layout, visual baselines, and performance regression budgets.

### 2.2 Known boundary

This phase is a strong application baseline, not yet a complete production service or public developer platform:

- deployment and recovery are not packaged as a repeatable production runbook;
- current tenant behavior is effectively single-tenant;
- production account provisioning/rotation and SSO are not productized;
- public machine credentials and capability scopes do not exist;
- there is no supported `@kiriko/web`, iOS, or Android package;
- positioning has no implementation or validated data program.

### 2.3 Historical implementation documents

The dated plans under `docs/superpowers/plans/` remain execution history for the server MVP, review issues, GDB import/reprocessing, routing, facilities, network behavior, and viewer/gallery refinements. They are not the current application roadmap.

---

## 3. Phase 1 — Production-ready shared web platform

**Status:** Next  
**Primary users:** JRE Consultants producers, internal reviewers, and invited client reviewers  
**Outcome:** The current web application can be deployed, operated, recovered, and shared as a dependable service without developer intervention for routine use.

### Entry gate

- Phase 0 architecture is reconciled and accepted.
- A representative production-like station IMDF/GDB dataset is available for smoke and recovery drills.
- The intended office-server host, reverse proxy, storage volume, and backup destination are identified.

### Workstream 1A — Deployment and data safety

**Required design:** service topology, process ownership, paths/volumes, TLS termination, backup consistency, restore process, upgrade/rollback, and secrets handling.

**Target outcomes:**

- one documented command or service definition installs/updates the server and web assets;
- production starts with secure cookies and no development-user seeding;
- SQLite plus blob storage are backed up as one recoverable dataset;
- a clean host can restore and serve an existing published venue;
- failed jobs, low disk, unavailable backup, and service health have an observable owner-facing signal;
- KVB/core upgrades have a rollback and legacy-recompile decision path.

**Release gate:** destroy a disposable production-like instance, restore from backup, sign in, open a published venue, load issues, and calculate a route from restored data.

### Workstream 1B — Production identity and authorization

**Required design:** account lifecycle, password policy/rotation or OIDC choice, role administration, tenant boundary, session security, CSRF/origin posture, and audit needs.

**Target outcomes:**

- production accounts can be created, disabled, and assigned roles without editing SQLite;
- tenant identity is derived from the authenticated principal or explicit public resource—not a hard-coded tenant constant;
- producer-only gallery/GDB/network operations cannot cross tenant boundaries;
- public bundle and issue-read behavior is an explicit venue/version policy;
- authentication failures, expired sessions, and permission failures remain usable in both Japanese and English;
- any OIDC integration preserves the existing server-session boundary rather than spreading provider tokens through the app.

**Release gate:** role/tenant acceptance matrix passes against two isolated tenants, including negative tests for every mutation family.

### Workstream 1C — Venue lifecycle and sharing

**Required design:** version history, latest-version selection/rollback semantics, share-link policy, deletion/retention, and embed configuration.

**Approved sharing policy (2026-07-31):**

The following partner-access and sharing policies are captain-approved and ready for design/implementation:

1. **Published venues are private by default** — publication does not authorize public read access.
2. **External partners use expiring, revocable capability tokens** scoped to tenant/venue/version and explicit permissions. Optional partner accounts may follow later.
3. **Anonymous embeds are a separate explicit per-venue opt-in**, never implied by venue publication.
4. **Partner access is view-only by default** for map and issue viewing; KVB bundle download requires a separate explicit `download_bundle` grant scoped to capability and venue/version.
5. **Raw GDB/IMDF sources remain unavailable** on all partner-accessible paths.
6. **Issue attachments inherit the same venue/version ACL** as the issue and map; revocation/expiry removes media access too.

Current public-read routes remain a documented gap (`docs/superpowers/specs/2026-07-17-kiriko-platform-architecture-design.md` §10.1) until the private-by-default ACL implementation is complete.

**Target outcomes:**

- producers can see immutable version history and each version’s source kind, status, time, and available graph/facility capabilities;
- selecting a prior published version as latest never rewrites its bundle;
- users can copy an explicit latest or pinned share link and understand the difference;
- deletion behavior states what happens to source blobs, bundles, issues, and existing public links;
- embed configuration has a stable documented parameter contract;
- failed/draft versions are visible to producers but never become public accidentally;
- partner invitation and capability-token lifetime and revocation are explicit and enforced.

**Release gate:** publish two versions, share latest and pinned links, switch the latest pointer, verify pinned identity/content stays unchanged, then exercise the approved deletion/retention behavior. Validate that a revoked or expired partner capability returns 401/403 for all scoped reads.

### Workstream 1D — Release acceptance and supportability

**Required design:** supported browsers/devices, representative datasets, accessibility matrix, performance budget environment, and support diagnostics.

**Target outcomes:**

- one automated production-like smoke covers sign-in, IMDF or GDB publish, viewer, issue, routing, and embed paths;
- representative large-station GDB import and generated-network behavior have recorded acceptance fixtures or a controlled external-fixture procedure;
- accessibility checks cover gallery, dialogs, viewer controls, issues, directions, and compact layout;
- current performance budgets are run in a documented environment and failures are actionable;
- operators can correlate a failed UI job with sanitized server diagnostics without exposing source data or credentials.

**Release gate:** production release checklist passes on the target office server and supported browser matrix.

### Phase 1 non-goals

- paid plans or billing;
- public third-party API guarantees;
- mobile SDKs;
- positioning accuracy claims;
- infrastructure replacement without measured office-server limits.

---

## 4. Phase 2 — Public platform API and `@kiriko/web`

**Status:** Planned  
**Primary users:** customer web developers and Kiriko embed integrators  
**Outcome:** Customers can integrate Kiriko maps, search, facilities, and routing through supported, versioned web contracts without depending on the internal application implementation.

### Entry gate

- Phase 1 production release gate passes.
- Tenant and venue visibility rules are enforced server-side.
- At least one real customer integration use case identifies the required capability tier and offline/cache expectations.

### Workstream 2A — Public resource and credential model

**Required design:** public API versioning, API-key lifecycle, tenant/venue scopes, capability scopes, origin restrictions where useful, rate limits, revocation, and audit events.

**Target outcomes:**

- machine credentials are stored by hash and shown only at creation;
- credentials can be scoped to tenant, venue, and capability;
- revocation takes effect without republishing a bundle;
- public API errors and pagination/versioning conventions are stable and documented;
- OpenAPI distinguishes internal producer routes from supported customer routes;
- bundle caching remains compatible with immutable pinned versions and latest-route revalidation.

**Release gate:** a revoked or under-scoped key cannot read or invoke a higher-tier capability; a correctly scoped key completes the customer sample flow.

### Workstream 2B — Supported embed tiers

**Required design:** anonymous/public versus credentialed embeds, configuration transport, allowed customization, localization, event/callback surface, and version pinning.

**Target outcomes:**

- the iframe embed has a documented URL/configuration contract;
- customers can choose latest or pinned venue behavior intentionally;
- supported options do not expose producer or review controls;
- embed loading/error states are accessible and localizable;
- integration guidance includes cache, CSP, referrer/origin, and privacy behavior.

**Release gate:** a static customer page embeds a venue using only public documentation and passes the supported browser matrix.

### Workstream 2C — `@kiriko/web`

**Required design:** package boundary, initialization, credential injection, KVB fetching/cache, MapLibre ownership, events, styling hooks, search/facility/routing APIs, ESM/bundler support, and semantic versioning.

**Target outcomes:**

- the package wraps `kiriko-wasm` and stable server contracts instead of importing internal app modules;
- a minimal API covers map display, level selection, search, facilities, and route queries;
- customers may use a Kiriko-managed map helper or feed decoded/query results into their own MapLibre application without duplicating Rust logic;
- package size, WASM loading, worker behavior, and browser support are measured and documented;
- example applications prove the supported integration shapes.

**Release gate:** a clean sample project installs the published package, authenticates, loads a pinned venue, searches a facility, and renders a route with no repository-internal imports.

### Workstream 2D — Commercial capability boundaries

The initial capability model should remain simple and map directly to enforceable server/API behavior:

1. map display;
2. facility/store data and search;
3. routing;
4. positioning, only if Phase 4 later passes its go/no-go gate.

Billing and entitlement-provider integration require a separate commercial specification. Phase 2 needs enforceable capabilities, not a speculative billing platform.

### Phase 2 non-goals

- native mobile wrappers;
- offline positioning;
- customer-authored arbitrary server code or style plugins;
- replacing MapLibre;
- billing before a commercial model is selected.

---

## 5. Phase 3 — Mobile map and routing SDKs

**Status:** Planned  
**Primary users:** JRE/customer iOS and Android application teams  
**Outcome:** Native applications can download/cache the same venue version, render it with MapLibre Native, search facilities, and calculate routes on-device without network connectivity.

### Entry gate

- KVB and route behavior are stable through Phase 2 external use.
- Supported iOS/Android versions, package registries, binary-size limits, and customer application constraints are approved.
- At least one iOS and one Android pilot application are named.

### Workstream 3A — Portable core and UniFFI boundary

**Required design:** crate feature boundaries, UniFFI-safe DTOs, async/cancellation behavior, error taxonomy, memory limits, thread safety, and KVB compatibility.

**Target outcomes:**

- a binding crate exposes bundle inspection/decode, levels, search-ready facility data, and route query;
- N-API, WASM, and UniFFI adapters share domain crates but no platform adapter imports another adapter;
- golden KVB and route vectors produce equivalent results on Rust, web, iOS, and Android;
- corrupt/unsupported bundles fail with stable domain errors rather than platform crashes.

**Release gate:** cross-platform conformance suite passes for the same committed bundles and route inputs.

### Workstream 3B — `KirikoKit` for iOS

**Required design:** Swift API, SPM distribution, async download/cache, MapLibre Native helpers, lifecycle/background behavior, and diagnostics.

**Target outcomes:**

- sample app downloads and pins a venue version;
- cached venue display and routing work in airplane mode;
- level, facility, and route overlays use thin MapLibre helpers;
- SDK errors preserve actionable domain codes without exposing internals.

**Release gate:** pilot app completes map/search/routing offline on the minimum supported iPhone/iOS version.

### Workstream 3C — `com.kiriko:sdk` for Android

**Required design:** Kotlin API, Maven/AAR distribution, coroutines, cache/lifecycle behavior, MapLibre Native helpers, ABI packaging, and diagnostics.

**Target outcomes:**

- behavior and naming match the iOS capability model where platform conventions allow;
- sample app downloads, pins, caches, displays, searches, and routes;
- supported ABIs and binary size are explicit;
- process recreation and offline use preserve the selected venue version safely.

**Release gate:** pilot app completes map/search/routing offline on the minimum supported Android/API and device architecture.

### Workstream 3D — Mobile release operations

**Target outcomes:**

- semantic version and compatibility policy across server, KVB, Rust core, iOS, and Android;
- automated package build/sign/publish path;
- upgrade guide and deprecation policy;
- crash/privacy diagnostics that do not upload venue source data by default;
- customer integration checklist and support ownership.

### Phase 3 non-goals

- positioning before Phase 4 evidence;
- replacing customer application navigation or UI architecture;
- a custom native renderer;
- online-only routing.

---

## 6. Phase 4 — Positioning research and optional productization

**Status:** Exploratory  
**Primary users:** navigation users in large or underground stations  
**Outcome:** Determine with measured station/device data whether beacon/Wi-Fi fusion can meet a defined navigation-quality, privacy, battery, and operational threshold. Product implementation begins only after a written go decision.

### Entry gate

- representative beacon/Wi-Fi fingerprint data can be collected legally and operationally;
- evaluation venues, device classes, consent/privacy rules, and ground-truth method are approved;
- the navigation use case defines acceptable horizontal/floor accuracy, update latency, outage behavior, and battery cost.

### Stage 4A — Data and evaluation protocol

**Deliverables:**

- versioned fingerprint and ground-truth data format;
- collection/calibration procedure and station-change maintenance model;
- train/evaluation split that prevents route or location leakage;
- metrics for horizontal error distribution, floor accuracy, time-to-fix, continuity, and battery use;
- privacy and retention assessment for scan/fingerprint data.

**Gate:** data quality and coverage are sufficient to compare algorithms reproducibly.

### Stage 4B — Algorithm prototypes

Compare the simplest viable methods first: nearest/fingerprint baselines, weighted probabilistic estimates, and only then fusion filters when temporal evidence justifies them. Prototype code must remain isolated from the shipping SDK contract.

**Gate:** a written evaluation shows whether any approach meets the approved thresholds across venues and device classes. Report failures and variance; do not promote average accuracy alone.

### Stage 4C — Go/no-go decision

- **No-go:** retain map/routing SDKs without positioning and document the failed thresholds or unavailable operational inputs.
- **Go:** approve a dedicated positioning product specification covering the `kiriko-position` crate, calibration tooling, mobile sensor APIs, privacy, battery, fallback behavior, telemetry, and customer operations.

### Stage 4D — Productization after a go decision

Only an approved go decision adds positioning to KVB §6, public capability scopes, mobile SDK APIs, or commercial tiers. Backward compatibility requires that map/search/routing clients continue to work when §6 is absent.

---

## 7. Cross-phase architecture work

These are constraints to satisfy inside the relevant phase, not separate speculative projects.

### 7.1 KVB evolution

- Keep required sections 1–3 readable across additive optional-section work.
- Use reserved section IDs only through an explicit format decision.
- Require deterministic golden updates and cross-adapter decoding tests for serialization/compression changes.
- Preserve the ability to recompile retained sources when a future major version is justified.

### 7.2 Tenant and identity safety

- Remove single-tenant assumptions before public machine access.
- Keep permanent public version IDs distinct from slugs, sequences, database IDs, and bundle hashes.
- Apply tenant checks at repository/service boundaries, not only in UI routing.
- Never reuse public review identities after deletion or recreation.

### 7.3 Observability and privacy

- Log identifiers, durations, counts, status codes, and sanitized domain errors—not raw source archives, issue bodies, credentials, or fingerprint scans.
- Define retention and deletion for logs, source blobs, bundles, issues, and future positioning data.
- Add telemetry only when it answers an owned operational or product question.

### 7.4 Accessibility and localization

Every public component and SDK sample must preserve Japanese/English parity, keyboard/focus behavior where applicable, reduced motion, and readable errors. Native SDKs expose data and semantics; customer UI remains customer-owned.

### 7.5 Performance

Optimize from measured customer/fixture behavior. Maintain current viewer budgets while adding larger representative station datasets. Before indexing, caching, queue, database, or storage changes, record the failing workload and acceptance target.

---

## 8. Decision register

| Decision | Current answer | Revisit trigger |
|---|---|---|
| Backend | TypeScript/Fastify | Only if measured service constraints cannot be resolved cleanly |
| Domain core | Rust | Standing decision |
| Web renderer | MapLibre GL JS | Renderer no longer meets required indoor-map capability/support |
| Native renderer | MapLibre Native | Evaluate during Phase 3 platform specs |
| Database | SQLite | Measured concurrency/operational limit after Phase 1 |
| Queue | In process | Work must survive process restart or scale beyond one worker |
| Blob storage | Local content-addressed disk | Multi-host deployment or storage durability requires object storage |
| Web embed | Same application runtime | SDK requirements prove a smaller separate runtime materially necessary |
| Routing | On-device over KVB §5 | Standing offline-navigation requirement |
| Positioning | Exploratory | Representative data and approved evaluation protocol exist |
| Billing | Unspecified | Commercial model and first paid integration are defined |
| Partner sharing (approved 2026-07-31) | Private venues; expiring revocable capability tokens; separate anonymous-embed opt-in; view-only by default; no raw sources; attachments inherit ACL | Partner token format, optional account tier, or consent/audit requirements change |

---

## 9. Required next planning artifacts

Phase 1 must be decomposed before implementation. Create and approve these independent artifacts in order:

1. **Production deployment and recovery spec/plan** — Workstream 1A.
2. **Production identity and tenant authorization spec/plan** — Workstream 1B.
3. **Venue version history, sharing, and retention spec/plan** — Workstream 1C.
4. **Production release acceptance spec/plan** — Workstream 1D, consuming the prior three contracts.

A workstream plan must name exact files, migrations, interfaces, tests, smoke commands, expected results, and rollback behavior. It must not absorb the next workstream “while here.”

Phase 2 planning begins only after Phase 1’s release gate. Phase 3 planning begins only after a Phase 2 customer integration proves the public contracts. Phase 4 research can prepare data-governance questions earlier, but it cannot add shipping APIs before its go/no-go gate.

## 10. Roadmap maintenance

Update this roadmap when a phase enters implementation, passes a release gate, is rejected, or changes dependency order. Do not mark a workstream complete because code was scaffolded or a narrow test passed; link the end-to-end evidence and reconcile the platform specification.

Dated feature specs and task plans remain historical records. If they disagree with this roadmap about priority or status, this roadmap controls future sequencing and the current platform specification controls implemented behavior.
