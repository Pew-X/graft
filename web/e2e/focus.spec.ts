// Where the keyboard's focus shows on the record. The canvas fills the screen, so a normal outline
// frames the whole page in neon green (a hard green line along an edge on a tall page); the mark is a
// ring on the stylus instead. Each test names the guarantee it protects. Driven in real Chromium.
import { expect, test, type Page } from "@playwright/test";

const slider = (page: Page) => page.getByRole("slider", { name: "the record" });

/** How many pixels of the focus ring's own green the record shows, and how many sit on the screen's edge. */
const ring = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".record canvas")!;
    const { width, height } = c;
    const d = c.getContext("2d")!.getImageData(0, 0, width, height).data;
    let all = 0;
    let edge = 0;
    for (let i = 0; i < d.length; i += 4) {
      // the ring is #5dff9c, painted solid, so it has exactly this colour
      if (Math.abs(d[i]! - 93) < 4 && d[i + 1]! > 250 && Math.abs(d[i + 2]! - 156) < 4) {
        all++;
        const p = i / 4;
        const x = p % width;
        const y = Math.floor(p / width);
        if (x < 8 || y < 8 || x > width - 9 || y > height - 9) edge++;
      }
    }
    return { all, edge };
  });

for (const size of [
  { name: "phone", width: 390, height: 844 },
  { name: "tall phone", width: 390, height: 1200 },
  { name: "laptop", width: 1280, height: 720 },
]) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("focusing the record draws no outline round the screen, only a ring on the stylus", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
      await page.waitForTimeout(900);
      const before = await ring(page);
      await page.keyboard.press("Tab"); // keyboard focus, so the focus is a visible one
      await slider(page).focus();
      await page.waitForTimeout(300);
      await expect(slider(page)).toBeFocused();
      expect(await slider(page).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
      const after = await ring(page);
      // a ring about 20 px in radius and 3 px thick is some hundred pixels of its own green
      expect(after.all - before.all).toBeGreaterThan(100);
      expect(after.edge).toBe(0);
    });

    test("the ring goes when the focus does", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
      await page.waitForTimeout(900);
      const before = await ring(page);
      await page.keyboard.press("Tab");
      await slider(page).focus();
      await page.waitForTimeout(300);
      await slider(page).blur();
      await page.waitForTimeout(300);
      const after = await ring(page);
      expect(after.all).toBeLessThan(before.all + 10);
    });
  });
}
