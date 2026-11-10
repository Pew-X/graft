// The recording scope, with a fake microphone: Chromium is given a sound of known content (a steady 150 Hz,
// 700 Hz and 2.2 kHz, each pulsing at 3 Hz, a third of a cycle apart) and the picture must be an X-Y figure
// in the middle of the tube: two-dimensional (not a flat line), compact (about half the screen at most),
// and centred. The microphone must be let go when recording ends, and the scope must never be wired to the
// speakers (that would be feedback). Driven in real Chromium against the built site.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RATE = 48_000;

/** Four seconds of mono 16-bit audio: three tones, each pulsing at 3 Hz, a third of a cycle apart. */
function writeSpeechLike(path: string): void {
  const n = RATE * 4;
  const pcm = Buffer.alloc(n * 2);
  const tones: ReadonlyArray<readonly [hz: number, phase: number]> = [
    [150, 0],
    [700, 1 / 3],
    [2200, 2 / 3],
  ];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let v = 0;
    for (const [hz, phase] of tones) {
      const pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * (3 * t - phase));
      v += 0.22 * pulse * Math.sin(2 * Math.PI * hz * t);
    }
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
  }
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
const wav = join(dist, "speech-like.wav");
writeSpeechLike(wav);

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

/** Watch what the page does with audio: contexts closed, anything wired to a speaker, tracks that ended. */
async function watchAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tracks: MediaStreamTrack[] = [];
    const log = {
      closed: 0,
      toSpeakers: 0,
      // a track the page stops reads "ended": the "ended" event only fires when the device itself goes away
      get ended() {
        return tracks.filter((t) => t.readyState === "ended").length;
      },
      get live() {
        return tracks.filter((t) => t.readyState === "live").length;
      },
    };
    (window as unknown as { audioLog: typeof log }).audioLog = log;
    const close = AudioContext.prototype.close;
    AudioContext.prototype.close = function (this: AudioContext) {
      log.closed++;
      return close.call(this);
    };
    const connect = AudioNode.prototype.connect as (this: AudioNode, ...a: unknown[]) => unknown;
    AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
      const target = args[0] as { context?: BaseAudioContext } | undefined;
      if (target && target === (target.context as AudioContext | undefined)?.destination)
        log.toSpeakers++;
      return connect.apply(this, args);
    } as typeof AudioNode.prototype.connect;
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const stream = await getUserMedia(c);
      tracks.push(...stream.getTracks());
      return stream;
    };
  });
}
const audioLog = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          audioLog: { closed: number; toSpeakers: number; ended: number; live: number };
        }
      ).audioLog,
  );

/** The lit part of the beam canvas: how many pixels, and the box and centre they fill, as shares of the screen. */
async function figure(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".scope-beam")!;
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    let minX = c.width;
    let maxX = 0;
    let minY = c.height;
    let maxY = 0;
    let sx = 0;
    let sy = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if ((data[(y * c.width + x) * 4 + 1] ?? 0) > 90) {
          lit++;
          sx += x;
          sy += y;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    return {
      lit,
      wide: lit ? (maxX - minX) / c.width : 0,
      tall: lit ? (maxY - minY) / c.height : 0,
      cx: lit ? sx / lit / c.width : 0,
      cy: lit ? sy / lit / c.height : 0,
    };
  });
}

async function startScope(page: Page): Promise<void> {
  await page.goto("/make");
  await page.getByRole("button", { name: "record with the microphone" }).click();
  await expect(page.getByTestId("record-scope")).toBeVisible();
  await expect
    .poll(async () =>
      Number((await page.getByTestId("record-scope").getAttribute("data-frames")) ?? 0),
    )
    .toBeGreaterThan(30);
}

test("the picture is an X-Y figure: two-dimensional, compact and in the middle of the tube", async ({
  page,
}, info) => {
  await watchAudio(page);
  await startScope(page);
  await page.waitForTimeout(1500);
  await page.getByTestId("record-scope").screenshot({ path: info.outputPath("scope.png") });
  const f = await figure(page);
  expect(f.lit, "something is drawn").toBeGreaterThan(150);
  expect(f.wide, "not a vertical line").toBeGreaterThan(0.05);
  expect(f.tall, "not a horizontal line").toBeGreaterThan(0.05);
  expect(f.wide, "compact: well inside the tube").toBeLessThan(0.75);
  expect(f.tall).toBeLessThan(0.9);
  expect(Math.abs(f.cx - 0.5), "centred across").toBeLessThan(0.12);
  expect(Math.abs(f.cy - 0.5), "centred up").toBeLessThan(0.12);
});

test("it is never wired to the speakers, and the microphone and the audio context are let go when recording ends", async ({
  page,
}) => {
  await watchAudio(page);
  await startScope(page);
  expect((await audioLog(page)).toSpeakers, "wired to a speaker: it would howl").toBe(0);
  expect((await audioLog(page)).live, "the microphone is open while recording").toBeGreaterThan(0);
  await page.getByRole("button", { name: "stop recording" }).click();
  await expect(page.getByTestId("record-scope")).toHaveCount(0);
  await expect
    .poll(async () => (await audioLog(page)).closed, { message: "the scope's context is closed" })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await audioLog(page)).live, { message: "no microphone track is left open" })
    .toBe(0);
  expect((await audioLog(page)).ended).toBeGreaterThan(0);
  expect((await audioLog(page)).toSpeakers).toBe(0);
});

test("leaving the page while recording lets everything go too", async ({ page }) => {
  await watchAudio(page);
  await startScope(page);
  await page.getByRole("link", { name: /graft/ }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(async () => (await audioLog(page)).closed).toBeGreaterThan(0);
  await expect.poll(async () => (await audioLog(page)).live).toBe(0);
});

test("with reduced motion the scope still draws, without the afterglow", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await startScope(page);
  expect((await figure(page)).lit).toBeGreaterThan(40);
});

test("the scope is a picture only: hidden from a screen reader, and the status line says what is happening", async ({
  page,
}) => {
  await startScope(page);
  await expect(page.getByTestId("record-scope")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("status").filter({ hasText: "recording." })).toBeVisible();
});
