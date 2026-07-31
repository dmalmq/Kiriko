# Kiriko Platform Architecture and Application Specification

**Originally approved:** 2026-07-17  
**Current-state reconciliation:** 2026-07-24  
**Status:** Approved living specification; implementation claims reconciled against the repository through 2026-07-24  
**Scope:** Product boundary, implemented application behavior, system architecture, data contracts, and full product direction for Kiriko.

## 1. Product definition

Kiriko is a web platform for preparing, publishing, viewing, reviewing, and navigating indoor GIS datasets. Its current product is a bilingual React/MapLibre application backed by Fastify, SQLite, immutable KVB venue bundles, and a shared Rust core.

The primary users are BIM/GIS producers at JRE Consultants who prepare IMDF and File Geodatabase (GDB) station data. Secondary users are client stakeholders and reviewers who open a shared venue, inspect floors and attributes, and discuss map-pinned issues without desktop GIS software.

The long-term product remains “Forma/ACC for indoor GIS”: one governed venue dataset can support internal review, public embeds, web applications, mobile navigation SDKs, and eventually on-device positioning.

### 1.1 Product outcomes

- A producer can publish a new venue or immutable version from IMDF or GDB source data.
- A reviewer can open a link, understand the indoor map, and leave version-pinned feedback.
- A producer can attach, generate, inspect, edit, export, and republish routing data without mutating an existing version.
- A user can calculate a floor-aware route and route to imported point facilities when the bundle carries the required data.
- Future web and mobile products consume the same versioned venue bundle and Rust-owned domain logic rather than reimplementing venue interpretation.

### 1.2 Product and design constraints

- The map is the product; application chrome remains quiet and secondary.
- Japanese and English are peers in UI copy, search, labels, and layout.
- Published data is immutable and content-addressed.
- Venue interpretation belongs in the Rust core. The TypeScript server moves bytes, applies access rules, and orchestrates jobs.
- Rendering uses MapLibre. Kiriko owns data preparation, collaboration, routing, and future positioning—not a proprietary renderer.
- The initial deployment target is one internal office server. The architecture must remain container-ready and free of cloud-only dependencies.
- Operational complexity must fit one developer plus AI agents: one service process, SQLite, a disk blob store, and an in-process queue until measured load requires more.

## 2. Status model and current capability

This document uses four status labels:

- **Implemented:** present in application code with a test, route, migration, or executable integration path.
- **Next:** required to operate the current web product as a dependable production service.
- **Planned:** accepted product direction whose implementation is not yet present.
- **Exploratory:** dependent on customer validation, hardware data, or research.

| Capability | Status | Current boundary |
|---|---|---|
| Authenticated dataset gallery | Implemented | Session login/logout/current-user, venue listing, create/delete, and bilingual dataset cards |
| IMDF publication | Implemented | Create venue or upload a new immutable version; strict Rust import and deterministic KVB compilation |
| Local/source IMDF viewing | Implemented | Local picker, drag/drop, and explicit `?src=` ZIP loads remain browser-side and are not review resources |
| GDB publication | Implemented | Inspect, suggested mapping, mapping review/edit, WGS84 conversion, IMDF synthesis, and publication |
| GDB reprocessing | Implemented | Upload a new GDB version, edit stored mapping, add or inherit network/facility inputs |
| Indoor viewer | Implemented | Floor grouping, search, layers, warnings, selection/inspection, responsive layout, and bilingual rendering |
| Review issues | Implemented | Version-pinned issues, replies, pins, status, assignment, due dates, permissions, optimistic concurrency, and SSE synchronization |
| Explicit-network routing | Implemented | Import `net_junction`/`net_path`, embed KVB §5, route in WASM, and render floor-aware corridor geometry |
| Generated routing | Implemented | Synthesize a graph from walkable venue geometry; fail publication when no routable graph is produced |
| Point facilities | Implemented | Import `point_facility_network`, embed KVB §7, render floor-aware markers, and route to anchored facilities |
| Network QA and editing | Implemented | Connectivity summary, floor overlay, add/delete edges, save as a new version, export/import network GDB |
| Embed mode | Implemented | Same viewer runtime with reduced chrome and no review-issue activity |
| Production operations baseline | Next | Repeatable deployment, TLS/proxy configuration, backups, restore drill, monitoring, and production runbook |
| Scoped machine API keys and public platform API | Planned | Tenant/venue/capability scopes for embeds and SDK clients |
| Packaged `@kiriko/web` SDK | Planned | Stable public wrapper around KVB/WASM/MapLibre capabilities |
| iOS and Android SDKs | Planned | UniFFI core bindings plus MapLibre Native integration |
| Beacon/Wi-Fi positioning | Exploratory | Requires representative station fingerprint and device data before algorithm or API commitments |

## 3. System overview

```text
┌──────────────────────────────────────────────────────────────────┐
│ kiriko-server                                                    │
│ TypeScript · Fastify · SQLite · content-addressed disk blobs      │
│ sessions · venues/versions · issues · GDB orchestration · jobs    │
│                              │                                   │
│                     @kiriko/node (N-API)                          │
│              strict import · KVB compile · graph export           │
└──────────────┬──────────────────────────────┬────────────────────┘
               │ HTTP/JSON + SSE              │ immutable .kvb
               ▼                              ▼
┌──────────────────────────────┐   ┌───────────────────────────────┐
│ Current web application      │   │ Future distribution          │
│ React · MapLibre GL JS       │   │ @kiriko/web                  │
│ gallery · viewer · review    │   │ iOS / Android SDKs           │
│ GDB workflows · embeds       │   │ customer applications        │
│ @kiriko/wasm decode/route    │   │ all backed by kiriko-core    │
└──────────────────────────────┘   └───────────────────────────────┘
```

The backend and shared client core are separate decisions:

1. The **TypeScript backend** owns HTTP, authentication, persistence, uploads, and job orchestration.
2. The **Rust core** owns deterministic venue interpretation, bundle encoding/decoding, route-graph construction/query, facility projection, and graph export.

Clients communicate with the server through HTTP and consume immutable bundles. Backend language does not constrain customer SDK language; the Rust core is the portability boundary.

## 4. Web application

### 4.1 Gallery

The gallery is the producer workspace. Implemented actions include:

- sign in and sign out;
- filter datasets;
- create and delete venues;
- upload an IMDF dataset or a new IMDF version;
- import a GDB dataset or a new GDB version;
- reopen and edit the latest retained GDB mapping;
- add or replace a routing-network GDB and/or point-facility GDB;
- generate routing from the venue’s own walkable geometry;
- export an embedded routing graph as a GDB ZIP;
- open the viewer directly in network-review mode.

Every publish-like action creates a new version. The UI does not mutate a published bundle in place.

### 4.2 Viewer

The viewer supports:

- dataset-backed KVB loads, local IMDF ZIPs, dropped files, and explicit source URLs;
- latest and sequence-pinned dataset URLs;
- one visible floor control per ordinal while retaining real IMDF level identities underneath;
- floor-aware geometry, bounds, issue pins, facilities, routing, and network overlays;
- localized search across venue features;
- layer visibility, warning inspection, feature selection, and attribute inspection;
- map-pinned review issues for eligible published dataset loads;
- directions between two map points when KVB §5 exists;
- route-to-facility when a KVB §7 facility has a graph anchor;
- connectivity review and edge editing for embedded networks;
- compact/mobile layout, keyboard focus states, reduced-motion behavior, and Japanese/English UI.

Published dataset provenance is explicit. Review APIs start only after the exact bundle response provides a permanent public version identity. Embed, local ZIP, dropped-file, and `?src=` loads never start issue API or SSE work.

### 4.3 Embed mode

`?embed=1` runs the existing viewer with embed chrome and behavior; it is not a second runtime. Embed mode can load a dataset or source URL and preselect a level. Review issues and producer-only network controls remain hidden.

## 5. Shared Rust core

The workspace currently contains:

| Crate | Implemented responsibility | Runtime |
|---|---|---|
| `kiriko-model` | Strict IMDF archive import, canonical venue model, geometry normalization, and validation warnings | native |
| `kiriko-bundle` | Deterministic KVB1 codec, optional network/facility sections, generated network, and graph export | native shared core |
| `kiriko-route` | Explicit route-graph construction, floor mapping, edge-projection snapping, and A* route query | native + WASM through adapters |
| `kiriko-facilities` | Point-facility import and optional routing-anchor resolution | native shared core |
| `kiriko-node` | N-API adapter for asynchronous compilation, source/bundle inspection, and network export | server |
| `kiriko-wasm` | Browser bundle decode, route query, facilities projection, and network export | web |

There are no implemented UniFFI, iOS, Android, or positioning crates in the current workspace. Those are future distribution phases, not current architecture claims.

### 5.1 Source ownership

Published dataset viewers always fetch KVB and decode it through `kiriko-wasm`. Direct local uploads, drops, and `?src=` ZIP URLs continue through the browser IMDF worker and TypeScript normalizer. This is a deliberate provenance boundary:

- published loads have immutable version identity and can participate in review;
- local/source loads have no server-backed version identity and remain issue-free;
- golden and conformance fixtures keep the Rust and TypeScript venue projections aligned.

## 6. Ingestion, compilation, and versioning

### 6.1 IMDF

```text
IMDF ZIP
  → content-addressed source blob
  → draft version + publish job
  → kiriko-node strict import and canonicalization
  → deterministic KVB
  → content-addressed bundle blob
  → transactional version publication
```

An existing venue accepts the same upload path as a new immutable version. A failed compilation leaves the version failed and never replaces the latest published bundle.

### 6.2 File Geodatabase

GDB ingestion is a reviewed conversion pipeline:

```text
.gdb.zip
  → archive validation and GDAL inspection
  → server-suggested building/layer/floor/category mapping
  → bilingual mapping review
  → selected-layer WGS84 GeoJSON conversion
  → strict IMDF synthesis
  → normal IMDF/KVB publish job
```

Internal A/B/C category codes are mapped to IMDF categories during conversion. Structurally unsuitable layers can be excluded automatically with an explicit response. Raw GDB source identity and the normalized mapping plan are retained on the version so a producer can reopen and refine the mapping later.

### 6.3 Routing and facilities inputs

A GDB publish can include:

- an optional routing archive containing `net_junction` and `net_path`; and
- an optional facilities archive containing `point_facility_network`.

The server extracts and stores normalized GeoJSON blobs, then the Rust compiler embeds non-empty results in KVB §5 and §7. Reprocessing resolves each omitted optional input from the latest published version so a mapping-only republish does not silently drop routing or facilities.

Alternatively, the producer can generate a route graph from the latest venue geometry. The generator uses recognized walkable/circulation categories, including station platforms. A generated version is marked `synthesized`; a generation that produces no graph fails with `no_routable_network` instead of publishing a misleading success.

### 6.4 Immutability and provenance

- `versions.public_id` is a permanent random 256-bit lowercase hexadecimal identity.
- A public ID is never reused, including after venue deletion and slug recreation.
- Source and bundle blobs are independently content-addressed by SHA-256.
- Publishing updates a version only when its source identity still matches, preventing stale jobs from publishing over replacements.
- Latest bundle URLs revalidate; sequence-pinned URLs are immutable.
- `ETag` is the bundle hash. `Kiriko-Version-Id` is the review identity. They are intentionally different.
- Raw retained source archives are not exposed through public read routes.

## 7. KVB1 venue bundle

KVB1 is the product’s immutable distribution atom. The fixed 52-byte envelope is:

```text
0..4   magic = 4b 56 42 00 ("KVB\0")
4..6   major = little-endian u16 = 1
6..8   minor = little-endian u16 = 0
8..12  flags = little-endian u32; bit 0 means zstd
12..20 uncompressed payload length = little-endian u64
20..52 SHA-256 of the uncompressed payload
52..   exactly one deterministic zstd frame
```

The payload begins with a section count and fixed 20-byte directory rows `(id, version, offset, length)` sorted by ascending ID.

| ID | Section | Requirement | Current content |
|---:|---|---|---|
| 1 | manifest | required | metadata, IMDF manifest, levels, bounds, warnings, stats |
| 2 | geometry | required | canonical non-occupant venue features |
| 3 | stores | required | canonical occupant features |
| 4 | style | reserved | not emitted |
| 5 | graph | optional | route nodes, weighted floor-aware edges, and corridor bend points |
| 6 | beacons | reserved | not emitted |
| 7 | facilities | optional | named point facilities, icons, floor ordinals, and optional graph anchors |

The decoder rejects unsupported envelope versions, malformed directories, invalid section versions, out-of-bounds or overlapping sections, corrupt hashes, non-finite coordinates, and declared payloads above the configured safety cap. Required sections remain backward-compatible with older KVB1 bundles that lack optional sections.

## 8. Server and persistence

Kiriko server is one Fastify process on Node.js 24–26, one SQLite database, one content-addressed blob directory, and one in-process job queue.

### 8.1 Persistence

```text
users          username · password hash · role
sessions       token hash · user · expiry
tenants        name · slug
venues         tenant · slug · name · creator · creation time
versions       venue · sequence · permanent public id
               source/bundle hashes · status · source kind · stats/error
               retained GDB source + mapping
               network/facility blob hashes · synthesized flag
jobs           kind · status · payload/result/error
blobs          hash · size · creation time
comment_state          version revision · next pin number
comments               versioned root issues and one-level replies
issue_attachments      staged/attached/detached per-upload rows
issue_attachment_blobs content-addressed normalized image metadata
```

The on-disk layout is:

```text
data/kiriko.db
data/blobs/sha256/<first-two-hex>/<sha256>
data/issue-attachments/sha256/<first-two-hex>/<sha256>
```

SQLite migrations are additive. The current schema includes the initial platform tables, version-pinned review issues and their first-party image attachments, retained GDB reprocessing inputs, and the synthesized-network marker. Attachment storage, lifecycle, security, backup, and rollback are owned by `docs/issue-attachments-operations.md`.

### 8.2 Implemented HTTP surface

```text
GET  /healthz
GET  /api/openapi.json

POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me

GET/POST /api/venues
DELETE   /api/venues/:id
POST     /api/venues/:id/versions
GET      /api/jobs/:id

GET /v/:tenant/:venue/bundle
GET /v/:tenant/:venue/bundle@:seq

POST /api/gdb/inspect
POST /api/gdb/inspect-network
POST /api/gdb/inspect-facilities
POST /api/gdb/publish
POST /api/gdb/augment
POST /api/gdb/generate-network
POST /api/gdb/export-network
POST /api/gdb/import-network
GET  /api/venues/:id/gdb-mapping

GET/POST    /api/review/versions/:publicVersionId/issues
GET         /api/review/versions/:publicVersionId/issues/events
GET         /api/reviewers
POST        /api/issues/:issueId/replies
PATCH/DELETE /api/issues/:issueId
PATCH/DELETE /api/replies/:replyId
POST         /api/review/versions/:publicVersionId/issue-attachments
DELETE       /api/issue-attachments/:attachmentId
GET          /api/issue-attachments/:attachmentId/content
GET          /api/issue-attachments/:attachmentId/thumbnail
```

Fastify route schemas generate `/api/openapi.json`. GDB inspection and all mutations, including attachment upload/cancel, require a human session. Published bundle reads, issue collection reads, and media attached to a live comment on the currently published version are public. Machine API keys are not yet implemented.

### 8.3 Review synchronization

Root comments are map-anchored issues; child comments are replies. Markdown remains canonical in `comments.body_markdown`; attachment IDs are bound transactionally from first-party image tokens. `comment_state.revision` is a version-scoped monotonic collection revision and each comment has an optimistic-concurrency row version.

Mutations support idempotent request IDs and expected-version checks. The SSE stream carries revision notifications only; clients coalesce notifications and refetch canonical state. Connection limits are configurable globally and per public version.

## 9. Routing, facilities, and network review

### 9.1 Explicit route graph

`kiriko-route` maps GDB floor labels to venue ordinals, validates junction/path references, preserves path bend points, and builds deterministic weighted edges. Browser routing projects each endpoint onto the nearest appropriate edge, handles same-edge routes directly, runs A* through virtual endpoints for longer routes, and returns maximal same-floor route segments.

The viewer renders real corridor geometry, per-floor route segments, and click-to-network connectors. It does not draw straight chords through walls when source path geometry contains bends.

### 9.2 Generated route graph

When no explicit network is available, `kiriko-bundle` can derive a graph from walkable IMDF geometry. The preferred build uses a medial-axis network when the `netgen` feature is present. Generated and imported graphs share KVB §5 and the same query/export path.

### 9.3 Facilities

`kiriko-facilities` imports named point facilities with floor, icon, and optional route-node linkage. Facilities remain visible even when an anchor cannot be resolved; route-to-facility is available only for anchored items.

### 9.4 Review and editing

The network overlay reports connectivity, islands, and linked floors. In edit mode a producer can select junctions to add an edge or select an edge to delete it. Saving serializes the edited graph and publishes it as a new immutable venue version. Export packages the current graph as a re-importable GDB ZIP.

## 10. Authentication and authorization

Implemented human authentication uses server-side sessions stored by token hash. Roles are `admin`, `member`, and `viewer`.

- Anonymous users can read published bundles and existing issue collections.
- Authenticated users can create issues/replies and stage image attachments subject to role, ownership, and attachment-budget rules.
- Members/admins can manage issue status, due dates, and broader assignments.
- Producer gallery, upload, GDB, network, and reviewer-directory operations require a session.
- Secure-cookie behavior is configurable and must be enabled behind production TLS.

OIDC/SSO, tenant administration UI, API keys, and customer-facing capability scopes are planned rather than implemented.

### 10.1 Approved partner-sharing policy (2026-07-31)

The following access control policies are approved target behavior for Phase 1 implementation:

**Venue publication and access:**
- Published venues are **private by default**; publication to the system does not authorize public read access.
- External partners use **expiring, revocable capability tokens** scoped to tenant/venue/version and explicit permissions.
- Optional partner accounts may follow later; initial Phase 1 partner access is token-based.
- Anonymous embeds are a **separate explicit per-venue opt-in**, never implied by venue publication.

**Partner permissions:**
- Partner access is **view-only by default** for map and issue viewing.
- KVB bundle download requires a **separate explicit `download_bundle` grant**, scoped to the partner capability and venue/version.
- Raw GDB/IMDF sources remain unavailable on all partner-accessible paths.

**Issue attachments:**
- Attachments inherit the same venue/version ACL as the issue and published map.
- Revocation or token expiry removes media access along with the map read permission.

**Current-state gap:**
- Current shipped routes `GET /v/:tenant/:venue/bundle`, `GET /api/review/versions/:publicVersionId/issues`, and issue media (`GET /api/issue-attachments/*/content`) are effectively world-readable if the URL is known.
- This is a documented gap until Workstream 1C (Venue lifecycle and sharing) design and implementation are complete.
- Existing public-read behavior is not removed during Phase 1 implementation; it remains alongside the new private-by-default ACL model until a separate authorization task gates the transition.

## 11. Quality and verification

- **Rust:** strict IMDF import, canonicalization, KVB integrity/determinism, graph/facility encoding, graph generation, route queries, graph export, N-API, and WASM adapters.
- **Server:** real SQLite migration/repository tests, blob identity, job isolation, GDB validation/conversion/reprocessing, network/facility publication, issue permissions/idempotency/concurrency, and SSE capacity.
- **Web:** Vitest for load provenance, bundle hydration, search, floor grouping, map layers, facilities, routes, network editing/connectivity, gallery flows, issue state, Markdown safety, accessibility, and responsive UI.
- **End to end:** Playwright covers gallery publication, local/source/embed viewing, issue collaboration and identity isolation, cross-browser viewer behavior, visual baselines, and measured viewer performance.

Current performance acceptance in the executable browser suite includes:

- fresh local upload to map-ready-and-idle P95 at or below 3 seconds;
- warm floor change P95 at or below 150 ms;
- a one-second drag sustaining at least 30 frames with no long task above 100 ms.

These thresholds are regression budgets for the tested fixtures and workstation class, not universal customer SLAs.

## 12. Operations posture

### 12.1 Implemented

- one process and in-process queue;
- environment-based data directory, port, secure-cookie, bootstrap-user, development-user, SSE-capacity, and issue-attachment budget/janitor configuration;
- content-addressed disk storage, including a separately garbage-collected issue-attachment tree;
- startup migrations and legacy bundle recompilation;
- stdout-compatible Fastify logging;
- health and OpenAPI endpoints.

### 12.2 Required before dependable production operation

- repeatable service/container deployment and reverse-proxy TLS configuration;
- secure production bootstrap and credential rotation procedure;
- scheduled SQLite and blob backup with a tested restore drill;
- log retention, disk/queue/failed-job monitoring, and alert ownership;
- source/blob retention and deletion policy;
- documented upgrade, rollback, and KVB compatibility procedure;
- production smoke test using a representative station dataset.

External queues, S3, and Postgres remain scale-up options, not near-term requirements. They should be introduced only after measured office-server limits justify the extra operational surface.

## 13. Product roadmap boundary

The platform roadmap is maintained in `docs/superpowers/plans/2026-07-24-kiriko-platform-roadmap.md`. Its sequence is:

1. **Shipped web baseline:** current gallery, publication, viewer, issues, GDB, routing, facilities, and network workflows.
2. **Production-ready shared web platform:** operations, security hardening, version/share administration, and release acceptance.
3. **Public platform API and web SDK:** scoped machine credentials, stable contracts, packaged `@kiriko/web`, and supported embed tiers.
4. **Mobile map and routing SDKs:** shared Rust core through UniFFI plus thin MapLibre Native wrappers.
5. **Positioning research and productization:** fingerprint data collection, algorithm evaluation, privacy/battery constraints, then an explicit go/no-go.

Each future phase requires its own approved design and executable implementation plan. The roadmap records product order and release gates; it does not make unimplemented interfaces part of the current contract.

## 14. Risks and standing decisions

- **GDB variability:** customer schemas differ. Keep suggestions reviewable, preserve raw source/mapping, fail explicitly, and avoid silent semantic guesses.
- **Bundle evolution:** KVB major/version checks and retained source blobs permit controlled recompilation. Any serialization or compression change requires a format decision and golden update.
- **Rust portability:** keep domain crates free of N-API, WASM, and future UniFFI concerns; bindings stay in adapter crates.
- **Generated-route quality:** generation provides a useful fallback, not guaranteed survey-grade navigation. Connectivity review and export/edit workflows remain part of acceptance.
- **Mobile scope:** MapLibre Native churn stays behind thin platform wrappers. Shared domain behavior remains in Rust.
- **Positioning uncertainty:** do not schedule or advertise accuracy before representative station fingerprints and device trials exist.
- **Operational simplicity:** do not pre-build Redis, Postgres, Kubernetes, or multi-region storage. Preserve replaceable seams and scale from evidence.

## 15. Documentation hierarchy

- `PRODUCT.md` — audience, purpose, positioning, and design principles.
- `DESIGN.md` — visual and interaction system.
- This document — authoritative current platform/application specification.
- `docs/superpowers/plans/2026-07-24-kiriko-platform-roadmap.md` — forward sequence and release gates.
- Dated feature specs and implementation plans — decision and execution history for individual slices.

When a dated feature document conflicts with this reconciled specification about current implementation status, this document wins. Feature documents remain authoritative for the detailed decision that introduced their behavior unless superseded explicitly.
