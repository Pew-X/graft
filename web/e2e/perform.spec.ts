// Performing the roll: the number keys play the stages by position, Escape silences and then leaves, the
// roll comes back to its place, and none of it reaches the first-visit guide as a visitor's own play. Driven
// in real Chromium over the built site with a spy on the audio context (which sources start, how many
// contexts exist), so what is asserted is what reaches the sound, not only what is drawn.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const chain = JSON.parse(readFileSync(join(here, "..", "snapshot", "chain.json"), "utf8")) as {
  stages: Array<{ frames: number }>;
};
/** The home chain's stage lengths in frames, source first. */
const FRAMES = chain.stages.map((s) => s.frames);

declare global {
  interface Window {
    __started: number[];
    __contexts: number;
  }
}

/** Count audio contexts and record the length of every buffer that starts to sound. */
async function spy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__started = [];
    window.__contexts = 0;
    const Real = window.AudioContext;
    window.AudioContext = class extends Real {
      constructor(options?: AudioContextOptions) {
        super(options);
        window.__contexts += 1;
      }
      override createBufferSource(): AudioBufferSourceNode {
        const source = super.createBufferSource();
        const start = source.start.bind(source);
        source.start = (...args: Parameters<typeof start>) => {
          window.__started.push(source.buffer?.length ?? 0);
          return start(...args);
        };
        return source;
      }
    };
  });
}

async function arrive(page: Page): Promise<void> {
  await spy(page);
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
}
const roll = (page: Page) => page.locator(".roll");
const toggle = (page: Page) => page.getByRole("button", { name: "perform", exact: true });
const started = (page: Page) => page.evaluate(() => window.__started);

async function enter(page: Page): Promise<void> {
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  // the performer is made once the audio has been unlocked
  await expect(roll(page)).toHaveAttribute("data-latency", /\d/);
}

test("perform is a button with a pressed state, and the keys do nothing until it is on", async ({
  page,
}) => {
  await arrive(page);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Digit2");
  expect(await started(page)).toEqual([]);
  await enter(page);
  await page.keyboard.press("Digit2");
  expect(await started(page)).toEqual([FRAMES[1]]);
});

test("keys 1 to 4 play stages 1 to 4 on the roll's own sounds, and the page follows each", async ({
  page,
}) => {
  await arrive(page);
  await enter(page);
  for (const [i, code] of ["Digit1", "Digit2", "Digit3", "Digit4"].entries()) {
    await page.keyboard.press(code);
    await expect(roll(page)).toHaveAttribute("data-hero", String(i));
    await expect(roll(page)).toHaveAttribute("data-sounding", "true");
  }
  expect(await started(page)).toEqual(FRAMES);
  // stage 4's number on the slab agrees with the key
  await expect(page.locator('.block[data-hero="true"]')).toContainText("04");
});

test("keys are named by position: a layout that prints other characters plays the same stages", async ({
  page,
}) => {
  await arrive(page);
  await enter(page);
  // an AZERTY keyboard's first key prints "&" and its second "é"; the browser still says Digit1, Digit2
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit2", key: "é", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", key: "&", bubbles: true }));
  });
  expect(await started(page)).toEqual([FRAMES[1], FRAMES[0]]);
});

test("a stage the chain does not have, a held key, and a shortcut with a modifier play nothing", async ({
  page,
}) => {
  await arrive(page);
  await enter(page);
  await page.keyboard.press("Digit9");
  await page.keyboard.press("Digit0");
  await page.keyboard.press("Minus");
  await page.keyboard.press("Equal");
  await page.keyboard.press("Control+Digit1");
  await page.keyboard.press("Shift+Digit1");
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Digit1", repeat: true, bubbles: true }),
    );
  });
  expect(await started(page)).toEqual([]);
});

test("escape silences what sounds, and a second escape leaves perform", async ({ page }) => {
  await arrive(page);
  await enter(page);
  await page.keyboard.press("Digit3");
  await expect(roll(page)).toHaveAttribute("data-sounding", "true");
  await page.keyboard.press("Escape");
  await expect(roll(page)).toHaveAttribute("data-sounding", "false");
  await expect(roll(page)).toHaveAttribute("data-perform", "true");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(roll(page)).toHaveAttribute("data-perform", "false");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  // and the keys are off again
  await page.keyboard.press("Digit1");
  expect(await started(page)).toEqual([FRAMES[2]]);
});

test("escape belongs to marking a part first: it leaves marking and perform stays on", async ({
  page,
}) => {
  await arrive(page);
  await enter(page);
  await page
    .getByRole("button", { name: /cut on the record/i })
    .first()
    .click();
  await expect(page.locator(".mark-toggle").first()).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator(".mark-toggle").first()).toHaveAttribute("aria-pressed", "false");
  await expect(roll(page)).toHaveAttribute("data-perform", "true");
  await page.keyboard.press("Escape");
  await expect(roll(page)).toHaveAttribute("data-perform", "false");
});

test("entering perform pauses the roll where it was, and leaving does not start it again", async ({
  page,
}) => {
  await arrive(page);
  await page.locator(".controls .primary").click();
  await expect(roll(page)).toHaveAttribute("data-sounding", "true");
  await page.getByRole("button", { name: "next stage" }).click();
  const stage = await roll(page).getAttribute("data-stage");
  await toggle(page).click();
  await expect(roll(page)).toHaveAttribute("data-playback", "paused");
  await expect(roll(page)).toHaveAttribute("data-sounding", "false");
  await page.keyboard.press("Digit4");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(roll(page)).toHaveAttribute("data-perform", "false");
  await expect(roll(page)).toHaveAttribute("data-playback", "paused");
  await expect(roll(page)).toHaveAttribute("data-stage", stage ?? "");
  await expect(roll(page)).toHaveAttribute("data-sounding", "false");
});

test("pressing play leaves perform and the roll plays as it always did", async ({ page }) => {
  await arrive(page);
  await enter(page);
  await page.keyboard.press("Digit2");
  await page.locator(".controls .primary").click();
  await expect(roll(page)).toHaveAttribute("data-perform", "false");
  await expect(roll(page)).toHaveAttribute("data-playback", "rolling");
});

test("no second audio context is made, and nothing is fetched on a press", async ({ page }) => {
  await arrive(page);
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await enter(page);
  expect(await page.evaluate(() => window.__contexts)).toBe(1);
  requests.length = 0;
  for (const code of ["Digit1", "Digit2", "Digit3", "Digit4", "Digit1"]) {
    await page.keyboard.press(code);
  }
  await page.waitForTimeout(200);
  // the sounds and the service: the browser may fetch its own icon at any time, which is not ours
  expect(requests.filter((u) => /\/seed\/|\/v1\/|\.pcm/.test(u))).toEqual([]);
  expect(await page.evaluate(() => window.__contexts)).toBe(1);
});

test("a press reaches the audio in the same task as the key", async ({ page }) => {
  await arrive(page);
  await enter(page);
  const same = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const before = window.__started.length;
        window.addEventListener(
          "keydown",
          () => {
            // listeners added later run after the page's own, in the same dispatch
            resolve(window.__started.length === before + 1);
          },
          { once: true },
        );
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", bubbles: true }));
      }),
  );
  expect(same).toBe(true);
});

test("the output latency is read and reported, not asserted", async ({ page }, info) => {
  await arrive(page);
  await enter(page);
  const latency = await roll(page).getAttribute("data-latency");
  info.annotations.push({ type: "base+output latency (ms)", description: String(latency) });
  expect(latency).toMatch(/^\d+\+\d+$/);
});

test("a polite line names the stage that was played", async ({ page }) => {
  await arrive(page);
  await enter(page);
  await page.keyboard.press("Digit2");
  await expect(page.locator('[aria-live="polite"]')).toContainText("stage 2 of 4");
});

test("tapping a stage's own play button while performing hands over to the roll: one sound, and the page follows it", async ({
  page,
}) => {
  await arrive(page);
  await enter(page);
  await page.keyboard.press("Digit2");
  await expect(roll(page)).toHaveAttribute("data-perform", "true");
  await page.locator('.block[data-hero="true"] .slab button').click();
  // perform is over, the roll's audition is what sounds, and the stage lit is the roll's
  await expect(roll(page)).toHaveAttribute("data-perform", "false");
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  await expect(roll(page)).toHaveAttribute("data-sounding", "true");
  await expect(page.locator(".bank")).toHaveCount(0);
});

test("leaving perform and coming back finds nothing current: no stylus parked on the stage played before", async ({
  page,
}) => {
  await arrive(page);
  await enter(page);
  await page.keyboard.press("Digit3");
  await expect(roll(page)).toHaveAttribute("data-hero", "2");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(roll(page)).toHaveAttribute("data-perform", "false");
  await toggle(page).click();
  await expect(roll(page)).toHaveAttribute("data-perform", "true");
  // the large stage is no longer the one played before, because nothing has been played in this visit
  await expect(page.locator(".pad[aria-current='true']")).toHaveCount(0);
});
