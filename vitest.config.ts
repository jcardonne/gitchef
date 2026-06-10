import { defineConfig } from "vitest/config";

// Pure-logic unit tests (fileTree, storage). No DOM is needed - storage.ts only
// touches localStorage, which vitest.setup.ts polyfills in the Node environment.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
