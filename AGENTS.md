# Kiriko — project context

Kiriko is a React/MapLibre indoor-GIS viewer + review workspace backed by Fastify + SQLite, with a Rust core (`kiriko-*` crates) that compiles IMDF/GDB into immutable `.kvb` bundles. See `PRODUCT.md` and `DESIGN.md` for product/visual intent, and `docs/superpowers/specs/2026-07-17-kiriko-platform-architecture-design.md` for architecture and phasing.

## Layout
- `src/` — web app (viewer, gallery, review, bundle worker).
- `server/` — Fastify server (`server/src/gdb/` = GDB import via gdal3.js; `server/src/core/native.ts` = Rust addon bridge).
- `core/crates/` — Rust: `kiriko-model` (IMDF import), `kiriko-bundle` (KVB codec), `kiriko-node` (napi addon), `kiriko-wasm` (browser), `kiriko-route` (routing graph + A\*), `kiriko-facilities` (POIs).
- `docs/superpowers/` — specs and implementation plans.

## Running locally (dev)
Two processes; backend first (Vite proxies `/api` → `:8790`):
```bash
pnpm dev:server   # predev:server rebuilds @kiriko/node; tsx watch
pnpm dev          # predev rebuilds @kiriko/wasm; Vite on :5173
```
First run seeds an admin only from env on an empty DB:
`KIRIKO_BOOTSTRAP_USER=admin KIRIKO_BOOTSTRAP_PASSWORD=… pnpm dev:server`.
For local role testing, `KIRIKO_SEED_DEV_USERS=1 pnpm dev:server` also seeds `admin`/`member`/`viewer` (all password `password`), (re)setting those three accounts' passwords/roles each run. Opt-in, and hard-skipped under `NODE_ENV=production`.
Editing Rust while servers run needs a restart (or `pnpm core:build`). Verify: `cargo test --manifest-path core/Cargo.toml --workspace`, `pnpm exec tsc --noEmit`, `pnpm --dir server exec tsc --noEmit`, `pnpm exec vitest run`, `pnpm --dir server exec vitest run`.

**Windows toolchain:** the wasm build (`core:build:wasm`) compiles a C dependency (`zstd-sys`) for `wasm32`, which requires **clang** (MSVC can't target wasm). Install LLVM (`winget install LLVM.LLVM`). `scripts/build-wasm.mjs` auto-points cc-rs at a standard LLVM install when clang isn't on PATH; otherwise set `CC_wasm32_unknown_unknown` to a wasm-capable clang.

## GDB / network / routing data
The JR East Tokyo dataset is three EPSG:3857 File Geodatabases (venue, routing network, point facilities). **Full schema, layer inventory, floor-label mapping, icon situation, and the GDB→GeoJSON→KVB→routing pipeline are documented in `docs/gdb-data-reference.md` — read it before touching GDB import, `kiriko-route`, `kiriko-facilities`, or KVB sections.**

## Issue comment attachments
Before changing rich comments or first-party media, read the canonical storage, lifecycle, security, and operations contract in `docs/issue-attachments-operations.md`.

Key facts: GDAL stays in TypeScript (gdal3.js); all data interpretation is Rust. KVB sections: `1 manifest / 2 geometry / 3 stores / 5 graph / 7 facilities` (5 and 7 optional, backward-compatible). Reproject 3857→4326 on every GDB read. New Rust `WarningCode`s must be added to the TS bridge allowlist (`server/src/core/native.ts`) AND the client type (`src/imdf/types.ts`) or publish fails with `bridge_error`.

## Conventions
- TDD; commit per logical change; strict TS (no `any`); match existing patterns.
- Bilingual UI (ja/en) — every user string needs both.

## Agent skills

### Issue tracker
GitHub issues in `dmalmq/imdf-map-application` via `gh`. `origin` is the tracker remote; `no-mistakes` is a local tooling artifact. See `docs/agents/issue-tracker.md`.

### Triage labels
The five canonical roles, each label string equal to its name. A separate axis from the existing `wayfinder:*` ticket-type labels. See `docs/agents/triage-labels.md`.

### Domain docs
Single-context: `CONTEXT.md` + `docs/adr/` at the repo root, both created lazily by `/domain-modeling`. Until then, architectural decisions of record live in the platform roadmap's §8 decision register. See `docs/agents/domain.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
