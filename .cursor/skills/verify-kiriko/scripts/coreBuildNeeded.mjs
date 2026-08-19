/**
 * Decide whether isolated verification must run `pnpm core:build`.
 * Presence of artifacts is not enough: ignored .node / wasm pkg files can
 * outlive a later edit under core/.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["target", "pkg", "node_modules", ".git"]);
const SOURCE_EXT = new Set([".rs", ".toml"]);

function listFiles(dir, acc) {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      listFiles(abs, acc);
      continue;
    }
    if (SOURCE_EXT.has(path.extname(ent.name)) || ent.name === "Cargo.lock") {
      acc.push(abs);
    }
  }
}

function mtimeMs(file) {
  return statSync(file).mtimeMs;
}

export function listNodeAddons(repoRoot) {
  const dir = path.join(repoRoot, "core/crates/kiriko-node");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".node"))
    .map((name) => path.join(dir, name));
}

/**
 * @param {string} repoRoot
 * @param {{ force?: boolean }} [options]
 * @returns {string | null} why to rebuild, or null when artifacts are current
 */
export function coreBuildReason(repoRoot, options = {}) {
  if (options.force) return "KIRIKO_VERIFY_REBUILD=1";

  const wasmPkg = path.join(repoRoot, "core/crates/kiriko-wasm/pkg/package.json");
  const addons = listNodeAddons(repoRoot);
  if (!existsSync(wasmPkg) || addons.length === 0) {
    return "Native/wasm artifacts missing";
  }

  const oldestArtifact = Math.min(mtimeMs(wasmPkg), ...addons.map(mtimeMs));
  const sources = [];
  listFiles(path.join(repoRoot, "core"), sources);
  const wasmScript = path.join(repoRoot, "scripts/build-wasm.mjs");
  if (existsSync(wasmScript)) sources.push(wasmScript);
  if (sources.length === 0) return null;

  const newestSource = Math.max(...sources.map(mtimeMs));
  if (newestSource > oldestArtifact) {
    return "core/ sources newer than native/wasm artifacts";
  }
  return null;
}
