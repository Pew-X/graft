// The thread: a patch cable from the stage in view to its ring on the record, carrying that stage's
// trace. It exists only while that stage sounds, in the stage's own colour, and so does the tile's and the
// lit groove's colour; at rest it is gone and the tile is green. Each test names the guarantee it protects.
// Driven in real Chromium against the built site.
import { expect, test, type Page } from "@playwright/test";
import { bandOuter, layout } from "../lib/record/disc.ts";
import { dyes } from "../lib/theme/tokens.ts";

const GREEN = "rgb(93, 255, 156)";
const rgb = (hex: string): string =>
  `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
const strokeOf = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).stroke);
/** The colour the stage in view should have while it sounds, read from the page's own marker. */
const liveColour = async (page: Page): Promise<string> => {
  const dye = Number(await roll(page).getAttribute("data-live"));
  return rgb(dyes[dye]!.fill);
};

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

    test("at rest there is no cable and the tile is green", async ({ page }) => {
      await arrive(page);
      await expect(thread(page)).toHaveAttribute("data-on", "false");
      await expect(thread(page)).toHaveCSS("opacity", "0");
      await expect(roll(page)).not.toHaveAttribute("data-live", /.*/);
      expect(await strokeOf(page, '.block[data-hero="true"] .trace-face .beam')).toBe(GREEN);
    });

    test("while the stage sounds, the cable, the tile and the lit groove take that stage's colour, and it is thin", async ({
      page,
    }) => {
      await arrive(page);
      await page.getByRole("button", { name: "play", exact: true }).click();
      await expect(roll(page)).toHaveAttribute("data-live", /[0-3]/);
      const want = await liveColour(page);
      await expect(thread(page)).toHaveAttribute("data-on", "true");
      await expect(thread(page)).toHaveCSS("opacity", "1");
      await expect.poll(() => strokeOf(page, ".thread .beam")).toBe(want);
      await expect
        .poll(() => strokeOf(page, '.block[data-hero="true"] .trace-face .beam'))
        .toBe(want);
      // thin: a hairline, never the old 7 px glow
      const width = await page
        .locator(".thread .beam")
        .evaluate((el) => parseFloat(getComputedStyle(el).strokeWidth));
      expect(width).toBeGreaterThan(0.9);
      expect(width).toBeLessThan(2.4);
      expect(await page.locator(".thread .glow, .thread .under").count()).toBe(0);
    });

    test("after a pause the cable is gone and the tile is green again", async ({ page }) => {
      await arrive(page);
      await page.getByRole("button", { name: "play", exact: true }).click();
      await expect(thread(page)).toHaveAttribute("data-on", "true");
      await page.getByRole("button", { name: "pause", exact: true }).click();
      await expect(roll(page)).toHaveAttribute("data-sounding", "false");
      await expect(thread(page)).toHaveAttribute("data-on", "false");
      await expect(thread(page)).toHaveCSS("opacity", "0");
      await expect
        .poll(() => strokeOf(page, '.block[data-hero="true"] .trace-face .beam'))
        .toBe(GREEN);
      await expect(roll(page)).not.toHaveAttribute("data-live", /.*/);
    });

    test("a sound that is not the stage on screen makes nothing live", async ({ page }) => {
      await arrive(page);
      await page.getByRole("button", { name: "play", exact: true }).click();
      await expect(roll(page)).toHaveAttribute("data-live", /[0-3]/);
      // moving the keyboard's focus to another stage's title brings that stage into view while the first still sounds
      const hero = Number(await roll(page).getAttribute("data-hero"));
      const other = (hero + 2) % 4;
      await page.locator(".block").nth(other).locator(".slab button").focus();
      await expect(roll(page)).toHaveAttribute("data-hero", String(other));
      await expect(roll(page)).not.toHaveAttribute("data-live", /.*/);
      await expect(thread(page)).toHaveAttribute("data-on", "false");
    });

    test("marking a part hides the cable but the stage keeps its colour", async ({ page }) => {
      await arrive(page);
      await page.getByRole("button", { name: "play", exact: true }).click();
      await expect(thread(page)).toHaveAttribute("data-on", "true");
      await page.getByRole("button", { name: "cut on the record" }).click();
      await expect(thread(page)).toHaveAttribute("data-on", "false");
      await expect(roll(page)).toHaveAttribute("data-live", /[0-3]/);
    });

    test("while a first-visit hint is up the cable stays away, and it comes back when the guide is done", async ({
      page,
    }) => {
      // a browser that has been through the narration: the first hint is next
      await page.addInitScript(() => localStorage.setItem("graft.coach", "narrated"));
      await page.goto("/");
      await expect(roll(page)).toHaveAttribute("data-audio", "ready");
      await page.getByRole("button", { name: "play", exact: true }).click();
      await expect(roll(page)).toHaveAttribute("data-live", /[0-3]/);
      await expect(page.getByTestId("hint")).toBeVisible();
      await expect(thread(page)).toHaveAttribute("data-on", "false");
      // the hints go by themselves after a few seconds; then nothing is left in the way
      await expect(page.getByTestId("hint")).toHaveCount(0, { timeout: 25_000 });
      await expect(roll(page)).toHaveAttribute("data-guide", "done");
      await expect(thread(page)).toHaveAttribute("data-on", "true");
    });

    test("the roll slides to the next stage in a quarter of a second, not most of one", async ({
      page,
    }) => {
      await arrive(page);
      const seconds = await page
        .locator(".sheet")
        .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
      expect(seconds).toBeLessThanOrEqual(0.3);
      expect(seconds).toBeGreaterThan(0.1);
    });
  });
}

test.describe("reduced motion", () => {
  test.use({ viewport: { width: 1280, height: 720 }, reducedMotion: "reduce" });
  test("the cable is steady: it appears without fading, and nothing runs along it", async ({
    page,
  }) => {
    await arrive(page);
    await page.getByRole("button", { name: "play all", exact: true }).click();
    await expect(thread(page)).toHaveAttribute("data-on", "true");
    await expect(page.locator(".thread .pulse")).toHaveCSS("opacity", "0");
    await expect(page.locator(".thread .pulse")).toHaveCSS("animation-name", "none");
    await expect(thread(page)).toHaveCSS("transition-duration", "0s");
    expect(await thread(page).evaluate((el) => el.style.getPropertyValue("--amp"))).toBe("0.5");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("there is no cable where the record is under the words, but the colour still says which stage is live", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(roll(page)).toHaveAttribute("data-audio", "ready");
    await expect(thread(page)).toHaveAttribute("data-shown", "false");
    await expect(thread(page)).toBeHidden();
    await page.getByRole("button", { name: "play", exact: true }).tap();
    await expect(roll(page)).toHaveAttribute("data-live", /[0-3]/);
    await expect(thread(page)).toBeHidden();
    const want = await liveColour(page);
    await expect
      .poll(() => strokeOf(page, '.block[data-hero="true"] .trace-face .beam'))
      .toBe(want);
  });
});

// Audit 3.4: "a colour flash at stop". The tile and the lit groove took the colour away in one frame while the
// thread was still fading out, so the stage's colour jumped to green. The colour is now held for the fade.
test("when the sound stops the stage's own colour is held while the thread fades, then goes", async ({
  page,
}) => {
  await arrive(page);
  await page.locator(".controls .primary").click();
  await expect(roll(page)).toHaveAttribute("data-live", /[0-3]/);
  const live = await roll(page).getAttribute("data-live");
  const seen = await page.evaluate(
    () =>
      new Promise<{ first: string | null; later: string | null }>((resolve) => {
        const el = document.querySelector(".roll")!;
        (document.querySelector(".controls .primary") as HTMLElement).click(); // pause
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const first = el.getAttribute("data-live");
            setTimeout(() => resolve({ first, later: el.getAttribute("data-live") }), 700);
          }),
        );
      }),
  );
  expect(seen.first, "the colour was taken away in the first frames after the stop").toBe(live);
  expect(seen.later, "and it goes once the thread has faded").toBeNull();
  await expect(thread(page)).toHaveAttribute("data-on", "false");
});

test("with reduced motion the colour goes at once: there is no fade to wait for", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await arrive(page);
  await page.locator(".controls .primary").click();
  await expect(roll(page)).toHaveAttribute("data-live", /[0-3]/);
  await page.locator(".controls .primary").click();
  await expect(roll(page)).not.toHaveAttribute("data-live", /./, { timeout: 500 });
});
