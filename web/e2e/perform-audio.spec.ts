// Performing, measured: a pad is as loud as the same stage on the roll, many pads never pass full scale,
// and a cut between two pads makes no click. Rendered offline in Chromium (exact, not by ear), over the
// home page's own stages. The bus is deterministic on purpose: no browser compressor is assumed.
import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const seed = join(here, "..", "public", "seed");

type Stages = number[][];
interface Measure {
  viaRoll(s: Stages, stage: number, seconds: number): Promise<{ peak: number; rms: number }>;
  viaPad(s: Stages, stage: number, seconds: number): Promise<{ peak: number; rms: number }>;
  allAtOnce(s: Stages, seconds: number): Promise<{ peak: number }>;
  cutClick(
    s: Stages,
    first: number,
    second: number,
    at: number,
    seconds: number,
  ): Promise<{ near: number; overall: number; first: number }>;
}
declare global {
  interface Window {
    measure: Measure;
  }
}

/** The shipped stages, as signed 16-bit samples, at most `n` of them and at most `max` seconds each. */
function shipped(n: number, max = 2): Stages {
  return readdirSync(seed)
    .filter((f) => f.endsWith(".pcm"))
    .slice(0, n)
    .map((f) => {
      const raw = readFileSync(join(seed, f));
      const view = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
      return Array.from(view.subarray(0, Math.round(max * 48_000)));
    });
}
/** A steady tone at a given share of full scale. */
function tone(hz: number, share: number, seconds: number): number[] {
  return Array.from({ length: Math.round(seconds * 48_000) }, (_, i) =>
    Math.round(share * 32767 * Math.sin((2 * Math.PI * hz * i) / 48_000)),
  );
}
const db = (a: number, b: number): number => 20 * Math.log10(a / b);

test.beforeEach(async ({ page }) => {
  await page.setContent("<!doctype html><title>perform</title>");
  await page.addScriptTag({ path: join(here, "dist", "perform.js") });
});

test("one pad is as loud as the same stage on the roll, for every stage the page ships", async ({
  page,
}) => {
  const stages = shipped(12);
  expect(stages.length).toBeGreaterThan(3);
  for (let stage = 0; stage < stages.length; stage++) {
    const [roll, pad] = await page.evaluate(
      async ([s, i]) => [
        await window.measure.viaRoll(s as Stages, i as number, 2.1),
        await window.measure.viaPad(s as Stages, i as number, 2.1),
      ],
      [stages, stage] as const,
    );
    expect(Math.abs(db(pad!.peak, roll!.peak)), `stage ${stage} peak`).toBeLessThan(0.5);
    expect(Math.abs(db(pad!.rms, roll!.rms)), `stage ${stage} level`).toBeLessThan(0.5);
  }
});

test("a stage at the top of its range costs under half a decibel through the bus", async ({
  page,
}) => {
  const loud = [tone(220, 1, 0.6)];
  const [roll, pad] = await page.evaluate(
    async (s) => [await window.measure.viaRoll(s, 0, 0.7), await window.measure.viaPad(s, 0, 0.7)],
    loud,
  );
  expect(Math.abs(db(pad!.peak, roll!.peak))).toBeLessThan(0.5);
});

test("twelve pads sounding together never pass full scale", async ({ page }) => {
  const twelve = Array.from({ length: 12 }, (_, i) => tone(110 * (i + 1), 1, 0.5));
  const { peak } = await page.evaluate((s) => window.measure.allAtOnce(s, 0.6), twelve);
  expect(peak).toBeGreaterThan(0.2);
  expect(peak).toBeLessThan(1);
});

test("the shipped stages together never pass full scale either", async ({ page }) => {
  const { peak } = await page.evaluate((s) => window.measure.allAtOnce(s, 2.1), shipped(12));
  expect(peak).toBeLessThan(1);
});

// where the first tone (220 Hz) is near a peak, so an abrupt stop would be a large step
const CUT_AT = 0.2011;

test("a press and a cut to another pad make no click", async ({ page }) => {
  // a tone's own largest step is 2 pi f / rate * amplitude; a click would be far more
  const stages = [tone(220, 0.5, 1), tone(330, 0.5, 1)];
  const natural = ((2 * Math.PI * 330) / 48_000) * 0.5 * 1.05;
  const r = await page.evaluate(
    ([s, at]) => window.measure.cutClick(s as Stages, 0, 1, at as number, 0.6),
    [stages, CUT_AT] as const,
  );
  expect(r.first, "starts from silence").toBe(0);
  expect(r.near, "the cut").toBeLessThan(natural * 2);
  expect(r.overall, "anywhere").toBeLessThan(natural * 2);
});
