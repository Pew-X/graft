// The core loop, once, in every engine the site supports (Chromium, Firefox, WebKit): open, play,
// hear the finished flip, the roll begins, the ancestry reads in order, go back to an earlier stage,
// audition another, pause and resume, and "flip this" opens the make flow. It uses plain clicks and
// keys (Firefox does not emulate touch); the touch paths are covered in roll.spec.ts and record.spec.ts
// in Chromium. What it checks is the engine's observable state, never timing guesses.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test.use({ viewport: { width: 390, height: 844 } });

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const titles = (
  JSON.parse(readFileSync(join(web, "snapshot", "chain.json"), "utf8")) as {
    stages: { title: string }[];
  }
).stages.map((s) => s.title);

const roll = (page: Page) => page.locator(".roll");

/** A stage's own label, by keyboard: on a phone only the stage in view can be touched, but any can be reached. */
async function stage(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`${title} play this stage`) }).focus();
  await page.keyboard.press("Enter");
}

test("open, play, follow the ancestry, go back, audition, pause, resume, flip this", async ({
  page,
}) => {
  await page.goto("/");
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
  await expect(roll(page)).toHaveAttribute("data-playback", "idle");

  // The ancestry is on the page in the chain's own order, as text.
  await expect(page.locator(".block .title")).toHaveText(titles);

  // One press starts it: the finished flip first, then the roll goes back to the source.
  await page.getByRole("button", { name: "play", exact: true }).click();
  await expect(roll(page)).toHaveAttribute("data-playback", "rolling");
  await expect(roll(page)).toHaveAttribute("data-sounding", "true");
  await expect(page.locator('.block[data-current="true"] .title')).toHaveText(titles.at(-1) ?? "");
  await expect(roll(page)).toHaveAttribute("data-stage", "0", { timeout: 20_000 });

  // Go back to an earlier stage by its label, then audition another.
  await stage(page, titles[1] ?? "");
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  await expect(roll(page)).toHaveAttribute("data-stage", "1");
  await stage(page, titles[2] ?? "");
  await expect(roll(page)).toHaveAttribute("data-stage", "2");

  // Pause freezes it; play carries on in the same mode.
  const main = page.getByRole("button", { name: /^(play|pause)$/ });
  await main.click();
  await expect(roll(page)).toHaveAttribute("data-playback", "paused");
  await main.click();
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  await expect(roll(page)).toHaveAttribute("data-stage", "2");

  // "Flip this" opens the make flow on that stage.
  const flip = page.locator('.block[data-hero="true"] .flip');
  await flip.scrollIntoViewIfNeeded();
  await flip.click();
  await expect(page).toHaveURL(/\/make\?from=/);
  await expect(page.getByRole("slider", { name: "start of the cut" })).toBeVisible();
});
