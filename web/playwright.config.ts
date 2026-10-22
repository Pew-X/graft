import { defineConfig } from "@playwright/test";

// Full Chromium, not the stripped-down headless shell (which crashed in an earlier check).
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  projects: [{ name: "chromium", use: { browserName: "chromium", channel: "chromium" } }],
});
