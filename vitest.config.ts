import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Device clients and CLI glue need real devices; they're exercised by the e2e checklist instead.
      exclude: [
        "src/cli.ts",
        "src/mcp/**",
        "src/setup.ts",
        "src/session.ts",
        "src/driver/**/driver.ts",
        "src/driver/**/wda.ts",
        "src/driver/**/uia2.ts",
        "src/driver/**/cdp.ts",
        "src/driver/**/adb.ts",
        "src/driver/**/simctl.ts",
        "src/driver/select.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
