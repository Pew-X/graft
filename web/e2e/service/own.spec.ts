// Starting from the maker's own sound, against the real service (scripts/service-e2e.sh): a picked
// file or the microphone, read on the device, cut and flipped privately, and published as a source
// under a declaration only if uploads are on. Uploads are off by default, so most of these use the
// second instance the script starts with them on, reached by sending the page's own requests there.
import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { API, allowBucketReads } from "./service.ts";

const UPLOADS_API = process.env["GRAFT_UPLOADS_API_URL"] ?? "http://127.0.0.1:3301";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  // A fake microphone that plays a tone, allowed without a prompt (the denied case overrides it).
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["microphone"],
});

/** A little-endian 16-bit WAV. `sample(i, channel)` gives the 16-bit value of frame i. */
function wav(opts: {
  rate: number;
  channels: number;
  frames: number;
  sample: (i: number, c: number) => number;
}): Buffer {
  const { rate, channels, frames, sample } = opts;
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) data.writeInt16LE(sample(i, c), (i * channels + c) * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// A decaying two-tone with a little noise: not silent, not constant, not clipped.
const tone = (i: number, c: number) =>
  Math.round(
    9000 * Math.exp(-i / 30000) * Math.sin(i / (c === 0 ? 11 : 13)) + 1500 * Math.sin(i * 0.37 + c),
  );
const stereo = (frames: number) => wav({ rate: 48000, channels: 2, frames, sample: tone });

async function pick(page: Page, file: Buffer, name = "my sound.wav"): Promise<void> {
  await page
    .locator("input[type=file]")
    .setInputFiles({ name, mimeType: "audio/wav", buffer: file });
}

async function viaUploads(page: Page): Promise<void> {
  await page.route(`${API}/**`, (route) =>
    route.continue({ url: route.request().url().replace(API, UPLOADS_API) }),
  );
}

test.beforeEach(async ({ page }) => {
  await allowBucketReads(page);
});

test("a picked file is cut and flipped on the device, published as a source under a declaration, and forked", async ({
  page,
  request,
}) => {
  await viaUploads(page);
  const frames = 60_000;
  await page.goto("/make");
  await pick(page, stereo(frames));
  await expect(page.getByRole("slider", { name: "start of the cut" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "end of the cut" })).toHaveAttribute(
    "aria-valuemax",
    String(frames),
  );

  // The flip cannot be published until the sound itself is.
  await expect(page.getByRole("button", { name: "publish this flip" })).toBeDisabled();
  await page.getByRole("button", { name: "publish your sound" }).click();
  await page.getByLabel(/^title/).fill("my door");
  await page.getByLabel(/^your name/).fill("pat");
  const submit = page.getByRole("button", { name: "publish", exact: true });
  await expect(submit).toBeDisabled();
  await expect(page.locator("#publish-why")).toContainText(
    "I made this sound or I have the right to share it",
  );
  await page.getByLabel(/i confirm/).check();
  await submit.click();
  const link = page.getByTestId("published-link");
  await expect(link).toBeVisible();
  const id = (await link.getAttribute("href"))!.replace("/p/", "");

  // The service holds a root with the declaration, shown as declared, and exactly the canonical bytes
  // worked out by hand: (left + right + 1) >> 1 on each pair.
  const chain = (await (await request.get(`${UPLOADS_API}/v1/chains/${id}`)).json()) as {
    stages: Array<{
      kind: string;
      lines: Array<{ role: string; honesty: string }>;
      details: { output_blob: string };
    }>;
  };
  expect(chain.stages).toHaveLength(1);
  expect(chain.stages[0]!.kind).toBe("source");
  const declaration = chain.stages[0]!.lines.find((l) => l.role === "declaration");
  expect(declaration?.honesty).toBe("declared");
  const expected = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    expected.writeInt16LE((tone(i, 0) + tone(i, 1) + 1) >> 1, i * 2);
  }
  expect(chain.stages[0]!.details.output_blob).toBe(
    createHash("sha256").update(expected).digest("hex"),
  );

  // Now the flip made from it can be published, and the chain has two stages.
  await expect(page.getByText("you can now publish the flip you made from it")).toBeVisible();
  await page.getByRole("button", { name: "publish this flip" }).click();
  await page
    .getByLabel(/^title/)
    .last()
    .fill("my door, up");
  await page
    .getByLabel(/^your name/)
    .last()
    .fill("pat");
  await page.getByRole("button", { name: "publish", exact: true }).last().click();
  await expect(page.getByTestId("published-link")).toHaveCount(2);
  const flipHref = (await page.getByTestId("published-link").last().getAttribute("href"))!;
  const flipChain = (await (
    await request.get(`${UPLOADS_API}/v1${flipHref.replace("/p/", "/chains/")}`)
  ).json()) as {
    stages: unknown[];
  };
  expect(flipChain.stages).toHaveLength(2);
  await page.goto(`/p/${id}`);
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
});

test("nothing leaves the device before publish: only reads, and the one check of what is open", async ({
  page,
}) => {
  await viaUploads(page);
  const requests: Array<{ method: string; url: string }> = [];
  page.on("request", (r) => requests.push({ method: r.method(), url: r.url() }));
  await page.goto("/make");
  await pick(page, stereo(60_000));
  await expect(page.getByRole("slider", { name: "speed" })).toBeVisible();
  await page.getByRole("slider", { name: "speed" }).focus();
  await page.keyboard.press("ArrowRight");
  // Moving a control starts the preview by itself.
  await expect(page.getByRole("button", { name: "pause" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  const origin = new URL(page.url()).origin;
  const away = requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith("data:"));
  expect(away.map((r) => new URL(r.url).pathname)).toEqual(["/v1/features"]);
});

test("with uploads off, the sound can still be cut and flipped, and publishing it says why not and sends nothing", async ({
  page,
}) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(r.url());
  });
  await page.goto("/make");
  await pick(page, stereo(60_000));
  await expect(page.getByRole("slider", { name: "speed" })).toBeVisible();
  const publish = page.getByRole("button", { name: "publish your sound" });
  await expect(publish).toBeDisabled();
  await expect(page.locator("#own-why")).toContainText("uploading your own sounds is switched off");
  await expect(page.getByRole("button", { name: "hear it" })).toBeEnabled();
  expect(posts).toEqual([]);
});

test("a 44.1 kHz file is resampled by the browser to 48 kHz: informational, within a frame of the exact length", async ({
  page,
}, info) => {
  await page.goto("/make");
  await pick(page, wav({ rate: 44_100, channels: 1, frames: 44_100, sample: (i) => tone(i, 0) }));
  const end = page.getByRole("slider", { name: "end of the cut" });
  await expect(end).toBeVisible();
  const frames = Number(await end.getAttribute("aria-valuemax"));
  info.annotations.push({
    type: "decode",
    description: `44.1 kHz, one second, read as ${frames} frames at 48 kHz`,
  });
  expect(Math.abs(frames - 48_000)).toBeLessThanOrEqual(2);
});

test("a recording over 15 seconds is trimmed to a part before it becomes a source, and a part that is too long says so", async ({
  page,
}) => {
  await page.goto("/make");
  await pick(
    page,
    wav({ rate: 48_000, channels: 1, frames: 20 * 48_000, sample: (i) => tone(i, 0) }),
  );
  await expect(page.getByRole("heading", { name: /pick the part to keep/ })).toBeVisible();
  const use = page.getByRole("button", { name: "use this part" });
  await expect(use).toBeEnabled();
  const end = page.getByRole("slider", { name: "end of the cut" });
  await end.focus();
  await page.keyboard.press("End");
  await expect(use).toBeDisabled();
  await expect(page.locator("#trim-why")).toContainText("at most 720000 frames, 15 seconds");
  await page.keyboard.press("Home");
  await expect(page.locator("#trim-why")).toContainText("ends before it starts");
  await page.keyboard.press("PageUp");
  await page.getByRole("slider", { name: "start of the cut" }).focus();
  await page.keyboard.press("Home");
  await end.focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press("PageUp");
  await page.keyboard.press("PageDown");
  await page.keyboard.press("Home");
  for (let i = 0; i < 100; i++) await page.keyboard.press("PageUp");
  await expect(use).toBeEnabled();
  await use.click();
  await expect(page.getByRole("slider", { name: "end of the cut" })).toHaveAttribute(
    "aria-valuemax",
    /^(4800|[1-7]\d{5})/,
  );
});

test("a file that is not audio is told so kindly and the list of sounds stays usable", async ({
  page,
}) => {
  await page.goto("/make");
  await page.locator("input[type=file]").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not sound at all"),
  });
  await expect(page.getByText("could not be read as audio")).toBeVisible();
  await page.getByRole("button", { name: "flip this sound: saber hum" }).click();
  await expect(page.getByRole("slider", { name: "speed" })).toBeVisible();
});

test("a microphone that is not allowed leaves the sounds made for graft fully usable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException("denied", "NotAllowedError"));
  });
  await page.goto("/make");
  await page.getByRole("button", { name: "record with the microphone" }).click();
  await expect(page.getByText("the microphone was not allowed")).toBeVisible();
  await page.getByRole("button", { name: "flip this sound: laser zap" }).click();
  await expect(page.getByRole("slider", { name: "start of the cut" })).toBeVisible();
  await expect(page.getByRole("button", { name: "hear it" })).toBeEnabled();
});

test("recording stops on request and the recording becomes a sound to cut and flip", async ({
  page,
}) => {
  await page.goto("/make");
  await page.getByRole("button", { name: "record with the microphone" }).click();
  await expect(page.getByText("recording. it stops by itself at 15 seconds.")).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "stop recording" }).click();
  await expect(page.getByRole("slider", { name: "start of the cut" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("your sound").first()).toBeVisible();
});
