// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addonDestName,
  candidateSources,
  cdylibFileName,
  hostTriples,
  isLockError,
  recoverAddon,
} from "../scripts/place-node-addon.mjs";

const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "kiriko-place-addon-"));
  fixtures.push(root);
  return root;
}

describe("hostTriples", () => {
  it("searches both Windows MSVC and GNU triples", () => {
    expect(hostTriples("win32", "x64")).toEqual([
      "x86_64-pc-windows-msvc",
      "x86_64-pc-windows-gnu",
    ]);
  });

  it("maps Linux x64 to gnu then musl", () => {
    expect(hostTriples("linux", "x64")).toEqual([
      "x86_64-unknown-linux-gnu",
      "x86_64-unknown-linux-musl",
    ]);
  });
});

describe("addonDestName", () => {
  it("matches napi --platform Windows dest names", () => {
    expect(
      addonDestName({ binaryName: "kiriko-node", platformArchABI: "win32-x64-msvc" }),
    ).toBe("kiriko-node.win32-x64-msvc.node");
  });

  it("matches napi --platform Linux dest names", () => {
    expect(
      addonDestName({ binaryName: "kiriko-node", platformArchABI: "linux-x64-gnu" }),
    ).toBe("kiriko-node.linux-x64-gnu.node");
  });
});

describe("candidateSources", () => {
  it("lists the triple subdirectory before the implicit host profile dir", () => {
    const candidates = candidateSources({
      targetDirs: ["/core/target"],
      triples: ["x86_64-pc-windows-msvc"],
      profile: "release",
      libName: "kiriko_node",
      platform: "win32",
    });
    expect(candidates).toEqual([
      path.join("/core/target", "x86_64-pc-windows-msvc", "release", "kiriko_node.dll"),
      path.join("/core/target", "release", "kiriko_node.dll"),
    ]);
  });

  it("uses the Unix lib prefix off Windows", () => {
    expect(cdylibFileName("kiriko_node", "linux")).toBe("libkiriko_node.so");
  });
});

describe("recoverAddon", () => {
  it("copies a Windows dll from the cargo triple dir onto the napi dest name", () => {
    const root = tmp();
    const crateDir = path.join(root, "crate");
    const targetDir = path.join(root, "target");
    const src = path.join(
      targetDir,
      "x86_64-pc-windows-msvc",
      "release",
      "kiriko_node.dll",
    );
    mkdirSync(path.dirname(src), { recursive: true });
    mkdirSync(crateDir, { recursive: true });
    writeFileSync(src, "fresh-dll");

    const result = recoverAddon({
      crateDir,
      targetDirs: [targetDir],
      binaryName: "kiriko-node",
      libName: "kiriko_node",
      platform: "win32",
      arch: "x64",
      profile: "release",
    });

    expect(result).toEqual({
      kind: "placed",
      src,
      dest: path.join(crateDir, "kiriko-node.win32-x64-msvc.node"),
      parked: null,
    });
    expect(readFileSync(result.kind === "placed" ? result.dest : "", "utf8")).toBe(
      "fresh-dll",
    );
  });

  it("parks a previous dest as .inuse before replacing it", () => {
    const root = tmp();
    const crateDir = path.join(root, "crate");
    const targetDir = path.join(root, "target");
    const src = path.join(targetDir, "release", "libkiriko_node.so");
    const dest = path.join(crateDir, "kiriko-node.linux-x64-gnu.node");
    mkdirSync(path.dirname(src), { recursive: true });
    mkdirSync(crateDir, { recursive: true });
    writeFileSync(src, "new-so");
    writeFileSync(dest, "old-node");

    const result = recoverAddon({
      crateDir,
      targetDirs: [targetDir],
      binaryName: "kiriko-node",
      libName: "kiriko_node",
      platform: "linux",
      arch: "x64",
      profile: "release",
    });

    expect(result.kind).toBe("placed");
    if (result.kind !== "placed") return;
    expect(result.parked).toBe(`${dest}.inuse`);
    expect(readFileSync(dest, "utf8")).toBe("new-so");
    expect(readFileSync(`${dest}.inuse`, "utf8")).toBe("old-node");
  });

  it("replaces a leftover .inuse on a second recover", () => {
    const root = tmp();
    const crateDir = path.join(root, "crate");
    const targetDir = path.join(root, "target");
    const src = path.join(targetDir, "release", "libkiriko_node.so");
    const dest = path.join(crateDir, "kiriko-node.linux-x64-gnu.node");
    mkdirSync(path.dirname(src), { recursive: true });
    mkdirSync(crateDir, { recursive: true });
    writeFileSync(src, "first");
    writeFileSync(dest, "stale");

    recoverAddon({
      crateDir,
      targetDirs: [targetDir],
      binaryName: "kiriko-node",
      libName: "kiriko_node",
      platform: "linux",
      arch: "x64",
      profile: "release",
    });
    writeFileSync(src, "second");
    writeFileSync(dest, "in-the-way");

    const result = recoverAddon({
      crateDir,
      targetDirs: [targetDir],
      binaryName: "kiriko-node",
      libName: "kiriko_node",
      platform: "linux",
      arch: "x64",
      profile: "release",
    });

    expect(result.kind).toBe("placed");
    expect(readFileSync(dest, "utf8")).toBe("second");
    expect(readFileSync(`${dest}.inuse`, "utf8")).toBe("in-the-way");
  });

  it("returns src-missing with every path it tried", () => {
    const root = tmp();
    const crateDir = path.join(root, "crate");
    const targetDir = path.join(root, "target");
    mkdirSync(crateDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });

    const result = recoverAddon({
      crateDir,
      targetDirs: [targetDir],
      binaryName: "kiriko-node",
      libName: "kiriko_node",
      platform: "win32",
      arch: "x64",
      profile: "release",
    });

    expect(result.kind).toBe("src-missing");
    if (result.kind !== "src-missing") return;
    expect(result.tried).toEqual(
      candidateSources({
        targetDirs: [targetDir],
        triples: hostTriples("win32", "x64"),
        profile: "release",
        libName: "kiriko_node",
        platform: "win32",
      }),
    );
  });
});

describe("isLockError", () => {
  it("treats Windows replace failures as lock errors", () => {
    expect(isLockError({ code: "EPERM" })).toBe(true);
    expect(isLockError({ code: "EBUSY" })).toBe(true);
    expect(isLockError({ code: "EACCES" })).toBe(true);
    expect(isLockError({ code: "ENOENT" })).toBe(false);
  });
});
