#!/usr/bin/env node
/**
 * Isolated Kiriko verification controller.
 *
 *   node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs launch
 *   node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs doctor
 *   node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs fixture-zip [path]
 *   node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs drive sign-in-gallery
 *   node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs stop
 *
 * Does not touch ./dev.sh, :5173, or :8790. Kill only PIDs recorded here.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_PORT = Number(process.env.KIRIKO_VERIFY_FRONTEND_PORT ?? 14173);
const BACKEND_PORT = Number(process.env.KIRIKO_VERIFY_BACKEND_PORT ?? 18790);
const USER = process.env.KIRIKO_BOOTSTRAP_USER ?? "e2e";
const PASSWORD = process.env.KIRIKO_BOOTSTRAP_PASSWORD ?? "e2e-password";
const ORIGIN = `http://127.0.0.1:${FRONTEND_PORT}`;
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`;
const HEALTHZ = `${BACKEND_ORIGIN}/healthz`;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..");
const VERIFY_ROOT = path.join(REPO_ROOT, ".kiriko-verify");
const RUN_DIR = path.join(VERIFY_ROOT, "run");
const DATA_DIR = path.join(RUN_DIR, "data");
const EVIDENCE_DIR = path.join(VERIFY_ROOT, "evidence");
const INSTANCE_PATH = path.join(RUN_DIR, "instance.json");
const VITE_CONFIG_PATH = path.join(RUN_DIR, "vite.config.mjs");
const BACKEND_LOG = path.join(RUN_DIR, "backend.log");
const FRONTEND_LOG = path.join(RUN_DIR, "frontend.log");

const NODE_ADDON_DIR = path.join(REPO_ROOT, "core/crates/kiriko-node");
const WASM_PKG = path.join(REPO_ROOT, "core/crates/kiriko-wasm/pkg/package.json");

const command = process.argv[2] ?? "help";

function fail(message, extra) {
  console.error(message);
  if (extra) console.error(extra);
  process.exit(1);
}

function pnpmBin() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function readInstance() {
  if (!existsSync(INSTANCE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(INSTANCE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeInstance(instance) {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(INSTANCE_PATH, `${JSON.stringify(instance, null, 2)}\n`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function fetchTimed(url, init = {}, ms = 8_000) {
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  return fetch(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(ms),
  });
}

async function fetchJson(url, init, ms = 8_000) {
  const response = await fetchTimed(url, init, ms);
  const text = await response.text();
  let body = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body, headers: response.headers };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listNodeAddons() {
  if (!existsSync(NODE_ADDON_DIR)) return [];
  return readdirSync(NODE_ADDON_DIR).filter((name) => name.endsWith(".node"));
}

function needsCoreBuild() {
  return !existsSync(WASM_PKG) || listNodeAddons().length === 0;
}

function runPnpm(args, options = {}) {
  const result = spawnSync(pnpmBin(), args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    fail(`pnpm ${args.join(" ")} exited ${result.status ?? "null"}`);
  }
}

function writeViteConfig() {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(
    VITE_CONFIG_PATH,
    `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: ${JSON.stringify(REPO_ROOT.replaceAll("\\", "/"))},
  plugins: [react()],
  worker: { format: "es" },
  optimizeDeps: {
    entries: ["index.html"],
    exclude: ["@kiriko/wasm"],
  },
  server: {
    host: "127.0.0.1",
    port: ${FRONTEND_PORT},
    strictPort: true,
    hmr: false,
    watch: {
      ignored: ["**/.kiriko-verify/**", "**/.e2e-data/**", "**/server/data/**"],
    },
    proxy: {
      "/api": "http://127.0.0.1:${BACKEND_PORT}",
      "/v": "http://127.0.0.1:${BACKEND_PORT}",
    },
  },
  preview: {
    host: "127.0.0.1",
    port: ${FRONTEND_PORT},
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:${BACKEND_PORT}",
      "/v": "http://127.0.0.1:${BACKEND_PORT}",
    },
  },
});
`,
  );
}

function quoteArg(value) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function spawnLogged(args, logPath, env) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `${pnpmBin()} ${args.map(quoteArg).join(" ")}`], {
          cwd: REPO_ROOT,
          env: { ...process.env, ...env },
          stdio: ["ignore", fd, fd],
          windowsHide: true,
        })
      : spawn(pnpmBin(), args, {
          cwd: REPO_ROOT,
          env: { ...process.env, ...env },
          stdio: ["ignore", fd, fd],
        });
  child.on("exit", () => {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  });
  return child;
}

function killTree(pid) {
  if (!pidAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

function stopRecorded(instance) {
  if (!instance) return;
  killTree(instance.frontendPid);
  killTree(instance.backendPid);
  if (Number.isInteger(instance.launchPid) && instance.launchPid !== process.pid) {
    killTree(instance.launchPid);
  }
}

async function waitFor(label, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result === true) return;
      last = result === false ? "" : String(result);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  fail(`${label} did not become ready within ${timeoutMs}ms${last ? `: ${last}` : ""}`);
}

async function doctorReport() {
  const instance = readInstance();
  const report = {
    driveable: false,
    origin: ORIGIN,
    healthz: HEALTHZ,
    dataDir: DATA_DIR,
    user: USER,
    instance: instance,
    checks: {},
  };

  if (!instance) {
    report.checks.instanceFile = "missing";
    return report;
  }

  report.checks.instanceFile = "ok";
  report.checks.frontendPidAlive = pidAlive(instance.frontendPid);
  report.checks.backendPidAlive = pidAlive(instance.backendPid);
  report.checks.portsMatch =
    instance.frontendPort === FRONTEND_PORT && instance.backendPort === BACKEND_PORT;
  report.checks.dataDirOurs =
    path.resolve(instance.dataDir) === path.resolve(DATA_DIR);

  try {
    const health = await fetchJson(HEALTHZ);
    report.checks.healthz = health.status === 200 && health.body?.ok === true;
  } catch (error) {
    report.checks.healthz = false;
    report.checks.healthzError = error instanceof Error ? error.message : String(error);
  }

  try {
    const page = await fetchTimed(ORIGIN, { redirect: "manual" }, 20_000);
    const html = await page.text();
    report.checks.frontendHtml =
      page.status === 200 && html.includes('id="root"') && html.includes("IMDF Map Viewer");
  } catch (error) {
    report.checks.frontendHtml = false;
    report.checks.frontendError = error instanceof Error ? error.message : String(error);
  }

  try {
    const me = await fetchJson(`${BACKEND_ORIGIN}/api/auth/me`);
    report.checks.meUnauthorized = me.status === 401;
  } catch (error) {
    report.checks.meUnauthorized = false;
    report.checks.meError = error instanceof Error ? error.message : String(error);
  }

  try {
    const login = await fetchJson(`${BACKEND_ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USER, password: PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    report.checks.loginUser = login.body?.user?.username === USER;
    report.checks.loginCookie = cookie.includes("kiriko_session=");
    if (login.ok && cookie.includes("kiriko_session=")) {
      const me = await fetchJson(`${BACKEND_ORIGIN}/api/auth/me`, {
        headers: { cookie: cookie.split(";", 1)[0] },
      });
      report.checks.sessionMe = me.body?.user?.username === USER;
    }
  } catch (error) {
    report.checks.loginUser = false;
    report.checks.loginError = error instanceof Error ? error.message : String(error);
  }

  const required = [
    "instanceFile",
    "frontendPidAlive",
    "backendPidAlive",
    "portsMatch",
    "dataDirOurs",
    "healthz",
    "frontendHtml",
    "meUnauthorized",
    "loginUser",
    "loginCookie",
    "sessionMe",
  ];
  report.driveable = required.every((key) => report.checks[key] === true || report.checks[key] === "ok");
  return report;
}

async function cmdDoctor() {
  const report = await doctorReport();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.driveable ? 0 : 2);
}

async function cmdLaunch() {
  const existing = await doctorReport();
  if (existing.driveable) {
    console.log(`Already driveable at ${ORIGIN}`);
    console.log(JSON.stringify(existing, null, 2));
    return;
  }

  const leftover = readInstance();
  if (leftover) {
    console.log("Stopping a stale verify instance before relaunch.");
    stopRecorded(leftover);
    await sleep(500);
  }

  if (!(await portFree(BACKEND_PORT))) {
    fail(
      `127.0.0.1:${BACKEND_PORT} is already in use and is not a driveable verify instance. ` +
        `Refuse to hijack it. Stop that process, or set KIRIKO_VERIFY_BACKEND_PORT.`,
    );
  }
  if (!(await portFree(FRONTEND_PORT))) {
    fail(
      `127.0.0.1:${FRONTEND_PORT} is already in use and is not a driveable verify instance. ` +
        `Refuse to hijack it. Stop that process, or set KIRIKO_VERIFY_FRONTEND_PORT.`,
    );
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeViteConfig();
  writeFileSync(BACKEND_LOG, "");
  writeFileSync(FRONTEND_LOG, "");

  if (needsCoreBuild()) {
    console.log("Native/wasm artifacts missing; running pnpm core:build (can take several minutes).");
    runPnpm(["core:build"]);
  }

  const distHtml = path.join(REPO_ROOT, "dist/index.html");
  const rebuild = process.env.KIRIKO_VERIFY_REBUILD === "1" || !existsSync(distHtml);
  if (rebuild) {
    console.log(
      existsSync(distHtml)
        ? "KIRIKO_VERIFY_REBUILD=1; running vite build."
        : "dist/ missing; running vite build for the preview server.",
    );
    runPnpm(["exec", "vite", "build", "--config", VITE_CONFIG_PATH]);
  }

  const backend = spawnLogged(
    ["--filter", "kiriko-server", "start"],
    BACKEND_LOG,
    {
      KIRIKO_DATA_DIR: DATA_DIR,
      KIRIKO_PORT: String(BACKEND_PORT),
      KIRIKO_BOOTSTRAP_USER: USER,
      KIRIKO_BOOTSTRAP_PASSWORD: PASSWORD,
    },
  );
  const frontend = spawnLogged(
    [
      "exec",
      "vite",
      "preview",
      "--config",
      VITE_CONFIG_PATH,
      "--host",
      "127.0.0.1",
      "--port",
      String(FRONTEND_PORT),
    ],
    FRONTEND_LOG,
    {},
  );

  writeInstance({
    origin: ORIGIN,
    healthz: HEALTHZ,
    frontendPort: FRONTEND_PORT,
    backendPort: BACKEND_PORT,
    dataDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    backendPid: backend.pid,
    frontendPid: frontend.pid,
    launchPid: process.pid,
    startedAt: new Date().toISOString(),
  });

  const abortLaunch = (reason) => {
    stopRecorded(readInstance());
    fail(reason);
  };

  backend.on("exit", (code, signal) => {
    if (!readInstance()) return;
    abortLaunch(`backend exited early (code ${code}, signal ${signal}). See ${BACKEND_LOG}`);
  });
  frontend.on("exit", (code, signal) => {
    if (!readInstance()) return;
    abortLaunch(`frontend exited early (code ${code}, signal ${signal}). See ${FRONTEND_LOG}`);
  });

  await waitFor("backend /healthz", 180_000, async () => {
    const health = await fetchJson(HEALTHZ);
    return health.status === 200 && health.body?.ok === true;
  });
  await waitFor("frontend HTML", 180_000, async () => {
    const page = await fetchTimed(ORIGIN);
    const html = await page.text();
    return page.ok && html.includes('id="root"');
  });

  const report = await doctorReport();
  if (!report.driveable) {
    abortLaunch(`doctor failed after launch:\n${JSON.stringify(report, null, 2)}`);
  }
  backend.removeAllListeners("exit");
  frontend.removeAllListeners("exit");
  console.log(`Driveable at ${ORIGIN} (backend ${HEALTHZ})`);
  console.log(`Sign-in: ${USER} / ${PASSWORD}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log("Holding the process tree. Leave this running; `control-kiriko stop` or Ctrl-C tears it down.");
  const shutdown = () => {
    const current = readInstance();
    if (current) {
      killTree(current.frontendPid);
      killTree(current.backendPid);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {});
}

function cmdStop() {
  const instance = readInstance();
  stopRecorded(instance);
  if (existsSync(RUN_DIR)) {
    rmSync(RUN_DIR, { recursive: true, force: true });
  }
  console.log(`Stopped verify instance. Evidence kept at ${EVIDENCE_DIR}`);
}

function defaultZipPath() {
  return path.join(RUN_DIR, "minimal-imdf.zip");
}

function cmdFixtureZip() {
  const outPath = path.resolve(process.argv[3] ?? defaultZipPath());
  mkdirSync(path.dirname(outPath), { recursive: true });
  const writer = path.join(SCRIPT_DIR, "write-fixture.ts");
  const result = spawnSync(pnpmBin(), ["exec", "tsx", writer, outPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    fail("fixture-zip failed", result.stderr || result.stdout);
  }
  console.log((result.stdout ?? "").trim());
}

async function cmdDrive(featureId) {
  if (featureId !== "sign-in-gallery") {
    fail(`No automated drive recipe for "${featureId ?? ""}". See features/ and drive it through the browser.`);
  }
  const report = await doctorReport();
  if (!report.driveable) {
    fail("Instance is not driveable. Run launch, then doctor.", JSON.stringify(report, null, 2));
  }

  const { chromium, expect } = await import("@playwright/test");
  const evidence = path.join(EVIDENCE_DIR, "sign-in-gallery");
  mkdirSync(evidence, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${ORIGIN}/`);
    await expect(page.locator(".signin-card")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("dialog", { name: /Kiriko にサインイン|Sign in to Kiriko/ })).toBeVisible();
    writeFileSync(
      path.join(evidence, "signed-out.aria.yml"),
      await page.locator(".signin-card").ariaSnapshot(),
    );
    await page.screenshot({ path: path.join(evidence, "signed-out.png"), fullPage: true });

    await page.getByLabel(/メールアドレス|Email/).fill(USER);
    await page.getByLabel(/パスワード|Password/).fill(PASSWORD);
    await page.getByRole("button", { name: /サインイン|Sign in/ }).click();
    await expect(page.locator(".gallery__title")).toHaveText(/データセット|Datasets/, {
      timeout: 15_000,
    });
    await expect(page.locator(".gallery-header__wordmark")).toHaveText("Kiriko");
    await expect(page.locator(".chip", { hasText: USER })).toBeVisible();
    await expect(page.getByText(/データセットがありません|No datasets yet/)).toBeVisible();

    writeFileSync(
      path.join(evidence, "signed-in.aria.yml"),
      await page.locator("body").ariaSnapshot(),
    );
    await page.screenshot({ path: path.join(evidence, "signed-in.png"), fullPage: true });

    const cookie = (await page.context().cookies(ORIGIN))
      .map((entry) => `${entry.name}=${entry.value}`)
      .join("; ");
    const venues = await fetchJson(`${ORIGIN}/api/venues`, { headers: { cookie } });
    if (!venues.ok || !Array.isArray(venues.body?.venues)) {
      fail(`signed-in /api/venues failed: ${JSON.stringify(venues)}`);
    }
    writeFileSync(
      path.join(evidence, "venues.json"),
      `${JSON.stringify({ status: venues.status, venues: venues.body.venues }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(evidence, "notes.md"),
      [
        "# sign-in-gallery proof",
        "",
        `- Feature: sign-in-gallery`,
        `- Entry point: GET ${ORIGIN}/`,
        `- Account: ${USER}`,
        `- Signed-out dialog: Kiriko にサインイン`,
        `- Signed-in heading: データセット, wordmark Kiriko, empty copy データセットがありません`,
        `- Side effect: GET ${ORIGIN}/api/venues returned ${venues.status} with ${venues.body.venues.length} venues`,
        "",
      ].join("\n"),
    );
    console.log(`Evidence written to ${evidence}`);
  } finally {
    await browser.close();
  }
}

function cmdHelp() {
  console.log(`control-kiriko — isolated Kiriko verification

Commands:
  launch                 Start the isolated stack on ${ORIGIN} and keep it running
  doctor                 Print JSON health; exit 0 only if driveable
  fixture-zip [path]     Write the synthetic minimal IMDF ZIP
  drive sign-in-gallery  Headless Playwright proof for the sign-in feature
  stop                   Kill recorded PIDs and delete .kiriko-verify/run
                         (evidence at .kiriko-verify/evidence is kept)

Ports ${FRONTEND_PORT} / ${BACKEND_PORT} are independent of ./dev.sh (5173 / 8790).
Never drive a stack this helper did not start.
`);
}

switch (command) {
  case "launch":
    await cmdLaunch();
    break;
  case "doctor":
    await cmdDoctor();
    break;
  case "stop":
  case "cleanup":
    cmdStop();
    break;
  case "fixture-zip":
    cmdFixtureZip();
    break;
  case "drive":
    await cmdDrive(process.argv[3]);
    break;
  case "help":
  case "--help":
  case "-h":
    cmdHelp();
    break;
  default:
    fail(`Unknown command "${command}".`);
}
