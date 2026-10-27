// Editing a marked part where it was marked: pick its speed on the record, hear the real rendering on a
// loop, and carry it to the make page with the speed already set. Each test names the guarantee it
// protects. Driven in real Chromium against the built site; nothing is published.
import { expect, test, type Page } from "@playwright/test";
import { pointOn } from "./disc.ts";

test.use({ viewport: { width: 1280, height: 800 } });

const toggle = (page: Page) => page.getByRole("button", { name: /cut on the record|stop cutting/ });
const bar = (page: Page) => page.getByRole("group", { name: "cut on the record" });
const chips = (page: Page) => bar(page).getByRole("group", { name: "speed of this part" });
const chip = (page: Page, name: RegExp) => chips(page).getByRole("button", { name });
const hear = (page: Page) => bar(page).getByRole("button", { name: /^(hear it|stop)$/ });

/** Count every looping buffer the page starts, with its length in seconds, as the browser would play it. */
async function watchLoops(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const loops: number[] = [];
    (window as unknown as { loops: number[] }).loops = loops;
    const make = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function (this: AudioContext) {
      const source = make.call(this);
      const start = source.start.bind(source);
      source.start = (when?: number) => {
        if (source.loop && source.buffer) loops.push(source.buffer.duration);
        start(when);
      };
      return source;
    };
  });
}
const loops = (page: Page) => page.evaluate(() => (window as unknown as { loops: number[] }).loops);

async function arrive(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await page.waitForTimeout(900);
}

async function markHalf(page: Page): Promise<number> {
  await toggle(page).click();
  const a = await pointOn(page, 4, 3, 0.25);
  const b = await pointOn(page, 4, 3, 0.75);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await expect(bar(page)).toBeVisible();
  const label = await bar(page)
    .getByRole("button", { name: /flip this part/ })
    .innerText();
  return Number(label.match(/(\d+\.\d+) s/)![1]);
}

test("a marked part offers six speeds, none chosen, and cannot be heard until one is", async ({
  page,
}) => {
  await arrive(page);
  await markHalf(page);
  const all = chips(page).getByRole("button");
  await expect(all).toHaveCount(6);
  expect(await all.evaluateAll((els) => els.map((e) => e.getAttribute("aria-pressed")))).toEqual(
    Array(6).fill("false"),
  );
  await expect(hear(page)).toBeDisabled();
  // each chip says the semitones it shows and the interval in words
  await expect(chip(page, /^\+7, a fifth up$/)).toHaveText("+7");
  await expect(chip(page, /^−12, an octave down$/)).toHaveText("−12");
});

test("choosing a speed says what the part becomes, worked from the part's own length", async ({
  page,
}) => {
  await arrive(page);
  const seconds = await markHalf(page);
  await chip(page, /\+7/).click();
  await expect(chip(page, /\+7/)).toHaveAttribute("aria-pressed", "true");
  const note = await bar(page).getByRole("status").innerText();
  const [from, to] = [...note.matchAll(/(\d+\.\d+) s/g)].map((m) => Number(m[1]));
  expect(from).toBeCloseTo(seconds, 2);
  // a fifth up is 3/2 as fast, so the part is two thirds as long
  expect(to).toBeCloseTo((seconds * 2) / 3, 1);
  // choosing it again gives the choice back
  await chip(page, /\+7/).click();
  await expect(chip(page, /\+7/)).toHaveAttribute("aria-pressed", "false");
  await expect(hear(page)).toBeDisabled();
});

test("hearing it loops the real rendering at that speed, and a new speed replaces the loop", async ({
  page,
}) => {
  await watchLoops(page);
  await arrive(page);
  const seconds = await markHalf(page);
  await chip(page, /\+7/).click();
  await hear(page).click();
  await expect(hear(page)).toHaveAttribute("aria-pressed", "true");
  await expect(hear(page)).toHaveText("stop");
  await expect.poll(async () => (await loops(page)).length).toBe(1);
  expect((await loops(page))[0]).toBeCloseTo((seconds * 2) / 3, 1);
  // a slower speed is a longer loop
  await chip(page, /−12/).click();
  await expect.poll(async () => (await loops(page)).length).toBe(2);
  expect((await loops(page))[1]).toBeCloseTo(seconds * 2, 1);
  await hear(page).click();
  await expect(hear(page)).toHaveText("hear it");
});

test("flipping the part carries its speed to the make page, already set", async ({ page }) => {
  await arrive(page);
  await markHalf(page);
  await chip(page, /\+7/).click();
  await bar(page)
    .getByRole("button", { name: /flip this part/ })
    .click();
  await page.waitForURL(/\/make\?from=.*&cut=\d+-\d+&speed=3%2F2/);
  await expect(page.getByRole("slider", { name: "speed" })).toHaveAttribute(
    "aria-valuetext",
    "150%, a fifth up",
  );
});

test("flipping without choosing a speed asks for none", async ({ page }) => {
  await arrive(page);
  await markHalf(page);
  await bar(page)
    .getByRole("button", { name: /flip this part/ })
    .click();
  await page.waitForURL(/\/make\?from=.*&cut=\d+-\d+$/);
});
