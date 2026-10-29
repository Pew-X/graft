// The recording scope follows the sound it hears. The fake microphone is given a pure 150 Hz tone: a quarter
// of its period is rate / 600 samples (80 at 48 kHz, 73.5 at 44.1 kHz), where the scope's untuned delay is
// 1.25 ms (60 and 55), so the delay must move to it, and a tone drawn with its own quarter period is a
// circle, so the figure must come out round.
// A voice is the same thing moving: the delay glides as the pitch does. Driven in real Chromium.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RATE = 48_000;

function writeTone(path: string, hz: number): void {
  const n = RATE * 4;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    pcm.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * hz * i) / RATE)), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
}

const dist = join(here, "dist");
mkdirSync(dist, { recursive: true });
const wav = join(dist, "tone-150.wav");
writeTone(wav, 150);

test.use({
  viewport: { width: 1000, height: 800 },
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}`,
    ],
  },
});

test("a steady tone tunes the delay to a quarter of its period and the figure comes out round", async ({
  page,
}, info) => {
  await page.goto("/make");
  await page.getByRole("button", { name: "record with the microphone" }).click();
  const scope = page.getByTestId("record-scope");
  await expect(scope).toBeVisible();
  // the page's own audio rate: a quarter of a 150 Hz period is rate / 600 samples
  await expect
    .poll(async () => Number((await scope.getAttribute("data-rate")) ?? 0))
    .toBeGreaterThan(8000);
  const rate = Number(await scope.getAttribute("data-rate"));
  const quarter = rate / 600;
  const untuned = Math.round((rate * 1.25) / 1000);
  expect(Math.abs(quarter - untuned), "the tone is told apart from the default").toBeGreaterThan(
    10,
  );
  // the delay glides from its default toward the quarter period a few samples at a time
  await expect
    .poll(async () => Number((await scope.getAttribute("data-delay")) ?? 0), { timeout: 8_000 })
    .toBeGreaterThan(quarter - 4);
  const delay = Number(await scope.getAttribute("data-delay"));
  expect(delay, `a quarter of 150 Hz at ${rate} Hz is ${quarter.toFixed(1)} samples`).toBeLessThan(
    quarter + 5,
  );
  await page.waitForTimeout(1500);
  await scope.screenshot({ path: info.outputPath("tuned-circle.png") });
  const f = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".scope-beam")!;
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let minX = c.width;
    let maxX = 0;
    let minY = c.height;
    let maxY = 0;
    let lit = 0;
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++)
        if ((data[(y * c.width + x) * 4 + 1] ?? 0) > 90) {
          lit++;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
    return { lit, w: maxX - minX, h: maxY - minY };
  });
  expect(f.lit).toBeGreaterThan(100);
  expect(f.w / f.h, "round: as wide as it is tall").toBeGreaterThan(0.85);
  expect(f.w / f.h).toBeLessThan(1.18);
});
