// "flip this next": after a publish the main button opens the make page on the new stage in the same tab,
// from a shipped pick, from a stage named in a link and from a marked part, and it warns before leaving
// a ticket whose key is neither kept nor copied. Against the real service (scripts/service-e2e.sh).
import { expect, test, type Page } from "@playwright/test";
import { SEEDED, SEEDED_LAST, allowBucketReads, publishFlip } from "./service.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await allowBucketReads(page);
});

async function publishHere(page: Page, title: string): Promise<void> {
  await expect(page.locator("[data-output-hash]:not([data-output-hash=''])")).toBeVisible();
  await page.getByRole("button", { name: "publish this flip" }).click();
  await page.getByLabel(/^title/).fill(title);
  await page.getByLabel(/^your name/).fill("next maker");
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.getByTestId("key-stub")).toBeVisible();
}

test("from a shipped pick, flip this next opens the NEW stage in the same tab, not the old pick", async ({
  page,
}) => {
  await page.goto("/make");
  await page
    .getByRole("button", { name: /^flip this sound: /i })
    .first()
    .click();
  await publishHere(page, "first of a pair");
  const tabs = page.context().pages().length;
  const href = (await page.getByTestId("published-link").getAttribute("href"))!;
  const id = href.replace("/p/", "");
  await page.getByTestId("flip-next").click();
  await expect(page).toHaveURL(new RegExp(`/make\\?from=${id}$`));
  await expect(page.locator(".stage-head .slab-text")).toHaveCount(0); // a live stage has no shipped title
  await expect(page.locator("[data-output-hash]:not([data-output-hash=''])")).toBeVisible();
  expect(page.context().pages().length).toBe(tabs);
  // and the new editor can publish again: a second flip, a chain of two of the maker's own
  await publishHere(page, "second of a pair");
  const next = (await page.getByTestId("published-link").getAttribute("href"))!;
  expect(next).not.toBe(href);
});

test("from a stage named in a link, flip this next moves on to the new stage", async ({
  page,
  request,
}) => {
  const parent = (await publishFlip(request, SEEDED_LAST, "parent for flip next")).id;
  await page.goto(`/make?from=${parent}&cut=0-12000&speed=3/2`);
  await publishHere(page, "from a link");
  const id = (await page.getByTestId("published-link").getAttribute("href"))!.replace("/p/", "");
  await page.getByTestId("flip-next").click();
  await expect(page).toHaveURL(new RegExp(`/make\\?from=${id}$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp("/make"));
  await expect(page.getByTestId("make")).toBeVisible();
});

test("from a part marked on the roll, flip this next works the same", async ({ page }) => {
  await page.goto(`/make?from=${SEEDED[1]}&cut=0-12000&speed=3/2`);
  await publishHere(page, "from a marked part");
  const id = (await page.getByTestId("published-link").getAttribute("href"))!.replace("/p/", "");
  await page.getByTestId("flip-next").click();
  await expect(page).toHaveURL(new RegExp(`/make\\?from=${id}$`));
});

test("a ticket that is neither kept nor copied warns once before the page is left", async ({
  page,
}) => {
  await page.goto(`/make?from=${SEEDED[1]}&cut=0-12000&speed=3/2`);
  await publishHere(page, "unkept ticket");
  await page.getByLabel(/keep this key in this browser/).uncheck();
  await page.getByTestId("flip-next").click();
  await expect(page.getByText(/not kept in this browser and not copied/)).toBeVisible();
  await expect(page).toHaveURL(/\/make\?from=[0-9a-z]{12}&/); // still here (the cut and speed are in the link)
  await page.getByTestId("flip-next").click();
  await expect(page).toHaveURL(/\/make\?from=[0-9a-z]{12}$/);
});

test("the old new-tab link and the manage link stay beside it", async ({ page }) => {
  await page.goto(`/make?from=${SEEDED[1]}&cut=0-12000&speed=3/2`);
  await publishHere(page, "links stay");
  await expect(page.getByRole("link", { name: "open it in a new tab" })).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(page.getByRole("link", { name: "manage this publication" })).toBeVisible();
  await expect(page.getByRole("link", { name: "your flips" })).toBeVisible();
});
