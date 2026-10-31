// "flips of this stage": the list under a stage on a chain page, against the real service. Publish three
// flips of one stage, open the stage, see three, open one; withdrawn ones are not listed; a service that does
// not answer is said once and asked again; hostile titles hold the layout. Each test names what it protects.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { scan } from "../a11y.ts";
import { API, ADMIN, SEEDED_LAST, allowBucketReads, hide, publishFlip } from "./service.ts";

test.beforeEach(async ({ page }) => {
  await allowBucketReads(page);
});

const toggle = (page: Page) => page.getByRole("button", { name: /^flips of this stage \(\d+\)/ });

async function stageWith(request: APIRequestContext, titles: string[]): Promise<string> {
  const parent = (await publishFlip(request, SEEDED_LAST, "parent of the set")).id;
  for (const title of titles) await publishFlip(request, parent, title);
  return parent;
}

test("three flips of a stage: the stage shows three, the list opens, and one opens that flip", async ({
  page,
  request,
}) => {
  const parent = await stageWith(request, ["first try", "second try", "third try"]);
  await page.goto(`/p/${parent}`);
  await expect(toggle(page)).toHaveText(/flips of this stage \(3\)/);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await toggle(page).click();
  const items = page.locator(".flips-of-item");
  await expect(items).toHaveCount(3);
  // newest first
  await expect(items.nth(0).locator(".flips-of-title")).toHaveText("third try");
  await expect(items.nth(2).locator(".flips-of-title")).toHaveText("first try");
  await expect(items.nth(0).locator(".flips-of-by")).toHaveText("by test maker");
  // computed facts only: the speed's interval, the length in seconds, the age
  await expect(items.nth(0).locator(".flips-of-facts")).toHaveText(
    /^same pitch, 0\.5 s, (just now|\d+ minutes? ago)$/,
  );
  await items.nth(1).locator(".flips-of-title").click();
  await expect(page).toHaveURL(/\/p\/[0-9a-z]{12}$/);
  await expect(page).not.toHaveURL(new RegExp(parent));
  // the opened flip has none of its own: no empty heading
  await expect(page.locator(".roll")).toBeVisible();
  await expect(page.getByTestId("flips-of")).toHaveCount(0);
});

test("a stage with no flips shows nothing, not an empty heading", async ({ page, request }) => {
  const lone = (await publishFlip(request, SEEDED_LAST, "lone")).id;
  await page.goto(`/p/${lone}`);
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await expect(page.getByTestId("flips-of")).toHaveCount(0);
  await expect(page.getByText(/flips of this stage/)).toHaveCount(0);
});

test("a withdrawn flip is not listed, and the count says so", async ({ page, request }) => {
  const parent = await stageWith(request, ["stays", "goes"]);
  const flips = (await (await request.get(`${API}/v1/publications/${parent}/flips`)).json()) as {
    flips: Array<{ id: string; title: string }>;
  };
  const goes = flips.flips.find((f) => f.title === "goes")!;
  await hide(request, goes.id, "withdrawn");
  await page.goto(`/p/${parent}`);
  await expect(toggle(page)).toHaveText(/\(1\)/);
  await toggle(page).click();
  await expect(page.locator(".flips-of-item")).toHaveCount(1);
  await expect(page.locator(".flips-of-title")).toHaveText("stays");
});

test("more than one page: show more adds the rest in order, and a failed second page keeps the first", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const titles = Array.from({ length: 26 }, (_, i) => `try ${String(i + 1).padStart(2, "0")}`);
  const parent = await stageWith(request, titles);
  await page.goto(`/p/${parent}`);
  await expect(toggle(page)).toHaveText(/\(26\)/);
  await toggle(page).click();
  await expect(page.locator(".flips-of-item")).toHaveCount(24);
  // the second page fails: the first stays, and the failure is said
  await page.route("**/flips?*cursor=*", (route) => route.abort());
  await page.getByRole("button", { name: "show more" }).click();
  await expect(page.getByText(/the next flips could not be read/)).toBeVisible();
  await expect(page.locator(".flips-of-item")).toHaveCount(24);
  await page.unroute("**/flips?*cursor=*");
  await page.getByRole("button", { name: "try again" }).click();
  await expect(page.locator(".flips-of-item")).toHaveCount(26);
  await expect(page.getByRole("button", { name: "show more" })).toHaveCount(0);
  const titlesShown = await page.locator(".flips-of-title").allInnerTexts();
  expect(titlesShown).toEqual([...titles].reverse());
});

test("a service that does not answer is said once and asked again by itself", async ({
  page,
  request,
}) => {
  const parent = await stageWith(request, ["after the wait"]);
  await page.clock.install();
  await page.route("**/flips?*", (route) => route.abort());
  await page.goto(`/p/${parent}`);
  await expect(page.getByText(/could not be read. the service may be waking up/)).toBeVisible();
  await page.unroute("**/flips?*");
  await page.clock.fastForward(7_000);
  await expect(toggle(page)).toHaveText(/\(1\)/);
});

test("hostile titles and names hold the list at laptop and phone width", async ({
  page,
  request,
}) => {
  const parent = (await publishFlip(request, SEEDED_LAST, "parent hostile")).id;
  for (const title of ["x".repeat(60), "W".repeat(60), "你好世界你好世界你好世界你好世界你好世界"])
    await publishFlip(request, parent, title);
  for (const [w, h] of [
    [1280, 800],
    [360, 640],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/p/${parent}`);
    await toggle(page).click();
    await expect(page.locator(".flips-of-item")).toHaveCount(3);
    const over = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - window.innerWidth,
      item: Math.max(
        0,
        ...[...document.querySelectorAll<HTMLElement>(".flips-of-item")].map(
          (i) => i.scrollWidth - i.clientWidth,
        ),
      ),
    }));
    expect(over.page, `page at ${w}`).toBeLessThanOrEqual(0);
    expect(over.item, `item at ${w}`).toBeLessThanOrEqual(0);
  }
});

test("the response carries nothing private, and the page with the list open has no serious accessibility violation", async ({
  page,
  request,
}, info) => {
  const parent = await stageWith(request, ["one", "two"]);
  const raw = await (await request.get(`${API}/v1/publications/${parent}/flips`)).text();
  for (const word of ["manage", "hash", "retry", "audio", "url"])
    expect(raw, `the list never says ${word}`).not.toContain(word);
  await page.goto(`/p/${parent}`);
  await toggle(page).click();
  await expect(page.locator(".flips-of-item")).toHaveCount(2);
  await scan(page, "chain page with the flips list open", info);
  void ADMIN;
});
