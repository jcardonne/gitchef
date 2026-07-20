import { defineConfig } from "vitest/config";

// Pure-logic unit tests (fileTree, storage). No DOM is needed - storage.ts only
// touches localStorage, which vitest.setup.ts polyfills in the Node environment.
export default defineConfig({
  test: {
    environment: "node",
    // `.tsx` too: with a `.ts`-only glob a component test file is silently
    // skipped and CI still reports green.
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
