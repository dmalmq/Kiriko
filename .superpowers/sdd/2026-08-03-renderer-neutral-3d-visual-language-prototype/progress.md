# SDD ledger — plan: docs/superpowers/plans/2026-08-03-renderer-neutral-3d-visual-language-prototype.md

Baseline: branch prototype/renderer-neutral-3d-visual-language at 45051a6; `pnpm exec tsc --noEmit` passed; `pnpm exec vitest run` passed 44 files / 894 tests after `pnpm core:build:wasm`.
Task 1 clarification: brief phrase “imports only types from visualLanguage.ts” conflicts with required runtime `COPY`; ruling: import `COPY` plus types from that module and no other dependencies.
Task 1: complete (commits 45051a6..8d8a7a7, review clean)
Task 2: fix round 1/5 (1 addressed, 0 open — source inspection cleared on both handoff entries; commits 8bfbb94..dea1051)
Task 2: complete (commits 8d8a7a7..dea1051, review clean)
Task 3 clarification: exact scene props omit fallback state despite veil wording; ruling: Task 4 owns the `fallbackPhase` veil overlay, while Task 3 exposes the stable scene canvas wrapper/class.
Task 3: fix round 1/5 (2 addressed, 0 open — pointer-transparent conveyance layer and accepted-point muted pattern; commits bca5369..18ce7a4)
Task 3: complete (commits dea1051..18ce7a4, review clean)
Task 4: fix round 1/5 (typecheck restored missing local diagnostics label; commits 25fb7b7..8f11458)
Task 4: fix round 2/5 (2 addressed, 0 open — primitive-ID synchronization and complete B1 HTML equivalents; commits 8f11458..9fc9dac)
Task 4: complete (commits 18ce7a4..9fc9dac, review clean)
Task 5 clarification: generated brief is authoritative; Task 5 creates `visualLanguagePrototype.css` and may update both prototype TSX files for the exact root/import/class hooks. The initial CSS-only dispatch constraint was withdrawn before implementation.
Task 5: review Approved (0 Critical/Important; 5 Minor). Parent applied two Minor cleanups in 4cfd3b5 (dead connector `strokeDasharray`, unused `--vl-indigo-deep`); remaining Minors are intentional dead-hook/state-class notes.
Task 5: complete (commits 9fc9dac..4cfd3b5; `pnpm exec tsc --noEmit` and `pnpm exec vite build` pass)
Task 6: browser proof found and fixed real defects — null selection highlighting 42 faces, label collision, advisory finding unreachable (findings are severity-filtered, not floor-gated, per spec §12), inspector/caption overlap, guidance-card occlusion (now an in-flow next-action bar), review amber below WCAG AA (spec palette updated to #B45309), overview leg opacity 0.45 per spec §11, scene 280px floor scoped to mobile, floating panels separated.
Task 6: four evidence images captured; collision audit clean across 6 scenarios x 1440x900 / 1180x720 / 390x844; `pnpm exec tsc --noEmit` and `pnpm exec vite build` pass (commit 710c60d).
Whole-branch review: Ready to resolve; 0 Critical, 1 Important (fallback left Compare active beside an "unavailable" notice), Minors incl. accepted hatch suppressed by CSS `fill: none`. Both fixed in 2dd0d1e.
Verification: `pnpm exec tsc --noEmit`, `pnpm exec vite build`, `pnpm exec vitest run` (44 files / 894 tests) all pass; branch pushed at 2dd0d1e.
