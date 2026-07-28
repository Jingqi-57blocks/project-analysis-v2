import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "engine/**/*.test.ts"],
    // Analysis targets are read, never executed as code under test.
    exclude: ["node_modules/**", ".targets/**"],
    // SQLite ships with the runtime, which is why the tool needs no native
    // dependency or build step. The experimental warning is expected and
    // accepted; the risk is contained by keeping the driver behind
    // engine/store. See engine/store/open.ts.
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});
