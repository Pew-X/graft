// The editor's aids for cutting precisely: a line that follows what is playing, a zoom, a speed typed as a
// percentage, and a note on a sketch. Against the built site and its shipped snapshots (no service). Each
// test names the guarantee it protects.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "./a11y.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = (
  JSON.parse(readFileSync(join(web, "snapshot", "sources.json"), "utf8")) as {
    stages: Array<{ id: string; title: string; frames: number }>;
  }
).stages;
const FIRST = sources[0]!;
const KEY = "graft.sketches";

test.use({ bypassCSP: true });

const hash = (page: Page) => page.locator("[data-output-hash]");
const ready = (page: Page) => expect(hash(page)).not.toHaveAttribute("data-output-hash", "");
const link = (cut = "0-48000", speed = "3/2") => `/make?from=${FIRST.id}&cut=${cut}&speed=${speed}`;
const handle = (page: Page, which: "start" | "end") => page.locator(`[data-handle="${which}"]`);
const valueOf = async (page: Page, which: "start" | "end") =>
  Number(await handle(page, which).getAttribute("aria-valuenow"));

test("a line follows what is playing, stays inside the cut, and goes when the sound stops", async ({
  page,
}) => {
  await page.goto(link("12000-48000"));
  await ready(page);
  const line = page.getByTestId("playhead");
  await expect(line).toHaveAttribute("data-on", "false");
  await page.getByRole("button", { name: "hear it" }).click();
  await expect(line).toHaveAttribute("data-on", "true");
  const seen = new Set<number>();
  for (let i = 0; i < 12; i++) {
    const frame = Number(await line.getAttribute("data-frame"));
    expect(frame).toBeGreaterThanOrEqual(12_000);
    expect(frame).toBeLessThanOrEqual(48_000);
    seen.add(frame);
    await page.waitForTimeout(60);
  }
  expect(seen.size, "the line moves while the sound plays").toBeGreaterThan(2);
  await page.getByRole("button", { name: "pause" }).click();
  await expect(line).toHaveAttribute("data-on", "false");
});

test("with reduced motion the line steps instead of gliding", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(link("12000-48000"));
  await ready(page);
  await page.getByRole("button", { name: "hear it" }).click();
  const line = page.getByTestId("playhead");
  await expect(line).toHaveAttribute("data-on", "true");
  const frames = new Set<number>();
  for (let i = 0; i < 20; i++) {
    frames.add(Number(await line.getAttribute("data-frame")));
    await page.waitForTimeout(100);
  }
  // four places only: a quarter of the cut each (9,000 frames)
  expect(frames.size).toBeLessThanOrEqual(4);
  for (const f of frames) expect((f - 12_000) % 9_000).toBe(0);
});

test("zoom looks closer without changing what the brackets hold, and zooming out comes back whole", async ({
  page,
}) => {
  await page.goto(link("12000-48000"));
  await ready(page);
  const [start, end] = [await valueOf(page, "start"), await valueOf(page, "end")];
  const toggle = page.getByTestId("zoom-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("zoom-window")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const shown = await page.getByTestId("zoom-window").innerText();
  expect(shown).toMatch(/^showing \d+\.\d{3} to \d+\.\d{3} seconds/);
  // the brackets are still the whole sound's frames
  expect([await valueOf(page, "start"), await valueOf(page, "end")]).toEqual([start, end]);

  // the wheel zooms in around the pointer
  const track = page.locator(".cut-editor .track");
  const box = (await track.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -480);
  await expect.poll(async () => page.getByTestId("zoom-window").innerText()).not.toBe(shown);
  const [a, b] = (await page.getByTestId("zoom-window").innerText())
    .match(/(\d+\.\d{3}) to (\d+\.\d{3})/)!
    .slice(1)
    .map(Number) as [number, number];
  const [a0, b0] = shown
    .match(/(\d+\.\d{3}) to (\d+\.\d{3})/)!
    .slice(1)
    .map(Number) as [number, number];
  expect(b - a).toBeLessThan(b0 - a0);
  expect([await valueOf(page, "start"), await valueOf(page, "end")]).toEqual([start, end]);

  // a bracket moved by key keeps its meaning in whole-sound frames
  await handle(page, "start").focus();
  await page.keyboard.press("ArrowRight");
  expect(await valueOf(page, "start")).toBe(start + 48);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("zoom-window")).toHaveCount(0);
  expect(await valueOf(page, "end")).toBe(end);
});

test("zoom on a cut that covers the whole sound visibly zooms in at once, brackets unchanged", async ({
  page,
}) => {
  await page.goto(link(`0-${FIRST.frames}`));
  await ready(page);
  const [start, end] = [await valueOf(page, "start"), await valueOf(page, "end")];
  await page.getByTestId("zoom-toggle").click();
  const text = await page.getByTestId("zoom-window").innerText();
  const [a, b] = text
    .match(/(\d+\.\d{3}) to (\d+\.\d{3})/)!
    .slice(1)
    .map(Number) as [number, number];
  // a quarter of the sound, from its start, so turning zoom on shows a change
  expect(a).toBe(0);
  expect(b).toBeGreaterThan(0);
  expect(b).toBeLessThan((FIRST.frames / 48_000) * 0.3);
  expect([await valueOf(page, "start"), await valueOf(page, "end")]).toEqual([start, end]);
  // and fit the cut still comes back to the whole sound
  await page.getByRole("button", { name: "fit the cut" }).click();
  await expect(page.getByTestId("zoom-window")).toContainText(
    `${(FIRST.frames / 48_000).toFixed(3)}`,
  );
});

test("a speed typed as a percentage moves the speed control, and says when it snapped", async ({
  page,
}) => {
  await page.goto(link());
  await ready(page);
  const field = page.getByTestId("typed-speed");
  const said = page.getByTestId("typed-speed-said");
  const slider = page.getByRole("slider", { name: "speed" });
  const before = await slider.inputValue();

  await field.fill("100");
  await field.press("Enter");
  await expect(said).toHaveText("set to 100%");
  await expect(page.locator(".speed-readout .percent")).toHaveText("100%");
  expect(await slider.inputValue()).not.toBe(before);

  await field.fill("148");
  await field.press("Enter");
  await expect(said).toHaveText("set to 148%");
  await field.fill("210");
  await field.press("Enter");
  await expect(said).toContainText("snapped to 209%");
  await expect(said).toContainText("the nearest speed there is");

  await field.fill("abc");
  await field.press("Enter");
  await expect(said).toContainText("that is not a number");
  await field.fill("900");
  await field.press("Enter");
  await expect(said).toContainText("speeds go from 25 to 400 percent");
  // a refusal leaves the speed as it was
  await expect(page.locator(".speed-readout .percent")).not.toHaveText("900%");
});

test("a note on a sketch is kept with it, shown, edited and removed, and is stored as plain text", async ({
  page,
}) => {
  await page.goto(link());
  await ready(page);
  await page.getByTestId("sketch-note-add").click();
  await page.getByTestId("sketch-note").fill("from the tape at the lake");
  await page.getByRole("button", { name: "keep as sketch" }).click();
  await expect(page.getByTestId("sketch-note-text")).toHaveText("from the tape at the lake");
  const book = await page.evaluate(
    (key) =>
      JSON.parse(localStorage.getItem(key) ?? "null") as { sketches: Array<{ note?: string }> },
    KEY,
  );
  expect(book.sketches[0]?.note).toBe("from the tape at the lake");

  await page.getByTestId("sketch-note-open").click();
  await page.getByTestId("sketch-note-edit").fill("second thoughts, see example.com");
  await page.getByRole("button", { name: "save the note" }).click();
  await expect(page.getByTestId("sketch-note-text")).toHaveText("second thoughts, see");
  await expect(page.getByText("a link or a handle was removed from the note")).toBeVisible();

  await page.getByTestId("sketch-note-open").click();
  await page.getByTestId("sketch-note-edit").fill("");
  await page.getByRole("button", { name: "remove the note" }).click();
  await expect(page.getByTestId("sketch-note-text")).toHaveCount(0);
  const after = await page.evaluate(
    (key) =>
      JSON.parse(localStorage.getItem(key) ?? "null") as { sketches: Array<{ note?: string }> },
    KEY,
  );
  expect("note" in (after.sketches[0] ?? {})).toBe(false);
});

test("a note that breaks the rules is not kept and says why", async ({ page }) => {
  await page.goto(link());
  await ready(page);
  await page.getByTestId("sketch-note-add").click();
  await page.getByTestId("sketch-note").fill("x".repeat(139) + "​");
  await page.getByRole("button", { name: "keep as sketch" }).click();
  await expect(page.getByText(/the note has a character that is not allowed/)).toBeVisible();
  await expect(page.getByTestId("sketch-note-text")).toHaveCount(0);
});

test("the editor with its aids has no accessibility violations", async ({ page }, info) => {
  await page.goto(link());
  await ready(page);
  await page.getByTestId("zoom-toggle").click();
  await scan(page, "make: cut editor with zoom on", info);
});
