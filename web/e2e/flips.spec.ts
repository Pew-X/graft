// "Your flips": the list of the flips this browser holds a manage key for, and the publish step keeping
// that key by default. The service is answered by the test, so what is checked is the page: what it
// lists, in what order, what it does when the service is asleep, and that forgetting a key is the
// browser's own act and says twice that it cannot be undone. Each test names the guarantee it protects.
import { expect, test, type Page } from "@playwright/test";
import { scan, smallTargets } from "./a11y.ts";

// The page's policy lets it talk only to itself and the service's real address; the service here is the
// test, so the policy is set aside for this file.
test.use({ bypassCSP: true });

const KEYS = "graft.manage-keys";
const A = "aaaaaaaaaaaa"; // kept first, so listed last
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";
const D = "dddddddddddd";
const SEEDED = "es1418qka9yt";

/** The service's public read of one publication, answered by id. */
function serve(page: Page, entries: Record<string, { status?: number; body?: object }>) {
  return page.route("**/v1/publications/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    const e = entries[id];
    if (!e)
      return route.fulfill({ status: 404, contentType: "application/problem+json", body: "{}" });
    return route.fulfill({
      status: e.status ?? 200,
      contentType: "application/json",
      body: JSON.stringify(e.body ?? {}),
    });
  });
}

async function keep(page: Page, ids: string[]): Promise<void> {
  await page.addInitScript(
    ([key, list]) => {
      // seeded once per tab: a reload must keep what the page itself has stored since
      if (sessionStorage.getItem("kept")) return;
      sessionStorage.setItem("kept", "1");
      localStorage.setItem(
        key!,
        JSON.stringify(Object.fromEntries(list!.map((i) => [i, "k".repeat(64)]))),
      );
    },
    [KEYS, ids] as const,
  );
}

const stored = (page: Page) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, string>,
    KEYS,
  );

test("a browser with no flips says so, and offers to make one", async ({ page }) => {
  await page.goto("/flips");
  await expect(page.getByText("no flips here yet")).toBeVisible();
  await expect(page.getByRole("link", { name: "make a flip" })).toHaveAttribute("href", "/make");
});

test("the flips are listed newest first, each with its title, how it stands and the ways to act", async ({
  page,
}) => {
  await keep(page, [A, B, C, D]);
  await serve(page, {
    [A]: { body: { state: "available", title: "first one", author: "x", fork_permitted: true } },
    [B]: { body: { state: "available", title: "second", author: "x", fork_permitted: false } },
    [C]: { body: { state: "withdrawn", title: "third", author: "x", fork_permitted: true } },
    // D is not found
  });
  await page.goto("/flips");
  const rows = page.locator(".your-flip");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("a flip"); // D: not found, so no title
  await expect(rows.nth(0)).toContainText("not found");
  await expect(rows.nth(1)).toContainText("third");
  await expect(rows.nth(1)).toContainText("withdrawn");
  await expect(rows.nth(2)).toContainText("second");
  await expect(rows.nth(2)).toContainText("closed to new flips");
  await expect(rows.nth(3)).toContainText("first one");
  await expect(rows.nth(3)).toContainText("open to new flips");
  // an open flip can be opened and managed; a withdrawn or missing one can only be managed or forgotten
  await expect(rows.nth(3).getByRole("link", { name: "open" })).toHaveAttribute("href", `/p/${A}`);
  await expect(rows.nth(3).getByRole("link", { name: "manage" })).toHaveAttribute(
    "href",
    `/manage/${A}`,
  );
  await expect(rows.nth(1).getByRole("link", { name: "open" })).toHaveCount(0);
  await expect(rows.nth(0).getByRole("link", { name: "open" })).toHaveCount(0);
});

test("anything in the kept keys that is not a publication id is never listed or asked about", async ({
  page,
}) => {
  const asked: string[] = [];
  await page.route("**/v1/publications/*", (route) => {
    asked.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 404, contentType: "application/problem+json", body: "{}" });
  });
  await keep(page, [A, "../../admin", "<script>alert(1)</script>", "short", "AAAAAAAAAAAA"]);
  await page.goto("/flips");
  await expect(page.locator(".your-flip")).toHaveCount(1);
  // the row is drawn before its read is sent: wait for the one ask, then check nothing else was
  await expect.poll(() => asked.length).toBe(1);
  expect(asked).toEqual([`/v1/publications/${A}`]);
});

test("forgetting a key asks twice, can be backed out of, and removes only that key from the browser", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && new URL(r.url()).pathname.startsWith("/v1/"))
      requests.push(`${r.method()} ${r.url()}`);
  });
  await keep(page, [A, B]);
  await serve(page, {
    [A]: { body: { state: "available", title: "first one", author: "x", fork_permitted: true } },
    [B]: { body: { state: "available", title: "second", author: "x", fork_permitted: true } },
  });
  await page.goto("/flips");
  const second = page.locator(".your-flip").filter({ hasText: "second" });
  await second.getByRole("button", { name: "forget", exact: true }).click();
  await expect(second).toContainText(
    "you will not be able to close, withdraw or change the note of this flip",
  );
  await second.getByRole("button", { name: "keep it" }).click();
  expect(Object.keys(await stored(page)).sort()).toEqual([A, B]);
  await second.getByRole("button", { name: "forget", exact: true }).click();
  await second.getByRole("button", { name: "yes, forget it" }).click();
  await expect(page.locator(".your-flip")).toHaveCount(1);
  await expect(page.getByText("forgotten.", { exact: true })).toBeVisible();
  expect(Object.keys(await stored(page))).toEqual([A]);
  expect(requests, "forgetting a key is the browser's own act: nothing is sent").toEqual([]);
});

test("when the service does not answer the page says so, and asks again by itself and on request", async ({
  page,
}) => {
  await page.clock.install();
  await keep(page, [A, B]);
  await page.route("**/v1/publications/*", (route) => route.abort());
  await page.goto("/flips");
  await expect(page.locator(".your-flip").first()).toContainText("not answering");
  await expect(page.locator(".your-flip").nth(1)).toContainText("not answering");
  // still able to manage or forget what it cannot name
  await expect(
    page.locator(".your-flip").first().getByRole("link", { name: "manage" }),
  ).toBeVisible();
  await page.unroute("**/v1/publications/*");
  await serve(page, {
    [A]: { body: { state: "available", title: "first one", author: "x", fork_permitted: true } },
    [B]: { body: { state: "available", title: "second", author: "x", fork_permitted: true } },
  });
  // by itself, a few seconds later
  await page.clock.fastForward(7_000);
  await expect(page.locator(".your-flip").first()).toContainText("second");
  await expect(page.locator(".your-flip").nth(1)).toContainText("first one");
});

test("and the try again button asks at once", async ({ page }) => {
  await page.clock.install();
  await keep(page, [A]);
  await page.route("**/v1/publications/*", (route) => route.abort());
  await page.goto("/flips");
  await expect(page.locator(".your-flip")).toContainText("not answering");
  await page.unroute("**/v1/publications/*");
  await serve(page, {
    [A]: { body: { state: "available", title: "first one", author: "x", fork_permitted: true } },
  });
  await page.getByRole("button", { name: "try again" }).click();
  await expect(page.locator(".your-flip")).toContainText("first one");
});

test("a long title wraps on its row and the page does not scroll sideways", async ({ page }) => {
  await keep(page, [A]);
  await serve(page, {
    [A]: { body: { state: "available", title: "x".repeat(60), author: "x", fork_permitted: true } },
  });
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/flips");
  await expect(page.locator(".your-flip")).toContainText("xxxx");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});

test("the footer names the list only in a browser that holds a key, and it opens the list", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await expect(page.getByRole("link", { name: "your flips" })).toHaveCount(0);
  await keep(page, [A]);
  await serve(page, {
    [A]: { body: { state: "available", title: "t", author: "x", fork_permitted: true } },
  });
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await page.getByRole("link", { name: "your flips" }).click();
  await expect(page).toHaveURL(/\/flips$/);
  await expect(page.locator(".your-flip")).toHaveCount(1);
});

test("publishing keeps the key in this browser, and unticking forgets it", async ({ page }) => {
  await page.route("**/v1/publications", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        publication: { id: B },
        manage_key: "f".repeat(64),
        preview_matches: true,
        adjusted_fields: [],
      }),
    });
  });
  await page.goto(`/make?from=${SEEDED}&cut=960-43200&speed=3/2`);
  await expect(page.locator("[data-output-hash]:not([data-output-hash=''])")).toBeVisible();
  await page.getByRole("button", { name: "publish this flip" }).click();
  await page.getByLabel(/^title/).fill("a title");
  await page.getByLabel(/^your name/).fill("a name");
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.getByRole("heading", { name: "published" })).toBeVisible();
  // kept as soon as it is shown, with the box ticked to say so
  const box = page.getByLabel(/keep this key in this browser/);
  await expect(box).toBeChecked();
  expect(await stored(page)).toEqual({ [B]: "f".repeat(64) });
  // unticking forgets it, and says to copy it now
  await box.uncheck();
  await expect(page.getByText(/forgotten\. copy the key now/)).toBeVisible();
  expect(await stored(page)).toEqual({});
  // ticking again keeps it again
  await box.check();
  expect(await stored(page)).toEqual({ [B]: "f".repeat(64) });
  await expect(page.getByRole("link", { name: "your flips" })).toHaveAttribute("href", "/flips");
});

for (const scheme of ["light", "dark"] as const) {
  test(`your flips (${scheme}): no serious accessibility violation`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await keep(page, [A, B]);
    await serve(page, {
      [A]: { body: { state: "available", title: "first one", author: "x", fork_permitted: true } },
      [B]: { body: { state: "withdrawn", title: "second", author: "x", fork_permitted: true } },
    });
    await page.goto("/flips");
    await expect(page.locator(".your-flip")).toHaveCount(2);
    await scan(page, `your flips ${scheme}`, info);
    // the forget question has its own buttons: they are controls too
    await page
      .locator(".your-flip")
      .first()
      .getByRole("button", { name: "forget", exact: true })
      .click();
    expect(await smallTargets(page), "controls under 44 px").toEqual([]);
  });
}

test("the flips page has one top heading", async ({ page }) => {
  await page.goto("/flips");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/your flips/i);
});
