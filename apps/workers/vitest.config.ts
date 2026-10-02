import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve bare local imports ("metrics", "workerTracing", ...) through the
  // tsconfig baseUrl, like the TypeScript compiler and the build do.
  resolve: { tsconfigPaths: true },
});
