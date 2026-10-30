// A phrase: rec keeps the pads pressed in perform as stage numbers and times in the page's own address;
// play runs them again through the same path as a key; a link that carries one only offers it. Driven in real
// Chromium over the built site with a spy on the audio context, so what is asserted is what reaches the sound.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const chain = JSON.parse(readFileSync(join(here, "..", "snapshot", "chain.json"), "utf8")) as {
  stages: Array<{ frames: number }>;
};
const FRAMES = chain.stages.map((s) => s.frames);

declare global {
  interface Window {
    __started: number[];
  }
}

async function spy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__started = [];
    const Real = window.AudioContext;
    window.AudioContext = class extends Real {
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

async function arrive(page: Page, hash = ""): Promise<void> {
  await spy(page);
  await page.goto(`/${hash}`);
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
}
const toggle = (page: Page) => page.getByRole("button", { name: "perform", exact: true });
const started = (page: Page) => page.evaluate(() => window.__started);
const rec = (page: Page) => page.getByRole("button", { name: /^(rec|stop rec)$/ });
const status = (page: Page) => page.locator(".status");

async function enter(page: Page): Promise<void> {
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".roll")).toHaveAttribute("data-latency", /\d/);
}

test("rec keeps the pads pressed, the address carries them, play runs them again", async ({
  page,
}) => {
  await arrive(page);
  await enter(page);
  await rec(page).click();
  await expect(rec(page)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Digit1");
  await page.waitForTimeout(200);
  await page.keyboard.press("Digit3");
  await page.waitForTimeout(150);
  await page.keyboard.press("Digit2");
  await rec(page).click();
  await expect(rec(page)).toHaveAttribute("aria-pressed", "false");
  expect(await started(page)).toEqual([FRAMES[0], FRAMES[2], FRAMES[1]]);
  // the address holds the phrase: stages 1, 3, 2 and their times
  const hash = new URL(page.url()).hash;
  const m = /^#phrase=1:0,3:(\d+),2:(\d+)$/.exec(hash);
  expect(m, hash).not.toBeNull();
  const second = Number(m?.[1]);
  const third = Number(m?.[2]);
  expect(second).toBeGreaterThan(15);
  expect(second).toBeLessThan(40);
  expect(third - second).toBeGreaterThan(10);
  await expect(status(page)).toContainText("phrase kept: 3 presses");

  // play: the same three stages again, in the same order, through the same path
  await page.getByRole("button", { name: "play phrase" }).click();
  await expect.poll(() => started(page).then((s) => s.length)).toBe(6);
  expect((await started(page)).slice(3)).toEqual([FRAMES[0], FRAMES[2], FRAMES[1]]);
  await expect(page.getByRole("button", { name: "play phrase" })).toBeVisible();

  // loop: it goes round again until stopped; escape stops the phrase and then the sound
  await page.getByRole("button", { name: "loop" }).click();
  await page.getByRole("button", { name: "play phrase" }).click();
  await expect
    .poll(() => started(page).then((s) => s.length), { timeout: 8000 })
    .toBeGreaterThan(11);
  await page.keyboard.press("Escape");
  const n = (await started(page)).length;
  await page.waitForTimeout(1500);
  expect((await started(page)).length).toBe(n);
  // perform is still on: the first escape ended the phrase, only the next leaves
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

  // clear removes it from the address
  await page.getByRole("button", { name: "clear" }).click();
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.getByRole("button", { name: "play phrase" })).toHaveCount(0);
});

test("a recording with no press keeps nothing and says so; escape ends a recording and keeps it", async ({
  page,
}) => {
  await arrive(page);
  await enter(page);
  await rec(page).click();
  await rec(page).click();
  await expect(status(page)).toContainText("nothing was pressed");
  expect(new URL(page.url()).hash).toBe("");
  await rec(page).click();
  await page.keyboard.press("Digit4");
  await page.keyboard.press("Escape");
  await expect(rec(page)).toHaveAttribute("aria-pressed", "false");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  expect(new URL(page.url()).hash).toBe("#phrase=4:0");
});

test("a link that carries a phrase offers it and never plays by itself", async ({ page }) => {
  await arrive(page, "#phrase=1:0,3:30,2:60");
  const invite = page.locator(".phrase-invite");
  await expect(invite).toBeVisible();
  await expect(invite).toContainText("no sound with it");
  await page.waitForTimeout(800);
  expect(await started(page)).toEqual([]);
  await invite.getByRole("button", { name: "play the phrase" }).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => started(page).then((s) => s.length)).toBe(3);
  expect(await started(page)).toEqual([FRAMES[0], FRAMES[2], FRAMES[1]]);
  await expect(invite).toHaveCount(0);
});

test("not now closes the invitation and keeps the link as it was", async ({ page }) => {
  await arrive(page, "#phrase=1:0,2:20");
  await page.getByRole("button", { name: "not now" }).click();
  await expect(page.locator(".phrase-invite")).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe("#phrase=1:0,2:20");
  expect(await started(page)).toEqual([]);
});

test("a hostile, broken or too-long link is no phrase: no invitation, no error", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const hash of [
    "#phrase=%3Cscript%3Ealert(1)%3C/script%3E",
    "#phrase=1:0,2:5,3:1",
    "#phrase=99:0",
    "#phrase=1:0,,2:3",
    "#phrase=",
    `#phrase=${"1:0,".repeat(80)}1:0`,
    "#phrase=1:0," + "x".repeat(5000),
  ]) {
    await arrive(page, hash);
    await expect(page.locator(".phrase-invite")).toHaveCount(0);
    await expect(toggle(page)).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("the guide's own address, #how, is untouched by phrases", async ({ page }) => {
  await arrive(page, "#how");
  await expect(page.locator(".phrase-invite")).toHaveCount(0);
});
