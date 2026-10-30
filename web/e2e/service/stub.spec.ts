// The ticket's stub on the publish success screen, against the real service (scripts/service-e2e.sh):
// copying the key tears the stub from the ticket (a state, said in words too), "kept in this browser" is a
// hole punched in the paper, reduced motion gets the same end state without the movement, and no picture
// of the stub ever holds the key.
import { expect, test, type Page } from "@playwright/test";
import { SEEDED_LAST, allowBucketReads, publishFlip } from "./service.ts";

test.beforeEach(async ({ page }) => {
  await allowBucketReads(page);
});

async function published(page: Page, request: Parameters<typeof publishFlip>[0]): Promise<void> {
  const parent = (await publishFlip(request, SEEDED_LAST, "parent for a stub test")).id;
  await page.goto(`/make?from=${parent}&cut=0-12000&speed=3/2`);
  await expect(page.locator("[data-output-hash]:not([data-output-hash=''])")).toBeVisible();
  await page.getByRole("button", { name: "publish this flip" }).click();
  await page.getByLabel(/^title/).fill("a flip with a stub");
  await page.getByLabel(/^your name/).fill("stub maker");
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.getByTestId("key-stub")).toBeVisible();
}

test("copying the key tears the stub away, in words and in paper; the copy is the exact key", async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await published(page, request);
  const stub = page.getByTestId("key-stub");
  const key = await page.getByTestId("manage-key").innerText();
  await expect(stub).toHaveAttribute("data-torn", "no");
  // the key is plain text, selectable, and not part of any picture
  expect(await page.getByTestId("trace").evaluate((el) => el.outerHTML)).not.toContain(
    key.slice(0, 16),
  );
  await page.getByRole("button", { name: "copy the key" }).click();
  await expect(stub).toHaveAttribute("data-torn", "yes");
  await expect(page.getByText("key copied.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
  expect(await page.getByTestId("manage-key").innerText()).toBe(key);
  // the lower piece has moved off the perforation
  const moved = await stub.locator(".stub-body").evaluate((el) => getComputedStyle(el).transform);
  expect(moved).not.toBe("none");
});

test("kept in this browser is a punched hole, and un-keeping fills it", async ({
  page,
  request,
}) => {
  await published(page, request);
  const hole = page.locator(".stub-punch .hole");
  await expect(hole).toHaveAttribute("data-punched", "true");
  await expect(page.getByText("kept in this browser.")).toBeVisible();
  await page.getByLabel(/keep this key in this browser/).uncheck();
  await expect(hole).toHaveAttribute("data-punched", "false");
  await expect(page.getByText(/^forgotten\./)).toBeVisible();
  await page.getByLabel(/keep this key in this browser/).check();
  await expect(hole).toHaveAttribute("data-punched", "true");
});

test("reduced motion: the same torn state, with no animation", async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await published(page, request);
  await page.getByRole("button", { name: "copy the key" }).click();
  const stub = page.getByTestId("key-stub");
  await expect(stub).toHaveAttribute("data-torn", "yes");
  const style = await stub.locator(".stub-body").evaluate((el) => ({
    t: getComputedStyle(el).transitionDuration,
    a: getComputedStyle(el).animationName,
  }));
  expect(style.t.split(",").every((d) => parseFloat(d) === 0)).toBe(true);
  expect(style.a).toBe("none");
});
