/// <reference types="vitest" />

import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Redis rate limiter tests only (starts a Redis container via Docker).
export default defineConfig({
  plugins: [tsconfigPaths({ skip: (dir) => dir === ".claude" })],
  test: {
    globalSetup: ["./ratelimit-redis/src/tests/setup/startContainers.ts"],
    teardownTimeout: 30000,
    include: ["ratelimit-redis/src/tests/**/*.test.ts"],
    testTimeout: 60000,
  },
});
