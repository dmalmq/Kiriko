import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const dataDir = resolve(".e2e-data");
rmSync(dataDir, { recursive: true, force: true });

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => !key.startsWith("=") && typeof value === "string",
  ),
);
const command = process.platform === "win32" ? "cmd.exe" : "pnpm";
const args =
  process.platform === "win32"
    ? ["/d", "/s", "/c", "pnpm --filter kiriko-server start"]
    : ["--filter", "kiriko-server", "start"];
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: {
    ...env,
    KIRIKO_DATA_DIR: dataDir,
    KIRIKO_PORT: "8790",
    KIRIKO_BOOTSTRAP_USER: "e2e",
    KIRIKO_BOOTSTRAP_PASSWORD: "e2e-password",
  },
  stdio: "inherit",
});

const stop = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
