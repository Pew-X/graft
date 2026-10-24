// Marking a part of a stage on the record, to flip just that part. The record is a canvas, so points on
// it come from the same layout the page paints with. Each test names the guarantee it protects. Driven
// in real Chromium against the built site; nothing is published (the make page is only opened).
import { expect, test, type Page } from "@playwright/test";
import { scan } from "./a11y.ts";
import { pointOn } from "./disc.ts";

test.use({ viewport: { width: 1280, height: 800 } });

const slider = (page: Page) => page.getByRole("slider", { name: "the record" });
const toggle = (page: Page) => page.getByRole("button", { name: /cut on the record|stop cutting/ });
const bar = (page: Page) => page.getByRole("group", { name: "cut on the record" });

async function arrive(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await page.waitForTimeout(900);
}

/** Drag along the stage in view (the last of the four) from one place in it to another. */
async function dragAlong(page: Page, from: number, to: number): Promise<void> {
  const a = await pointOn(page, 4, 3, from);
  const b = await pointOn(page, 4, 3, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

test("the way to mark a part is a visible button on the stage, and it says what it does", async ({
  page,
}) => {
  await arrive(page);
  await expect(toggle(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(toggle(page)).toHaveText("stop cutting");
  await expect(page.getByRole("status").filter({ hasText: "drag along a ring" })).toBeVisible();
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
});

test("dragging along a ring marks a part, and flipping it opens the make page with that cut set", async ({
  page,
}) => {
  await arrive(page);
  await toggle(page).click();
  await dragAlong(page, 0.25, 0.75);
  await expect(bar(page)).toBeVisible();
  const label = await bar(page).getByRole("button").first().innerText();
  const seconds = Number(label.match(/(\d+\.\d+) s/)![1]);
  expect(seconds, "about half the stage, since the drag covered half of it").toBeGreaterThan(0.3);
  await bar(page)
    .getByRole("button", { name: /flip this part/ })
    .click();
  await page.waitForURL(/\/make\?from=.*&cut=\d+-\d+/);
  const url = new URL(page.url());
  const [start, end] = url.searchParams.get("cut")!.split("-").map(Number) as [number, number];
  expect(url.searchParams.get("from"), "the stage that was marked").toBeTruthy();
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect((end - start) / 48_000, "the cut is the length that was shown").toBeCloseTo(seconds, 1);
  // the make page reads it as it would any cut, and shows the same range
  await expect(page.getByTestId("cut-readout")).toHaveText(
    `${(start / 48_000).toFixed(3)} to ${(end / 48_000).toFixed(3)} seconds, ${((end - start) / 48_000).toFixed(3)} kept`,
  );
});

test("a tap is not a part: nothing is offered until something real is marked", async ({ page }) => {
  await arrive(page);
  await toggle(page).click();
  const p = await pointOn(page, 4, 3, 0.5);
  await page.mouse.click(p.x, p.y);
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "drag along a ring" })).toBeVisible();
});

test("without the button a drag still only scrubs: no part is marked", async ({ page }) => {
  await arrive(page);
  await dragAlong(page, 0.25, 0.75);
  await expect(bar(page)).toHaveCount(0);
});

test("on a keyboard, [ and ] at the cursor mark a part, and escape clears it", async ({ page }) => {
  await arrive(page);
  await toggle(page).click();
  await slider(page).focus();
  await page.keyboard.press("[");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("]");
  await expect(bar(page)).toBeVisible();
  await expect(bar(page)).toContainText("0.50 s");
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
});

test("clear takes the mark away and stays in marking", async ({ page }) => {
  await arrive(page);
  await toggle(page).click();
  await dragAlong(page, 0.2, 0.8);
  await bar(page).getByRole("button", { name: "clear" }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
});

test("flipping the whole stage still opens the make page with no cut", async ({ page }) => {
  await arrive(page);
  await page.locator('.block[data-hero="true"] .flip.primary').click();
  await page.waitForURL(/\/make\?from=[^&]+$/);
  expect(new URL(page.url()).searchParams.has("cut")).toBe(false);
});

test("with a part marked the page has no serious accessibility violation", async ({
  page,
}, info) => {
  await arrive(page);
  await toggle(page).click();
  await dragAlong(page, 0.25, 0.75);
  await expect(bar(page)).toBeVisible();
  await scan(page, "roll with a marked part", info);
});
