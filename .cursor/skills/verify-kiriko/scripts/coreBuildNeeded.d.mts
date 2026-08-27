/**
 * Types for `coreBuildNeeded.mjs`. The script itself stays plain ESM because
 * the skill runs it with bare `node`; this declaration is what lets
 * `tests/coreBuildNeeded.test.ts` import it under `strict` TypeScript.
 */

/** Absolute paths of every `.node` addon built for `core/crates/kiriko-node`. */
export function listNodeAddons(repoRoot: string): string[];

/** Why `pnpm core:build` must run, or `null` when the artifacts are current. */
export function coreBuildReason(repoRoot: string, options?: { force?: boolean }): string | null;
