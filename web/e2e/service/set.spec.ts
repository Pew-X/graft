// "Publish these" against the real service, database and bucket (scripts/service-e2e.sh): four sketches (three of
// one stage and one that goes on from one of them, all with default titles) are published as a set, each flip
// renders to the very hash the service computes, the database holds exactly the right number, a response lost
// after the service made a flip is replayed without a second one, and "your flips" lists them all.
import { expect, test, type Page } from "@playwright/test";
import { API, SEEDED_LAST, allowBucketReads, publishFlip } from "./service.ts";

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => {
  await allowBucketReads(page);
});

const KEY = "graft.sketches";

/** Four sketches of a stage of their own: default-style titles, one going on from another. */
async function seed(page: Page, parent: string): Promise<void> {
  await page.addInitScript(
    ([key, id]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      // a retry key belongs to one flip for ever: every test makes its own
      const run = Math.random().toString(36).slice(2, 12);
      const mk = (n: number, par: object, title: string, end: number, p: number, q: number) => ({
        id: `sk${String(n).padStart(12, "0")}`,
        parent: par,
        cut: { start: 0, end },
        p,
        q,
        title,
        retryKey: `web-${run}-0123456789abcdef0${n}`,
        at: n,
      });
      localStorage.setItem(
        key!,
        JSON.stringify({
          v: 1,
          bank: [],
          sketches: [
            mk(1, { kind: "stage", id }, "up a fifth, 0 to 0.25 s", 12000, 3, 2),
            mk(2, { kind: "stage", id }, "down an octave, 0 to 0.2 s", 9600, 1, 2),
            mk(3, { kind: "stage", id }, "same pitch, 0 to 0.15 s", 7200, 1, 1),
            mk(4, { kind: "sketch", id: "sk000000000001" }, "up a fifth, 0 to 0.1 s", 4800, 3, 2),
          ],
        }),
      );
    },
    [KEY, parent] as const,
  );
}

async function total(request: Parameters<typeof publishFlip>[0], id: string): Promise<number> {
  const r = await request.get(`${API}/v1/publications/${id}/flips`);
  return ((await r.json()) as { total: number }).total;
}

const choose = async (page: Page): Promise<void> => {
  for (const box of await page.getByLabel("publish this one").all()) await box.check();
};

test("four sketches, one going on from another, publish as a set: the right number exist, the child's render is the service's, and your flips lists all four", async ({
  page,
  request,
}) => {
  const parent = (await publishFlip(request, SEEDED_LAST, "parent of a set")).id;
  await seed(page, parent);
  await page.goto("/make");
  await choose(page);
  await page.getByLabel(/^your name/).fill("set maker");
  await page.getByRole("button", { name: "publish these (4)" }).click();
  await expect(page.getByTestId("set-summary")).toContainText("4 published, 0 waiting.", {
    timeout: 60_000,
  });
  // a render that differed from the service's would have stopped the set before the fourth
  await expect(page.getByText(/came out differently/)).toHaveCount(0);
  expect(await total(request, parent)).toBe(3);
  await expect(page.locator(".set-links li")).toHaveCount(4);
  // the child's parent is the first flip, as published
  const links = await page
    .locator(".set-links a.link")
    .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).pathname));
  const firstId = links[0]!.replace("/p/", "");
  const childId = links[3]!.replace("/p/", "");
  const chain = (await (await request.get(`${API}/v1/chains/${childId}`)).json()) as {
    stages: Array<{ id: string; state: string }>;
  };
  expect(chain.stages.at(-2)?.id).toBe(firstId);
  expect(chain.stages.at(-1)?.state).toBe("available");
  // keys are kept in this browser by default and "your flips" lists the four
  await page.goto("/flips");
  await expect(page.locator(".your-flip")).toHaveCount(4);
});

test("a response lost after the service made the flip: resuming publishes nothing twice, and says the key was never shown", async ({
  page,
  request,
}) => {
  const parent = (await publishFlip(request, SEEDED_LAST, "parent of a lossy set")).id;
  await seed(page, parent);
  let posts = 0;
  let lost = 0;
  await page.route("**/v1/publications", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts++;
    // the second sketch's answer is lost on the way back, every time it is tried in this first run
    const body = JSON.parse(route.request().postData() ?? "{}") as { title: string };
    if (body.title.startsWith("down an octave") && lost < 4) {
      lost++;
      await route.fetch(); // the service makes the flip (or replays it)...
      return route.abort(); // ...and the answer never arrives
    }
    return route.continue();
  });
  await page.goto("/make");
  await choose(page);
  await page.getByLabel(/^your name/).fill("lossy");
  await page.getByRole("button", { name: "publish these (4)" }).click();
  await expect(page.getByTestId("set-summary")).toContainText("the service did not answer", {
    timeout: 60_000,
  });
  // the flip exists although the page never heard so
  expect(await total(request, parent)).toBe(2);
  await page.getByRole("button", { name: "continue" }).click();
  await expect(page.getByTestId("set-summary")).toContainText("4 published, 0 waiting.", {
    timeout: 60_000,
  });
  await expect(page.getByText(/its key was never shown/)).toBeVisible();
  expect(await total(request, parent)).toBe(3);
  void posts;
});

test("two sketches of the same parent with the same default name publish as two flips with their own titles", async ({
  page,
  request,
}) => {
  const parent = (await publishFlip(request, SEEDED_LAST, "parent of twins")).id;
  await page.addInitScript(
    ([key, id]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      // a retry key belongs to one flip for ever: every test makes its own
      const run = Math.random().toString(36).slice(2, 12);
      const mk = (n: number, title: string, end: number) => ({
        id: `sk${String(n).padStart(12, "0")}`,
        parent: { kind: "stage", id },
        cut: { start: 0, end },
        p: 3,
        q: 2,
        title,
        retryKey: `web-${run}-0123456789abcdef0${n}`,
        at: n,
      });
      localStorage.setItem(
        key!,
        JSON.stringify({
          v: 1,
          bank: [],
          sketches: [mk(1, "up a fifth", 12000), mk(2, "up a fifth (2)", 12100)],
        }),
      );
    },
    [KEY, parent] as const,
  );
  await page.goto("/make");
  await choose(page);
  await page.getByLabel(/^your name/).fill("twin maker");
  await page.getByRole("button", { name: "publish these (2)" }).click();
  await expect(page.getByTestId("set-summary")).toContainText("2 published, 0 waiting.", {
    timeout: 60_000,
  });
  expect(await total(request, parent)).toBe(2);
});
