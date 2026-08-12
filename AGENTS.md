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

**Testing accounts.** `KIRIKO_SEED_DEV_USERS=1 KIRIKO_SEED_PASSWORD=… pnpm dev:server` seeds the accounts listed in `$KIRIKO_DATA_DIR/seed-users.json` (dev default: `server/data/seed-users.json`, gitignored — shape in `server/seed-users.example.json`), giving each the shared password and (re)setting password and role on every start. With no such file it falls back to `admin`/`member`/`viewer`. Accounts it does not list are untouched. `KIRIKO_SEED_PASSWORD` has no default — without it nothing is seeded, so named accounts can never end up with a guessable password. Opt-in, and hard-skipped under `NODE_ENV=production`. There is no user-management API yet (Workstream 1B); this file is how accounts exist.

**Sharing with colleagues on the LAN (testing only).** `pnpm dev:server` then `pnpm share` (= `vite --host`) and hand out `http://<this-machine-ip>:5173`. One port is enough: Vite serves the app and proxies both `/api` and `/v` to the backend on loopback, so the server itself stays unexposed. Windows Firewall needs an inbound rule, from an elevated shell: `New-NetFirewallRule -DisplayName "Kiriko dev" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow`. `pnpm dev` remains loopback-only, so exposing the machine is always deliberate. This is plaintext HTTP with a shared password and non-`Secure` session cookies — anyone on the network can read a session. Fine for colleague testing, not for anything real.

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
- **Absence never renders as success.** No measurement, no samples, nothing mapped, nothing found — none of these may be shown as a zero, an empty band, or a clean row. Zero is a measured value and reads as a good one. Put the absence in the type (`Option`/`| null`) at the layer that knows, so consumers must answer for it rather than each view remembering; render it as absent in words; and give every measurement view a test for its empty state. This is a real bug found twice in the tile registration report — see `docs/gdb-data-reference.md`'s producer-surface notes.

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
