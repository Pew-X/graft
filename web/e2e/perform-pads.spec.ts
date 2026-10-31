// The pad bank: one pad for every stage, numbered like its ring, doing exactly what its number key does,
// by mouse, by touch (two fingers at once) and by keyboard. Driven in real Chromium over the built site,
// and over the twelve-stage roll on a page of its own (no site around it).
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scan, smallTargets } from "./a11y.ts";
import { openLong } from "./long-page.ts";

const here = dirname(fileURLToPath(import.meta.url));
const chain = JSON.parse(readFileSync(join(here, "..", "snapshot", "chain.json"), "utf8")) as {
  stages: Array<{ frames: number; title: string }>;
};
const FRAMES = chain.stages.map((s) => s.frames);

declare global {
  interface Window {
    __started: number[];
  }
}

async function spy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__started = [];
    const Real = window.AudioContext;
    window.AudioContext = class extends Real {
      override createBufferSource(): AudioBufferSourceNode {
        const source = super.createBufferSource();
        const start = source.start.bind(source);
        source.start = (...args: Parameters<typeof start>) => {
          window.__started.push(source.buffer?.length ?? 0);
          return start(...args);
        };
        return source;
      }
    };
  });
}
const roll = (page: Page) => page.locator(".roll");
const toggle = (page: Page) => page.getByRole("button", { name: "perform", exact: true });
const pad = (page: Page, n: number) => page.locator(`.pad[data-pad="${n}"]`);
const started = (page: Page) => page.evaluate(() => window.__started);

async function home(page: Page): Promise<void> {
  await spy(page);
  await page.goto("/");
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
  await toggle(page).click();
  await expect(roll(page)).toHaveAttribute("data-latency", /\d/);
}

test("a pad for every stage, numbered like its ring, named for a reader of the screen", async ({
  page,
}) => {
  await home(page);
  await expect(page.locator(".pad")).toHaveCount(4);
  for (const [i, stage] of chain.stages.entries()) {
    await expect(pad(page, i)).toHaveAccessibleName(`stage ${i + 1}, ${stage.title}`);
    await expect(pad(page, i)).toHaveAttribute("aria-keyshortcuts", String(i + 1));
    await expect(pad(page, i).locator(".pad-n")).toHaveText(String(i + 1));
  }
  await expect(page.getByRole("group", { name: "the stages, as pads" })).toBeVisible();
});

test("a mouse press on a pad plays that stage once, on the press itself", async ({ page }) => {
  await home(page);
  await pad(page, 2).hover();
  await page.mouse.down();
  // sounding before the button is released: it does not wait for the click
  expect(await started(page)).toEqual([FRAMES[2]]);
  await page.mouse.up();
  expect(await started(page)).toEqual([FRAMES[2]]);
  await expect(roll(page)).toHaveAttribute("data-hero", "2");
});

test("the keyboard reaches the pads: Tab, then Enter or Space plays, once each", async ({
  page,
}) => {
  await home(page);
  await pad(page, 1).focus();
  await page.keyboard.press("Enter");
  expect(await started(page)).toEqual([FRAMES[1]]);
  await page.keyboard.press("Space");
  expect(await started(page)).toEqual([FRAMES[1], FRAMES[1]]);
  await expect(pad(page, 1)).toBeFocused();
});

test("two fingers play two pads at once, each tracked by its own pointer", async ({ page }) => {
  await home(page);
  await page.getByRole("button", { name: "overlap", exact: true }).click();
  await page.evaluate(() => {
    const down = (el: Element, id: number): void => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerId: id,
          pointerType: "touch",
          isPrimary: id === 1,
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height / 2,
          bubbles: true,
        }),
      );
    };
    down(document.querySelector('.pad[data-pad="0"]')!, 1);
    down(document.querySelector('.pad[data-pad="3"]')!, 2);
  });
  expect(await started(page)).toEqual([FRAMES[0], FRAMES[3]]);
  await expect(pad(page, 0)).toHaveAttribute("data-sounding", "true");
  await expect(pad(page, 3)).toHaveAttribute("data-sounding", "true");
});

test("a press shows in the same frame: the pad, the roll and the large stage agree", async ({
  page,
}) => {
  await home(page);
  const seen = await page.evaluate(
    () =>
      new Promise<Record<string, string | null>>((resolve) => {
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit4", bubbles: true }));
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const rollEl = document.querySelector(".roll")!;
            resolve({
              pad: document.querySelector('.pad[data-pad="3"]')!.getAttribute("data-sounding"),
              hero: rollEl.getAttribute("data-hero"),
              sounding: rollEl.getAttribute("data-sounding"),
              current: document.querySelector('.pad[data-pad="3"]')!.getAttribute("aria-current"),
            });
          }),
        );
      }),
  );
  expect(seen).toEqual({ pad: "true", hero: "3", sounding: "true", current: "true" });
});

test("a sounding pad is lit, goes dark when its sound ends or is stopped, and cut keeps one lit", async ({
  page,
}) => {
  await home(page);
  await page.keyboard.press("Digit1");
  await page.keyboard.press("Digit2");
  await expect(pad(page, 1)).toHaveAttribute("data-sounding", "true");
  await expect(pad(page, 0)).toHaveAttribute("data-sounding", "false");
  await page.getByRole("button", { name: "stop", exact: true }).click();
  await expect(pad(page, 1)).toHaveAttribute("data-sounding", "false");
  await expect(roll(page)).toHaveAttribute("data-perform", "true");
});

test("one at a time and overlap are a labelled pair, each says what it does, and overlap lets pads sound together", async ({
  page,
}) => {
  await home(page);
  const group = page.getByRole("group", { name: "when you press another pad" });
  const says = page.getByTestId("rule-says");
  await expect(group.getByRole("button", { name: "one at a time" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(says).toHaveText("a new pad stops the last one.");
  await group.getByRole("button", { name: "overlap" }).click();
  await expect(group.getByRole("button", { name: "overlap" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(says).toHaveText("pads sound together, up to six.");
  await page.keyboard.press("Digit1");
  await page.keyboard.press("Digit2");
  await expect(pad(page, 0)).toHaveAttribute("data-sounding", "true");
  await expect(pad(page, 1)).toHaveAttribute("data-sounding", "true");
});

test("with the bank up the page has no serious accessibility violation and every control is 44 px", async ({
  page,
}, info) => {
  await home(page);
  await page.keyboard.press("Digit2");
  await scan(page, "perform", info);
  expect(await smallTargets(page)).toEqual([]);
});

test("entering and leaving perform does not move the header, the title or the transport", async ({
  page,
}) => {
  await spy(page);
  await page.goto("/");
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
  const place = () =>
    page.evaluate(() => {
      const box = (sel: string) => {
        const r = document.querySelector(sel)!.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      };
      return {
        bar: box(".bar"),
        slab: box('.block[data-hero="true"] .slab'),
        controls: box(".controls"),
      };
    });
  const before = await place();
  await toggle(page).click();
  await expect(page.locator(".bank")).toBeVisible();
  await page.waitForTimeout(500);
  const during = await place();
  expect(during.bar).toEqual(before.bar);
  expect(during.controls).toEqual(before.controls);
  // the title stays where it is (to a pixel), though the details below it make room
  expect(during.slab[1]).toBeGreaterThanOrEqual(before.slab[1]! - 2);
  expect(during.slab[1]).toBeLessThanOrEqual(before.slab[1]! + 40);
  await page.keyboard.press("Escape");
  await expect(page.locator(".bank")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await place()).toEqual(before);
});

test("with reduced motion a pressed pad shows a lit state and plays no animation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await home(page);
  await page.keyboard.press("Digit1");
  await expect(pad(page, 0)).toHaveAttribute("data-sounding", "true");
  const animation = await pad(page, 0).evaluate((el) => getComputedStyle(el).animationName);
  expect(animation).toBe("none");
});

test("twelve pads on the twelve-stage roll, the last three marked with their keys 0, minus and equal", async ({
  page,
}) => {
  await openLong(page);
  await toggle(page).click();
  await expect(page.locator(".pad")).toHaveCount(12);
  await expect(pad(page, 9).locator(".pad-key")).toHaveText("0");
  await expect(pad(page, 10).locator(".pad-key")).toHaveText("-");
  await expect(pad(page, 11).locator(".pad-key")).toHaveText("=");
  await expect(pad(page, 3).locator(".pad-key")).toHaveCount(0);
  await expect(pad(page, 11)).toHaveAttribute("aria-keyshortcuts", "=");
  // four across
  const xs = await page
    .locator(".pad")
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)));
  expect(new Set(xs).size).toBe(4);
});

// Eight presses a second on the deepest chain with the CPU slowed. The numbers are gates only under
// GRAFT_FRAME_BUDGET=strict (see record.spec.ts for why); everywhere else they are recorded.
test("eight presses a second on twelve pads at 4x CPU slowdown keeps the frame budget", async ({
  page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  await openLong(page);
  await toggle(page).click();
  await expect(page.locator(".pad")).toHaveCount(12);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const gaps = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const out: number[] = [];
        let last = performance.now();
        let n = 0;
        const codes = [
          "Digit1",
          "Digit2",
          "Digit3",
          "Digit4",
          "Digit5",
          "Digit6",
          "Digit7",
          "Digit8",
        ];
        const press = window.setInterval(() => {
          window.dispatchEvent(
            new KeyboardEvent("keydown", { code: codes[n++ % 8]!, bubbles: true }),
          );
        }, 125);
        const tick = (t: number): void => {
          out.push(t - last);
          last = t;
          if (out.length < 120) requestAnimationFrame(tick);
          else {
            window.clearInterval(press);
            resolve(out);
          }
        };
        requestAnimationFrame(tick);
      }),
  );
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  test.info().annotations.push({
    type: "frame pacing while performing at 4x (ms)",
    description: `median ${median.toFixed(1)}, p95 ${p95.toFixed(1)}`,
  });
  if (process.env["GRAFT_FRAME_BUDGET"] === "strict") {
    expect(median).toBeLessThan(20);
    expect(p95).toBeLessThan(34);
  }
  // the page still answers: the last pad pressed is lit
  await expect(page.locator('.pad[data-sounding="true"]')).toHaveCount(1);
});

// Every length a lineage can have. The service's deepest chain is twelve (the number row); a deeper one
// (a raised cap, or a page cut short) has pads that no key reaches.
for (const n of [1, 2, 4, 9, 10, 12, 14]) {
  test(`a chain of ${n}: ${n === 1 ? "nothing to perform, so no control" : "pads, keys and numbers agree"}`, async ({
    page,
  }) => {
    await spy(page);
    await openLong(page, n);
    if (n === 1) {
      await expect(toggle(page)).toHaveCount(0);
      return;
    }
    await toggle(page).click();
    await expect(roll(page)).toHaveAttribute("data-latency", /\d/);
    await expect(page.locator(".pad")).toHaveCount(n);
    const numerals = await page.locator(".pad .pad-n").allInnerTexts();
    expect(numerals).toEqual(Array.from({ length: n }, (_, i) => String(i + 1)));
    // each key that exists plays its own stage, and the large stage's number is the pad's
    const keys = [
      "Digit1",
      "Digit2",
      "Digit3",
      "Digit4",
      "Digit5",
      "Digit6",
      "Digit7",
      "Digit8",
      "Digit9",
      "Digit0",
      "Minus",
      "Equal",
    ];
    for (const [i, code] of keys.entries()) {
      if (i >= n) {
        const before = (await started(page)).length;
        await page.keyboard.press(code);
        expect((await started(page)).length, `${code} with only ${n} stages`).toBe(before);
        continue;
      }
      await page.keyboard.press(code);
      await expect(roll(page)).toHaveAttribute("data-hero", String(i));
      await expect(pad(page, i)).toHaveAttribute("data-sounding", "true");
      await expect(page.locator('.block[data-hero="true"]')).toContainText(
        `no. ${String(i + 1).padStart(2, "0")}`,
      );
    }
    // a pad past the twelfth has no key printed on it and still plays
    if (n > 12) {
      await expect(pad(page, 12).locator(".pad-key")).toHaveCount(0);
      await pad(page, 13).focus();
      await page.keyboard.press("Enter");
      await expect(roll(page)).toHaveAttribute("data-hero", "13");
      await expect(
        page.getByRole("status").filter({ hasText: "the pads play them all" }).first(),
      ).toBeVisible();
    }
  });
}

test("the pads' corners show what is printed on a non-US layout's keys, and the keys still play by position", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const azerty = new Map([
      ["Digit0", "à"],
      ["Minus", ")"],
      ["Equal", "="],
    ]);
    Object.defineProperty(navigator, "keyboard", {
      value: { getLayoutMap: async () => azerty },
      configurable: true,
    });
  });
  await spy(page);
  await openLong(page);
  await toggle(page).click();
  await expect(pad(page, 9).locator(".pad-key")).toHaveText("à");
  await expect(pad(page, 10).locator(".pad-key")).toHaveText(")");
  await expect(pad(page, 11).locator(".pad-key")).toHaveText("=");
  await expect(pad(page, 9)).toHaveAttribute("aria-keyshortcuts", "à");
  // the label changes nothing about the key: the tenth position plays stage 10 on any layout
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit0", key: "à", bubbles: true }));
  });
  await expect(roll(page)).toHaveAttribute("data-hero", "9");
});

test("without a keyboard map a pad's key says where it is in plain words", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "keyboard", { value: undefined, configurable: true });
  });
  await spy(page);
  await openLong(page);
  await toggle(page).click();
  await expect(pad(page, 10)).toHaveAttribute("title", "top row, 11th key");
  await expect(pad(page, 10).locator(".pad-key")).toHaveText("-");
});

test("while the sounds are still loading there is nothing to perform with, and the keys do nothing", async ({
  page,
}) => {
  await spy(page);
  await page.route("**/seed/*.pcm", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto("/");
  await expect(roll(page)).toHaveAttribute("data-audio", "loading");
  await expect(toggle(page)).toHaveCount(0);
  await page.keyboard.press("Digit1");
  expect(await started(page)).toEqual([]);
  await expect(roll(page)).toHaveAttribute("data-audio", "ready", { timeout: 15_000 });
  await expect(toggle(page)).toBeVisible();
});

test("a held Enter on a focused pad plays it once, not thirty times a second", async ({ page }) => {
  await home(page);
  await pad(page, 1).focus();
  // the browser repeats keydown while a key is held: the second down is a repeat
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  expect(await started(page)).toEqual([FRAMES[1]]);
});
