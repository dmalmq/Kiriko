/**
 * Recover a napi-rs native addon after `napi build` fails at copyArtifact.
 * Cargo already wrote the cdylib; Windows often cannot unlink a loaded
 * `.node`, and napi-rs 3.7.3 looks only under target/<triple>/ and swallows
 * the copy error cause.
 */
export function hostTriples(_platform, _arch) {
  throw new Error("not implemented");
}

export function addonDestName(_opts) {
  throw new Error("not implemented");
}

export function cdylibFileName(_libName, _platform) {
  throw new Error("not implemented");
}

export function candidateSources(_opts) {
  throw new Error("not implemented");
}

export function isLockError(_err) {
  throw new Error("not implemented");
}

export function recoverAddon(_opts) {
  throw new Error("not implemented");
}
