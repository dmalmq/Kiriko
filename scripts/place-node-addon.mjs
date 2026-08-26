import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const HOST_TRIPLES = {
  win32: {
    x64: ["x86_64-pc-windows-msvc", "x86_64-pc-windows-gnu"],
    arm64: ["aarch64-pc-windows-msvc", "aarch64-pc-windows-gnu"],
  },
  linux: {
    x64: ["x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl"],
    arm64: ["aarch64-unknown-linux-gnu", "aarch64-unknown-linux-musl"],
  },
  darwin: {
    x64: ["x86_64-apple-darwin"],
    arm64: ["aarch64-apple-darwin"],
  },
};

const PLATFORM_ARCH_ABI_BY_TRIPLE = {
  "x86_64-pc-windows-msvc": "win32-x64-msvc",
  "x86_64-pc-windows-gnu": "win32-x64-gnu",
  "aarch64-pc-windows-msvc": "win32-arm64-msvc",
  "aarch64-pc-windows-gnu": "win32-arm64-gnu",
  "x86_64-unknown-linux-gnu": "linux-x64-gnu",
  "x86_64-unknown-linux-musl": "linux-x64-musl",
  "aarch64-unknown-linux-gnu": "linux-arm64-gnu",
  "aarch64-unknown-linux-musl": "linux-arm64-musl",
  "x86_64-apple-darwin": "darwin-x64",
  "aarch64-apple-darwin": "darwin-arm64",
};

const CDYLIB_PARTS = {
  win32: { prefix: "", suffix: ".dll" },
  linux: { prefix: "lib", suffix: ".so" },
  darwin: { prefix: "lib", suffix: ".dylib" },
};

const LOCK_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function hostTriples(platform, arch) {
  return HOST_TRIPLES[platform]?.[arch] ?? [];
}

export function addonDestName({ binaryName, platformArchABI }) {
  return `${binaryName}.${platformArchABI}.node`;
}

export function cdylibFileName(libName, platform) {
  const parts = CDYLIB_PARTS[platform];
  if (parts === undefined) {
    throw new Error(`Unsupported native addon platform: ${platform}`);
  }
  return `${parts.prefix}${libName}${parts.suffix}`;
}

function sourceCandidates({ targetDirs, triples, profile, libName, platform }) {
  const fileName = cdylibFileName(libName, platform);
  const implicitTriple = triples[0] ?? null;

  return targetDirs.flatMap((targetDir) => [
    ...triples.map((triple) => ({
      src: path.join(targetDir, triple, profile, fileName),
      triple,
    })),
    {
      src: path.join(targetDir, profile, fileName),
      triple: implicitTriple,
    },
  ]);
}

export function candidateSources(opts) {
  return sourceCandidates(opts).map(({ src }) => src);
}

function errorCode(err) {
  if (
    err === null ||
    typeof err !== "object" ||
    !("code" in err) ||
    typeof err.code !== "string"
  ) {
    return null;
  }
  return err.code;
}

export function isLockError(err) {
  const code = errorCode(err);
  return code !== null && LOCK_ERROR_CODES.has(code);
}

export function recoverAddon({
  crateDir,
  targetDirs,
  binaryName,
  libName,
  platform,
  arch,
  profile,
}) {
  const triples = hostTriples(platform, arch);
  if (triples.length === 0) {
    throw new Error(`Unsupported native addon target: ${platform}-${arch}`);
  }

  const candidates = sourceCandidates({
    targetDirs,
    triples,
    profile,
    libName,
    platform,
  });
  const found = candidates.find(({ src }) => existsSync(src));
  if (found === undefined) {
    return { kind: "src-missing", tried: candidates.map(({ src }) => src) };
  }

  const triple = found.triple ?? triples[0];
  const platformArchABI = PLATFORM_ARCH_ABI_BY_TRIPLE[triple];
  if (platformArchABI === undefined) {
    throw new Error(`Unsupported Rust host triple: ${triple}`);
  }

  const dest = path.join(crateDir, addonDestName({ binaryName, platformArchABI }));
  const parked = `${dest}.inuse`;
  let parkedDest = null;

  try {
    if (existsSync(dest)) {
      if (existsSync(parked)) {
        rmSync(parked, { recursive: true, force: true });
      }
      renameSync(dest, parked);
      parkedDest = parked;
    }
    copyFileSync(found.src, dest);
  } catch (err) {
    const code = errorCode(err);
    if (code !== null && LOCK_ERROR_CODES.has(code)) {
      return { kind: "dest-locked", dest, code };
    }
    throw err;
  }

  return { kind: "placed", src: found.src, dest, parked: parkedDest };
}
