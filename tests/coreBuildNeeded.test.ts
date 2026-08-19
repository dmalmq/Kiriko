// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { coreBuildReason } from "../.cursor/skills/verify-kiriko/scripts/coreBuildNeeded.mjs";

const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "kiriko-core-build-"));
  fixtures.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

function touch(root: string, rel: string, epochSec: number): void {
  utimesSync(path.join(root, rel), epochSec, epochSec);
}

const ARTIFACTS = {
  "core/crates/kiriko-node/kiriko-node.node": "addon",
  "core/crates/kiriko-wasm/pkg/package.json": "{}",
};

describe("coreBuildReason", () => {
  it("rebuilds when the wasm package is missing", () => {
    const root = repo({
      "core/Cargo.toml": "[workspace]\n",
      "core/crates/kiriko-node/kiriko-node.node": "addon",
    });
    expect(coreBuildReason(root)).toBe("Native/wasm artifacts missing");
  });

  it("rebuilds when the node addon is missing", () => {
    const root = repo({
      "core/Cargo.toml": "[workspace]\n",
      "core/crates/kiriko-wasm/pkg/package.json": "{}",
    });
    expect(coreBuildReason(root)).toBe("Native/wasm artifacts missing");
  });

  it("leaves current artifacts alone", () => {
    const root = repo({
      "core/Cargo.toml": "[workspace]\n",
      "core/crates/kiriko-model/src/lib.rs": "pub fn f() {}",
      ...ARTIFACTS,
    });
    touch(root, "core/Cargo.toml", 1_000);
    touch(root, "core/crates/kiriko-model/src/lib.rs", 1_100);
    touch(root, "core/crates/kiriko-node/kiriko-node.node", 2_000);
    touch(root, "core/crates/kiriko-wasm/pkg/package.json", 2_000);
    expect(coreBuildReason(root)).toBeNull();
  });

  it("rebuilds when a crate source is newer than the artifacts", () => {
    const root = repo({
      "core/Cargo.toml": "[workspace]\n",
      "core/crates/kiriko-model/src/lib.rs": "pub fn f() {}",
      ...ARTIFACTS,
    });
    touch(root, "core/Cargo.toml", 1_000);
    touch(root, "core/crates/kiriko-node/kiriko-node.node", 1_500);
    touch(root, "core/crates/kiriko-wasm/pkg/package.json", 1_500);
    touch(root, "core/crates/kiriko-model/src/lib.rs", 2_000);
    expect(coreBuildReason(root)).toBe("core/ sources newer than native/wasm artifacts");
  });

  it("ignores files under target/ and pkg/ when comparing sources", () => {
    const root = repo({
      "core/Cargo.toml": "[workspace]\n",
      "core/crates/kiriko-model/src/lib.rs": "pub fn f() {}",
      "core/target/debug/deps/foo.rs": "stale rustc junk",
      "core/crates/kiriko-wasm/pkg/extra.rs": "generated",
      ...ARTIFACTS,
    });
    touch(root, "core/Cargo.toml", 1_000);
    touch(root, "core/crates/kiriko-model/src/lib.rs", 1_100);
    touch(root, "core/crates/kiriko-node/kiriko-node.node", 2_000);
    touch(root, "core/crates/kiriko-wasm/pkg/package.json", 2_000);
    touch(root, "core/target/debug/deps/foo.rs", 3_000);
    touch(root, "core/crates/kiriko-wasm/pkg/extra.rs", 3_000);
    expect(coreBuildReason(root)).toBeNull();
  });

  it("rebuilds when KIRIKO_VERIFY_REBUILD forces a core build", () => {
    const root = repo({
      "core/Cargo.toml": "[workspace]\n",
      ...ARTIFACTS,
    });
    touch(root, "core/Cargo.toml", 1_000);
    touch(root, "core/crates/kiriko-node/kiriko-node.node", 2_000);
    touch(root, "core/crates/kiriko-wasm/pkg/package.json", 2_000);
    expect(coreBuildReason(root, { force: true })).toBe("KIRIKO_VERIFY_REBUILD=1");
  });
});
