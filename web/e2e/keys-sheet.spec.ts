// The keys sheet: every keyboard control of a page in words, in a dialog built like the report dialog.
// A visible button opens it (not a character shortcut), focus stays inside, Escape closes it and focus
// goes back to the button. One sheet for each kind of page. Driven in real Chromium over the built site.
import { expect, test, type Page } from "@playwright/test";
import { scan } from "./a11y.ts";

const keysButton = (page: Page) => page.getByRole("button", { name: "keys", exact: true });
const sheet = (page: Page) => page.getByRole("dialog", { name: "keys" });

async function roll(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
}

test("the roll's keys sheet opens by button, lists the record, perform and the pads, and closes on escape", async ({
  page,
}) => {
  await roll(page);
  await keysButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole("heading", { name: "the roll" })).toBeVisible();
  await expect(sheet(page).getByRole("heading", { name: "perform" })).toBeVisible();
  // the number row, the pads as the way for screen readers, escape, and the two needles in one line
  await expect(sheet(page)).toContainText("1 2 3 4 5 6 7 8 9 0 - =");
  await expect(sheet(page)).toContainText("a screen reader keeps the digit keys for itself");
  await expect(sheet(page)).toContainText("no key reaches");
  await expect(sheet(page)).toContainText("the dashed ring shows where the sound is");
  await expect(sheet(page)).toContainText("the needle follows your pointer");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(keysButton(page)).toBeFocused();
});

test("focus stays in the sheet: tab never reaches a control of the page behind it", async ({
  page,
}) => {
  await roll(page);
  await keysButton(page).click();
  await expect(sheet(page)).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    // with one control in the sheet, tab may leave to the browser's own chrome (focus is then on nothing
    // in the page); it is never on a control of the page that the sheet covers
    const where = await page.evaluate(() => {
      const el = document.activeElement;
      return el === document.body || el === null ? "none" : el.closest("dialog") ? "sheet" : "page";
    });
    expect(where, `tab ${i + 1}`).not.toBe("page");
  }
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(keysButton(page)).toBeFocused();
});

test("the sheet opens at its top, with the close button first, and a click on close returns focus", async ({
  page,
}) => {
  await roll(page);
  await keysButton(page).click();
  await expect(sheet(page).getByRole("button", { name: "close" })).toBeFocused();
  const top = await sheet(page).evaluate((d) => d.scrollTop);
  expect(top).toBe(0);
  await sheet(page).getByRole("button", { name: "close" }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(keysButton(page)).toBeFocused();
});

test("perform's keys are not on while the sheet is open", async ({ page }) => {
  await roll(page);
  await page.getByRole("button", { name: "perform", exact: true }).click();
  await keysButton(page).click();
  await expect(sheet(page)).toBeVisible();
  // escape belongs to the dialog first: perform stays on
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator(".roll")).toHaveAttribute("data-perform", "true");
});

test("the make page has its own sheet, about the brackets and the speed", async ({ page }) => {
  await page.goto("/make");
  await keysButton(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole("heading", { name: "making a flip" })).toBeVisible();
  await expect(sheet(page)).toContainText("move it one millisecond. with shift, ten.");
  await expect(sheet(page)).toContainText("change the speed, and the sound with it, at once");
  await expect(sheet(page)).not.toContainText("perform");
  await page.keyboard.press("Escape");
  await expect(keysButton(page)).toBeFocused();
});

for (const scheme of ["light", "dark"] as const) {
  test(`the open sheet has no serious accessibility violation in ${scheme} (laptop and phone)`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const size of [
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await roll(page);
      await keysButton(page).click();
      await expect(sheet(page)).toBeVisible();
      await scan(page, `keys sheet ${scheme} ${size.width}`, info);
      await page.screenshot({ path: info.outputPath(`keys-${scheme}-${size.width}.png`) });
      // the dialog fits the window: it scrolls inside itself, the page does not scroll sideways
      const fit = await page.evaluate(() => {
        const r = document.querySelector("dialog[open]")!.getBoundingClientRect();
        return {
          inside: r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
          sideways: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      expect(fit.inside).toBe(true);
      expect(fit.sideways).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");
    }
  });
}
