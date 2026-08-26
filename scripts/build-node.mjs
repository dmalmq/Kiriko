import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cdylibFileName,
  hostTriples,
  recoverAddon,
} from "./place-node-addon.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const crateDir = path.join(repoRoot, "core", "crates", "kiriko-node");
const crateTargetDir = path.join(crateDir, "target");
const manifestPath = path.join(crateDir, "Cargo.toml");
const napiArgs = ["exec", "napi", "build", "--platform", "--release"];

function runNapi() {
  const result = spawnSync("pnpm", napiArgs, {
    cwd: crateDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

function cargoTargetDir() {
  const result = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", manifestPath],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    if (typeof result.stderr === "string" && result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    return null;
  }

  try {
    const metadata = JSON.parse(result.stdout);
    if (
      metadata !== null &&
      typeof metadata === "object" &&
      "target_directory" in metadata &&
      typeof metadata.target_directory === "string"
    ) {
      return metadata.target_directory;
    }
  } catch {
    return null;
  }
  return null;
}

function rustcHostTriple(fallback) {
  const result = spawnSync("rustc", ["-vV"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status === 0) {
    const hostLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("host: "));
    const host = hostLine?.slice("host: ".length).trim();
    if (host) {
      return host;
    }
  }
  return fallback;
}

function reportRecoveryFailure(recovery) {
  if (recovery.kind === "src-missing") {
    console.error("[build-node] Cargo artifact not found. Tried:");
    for (const tried of recovery.tried) {
      console.error(`  ${tried}`);
    }
    return 1;
  }
  console.error(
    `[build-node] ${recovery.dest} is loaded (${recovery.code}). ` +
      "Stop leftover Node processes that hold the addon, then retry.",
  );
  return 1;
}

function stageNapiExpectedSource(src, workspaceTargetDir) {
  const fallbackTriple = hostTriples(process.platform, process.arch)[0];
  if (fallbackTriple === undefined) {
    console.error(
      `[build-node] Unsupported native addon target: ${process.platform}-${process.arch}`,
    );
    return 1;
  }
  const expectedSource = path.join(
    workspaceTargetDir,
    rustcHostTriple(fallbackTriple),
    "release",
    cdylibFileName("kiriko_node", process.platform),
  );
  if (path.resolve(src) !== path.resolve(expectedSource)) {
    mkdirSync(path.dirname(expectedSource), { recursive: true });
    copyFileSync(src, expectedSource);
  }
  return 0;
}

function retryNapiAfterRecover(recovery) {
  if (runNapi() === 0) {
    return 0;
  }
  const indexJs = path.join(crateDir, "index.js");
  if (existsSync(recovery.dest) && existsSync(indexJs)) {
    console.warn(
      `[build-node] napi retry failed after placing ${recovery.dest}.`,
    );
    return 0;
  }
  return 1;
}

function main() {
  if (runNapi() === 0) {
    return 0;
  }

  const workspaceTargetDir =
    cargoTargetDir() ?? path.join(repoRoot, "core", "target");
  const targetDirs = [...new Set([workspaceTargetDir, crateTargetDir])];
  const recovery = recoverAddon({
    crateDir,
    targetDirs,
    binaryName: "kiriko-node",
    libName: "kiriko_node",
    platform: process.platform,
    arch: process.arch,
    profile: "release",
  });

  if (recovery.kind !== "placed") {
    return reportRecoveryFailure(recovery);
  }
  if (stageNapiExpectedSource(recovery.src, workspaceTargetDir) !== 0) {
    return 1;
  }
  return retryNapiAfterRecover(recovery);
}

process.exit(main());
