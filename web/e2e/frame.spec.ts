// The pages around the roll wear the same frame as the rest of the site: a tab icon, a way home, and
// an empty state that is laid out like a page. Each test names the guarantee it protects. Driven in
// real Chromium against the built site (no service is needed: a missing chain is a quiet 404).
import { expect, test } from "@playwright/test";

test("the site has a tab icon that can be fetched, so no page logs a missing-file error", async ({
  page,
}) => {
  const failed: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().endsWith(".svg")) failed.push(r.url());
  });
  await page.goto("/make");
  const href = await page.locator('link[rel~="icon"]').first().getAttribute("href");
  expect(href).toContain("/icon.svg");
  const icon = await page.request.get(href!);
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toContain("image/svg+xml");
  expect(failed).toEqual([]);
});

test("a mistyped link is a framed page with the way home, not text flush against the edge", async ({
  page,
}) => {
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  const back = page.getByRole("link", { name: "← graft" });
  await expect(back).toBeVisible();
  const heading = page.getByRole("heading", { name: "nothing here" });
  await expect(heading).toBeVisible();
  const [backBox, headingBox] = await Promise.all([back.boundingBox(), heading.boundingBox()]);
  expect(backBox!.x).toBeGreaterThan(8);
  expect(Math.abs(backBox!.x - headingBox!.x)).toBeLessThan(8);
  const roll = page.getByRole("link", { name: "go to the first roll" });
  expect((await roll.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("the manage page has a way home", async ({ page }) => {
  await page.goto("/manage/anything");
  const back = page.getByRole("link", { name: "← graft" });
  await expect(back).toBeVisible();
  expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await back.click();
  await expect(page).toHaveURL(/\/$/);
});
