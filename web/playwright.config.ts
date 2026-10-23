import { defineConfig } from "@playwright/test";

// Full Chromium, not the stripped-down headless shell (which crashed in an earlier check).
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", channel: "chromium", baseURL: "http://127.0.0.1:3100" },
    },
  ],
  // The roll specs drive the built site. The playback spec builds its own page and ignores this.
  webServer: {
    command: "pnpm build && pnpm start --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env["CI"],
    timeout: 240_000,
  },
});
