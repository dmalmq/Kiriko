import { defineConfig, devices } from "@playwright/test";

const VISUAL_SPEC = "**/viewer.visual.spec.ts";
// Both performance suites: the viewer's own budgets, and the scene renderer's
// load budgets and stability criteria. Single worker, real GPU.
const PERFORMANCE_SPEC = [
  "**/viewer.performance.spec.ts",
  "**/viewer.scene-performance.spec.ts",
];

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  // Plan-literal baseline names (desktop-tokyo-ja.png, …) on the fixed
  // Chromium/Linux runner; the visual project below is the only snapshot user.
  snapshotPathTemplate: "{testDir}/{testFileDir}/{testFileName}-snapshots/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  // Software-GL runners (no GPU, shared cores) can take tens of seconds for a
  // scene page to reach its first idle; the helper-level idle waits carry the
  // same headroom. Asserted contracts are unchanged — only the wait budget.
  timeout: 300_000,
  expect: {
    timeout: 90_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: [VISUAL_SPEC, ...PERFORMANCE_SPEC],
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testIgnore: [VISUAL_SPEC, ...PERFORMANCE_SPEC],
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testIgnore: [VISUAL_SPEC, ...PERFORMANCE_SPEC],
    },
    {
      // Real-time thresholds (P95 upload/level-change latency, longtask
      // budget) are only meaningful when nothing else contends for the CPU.
      // Kept out of the "chromium" project (whose other files run
      // concurrently across workers) and run via its own single-worker CLI
      // invocation in CI instead.
      name: "chromium-performance",
      use: { ...devices["Desktop Chrome"] },
      testMatch: PERFORMANCE_SPEC,
    },
    {
      // Visual baselines run on deterministic software rasterization
      // (SwiftShader) so GPU/driver variance cannot jitter pixels.
      // Performance specs stay off SwiftShader (see chromium-performance):
      // its timings would not represent the acceptance runner.
      name: "chromium-visual",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            // Deterministic text rasterization: marker labels otherwise flip
            // between LCD and grayscale antialiasing across runs.
            "--disable-lcd-text",
            "--font-render-hinting=none",
            "--force-color-profile=srgb",
            // Markers use 3D transforms and become composited layers; GPU
            // (SwiftShader-GL) tile rasterization of their text is not
            // run-deterministic. Software compositing is.
            "--disable-gpu-compositing",
          ],
        },
      },
      testMatch: VISUAL_SPEC,
    },
  ],
  webServer: [
    {
      command: "pnpm exec vite preview --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "node scripts/start-e2e-server.mjs",
      url: "http://127.0.0.1:8790/healthz",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
