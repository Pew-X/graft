// The busy-stage case, against a service with the REAL limits (not scripts/service-e2e.sh, which lifts them):
// the guided path sends every fresh visitor to the same ready-made stage, and the service allows 20 flips of one
// stage an hour across everyone. Five fresh profiles each publish a set of four sibling sketches of that stage
// (twenty flips, all accepted); a sixth profile's set is refused at its first sketch with the per-stage words
// and a wait, nothing is lost, and its sketches stay waiting. Run by hand against `scripts/dev-local.sh` started
// with GRAFT_PUBLISH_PER_IP=100 (so the per-address limit, 20 an hour, does not bite first):
//   GRAFT_PUBLISH_PER_IP=100 sh scripts/dev-local.sh      (in one terminal, on a fresh local database)
//   GRAFT_BUSY_STAGE=1 GRAFT_SERVICE_E2E=1 GRAFT_REUSE_SERVER=1 GRAFT_API_URL=http://127.0.0.1:3300 GRAFT_SITE_URL=http://127.0.0.1:3100 pnpm exec playwright test e2e/service/busy-stage
import { expect, test, type Browser, type Page } from "@playwright/test";
import { SEEDED_LAST, allowBucketReads } from "./service.ts";

test.skip(process.env["GRAFT_BUSY_STAGE"] !== "1", "needs a service with the real limits");
test.setTimeout(240_000);

const SITE = process.env["GRAFT_SITE_URL"] ?? "http://127.0.0.1:3100";

async function profile(browser: Browser, who: number): Promise<Page> {
  const context = await browser.newContext({
    baseURL: SITE,
    storageState: {
      cookies: [],
      origins: [{ origin: SITE, localStorage: [{ name: "graft.coach", value: "keys+made" }] }],
    },
  });
  const page = await context.newPage();
  await allowBucketReads(page);
  await page.addInitScript(
    ([stage, run]) => {
      const mk = (n: number, title: string, end: number) => ({
        id: `sk${String(n).padStart(12, "0")}`,
        parent: { kind: "stage", id: stage },
        cut: { start: 0, end },
        p: 1,
        q: 1,
        title,
        retryKey: `web-${run}-0123456789abcdef0${n}`,
        at: n,
      });
      localStorage.setItem(
        "graft.sketches",
        JSON.stringify({
          v: 1,
          bank: [],
          sketches: [1, 2, 3, 4].map((n) => mk(n, `busy ${run} try ${n}`, 6000 + n * 700)),
        }),
      );
      localStorage.setItem("graft.coach.sketch", "done");
    },
    [SEEDED_LAST, `${who}${Math.random().toString(36).slice(2, 8)}`] as const,
  );
  return page;
}

async function publishSet(page: Page, name: string): Promise<void> {
  await page.goto("/make");
  for (const box of await page.getByLabel("publish this one").all()) await box.check();
  await page.getByLabel(/^your name/).fill(name);
  await page.getByRole("button", { name: "publish these (4)" }).click();
}

test("five profiles publish twenty sibling flips of one stage; the sixth is refused with the per-stage words and loses nothing", async ({
  browser,
}) => {
  for (let who = 1; who <= 5; who++) {
    const page = await profile(browser, who);
    await publishSet(page, `maker ${who}`);
    await expect(page.getByTestId("set-summary")).toContainText("4 published, 0 waiting.", {
      timeout: 60_000,
    });
    await page.context().close();
  }
  const sixth = await profile(browser, 6);
  await publishSet(sixth, "maker six");
  const summary = sixth.getByTestId("set-summary");
  await expect(summary).toContainText("0 published, 4 waiting.", { timeout: 60_000 });
  await expect(summary).toContainText(
    "this stage has been flipped as often as is allowed this hour",
  );
  await expect(summary).toContainText(
    /try again in about \d+ (minutes|minute|seconds)|in an hour|in a moment/,
  );
  await expect(summary).toContainText("nothing is lost");
  // the sketches and their choice are still there: a reload resumes
  await sixth.reload();
  await expect(sixth.getByText("4 will be published, in this order:")).toBeVisible();
  await sixth.context().close();
});
