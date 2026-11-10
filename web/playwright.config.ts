import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

// In CI the job has just built the site from this checkout, so it is not built a second time.
const built = Boolean(process.env["CI"]) && existsSync(".next/BUILD_ID");

// Full Chromium, not the stripped-down headless shell (which crashed in an earlier check).
// Every spec starts as a returning visitor who has finished the first-visit guide, so its captions and
// hints do not cover the page; the guide's own spec starts with empty storage instead.
const returning = {
  cookies: [],
  origins: [
    {
      origin: "http://127.0.0.1:3100",
      localStorage: [
        { name: "graft.coach", value: "keys+made" },
        { name: "graft.coach.sketch", value: "done" },
      ],
    },
  ],
};

export default defineConfig({
  testDir: "e2e",
  use: { storageState: returning },
  testMatch: "**/*.spec.ts",
  // The specs under e2e/service need the real service, a database and a bucket: scripts/service-e2e.sh
  // starts them and sets GRAFT_SERVICE_E2E. Without it they are not part of the run.
  testIgnore: process.env["GRAFT_SERVICE_E2E"] ? [] : ["**/service/**"],
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", channel: "chromium", baseURL: "http://127.0.0.1:3100" },
    },
    // The page-hide flush is the one behaviour that differs between engines, and the core loop is the
    // one thing every visitor does: those two run in all three engines.
    {
      name: "firefox",
      testMatch: ["**/flush.spec.ts", "**/core-loop.spec.ts"],
      use: { browserName: "firefox", baseURL: "http://127.0.0.1:3100" },
    },
    {
      name: "webkit",
      // perform plays real Web Audio, which is where the engines differ most: it runs here too
      testMatch: [
        "**/flush.spec.ts",
        "**/core-loop.spec.ts",
        "**/perform.spec.ts",
        "**/phrase.spec.ts",
        // sketches keep their specs in storage and play real Web Audio: the two things the engines differ in
        "**/sketch.spec.ts",
        "**/sketch-move.spec.ts",
        "**/sketch-bank.spec.ts",
        "**/sketch-set.spec.ts",
        // a long recording is decoded and held in memory, where WebKit (an iPhone) is the engine to worry about
        "**/long-recording.spec.ts",
      ],
      use: { browserName: "webkit", baseURL: "http://127.0.0.1:3100" },
    },
  ],
  // The roll specs drive the built site. The playback spec builds its own page and ignores this.
  webServer: {
    command: built ? "pnpm start --port 3100" : "pnpm build && pnpm start --port 3100",
    url: "http://127.0.0.1:3100",
    // A server left running from an earlier run would not know where the service is.
    // (GRAFT_REUSE_SERVER=1 lets a hand-run against `scripts/dev-local.sh` use the site already on this port)
    reuseExistingServer:
      !process.env["CI"] &&
      (!process.env["GRAFT_SERVICE_E2E"] || process.env["GRAFT_REUSE_SERVER"] === "1"),
    timeout: 240_000,
  },
});
