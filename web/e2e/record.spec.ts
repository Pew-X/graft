// The record, driven in real Chromium at a phone viewport. The record is a canvas, so points on it
// come from the same layout the page paints with (lib/record/disc.ts). Where a test needs the deepest
// chain (twelve stages, thirteen slots) it mounts the real roll over twelve stages, served from the
// site's own origin so the audio files load; nothing test-only is part of the site.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { themeCss } from "../lib/theme/tokens.ts";
import { bandOuter, layout, pointOn } from "./disc.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const here = dirname(fileURLToPath(import.meta.url));
const roll = (page: Page) => page.locator(".roll");
const slider = (page: Page) => page.getByRole("slider", { name: "the record" });
const ready = (page: Page) => expect(roll(page)).toHaveAttribute("data-audio", "ready");

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

test("the record is painted: the label is the dye of the stage in view, and grooves are on the disc", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  await page.waitForTimeout(300);
  const l = layout(390, 844, 4);
  // A point inside the label, above its centre, and one on a groove band of the source.
  const label = { x: l.cx, y: l.cy - l.Ri * 0.6 };
  const groove = await pointOn(page, 4, 0, 0.5);
  const pixel = (p: { x: number; y: number }) =>
    page.locator("canvas.disc").evaluate((c: HTMLCanvasElement, q) => {
      const dpr = c.width / c.clientWidth;
      return [
        ...c.getContext("2d")!.getImageData(Math.round(q.x * dpr), Math.round(q.y * dpr), 1, 1)
          .data,
      ];
    }, p);
  // At rest the finished flip (stage 4, magenta) is the one in view.
  const [r = 0, g = 0, b = 0, a = 0] = await pixel(label);
  expect(a).toBe(255);
  expect(Math.abs(r - 0xc2)).toBeLessThan(30);
  expect(Math.abs(g - 0x30)).toBeLessThan(30);
  expect(Math.abs(b - 0x7a)).toBeLessThan(30);
  // The disc itself is dark where there is a gap between grooves, and painted (not transparent).
  expect((await pixel(groove))[3]).toBe(255);
});

test("a tap on a slot auditions that stage from that point, and the labels do the same", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  // Stage 2 (slot 1) is 0.6 s long: a quarter of the way in is 0.15 s.
  const { x, y } = await pointOn(page, 4, 1, 0.25);
  await page.touchscreen.tap(x, y);
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  await expect(roll(page)).toHaveAttribute("data-stage", "1");
  const now = Number(await slider(page).getAttribute("aria-valuenow"));
  expect(now).toBeGreaterThan(130);
  expect(now).toBeLessThan(170);
  await expect(page.locator('.block[data-current="true"] .title')).toHaveText("up a fifth");

  // Parity: the plain control reaches the same state (by keyboard: on a phone only the stage in view is touchable).
  await page.reload();
  await ready(page);
  await page.getByRole("button", { name: /up a fifth/ }).focus();
  await page.keyboard.press("Enter");
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  await expect(roll(page)).toHaveAttribute("data-stage", "1");
});

test("dragging across slots scrubs, the roll follows, and releasing carries on from there", async ({
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
  const from = await pointOn(page, 4, 0, 0.2);
  const through = await pointOn(page, 4, 1, 0.5);
  const to = await pointOn(page, 4, 2, 0.5);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(through.x, through.y, { steps: 12 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await expect(roll(page)).toHaveAttribute("data-stage", "2");
  await page.mouse.up();
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

  // At rest the cursor is on the finished flip (stage 4, 1.2 s); back to the source by ArrowUp.
  await expect(slider(page)).toHaveAttribute(
    "aria-valuetext",
    /^stage 4 of 4, down an octave, 0\.0 of 1\.2 seconds$/,
  );
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(slider(page)).toHaveAttribute(
    "aria-valuetext",
    "stage 1 of 4, dm9 chord, 0.2 of 1.2 seconds",
  );
  await page.keyboard.press("ArrowDown");
  // Two tenths of 1.2 s is a sixth of the way in; a sixth of the 0.6 s stage is 0.1 s.
  await expect(slider(page)).toHaveAttribute(
    "aria-valuetext",
    "stage 2 of 4, up a fifth, 0.1 of 0.6 seconds",
  );
  await page.keyboard.press("Enter");
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  await expect(roll(page)).toHaveAttribute("data-stage", "1");
});

test("twelve stages: thirteen slots, every label a 44 px target, and a shaking pointer does not flicker", async ({
  page,
}) => {
  await openLong(page);
  expect(layout(390, 844, 12).slots).toBe(13);
  const labels = page.locator(".slab button");
  await expect(labels).toHaveCount(12);
  for (let i = 0; i < 12; i++) {
    const box = (await labels.nth(i).boundingBox())!;
    expect(box.height, `label ${i + 1}`).toBeGreaterThanOrEqual(44);
    expect(box.width, `label ${i + 1}`).toBeGreaterThanOrEqual(44);
  }

  // The pointer shakes within a fifth of a slot either side of the edge of slot 5, then walks out into slot 4.
  const l = layout(390, 844, 12);
  const pitch = l.slotW + l.gap;
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
  const start = await pointOn(page, 12, 5, 0.5);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const outer = bandOuter(l, 5);
  for (const d of [0.1, -0.15, 0.2, -0.1, 0.05, -0.2, 0.15, 0.4, 0.6, 0.9]) {
    // a point at `outer + d * pitch` from the centre, on the needle's line
    const r = outer + d * pitch;
    await page.mouse.move(l.cx, l.cy - r);
  }
  await page.mouse.up();
  const changes = seen.filter((s, i) => i === 0 || s !== seen[i - 1]);
  // It started in slot 5 and went to slot 4 exactly once, however the pointer shook on the edge.
  expect(changes).toEqual(["5", "4"]);
});

test("the disc keeps frames flowing while a stage plays", async ({ page }) => {
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

// The frame budget, stated with numbers. Target: 60 frames a second (16.7 ms a frame). The CPU is slowed with
// the browser's own throttle (Chrome's DevTools call 4x "mid-tier mobile" and 6x "low-tier mobile") while the
// deepest chain (twelve stages, thirteen rings) plays. Measured on the builder's Mac, headless: the median
// stayed at 16.7 ms up to 40x. This is a proxy, not a phone: the real-phone check stays manual and is named
// as open in ARCHITECTURE.md. The record degrades to cached bands when the median of 30 frames passes 26 ms
// (lib/record/frames.ts).
//
// The numbers are GATES only when GRAFT_FRAME_BUDGET=strict (scripts/precheck.sh --full sets it, on a
// machine nobody else is using): a shared CI runner renders in software and is noisy, and a threshold
// calibrated on one laptop would fail there at random, which is worse than no gate. Everywhere else the
// run records the numbers as annotations and asserts what the visitor gets whichever drawing it settled on.
const strictBudget = process.env["GRAFT_FRAME_BUDGET"] === "strict";
for (const [rate, medianMs, p95Ms] of [
  [4, 20, 34],
  [6, 26, 50],
] as const) {
  test(`the thirteen-ring record plays at ${rate}x CPU slowdown (strict budget: median under ${medianMs} ms)`, async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page);
    await openLong(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    await page.getByRole("button", { name: "play", exact: true }).tap();
    await expect(roll(page)).toHaveAttribute("data-sounding", "true");
    await page.waitForTimeout(2500); // long enough for the governor to have judged 30 frames
    const gaps = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const out: number[] = [];
          let last = performance.now();
          const tick = (t: number): void => {
            out.push(t - last);
            last = t;
            if (out.length < 120) requestAnimationFrame(tick);
            else resolve(out);
          };
          requestAnimationFrame(tick);
        }),
    );
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    const mode = await page.locator(".record").getAttribute("data-record");
    test.info().annotations.push({
      type: `frame pacing at ${rate}x (ms)`,
      description: `median ${median.toFixed(1)}, p95 ${p95.toFixed(1)}, record ${mode}`,
    });
    if (strictBudget) {
      expect(median).toBeLessThan(medianMs);
      expect(p95).toBeLessThan(p95Ms);
    }
    // Whichever drawing it settled on, it is one of the two, and the sound never stopped.
    expect(["live", "cached"]).toContain(mode);
    await expect(roll(page)).toHaveAttribute("data-sounding", "true");
  });
}

test("slow frames put the record back on a drawn copy of its grooves, and it still works", async ({
  page,
}) => {
  // Frames arrive every 70 ms, whatever the machine can do.
  await page.addInitScript(() => {
    window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 70);
    window.cancelAnimationFrame = (n) => window.clearTimeout(n);
  });
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "play", exact: true }).tap();
  await expect(page.locator(".record")).toHaveAttribute("data-record", "cached", {
    timeout: 15_000,
  });
  await expect(roll(page)).toHaveAttribute("data-sounding", "true");
  // The cached disc is still painted.
  const painted = await page.locator("canvas.disc").evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, Math.round(c.height * 0.8), c.width, 1).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
    return n;
  });
  expect(painted).toBeGreaterThan(100);
});

test("reduced motion: the record is still fully usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  const { x, y } = await pointOn(page, 4, 2, 0.5);
  await page.touchscreen.tap(x, y);
  await expect(roll(page)).toHaveAttribute("data-stage", "2");
  // That nothing turns is checked where it can be exact: the painter draws no rotation in reduced motion
  // (lib/record/paint.test.ts). Here, the page says it is in that mode and the record still answers.
  await expect(roll(page)).toHaveAttribute("data-reduced", "true");
});

test("no stage is told apart by colour alone: every title has its numeral, and the control says the title", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  await expect(page.locator(".block .numeral")).toHaveText(["1", "2", "3", "4"]);
  const { x, y } = await pointOn(page, 4, 3, 0.4);
  await page.touchscreen.tap(x, y);
  await expect(slider(page)).toHaveAttribute("aria-valuetext", /stage 4 of 4, down an octave/);
});
