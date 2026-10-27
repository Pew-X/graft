// The thread: a patch cable from the stage in view to its ring on the record, carrying that stage's
// trace. Each test names the guarantee it protects. Driven in real Chromium against the built site.
import { expect, test, type Page } from "@playwright/test";
import { bandOuter, layout } from "../lib/record/disc.ts";

const roll = (page: Page) => page.locator(".roll");
const thread = (page: Page) => page.getByTestId("thread");

async function arrive(page: Page): Promise<void> {
  await page.goto("/");
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
  await expect(thread(page)).toHaveAttribute("data-shown", "true");
}

/** The cable's two plugs as drawn, and the trace face it should start at. */
const plugs = (page: Page) =>
  page.evaluate(() => {
    const [a, b] = [...document.querySelectorAll(".thread circle")].map((c) => ({
      x: Number(c.getAttribute("cx")),
      y: Number(c.getAttribute("cy")),
    }));
    const face = document
      .querySelector('.block[data-hero="true"] .trace-face')!
      .getBoundingClientRect();
    return { a: a!, b: b!, face: { right: face.right, mid: face.top + face.height / 2 } };
  });

for (const size of [
  { name: "13-inch laptop", width: 1280, height: 720 },
  { name: "large laptop", width: 1440, height: 900 },
]) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("the cable leaves the stage's trace and lands inside that stage's ring", async ({
      page,
    }) => {
      await arrive(page);
      const { a, b, face } = await plugs(page);
      expect(Math.abs(a.x - face.right)).toBeLessThan(2);
      expect(Math.abs(a.y - face.mid)).toBeLessThan(2);
      const hero = Number(await roll(page).getAttribute("data-hero"));
      const l = layout(size.width, size.height, 4);
      const r = Math.hypot(b.x - l.cx, b.y - l.cy);
      expect(r).toBeLessThanOrEqual(bandOuter(l, hero));
      expect(r).toBeGreaterThanOrEqual(bandOuter(l, hero) - l.slotW);
    });

    test("it follows the stage in view when that changes", async ({ page }) => {
      await arrive(page);
      const before = await plugs(page);
      const d = await page.locator(".thread .beam").getAttribute("d");
      // focusing another stage's title brings that stage into view
      await page.locator(".block").nth(2).locator(".slab button").focus();
      await expect(roll(page)).toHaveAttribute("data-hero", "2");
      await expect
        .poll(async () => (await plugs(page)).b.x, { timeout: 5_000 })
        .not.toBeCloseTo(before.b.x, 0);
      const after = await plugs(page);
      expect(after.b.x).toBeLessThan(before.b.x); // an outer ring is further from the record's centre, so further left
      expect(await page.locator(".thread .beam").getAttribute("d")).not.toBe(d);
      await expect
        .poll(async () => {
          const p = await plugs(page);
          return Math.abs(p.a.x - p.face.right) + Math.abs(p.a.y - p.face.mid);
        })
        .toBeLessThan(3);
    });

    test("words are drawn over it and it takes no press", async ({ page }) => {
      await arrive(page);
      const info = await page.evaluate(() => {
        const t = document.querySelector(".thread")!;
        const v = document.querySelector(".viewport")!;
        return {
          before: Boolean(t.compareDocumentPosition(v) & Node.DOCUMENT_POSITION_FOLLOWING),
          z: [getComputedStyle(t).zIndex, getComputedStyle(v).zIndex],
          events: getComputedStyle(t).pointerEvents,
          hidden: t.getAttribute("aria-hidden"),
        };
      });
      expect(info).toEqual({ before: true, z: ["2", "2"], events: "none", hidden: "true" });
    });

    test("a pulse runs along it only while something sounds", async ({ page }) => {
      await arrive(page);
      const pulse = page.locator(".thread .pulse");
      await expect(pulse).toHaveCSS("opacity", "0");
      await page.getByRole("button", { name: "play", exact: true }).click();
      await expect(roll(page)).toHaveAttribute("data-sounding", "true");
      await expect(pulse).toHaveCSS("opacity", "1");
      await expect(pulse).toHaveCSS("animation-name", "thread-run");
    });
  });
}

test.describe("reduced motion", () => {
  test.use({ viewport: { width: 1280, height: 720 }, reducedMotion: "reduce" });
  test("nothing runs along the cable", async ({ page }) => {
    await arrive(page);
    await page.getByRole("button", { name: "play all", exact: true }).click();
    await expect(page.locator(".thread .pulse")).toHaveCSS("opacity", "0");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("there is no cable where the record is under the words", async ({ page }) => {
    await page.goto("/");
    await expect(roll(page)).toHaveAttribute("data-audio", "ready");
    await expect(thread(page)).toHaveAttribute("data-shown", "false");
    await expect(thread(page)).toBeHidden();
  });
});
