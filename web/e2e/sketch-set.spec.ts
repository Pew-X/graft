// "Publish these": a set of sketches published in order, one screen for every link and key, resumable, and
// with no way to lose a key or publish one twice. The service is answered by the test (its real answers, shape
// for shape: a created flip with its key, a replay with none, a refusal with its wait), so what is checked is
// the page: the order, the keys saved first, each refusal's own words and a clean resume. The real service is
// exercised by e2e/service/set.spec.ts. Each test names the guarantee it protects.
import { expect, test, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "./a11y.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = (
  JSON.parse(readFileSync(join(web, "snapshot", "sources.json"), "utf8")) as {
    stages: Array<{ id: string }>;
  }
).stages[0]!;
const KEY = "graft.sketches";
const KEPT = "graft.manage-keys";

test.use({ bypassCSP: true });

/** Three sketches: two siblings of the source and one that goes on from the first. */
async function seed(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, id]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      const mk = (n: number, parent: object, title: string, end: number) => ({
        id: `sk${String(n).padStart(12, "0")}`,
        parent,
        cut: { start: 0, end },
        p: 1,
        q: 1,
        title,
        retryKey: `web-0123456789abcdef0123456789ab0${n}`,
        at: n,
      });
      localStorage.setItem(
        key!,
        JSON.stringify({
          v: 1,
          bank: [],
          sketches: [
            mk(1, { kind: "stage", id }, "low", 8000),
            mk(2, { kind: "stage", id }, "high", 9000),
            mk(3, { kind: "sketch", id: "sk000000000001" }, "low then lower", 4000),
          ],
        }),
      );
    },
    [KEY, SOURCE.id] as const,
  );
  await page.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (t: string) => {
          (window as unknown as { __copied: string[] }).__copied.push(t);
          return Promise.resolve();
        },
      },
    });
  });
}

interface Posted {
  parent: string;
  key: string;
  title: string;
  author: string;
  hash: string | undefined;
}

/** A scripted service for publish: `answer(n, body)` decides each POST. */
async function service(
  page: Page,
  answer: (n: number, body: Record<string, unknown>) => { status: number; body?: object } | "abort",
): Promise<Posted[]> {
  const seen: Posted[] = [];
  let n = 0;
  await page.route("**/v1/publications", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    seen.push({
      parent: String(body["parent_id"]),
      key: String(body["retry_key"]),
      title: String(body["title"]),
      author: String(body["author"]),
      hash: body["preview_hash"] as string | undefined,
    });
    const made = answer(n++, body);
    if (made === "abort") return route.abort();
    return route.fulfill({
      status: made.status,
      contentType: made.status >= 400 ? "application/problem+json" : "application/json",
      body: JSON.stringify(made.body ?? {}),
    });
  });
  return seen;
}

const idFor = (n: number): string => `p${String(n).padStart(11, "k")}`.slice(0, 12);
const created = (
  n: number,
  key: string | null = `manage-key-number-${n}-0123456789abcdef`,
  replay = false,
) => ({
  status: replay ? 200 : 201,
  body: {
    publication: { id: idFor(n) },
    ...(key ? { manage_key: key } : {}),
    preview_matches: true,
    adjusted_fields: [],
  },
});
const problem = (type: string, status: number, extra: object = {}) => ({
  status,
  body: { type: `urn:graft:problem:${type}`, title: type, status, detail: type, ...extra },
});

const row = (page: Page, title: string) =>
  page.locator(".your-sketch", {
    has: page.locator(".sketch-title", { hasText: new RegExp(`^${title}$`) }),
  });
const chooseAll = async (page: Page, titles = ["low", "high", "low then lower"]): Promise<void> => {
  for (const t of titles) await row(page, t).getByLabel("choose for publish these").check();
};
async function start(page: Page, name = "set maker"): Promise<void> {
  await page.getByLabel(/^your name/).fill(name);
  await page.getByRole("button", { name: /^publish these \(\d+\)$/ }).click();
}
const stored = (page: Page, key: string) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key);

test("the set is published in order, each with its own key, from its parent's publication, ending on one screen with every link and key", async ({
  page,
}) => {
  await seed(page);
  const seen = await service(page, (n) => created(n + 1));
  await page.goto("/make");
  await chooseAll(page);
  await expect(page.getByText("3 will be published, in this order:")).toBeVisible();
  await start(page);
  await expect(page.getByTestId("set-summary")).toContainText("3 published, 0 waiting.");
  // order: the two parents before the sketch that goes on from the first
  expect(seen.map((s) => s.title)).toEqual(["low", "high", "low then lower"]);
  expect(seen.map((s) => s.key)).toEqual([
    "web-0123456789abcdef0123456789ab01",
    "web-0123456789abcdef0123456789ab02",
    "web-0123456789abcdef0123456789ab03",
  ]);
  expect(seen[0]!.parent).toBe(SOURCE.id);
  expect(seen[2]!.parent).toBe(idFor(1));
  expect(seen.every((s) => s.author === "set maker" && (s.hash ?? "").length === 64)).toBe(true);
  // one screen: three links, and three keys kept in this browser (the default)
  await expect(page.locator(".set-links li")).toHaveCount(3);
  const kept = (await stored(page, KEPT)) as Record<string, string>;
  expect(Object.keys(kept).sort()).toEqual([idFor(1), idFor(2), idFor(3)]);
  const book = (await stored(page, KEY)) as { sketches: Array<{ publishedAs?: string }> };
  expect(book.sketches.map((s) => s.publishedAs)).toEqual([idFor(1), idFor(2), idFor(3)]);
  // a key is shown on press, copied as plain text, and never in an address
  await page.getByRole("button", { name: "show key" }).first().click();
  await expect(page.locator(".set-links code").first()).toHaveText(/^manage-key-number-1-/);
  await page.getByRole("button", { name: "copy all keys" }).click();
  const copied = await page.evaluate(
    () => (window as unknown as { __copied: string[] }).__copied[0]!,
  );
  expect(copied.split("\n")).toHaveLength(3);
  expect(copied).toContain("manage-key-number-2-");
  expect(page.url()).not.toContain("manage-key");
  // and the chosen ones are cleared, so the next set starts empty
  await expect(page.locator(".sketch-choose input:checked")).toHaveCount(0);
});

test("a chosen sketch brings its unpublished parent in, and says so before it starts", async ({
  page,
}) => {
  await seed(page);
  await service(page, (n) => created(n + 1));
  await page.goto("/make");
  await row(page, "low then lower").getByLabel("choose for publish these").check();
  await expect(page.getByText("2 will be published, in this order:")).toBeVisible();
  await expect(
    page.getByText(
      "also published, because a sketch you chose goes on from them and they are not published yet: low.",
    ),
  ).toBeVisible();
  await expect(page.locator(".set-plan li")).toHaveText(["low", "low then lower"]);
});

test("a limit stops the set at that sketch: how many were published, how many wait, when to try again, never a countdown, and a resume sends only what is left", async ({
  page,
}) => {
  await seed(page);
  const seen = await service(page, (n) =>
    n === 2 ? problem("fork-cap", 429, { retry_after_secs: 1200 }) : created(n <= 1 ? n + 1 : n),
  );
  await page.goto("/make");
  await chooseAll(page);
  await start(page);
  const summary = page.getByTestId("set-summary");
  await expect(summary).toContainText("2 published, 1 waiting.");
  await expect(summary).toContainText(
    "this stage has been flipped as often as is allowed this hour. try again in about 20 minutes.",
  );
  await expect(summary).toContainText("nothing is lost");
  expect(seen).toHaveLength(3);
  // later: continue sends only the third, with the same retry key as the refused try
  await page.getByRole("button", { name: "continue" }).click();
  await expect(page.getByTestId("set-summary")).toContainText("3 published, 0 waiting.");
  expect(seen).toHaveLength(4);
  expect(seen[3]!.key).toBe(seen[2]!.key);
  expect(seen.map((s) => s.key).slice(0, 2)).not.toContain(seen[3]!.key);
});

test("each limit reads in its own words: per address, per stage, and everyone together", async ({
  page,
}) => {
  const words: Array<[string, RegExp]> = [
    ["rate-limited", /you have published a lot in a short time\. try again in about 5 minutes/],
    ["fork-cap", /this stage has been flipped as often as is allowed this hour/],
    ["publish-cap", /everyone together has published as much as is allowed for now/],
  ];
  for (const [type, expected] of words) {
    await seed(page);
    await service(page, () =>
      problem(type, 429, { retry_after_secs: type === "rate-limited" ? 290 : 900 }),
    );
    await page.goto("/make");
    await chooseAll(page, ["low"]);
    await start(page);
    await expect(page.getByTestId("set-summary")).toContainText(expected);
    await page.evaluate(() => sessionStorage.clear());
    await page.unroute("**/v1/publications");
    await page.evaluate(() => localStorage.clear());
  }
});

test("an answer lost after the service made the flip: the retry is 'already published', and the page says plainly its key was never shown", async ({
  page,
}) => {
  await seed(page);
  const seen = await service(page, (n) => {
    // the first sketch goes through; the second's answer is lost four times; then the service replays it
    if (n === 0) return created(1);
    if (n <= 4) return "abort";
    return created(2, null, true);
  });
  await page.goto("/make");
  await chooseAll(page, ["low", "high"]);
  await start(page);
  await expect(page.getByTestId("set-summary")).toContainText("the service did not answer", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("set-summary")).toContainText("1 published, 1 waiting.");
  await page.getByRole("button", { name: "continue" }).click();
  await expect(page.getByTestId("set-summary")).toContainText("2 published, 0 waiting.");
  await expect(page.getByText(/already published: an earlier try made it/)).toBeVisible();
  await expect(page.getByText(/its key was never shown/)).toBeVisible();
  // the same retry key every time: it can never have been made twice
  expect(new Set(seen.slice(1).map((s) => s.key)).size).toBe(1);
});

test("a title the service refuses stops the set at that sketch, can be changed, and resumes with the same key", async ({
  page,
}) => {
  await seed(page);
  const seen = await service(page, (n) =>
    n === 0 ? problem("invalid-field", 422, { field: "title", rule: "denied_word" }) : created(n),
  );
  await page.goto("/make");
  await chooseAll(page, ["low", "high"]);
  await start(page);
  await expect(page.getByTestId("set-summary")).toContainText("the title breaks a rule");
  await page.getByLabel(/change the title of low/).fill("deep low");
  await page.getByRole("button", { name: "save and continue" }).click();
  await expect(page.getByTestId("set-summary")).toContainText("2 published, 0 waiting.");
  expect(seen[1]!.title).toBe("deep low");
  expect(seen[1]!.key).toBe(seen[0]!.key);
});

test("a parent that went away skips that sketch and the ones that go on from it; the rest continue", async ({
  page,
}) => {
  await seed(page);
  await service(page, (n) => (n === 0 ? problem("parent-unavailable", 409) : created(n)));
  await page.goto("/make");
  await chooseAll(page);
  await start(page);
  await expect(page.getByTestId("set-summary")).toContainText("1 published, 0 waiting.");
  const states = page.locator(".set-progress li .set-state");
  await expect(states.nth(0)).toContainText("the stage you were flipping is no longer here");
  await expect(states.nth(2)).toContainText(
    "skipped: the sketch it goes on from was not published",
  );
});

test("a set is resumed after a reload: what was published stays, and only the rest is offered", async ({
  page,
}) => {
  await seed(page);
  await service(page, (n) =>
    n === 1 ? problem("rate-limited", 429, { retry_after_secs: 600 }) : created(n + 1),
  );
  await page.goto("/make");
  await chooseAll(page);
  await start(page);
  await expect(page.getByTestId("set-summary")).toContainText("1 published, 2 waiting.");
  await page.reload();
  await expect(page.getByText("2 will be published, in this order:")).toBeVisible();
  await expect(page.locator(".set-plan li")).toHaveText(["high", "low then lower"]);
  await expect(page.getByLabel(/^your name/)).toHaveValue("set maker");
});

test("a second tab sees the lease and does not publish the same set", async ({ page }) => {
  await seed(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      "graft.sketch-lease",
      JSON.stringify({ tab: "another-tab", at: Date.now() }),
    );
  });
  const seen = await service(page, (n) => created(n + 1));
  await page.goto("/make");
  await chooseAll(page, ["low"]);
  await page.getByLabel(/^your name/).fill("me");
  await expect(page.getByText("this set is being published in another tab.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^publish these/ })).toBeDisabled();
  expect(seen).toHaveLength(0);
});

test("the set panel and result pass an accessibility scan at laptop and phone width", async ({
  page,
}, info) => {
  await seed(page);
  await service(page, (n) => created(n + 1));
  await page.goto("/make");
  await chooseAll(page);
  await scan(page, "publish these, planned", info);
  await start(page);
  await expect(page.getByTestId("set-summary")).toContainText("3 published, 0 waiting.");
  await scan(page, "publish these, result", info);
  await page.setViewportSize({ width: 360, height: 640 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(0);
});
