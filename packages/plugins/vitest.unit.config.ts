/// <reference types="vitest" />

import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Plugin tests that don't need Docker (no global container setup).
export default defineConfig({
  plugins: [tsconfigPaths({ skip: (dir) => dir === ".claude" })],
  test: {
    include: [
      "ratelimit-memory/src/**/*.test.ts",
      "queue-liteque/src/**/*.test.ts",
    ],
    testTimeout: 60000,
  },
});
