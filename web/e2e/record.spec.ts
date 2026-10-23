// The record, driven in real Chromium at a phone viewport. Where a test needs the deepest chain
// (twelve stages, thirteen rings) it mounts the real roll over twelve stages, served from the site's
// own origin so the audio files load; nothing test-only is part of the site.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { layout } from "../lib/record/geometry.ts";
import { themeCss } from "../lib/theme/tokens.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const here = dirname(fileURLToPath(import.meta.url));
const roll = (page: Page) => page.locator(".roll");
const slider = (page: Page) => page.getByRole("slider", { name: "the record" });
const ready = (page: Page) => expect(roll(page)).toHaveAttribute("data-audio", "ready");

/** Where, in page pixels, a point on a band at a share of the way round (0 to 1) sits. */
async function pointOn(page: Page, stages: number, band: number, turn: number, drift = 0) {
  const box = (await slider(page).boundingBox())!;
  const geometry = layout(stages);
  const mid = geometry.radius - (band + 0.5) * geometry.thickness + drift;
  const scale = box.width / (2 * geometry.radius);
  const a = turn * 2 * Math.PI;
  return {
    x: box.x + box.width / 2 + mid * scale * Math.sin(a),
    y: box.y + box.height / 2 - mid * scale * Math.cos(a),
  };
}

async function openLong(page: Page): Promise<void> {
  const css = readFileSync(join(here, "..", "app", "roll.css"), "utf8");
  await page.route("**/long-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${themeCss()}${css}</style></head><body><main><div id="root"></div></main><script src="/long.js"></script></body></html>`,
    }),
  );
  await page.route("**/long.js", (route) =>
    route.fulfill({ contentType: "text/javascript", path: join(here, "dist", "long.js") }),
  );
  await page.goto("/long-fixture");
  await ready(page);
}

test("a tap on a band auditions that stage from that point, and the label list does the same", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  // Stage 2 (index 1) is 0.6 s long: a quarter of the way round is 0.15 s in.
  const { x, y } = await pointOn(page, 4, 1, 0.25);
  await page.touchscreen.tap(x, y);
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  await expect(roll(page)).toHaveAttribute("data-stage", "1");
  const now = Number(await slider(page).getAttribute("aria-valuenow"));
  expect(now).toBeGreaterThan(130);
  expect(now).toBeLessThan(170);
  await expect(page.locator('.block[data-current="true"] .title')).toHaveText("up a fifth");

  // Parity: the plain control reaches the same state.
  await page.reload();
  await ready(page);
  await page.getByRole("button", { name: /up a fifth/ }).tap();
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  await expect(roll(page)).toHaveAttribute("data-stage", "1");
});

test("dragging across bands scrubs, the roll follows, and releasing carries on from there", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  const seen: string[] = [];
  await page.exposeFunction("stageSeen", (s: string) => seen.push(s));
  await page.evaluate(() => {
    const el = document.querySelector(".roll")!;
    new MutationObserver(() => {
      void (window as unknown as { stageSeen: (s: string) => void }).stageSeen(
        el.getAttribute("data-stage") ?? "",
      );
    }).observe(el, { attributes: true, attributeFilter: ["data-stage"] });
  });
  const from = await pointOn(page, 4, 0, 0.1);
  const through = await pointOn(page, 4, 1, 0.3);
  const to = await pointOn(page, 4, 2, 0.5);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(through.x, through.y, { steps: 12 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await expect(roll(page)).toHaveAttribute("data-stage", "2");
  await page.mouse.up();
  // It carries on from the release point: still an audition of stage 3, sounding or just ended.
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  await expect(roll(page)).toHaveAttribute("data-stage", "2");
  expect([...new Set(seen)]).toEqual(["0", "1", "2"]);
  await expect(page.locator('.block[data-current="true"] .title')).toHaveText("down a fifth");
});

test("the slider is a keyboard control: arrows move within and between stages, Enter plays", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  await slider(page).focus();
  const outline = await slider(page).evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(2);

  await expect(slider(page)).toHaveAttribute(
    "aria-valuetext",
    "stage 1 of 4, dm9 chord, 0.0 of 1.2 seconds",
  );
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(slider(page)).toHaveAttribute(
    "aria-valuetext",
    "stage 1 of 4, dm9 chord, 0.2 of 1.2 seconds",
  );
  await page.keyboard.press("ArrowDown");
  // Two tenths of 1.2 s is a sixth of the way round; a sixth of the 0.6 s stage is 0.1 s.
  await expect(slider(page)).toHaveAttribute(
    "aria-valuetext",
    "stage 2 of 4, up a fifth, 0.1 of 0.6 seconds",
  );
  await page.keyboard.press("Enter");
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  await expect(roll(page)).toHaveAttribute("data-stage", "1");
});

test("twelve stages: thirteen rings, every label a 44 px target, and a shaking pointer does not flicker", async ({
  page,
}) => {
  await openLong(page);
  await expect(page.locator(".record .band")).toHaveCount(12);
  await expect(page.locator(".record .empty-slot")).toHaveCount(1);
  const labels = page.locator(".slab button");
  await expect(labels).toHaveCount(12);
  for (let i = 0; i < 12; i++) {
    const box = (await labels.nth(i).boundingBox())!;
    expect(box.height, `label ${i + 1}`).toBeGreaterThanOrEqual(44);
    expect(box.width, `label ${i + 1}`).toBeGreaterThanOrEqual(44);
  }

  // Bands are 6 units thick here. The edge between band 5 and band 6 is 6 units from the middle of
  // band 5; the stylus changes band only when the pointer is 1.5 units past it.
  const seen: string[] = [];
  await page.exposeFunction("stageSeen", (s: string) => seen.push(s));
  await page.evaluate(() => {
    const el = document.querySelector(".roll")!;
    new MutationObserver(() =>
      (window as unknown as { stageSeen: (s: string) => void }).stageSeen(
        el.getAttribute("data-stage") ?? "",
      ),
    ).observe(el, { attributes: true, attributeFilter: ["data-stage"] });
  });
  // Drift is measured from the middle of band 5; the edge to band 6 is at +3 inward, i.e. drift -3.
  const path = [
    0, -2.5, -3.4, -2.9, -3.8, -3.0, -4.2, -3.3, -4.4, -3.6, -4.45, -4.6, -5.2, -4.9, -5.5,
  ];
  const start = await pointOn(page, 12, 5, 0.2, path[0]!);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const drift of path.slice(1)) {
    const p = await pointOn(page, 12, 5, 0.2, drift);
    await page.mouse.move(p.x, p.y);
  }
  await page.mouse.up();
  const changes = seen.filter((s, i) => i === 0 || s !== seen[i - 1]);
  // It started in band 5 and went to band 6 exactly once, however the pointer shook on the edge.
  expect(changes).toEqual(["5", "6"]);
});

test("the stylus keeps frames flowing while a stage plays", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "play", exact: true }).tap();
  await expect(roll(page)).toHaveAttribute("data-sounding", "true");
  const gaps = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const out: number[] = [];
        let last = performance.now();
        const tick = (t: number): void => {
          out.push(t - last);
          last = t;
          if (out.length < 90) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  test.info().annotations.push({
    type: "frame pacing (ms)",
    description: `median ${median.toFixed(1)}, p95 ${p95.toFixed(1)}`,
  });
  expect(median).toBeLessThan(25);
  await expect(page.locator(".record")).toHaveAttribute("data-record", "live");
});

test("slow frames put the record back on its cached bands", async ({ page }) => {
  // Frames arrive every 70 ms, whatever the machine can do.
  await page.addInitScript(() => {
    window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 70);
    window.cancelAnimationFrame = (n) => window.clearTimeout(n);
  });
  await page.goto("/");
  await ready(page);
  const band3 = page.locator('.record .band[data-stage="3"] .groove');
  const cached = await band3.getAttribute("d");
  await page.getByRole("button", { name: "play", exact: true }).tap();
  await expect(page.locator(".record")).toHaveAttribute("data-record", "cached", {
    timeout: 15_000,
  });
  // On the cached bands the groove under the stylus is the drawn one, not a pushed copy.
  await expect(band3).toHaveAttribute("d", cached!);
  // And the instrument still works.
  await expect(roll(page)).toHaveAttribute("data-sounding", "true");
});

test("reduced motion: the record does not spin and is still fully usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  const animated = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => (a.effect as KeyframeEffect | null)?.target?.closest(".record")).length,
  );
  expect(animated).toBe(0);
  const { x, y } = await pointOn(page, 4, 2, 0.5);
  await page.touchscreen.tap(x, y);
  await expect(roll(page)).toHaveAttribute("data-stage", "2");
});

test("no stage is told apart by colour alone: the label shows its numeral and the control its title", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  await expect(page.locator(".record .label-numeral")).toHaveText("1");
  const { x, y } = await pointOn(page, 4, 3, 0.4);
  await page.touchscreen.tap(x, y);
  await expect(page.locator(".record .label-numeral")).toHaveText("4");
  await expect(slider(page)).toHaveAttribute("aria-valuetext", /stage 4 of 4, down an octave/);
});
