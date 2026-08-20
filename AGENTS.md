# Kiriko — agent brief

Indoor GIS viewer + review workspace. Product/visual: `PRODUCT.md`, `DESIGN.md`. Architecture: `docs/superpowers/specs/2026-07-17-kiriko-platform-architecture-design.md`.

## Commands

`./dev.sh` starts backend then Vite and can seed accounts / serve on the LAN (`KIRIKO_SHARE=0` / `KIRIKO_SEED=0` to skip). Vite proxies `/api` and `/v` to `:8790`. `KIRIKO_SEED_PASSWORD` has no default — without it nothing is seeded (`server/seed-users.example.json`). Do not use the developer stack (`:5173` / `:8790`) as a UI proof target; see `.cursor/skills/verify-kiriko/`.

`pnpm test` runs `pretest` → full `core:build`. For a TS-only check: `pnpm exec vitest run` (web) or `pnpm --dir server exec vitest run`. Rust: `cargo test --manifest-path core/Cargo.toml --workspace` (also `pnpm test:core`). Typecheck: `pnpm exec tsc --noEmit` and `pnpm --dir server exec tsc --noEmit`. Editing Rust while servers run needs `pnpm core:build` (or a restart). Wasm (`core:build:wasm`) needs **clang** — MSVC cannot target wasm32 (`winget install LLVM.LLVM`; `scripts/build-wasm.mjs` or `CC_wasm32_unknown_unknown`).

## Invariants

- TDD. Strict TS (no `any`).
- Bilingual UI (ja/en) — every user string needs both.
- **Absence never renders as success.** Put absence in the type (`Option` / `| null`) at the layer that knows; render it in words; test the empty state. Zero is a measured value. See `docs/gdb-data-reference.md` producer-surface notes.
- GDAL stays in TypeScript (gdal3.js); all data interpretation is Rust. KVB sections: `1 manifest / 2 geometry / 3 stores / 5 graph / 7 facilities` (5 and 7 optional). Reproject 3857→4326 on every GDB read. New Rust `WarningCode`s must be added to `server/src/core/native.ts` **and** `src/imdf/types.ts` or publish fails with `bridge_error`.

Read `docs/gdb-data-reference.md` before GDB import, `kiriko-route`, `kiriko-facilities`, or KVB sections. Read `docs/issue-attachments-operations.md` before rich comments or first-party media.

## Pointers

Issues live on GitHub `dmalmq/Kiriko` via `gh`. `origin` is the tracker; `no-mistakes` is local tooling. Agent-facing docs: `docs/agents/`.

## Maintaining this file

Canonical agent brief. `CLAUDE.md` is `@AGENTS.md` — edit this file only.
Keep what agents cannot infer from the repo: commands they get wrong, product invariants, pointers to other repos/docs. No directory tour. Prefer rewrite over append.
