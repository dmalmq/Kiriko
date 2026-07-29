import os from "node:os";

const cpuModels = [...new Set(os.cpus().map((cpu) => cpu.model))];
const identity = {
  runnerOs: process.env.RUNNER_OS ?? "unknown",
  runnerArch: process.env.RUNNER_ARCH ?? "unknown",
  imageOs: process.env.ImageOS ?? "unknown",
  imageVersion: process.env.ImageVersion ?? "unknown",
  nodeVersion: process.version,
  nodeArch: process.arch,
  logicalCpuCount: os.cpus().length,
  cpuModels,
};

// Deliberately whitelist only public runner/runtime identity. Do not dump env.
console.log(`runner diagnostics=${JSON.stringify(identity)}`);
