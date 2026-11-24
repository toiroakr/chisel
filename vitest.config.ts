import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/support/temporal.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
    },
  },
});
