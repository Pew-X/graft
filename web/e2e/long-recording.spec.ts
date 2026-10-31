// A recording of up to thirty minutes can be read, and the 15 seconds to keep are found by moving a window
// along it and hearing the part. The files are synthesized (a quiet low tone, no third-party sound) at 8 kHz
// mono so thirty minutes is about 29 megabytes; the browser resamples them to 48 kHz, which is what makes
// the frame limit real. Nothing is sent anywhere: the service is not needed.
import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

/** A little-endian 16-bit mono WAV of `seconds` at 8 kHz. */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const frames = seconds * rate;
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + frames * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / rate)), 44 + i * 2);
  }
  return buf;
}

async function pick(page: Page, seconds: number): Promise<void> {
  await page.goto("/make");
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "long.wav", mimeType: "audio/wav", buffer: wav(seconds) });
}

test("a five minute recording is read, and a window is moved along it to find the part", async ({
  page,
}) => {
  await pick(page, 300);
  await expect(page.getByRole("heading", { name: /pick the part to keep/ })).toBeVisible();
  const where = page.getByTestId("trim-where");
  await expect(where).toContainText("5:00 long");
  await expect(page.getByTestId("trim-at")).toHaveText("0:00 of 5:00");
  const move = page.getByRole("slider", { name: "where in the recording" });
  await move.focus();
  for (let i = 0; i < 90; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("trim-at")).toHaveText("1:30 of 5:00");
  // the brackets work in the minute shown, and the part is still at most fifteen seconds
  await expect(page.getByTestId("cut-readout")).toContainText("15.000 kept");
  await expect(page.getByRole("button", { name: "hear this part" })).toBeEnabled();
  await page.getByRole("button", { name: "use this part" }).click();
  await expect(page.getByRole("slider", { name: "end of the cut" })).toHaveAttribute(
    "aria-valuemax",
    "720000",
  );
});

test("a thirty minute recording is read to its very end", async ({ page }, info) => {
  test.setTimeout(120_000);
  const began = Date.now();
  await pick(page, 30 * 60);
  await expect(page.getByTestId("trim-where")).toContainText("30:00 long", { timeout: 90_000 });
  info.annotations.push({
    type: "decode",
    description: `thirty minutes read and drawn in ${Math.round((Date.now() - began) / 1000)} s`,
  });
  const move = page.getByRole("slider", { name: "where in the recording" });
  await move.focus();
  await page.keyboard.press("End");
  await expect(page.getByTestId("trim-at")).toHaveText("29:00 of 30:00");
  await expect(page.getByRole("button", { name: "use this part" })).toBeEnabled();
});

test("a recording over thirty minutes is refused in words, not silently", async ({ page }) => {
  test.setTimeout(120_000);
  await pick(page, 31 * 60);
  await expect(page.getByText("over thirty minutes")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("heading", { name: "pick a sound to start from" })).toBeVisible();
});

test("a recording of under a minute is shown whole, with no window to move", async ({ page }) => {
  await pick(page, 40);
  await expect(page.getByRole("heading", { name: /pick the part to keep/ })).toBeVisible();
  await expect(page.getByTestId("trim-where")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "hear this part" })).toBeEnabled();
});
