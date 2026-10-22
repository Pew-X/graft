import { expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

declare global {
  interface Window {
    player: {
      audioCreated(): boolean;
      contextState(): string;
      sampleRate(): number;
      resampled(): boolean;
      state(): { kind: string; ended?: boolean };
      voices(): number;
      timers(): number;
      level(): number;
    };
  }
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>player</title>
<button id="start">start</button><button id="tap1">tap 1</button><button id="tap2">tap 2</button>
<button id="play">play</button><button id="pause">pause</button>`;

test("a stage plays through real Web Audio and then stops by itself; pausing silences it", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  await page.setContent(PAGE);
  await page.addScriptTag({ path: join(here, "dist", "harness.js") });

  // Nothing exists before a gesture: no audio context is created while the page loads.
  expect(await page.evaluate(() => window.player.audioCreated())).toBe(false);

  // A tap is the user gesture that creates and unlocks the context.
  await page.click("#start");
  await expect.poll(() => page.evaluate(() => window.player.contextState())).toBe("running");

  // Audition stage 1 (0.5 s): sound comes out of the output, measured by the tapped analyser.
  await page.click("#tap1");
  expect(await page.evaluate(() => window.player.state().kind)).toBe("auditioning");
  await expect
    .poll(async () => page.evaluate(() => window.player.level()), {
      message: "sound is audible while it plays",
    })
    .toBeGreaterThan(0.05);

  // It plays once and ends by itself, and the output goes silent.
  await expect
    .poll(() => page.evaluate(() => window.player.state().ended), { timeout: 5000 })
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.player.level()), { message: "silent after the end" })
    .toBeLessThan(0.001);
  expect(await page.evaluate(() => window.player.voices())).toBe(0);

  // A tap after the end replays; pausing silences it and leaves no timers running.
  await page.click("#tap2");
  await expect.poll(() => page.evaluate(() => window.player.level())).toBeGreaterThan(0.05);
  await page.click("#pause");
  expect(await page.evaluate(() => window.player.state().kind)).toBe("paused");
  await expect.poll(() => page.evaluate(() => window.player.level())).toBeLessThan(0.001);
  expect(await page.evaluate(() => [window.player.voices(), window.player.timers()])).toEqual([
    0, 0,
  ]);

  // Roll mode starts from the main control and keeps exactly one voice sounding.
  await page.click("#play");
  await expect.poll(() => page.evaluate(() => window.player.level())).toBeGreaterThan(0.05);
  expect(await page.evaluate(() => window.player.voices())).toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: "audio",
    description: `context ${await page.evaluate(() => window.player.sampleRate())} Hz, resampled: ${await page.evaluate(() => window.player.resampled())}`,
  });
  expect(problems).toEqual([]);
});
