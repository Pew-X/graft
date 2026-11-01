// Starting from the maker's own sound, against the real service (scripts/service-e2e.sh): a picked
// file or the microphone, read on the device, cut and flipped privately, and published as a source
// under a declaration only if uploads are on. Uploads are off by default, so most of these use the
// second instance the script starts with them on, reached by sending the page's own requests there.
import { expect, test, type Page } from "@playwright/test";
import { API, allowBucketReads } from "./service.ts";

const UPLOADS_API = process.env["GRAFT_UPLOADS_API_URL"] ?? "http://127.0.0.1:3301";

test.use({
  viewport: { width: 1280, height: 860 },
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

test("own sound to three stages: the panels are named, one next button continues from the newest flip, and the lineage has three stages", async ({
  page,
  request,
}) => {
  await viaUploads(page);
  await page.goto("/make");
  await pick(page, stereo(120_000));
  // before anything is published the page says where the flip will sit
  await expect(page.getByTestId("making-from")).toContainText("it becomes stage 1");
  await page.getByRole("button", { name: "publish your sound" }).click();
  await page.getByLabel(/^title/).fill("hook isolate");
  await page.getByLabel(/^your name/).fill("pat");
  await page.getByLabel(/i confirm/).check();
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.getByTestId("published-link")).toHaveCount(1);
  await expect(page.getByText("the source: hook isolate")).toBeVisible();
  await expect(page.getByTestId("making-from")).toContainText("stage 1: hook isolate");
  const a = (await page.getByTestId("published-link").first().getAttribute("href"))!.replace(
    "/p/",
    "",
  );

  await page.getByRole("button", { name: "publish this flip" }).click();
  await page
    .getByLabel(/^title/)
    .last()
    .fill("hook down");
  await page
    .getByLabel(/^your name/)
    .last()
    .fill("pat");
  await page.getByRole("button", { name: "publish", exact: true }).last().click();
  await expect(page.getByText("stage 2: hook down, made from hook isolate")).toBeVisible();
  const b = (await page.getByTestId("published-link").last().getAttribute("href"))!.replace(
    "/p/",
    "",
  );

  // the source's panel is now one line: there is ONE next-stage button, and it belongs to the newest flip
  await expect(page.getByRole("button", { name: "flip this next" })).toHaveCount(1);
  await expect(page.locator(".publish.done.folded")).toHaveCount(1);
  await page.getByRole("button", { name: "flip this next" }).click();
  await page.waitForURL(/make\?from=/);
  expect(page.url().endsWith(`from=${b}`)).toBe(true);
  await expect(page.getByTestId("making-from")).toContainText("making stage 3, from hook down");
  await page.getByRole("button", { name: "publish this flip" }).click();
  await page
    .getByLabel(/^title/)
    .last()
    .fill("hook down more");
  await page
    .getByLabel(/^your name/)
    .last()
    .fill("pat");
  await page.getByRole("button", { name: "publish", exact: true }).last().click();
  await expect(page.getByText("stage 3: hook down more, made from hook down")).toBeVisible();
  const c = (await page.getByTestId("published-link").last().getAttribute("href"))!.replace(
    "/p/",
    "",
  );
  const chain = (await (await request.get(`${UPLOADS_API}/v1/chains/${c}`)).json()) as {
    stages: Array<{ id: string; title: string }>;
  };
  expect(chain.stages.map((s) => s.id)).toEqual([a, b, c]);

  // your flips says where each one sits
  await page.goto("/flips");
  await expect(page.getByText("stage 3, made from hook down")).toBeVisible();
  await expect(page.getByText("stage 2, made from hook isolate")).toBeVisible();
  await expect(page.getByText("source", { exact: true })).toBeVisible();

  // the source's own page shows the flips made from it before its facts, so the lineage going on is not hidden
  await page.goto(`/p/${a}`);
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  const flips = page.locator(".flips-of").first();
  await expect(flips).toBeVisible();
  const before = await page.evaluate(() => {
    const f = document.querySelector(".flips-of");
    const face = document.querySelector("dl.face");
    return !!f && !!face && !!(f.compareDocumentPosition(face) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(before).toBe(true);
});
