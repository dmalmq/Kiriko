import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  worker: {
    // `@kiriko/wasm` decodes bundles inside a dedicated worker; ES module
    // workers can `import` the wasm-pack "web" target glue directly, unlike
    // Vite's default IIFE worker format.
    format: "es",
  },
  optimizeDeps: {
    // The dep scanner globs the project root for `**/*.html` and does not read
    // `.gitignore`, so local scratch directories (design exports, tool output)
    // would otherwise be scanned as entry points — and any unparseable file in
    // them fails the whole scan. Pin it to the app's own entry.
    entries: ["index.html"],
    // wasm-pack's "web" target resolves its `.wasm` asset via
    // `new URL('kiriko_wasm_bg.wasm', import.meta.url)`. Vite's dependency
    // pre-bundler rewrites `import.meta.url`, which would break that
    // resolution, so this package must never be pre-bundled.
    exclude: ["@kiriko/wasm"],
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8790",
      "/v": "http://127.0.0.1:8790",
    },
  },
  preview: {
    proxy: {
      "/api": "http://127.0.0.1:8790",
      "/v": "http://127.0.0.1:8790",
    },
  },
});
