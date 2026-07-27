import { defineConfig, devices } from "@playwright/test";

const VISUAL_SPEC = "**/viewer.visual.spec.ts";

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
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: VISUAL_SPEC },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, testIgnore: VISUAL_SPEC },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testIgnore: VISUAL_SPEC },
    {
      // Visual baselines run on deterministic software rasterization
      // (SwiftShader) so GPU/driver variance cannot jitter pixels.
      // Performance specs stay on the plain chromium project: SwiftShader
      // timings would not represent the acceptance runner.
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
      command: "pnpm build && pnpm exec vite preview --host 127.0.0.1 --port 4173",
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
