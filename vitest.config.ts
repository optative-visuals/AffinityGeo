import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tools/test/**/*.test.js", "packages/*/test/**/*.test.{ts,js}", "apps/*/test/**/*.test.{ts,tsx,js}"],
  },
});
