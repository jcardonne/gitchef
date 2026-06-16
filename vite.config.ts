import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

// Tauri expects a fixed port and ignores the src-tauri folder for HMR.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Expose the app version (single source of truth: package.json, synced to
  // tauri.conf.json + Cargo.toml by scripts/bump-version.mjs) as a compile-time
  // constant, so the UI can show it without a runtime IPC round-trip.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
