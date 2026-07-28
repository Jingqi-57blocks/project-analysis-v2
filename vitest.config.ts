import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "engine/**/*.test.ts"],
    // Fixtures are analysis targets, not code under test. They deliberately
    // contain unresolvable references and divergent declarations.
    exclude: ["node_modules/**", "fixtures/**"],
  },
});
