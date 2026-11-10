// The make page's picker offers the maker's own flips (the ones this browser holds a manage key for) as a
// second section, and the pad rule says in words what it does. The service is answered by the test, so
// what is checked is the page: what is listed, in what order, what cannot be chosen and why, and that a
// hostile title holds the layout. Each test names the guarantee it protects.
import { expect, test, type Page } from "@playwright/test";
import { scan } from "./a11y.ts";

test.use({ bypassCSP: true });

const KEYS = "graft.manage-keys";
const A = "aaaaaaaaaaaa"; // kept first, so listed last
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";
const D = "dddddddddddd";

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

const open = (title: string, author = "a maker") => ({
  body: { state: "available", title, author, fork_permitted: true },
});

test("a browser that holds no keys shows no section for its own flips", async ({ page }) => {
  await page.goto("/make");
  await expect(page.getByRole("heading", { name: "pick a sound to start from" })).toBeVisible();
  await expect(page.getByTestId("pick-own")).toHaveCount(0);
  await expect(page.getByText("your flips", { exact: true })).toHaveCount(0);
});

test("storage that throws shows no section and no error", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("blocked");
      },
    });
  });
  await page.goto("/make");
  await expect(page.getByRole("heading", { name: "pick a sound to start from" })).toBeVisible();
  await expect(page.getByTestId("pick-own")).toHaveCount(0);
});

test("own flips come after the shipped ones, newest first, and only an open one can be chosen", async ({
  page,
}) => {
  await keep(page, [A, B, C, D]);
  await serve(page, {
    [A]: open("first one"),
    [B]: { body: { state: "no_longer_here", title: "pulled", author: "x", fork_permitted: true } },
    [C]: { body: { state: "available", title: "shut", author: "x", fork_permitted: false } },
    // D is not found
  });
  await page.goto("/make");
  const section = page.getByTestId("pick-own");
  await expect(section).toBeVisible();
  // after the shipped sections, not before
  const order = await page.evaluate(() => {
    const own = document.querySelector('[data-testid="pick-own"]')!;
    const curated = document.querySelector("#pick-curated")!;
    return curated.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING;
  });
  expect(order).toBeTruthy();
  const rows = section.locator(".own-flip");
  await expect(rows).toHaveCount(4);
  // newest kept first: D, C, B, A
  await expect(rows.nth(0)).toHaveAttribute("data-state", "missing");
  await expect(rows.nth(1)).toHaveAttribute("data-state", "closed");
  await expect(rows.nth(2)).toHaveAttribute("data-state", "withdrawn");
  await expect(rows.nth(3)).toHaveAttribute("data-state", "open");
  await expect(rows.nth(1)).toContainText("closed to new flips");
  await expect(rows.nth(2)).toContainText("withdrawn");
  await expect(rows.nth(0)).toContainText("not found");
  for (const i of [0, 1, 2]) await expect(rows.nth(i).getByRole("button")).toBeDisabled();
  await expect(rows.nth(3).getByRole("button")).toBeEnabled();
});

test("choosing one of your flips opens the editor on that stage in this tab", async ({ page }) => {
  await keep(page, [A]);
  await serve(page, { [A]: open("first one") });
  await page.goto("/make");
  const tabs = page.context().pages().length;
  await page.getByRole("button", { name: "flip this sound: first one" }).click();
  await expect(page).toHaveURL(new RegExp(`/make\\?from=${A}$`));
  expect(page.context().pages().length).toBe(tabs);
});

test("while the service is asleep a row says it is checking and fills in by itself", async ({
  page,
}) => {
  await page.clock.install();
  await keep(page, [A]);
  await page.route("**/v1/publications/*", (route) => route.abort());
  await page.goto("/make");
  const row = page.locator(".own-flip");
  await expect(row).toContainText("not answering");
  await expect(row.getByRole("button")).toBeDisabled();
  await page.unroute("**/v1/publications/*");
  await serve(page, { [A]: open("woke up") });
  await page.clock.fastForward(7_000);
  await expect(row).toContainText("woke up");
  await expect(row.getByRole("button")).toBeEnabled();
});

test("more than twenty kept keys list the newest twenty and say how many are older", async ({
  page,
}) => {
  const ids = Array.from({ length: 23 }, (_, i) => `a${String(i).padStart(11, "0")}`);
  await keep(page, ids);
  const entries: Record<string, { body: object }> = {};
  for (const id of ids) entries[id] = open(`flip ${id.slice(-2)}`);
  await serve(page, entries);
  await page.goto("/make");
  await expect(page.locator(".own-flip")).toHaveCount(20);
  await expect(page.getByText("3 older flips are also kept in this browser.")).toBeVisible();
});

test("anything in the kept keys that is not an id is never listed or asked about", async ({
  page,
}) => {
  await keep(page, [A, "../../etc/passwd", "short"]);
  const asked: string[] = [];
  await page.route("**/v1/publications/*", (route) => {
    asked.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(open("only one").body),
    });
  });
  await page.goto("/make");
  await expect(page.locator(".own-flip")).toHaveCount(1);
  // the row exists before its read is answered: wait for the answer, then look at what was asked
  await expect(page.locator(".own-flip")).toContainText("only one");
  expect(asked).toEqual([`/v1/publications/${A}`]);
});

test("a hostile title holds the row and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await keep(page, [A, B]);
  await serve(page, {
    [A]: open("x".repeat(60), "N".repeat(32)),
    [B]: open("😀".repeat(30), "مرحبا بالعالم hello שלום"),
  });
  await page.goto("/make");
  await expect(page.locator(".own-flip")).toHaveCount(2);
  const over = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    rows: Math.max(
      0,
      ...[...document.querySelectorAll<HTMLElement>(".own-flip button")].map(
        (b) => b.scrollWidth - b.clientWidth,
      ),
    ),
  }));
  expect(over.page).toBeLessThanOrEqual(0);
  expect(over.rows).toBeLessThanOrEqual(0);
});

test("the picker with its own flips has no serious accessibility violation", async ({
  page,
}, info) => {
  await keep(page, [A, B]);
  await serve(page, { [A]: open("first one"), [B]: open("second") });
  await page.goto("/make");
  await expect(page.locator(".own-flip")).toHaveCount(2);
  await scan(page, "make picker with own flips", info);
});
