// The first screen must never hide what it says. Found on the live site by looking, at ordinary
// laptop heights: the status pill sat on the stage's credit lines (covering a state word), the
// stage was cut mid-line by a hard clip, and in portrait the two plain lines had an opaque backing
// that painted over the record's rings and the tonearm. Each test names the guarantee.
// Driven in real Chromium against the built site, at the sizes people actually have.
import { expect, test, type Page } from "@playwright/test";

const SIZES = [
  { name: "13-inch laptop", width: 1280, height: 720 },
  { name: "laptop window", width: 1384, height: 797 },
  { name: "laptop window, taller", width: 1433, height: 840 },
  { name: "large laptop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
  { name: "small phone", width: 360, height: 640 },
  { name: "tall tablet", width: 676, height: 1000 },
] as const;

type Box = { x: number; y: number; w: number; h: number };

async function rect(page: Page, selector: string): Promise<Box | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return null;
    const r = el.getBoundingClientRect();
    return r.width < 1 || r.height < 1 ? null : { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
}

const overlap = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  // the roll slides to the stage in view, then rests
  await page.waitForTimeout(900);
}

for (const size of SIZES) {
  test.describe(`${size.name} ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("the stage in view stops above the status text, the controls and the footer", async ({
      page,
    }) => {
      await open(page);
      const article = await rect(page, '.block[data-hero="true"] > article');
      expect(article).not.toBeNull();
      const others: Record<string, Box | null> = {
        notes: await rect(page, ".notes"),
        controls: await rect(page, ".controls"),
        footer: await rect(page, ".roll .footer"),
      };
      for (const [name, box] of Object.entries(others)) {
        if (!box) continue;
        expect(
          overlap(article!, box),
          `the stage in view runs under the ${name}`,
        ).toBeLessThanOrEqual(4);
      }
      expect(article!.y, "the stage starts under the header").toBeGreaterThanOrEqual(60);
    });

    test("the first credit line is whole on screen, and more below says so", async ({ page }) => {
      await open(page);
      // On a very short screen (under 700 px) the slab and the button already fill the room, so what is
      // required there is that the button is whole and that the stage says there is more.
      const short = size.height < 700;
      const result = await page.evaluate((short) => {
        const article = document.querySelector<HTMLElement>('.block[data-hero="true"] > article');
        const line = article?.querySelector<HTMLElement>(short ? ".flip" : ".face .line");
        if (!article || !line) return null;
        const a = article.getBoundingClientRect();
        const l = line.getBoundingClientRect();
        const more = article.scrollHeight - article.scrollTop - article.clientHeight > 2;
        return {
          lineWhole: l.top >= a.top && l.bottom <= a.bottom + 1,
          more,
          flag: article.dataset["more"],
        };
      }, short);
      expect(result, "no stage in view").not.toBeNull();
      expect(
        result!.lineWhole,
        short
          ? "the flip button is cut off before anything is scrolled"
          : "the first credit line is cut off before anything is scrolled",
      ).toBe(true);
      // hidden rows are never a silent hard cut: the stage says there is more, and the cue is a fade
      expect(result!.flag, "more below, but nothing says so").toBe(String(result!.more));
    });

    test("every state word of the stage in view can be reached and is not covered", async ({
      page,
    }) => {
      await open(page);
      const states = page.locator('.block[data-hero="true"] > article .face .state');
      const count = await states.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const state = states.nth(i);
        await state.scrollIntoViewIfNeeded();
        const covered = await state.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(
            r.x + Math.min(r.width / 2, 20),
            r.y + r.height / 2,
          );
          return !(top === el || el.contains(top));
        });
        expect(covered, `state word ${i + 1} is covered by something`).toBe(false);
      }
    });

    test("no opaque panel hides the record, apart from the status pill and the controls", async ({
      page,
    }) => {
      await open(page);
      const hidden = await page.evaluate(() => {
        const disc = document.querySelector(".record .disc")?.getBoundingClientRect();
        if (!disc) return ["no record"];
        // the record's circle, as lib/record/disc.ts lays it out
        const { width: w0, height: h0 } = disc;
        const portrait = w0 < h0 * 0.9;
        const R = portrait ? Math.min(w0 * 0.9, h0 * 0.42) : Math.min(h0 * 0.68, w0 * 0.46);
        const cx = portrait ? w0 / 2 : w0 + R * 0.04;
        const cy = portrait ? h0 + R * 0.1 : h0 / 2;
        const bad: string[] = [];
        for (const el of document.querySelectorAll(".roll *")) {
          if (el.closest(".record, .controls, .bar, .coach")) continue;
          if (el.matches(".notes .status, .roll .footer, .record-caption")) continue;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") continue;
          const bg = style.backgroundColor
            .match(/rgba?\(([^)]+)\)/)?.[1]
            ?.split(",")
            .map(Number);
          const alpha = bg ? (bg.length === 4 ? (bg[3] ?? 1) : 1) : 0;
          if (alpha < 0.9) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.height < 24) continue;
          // sample the panel on a grid: how much of it lies over the record's rings
          let over = 0;
          for (let i = 0; i < 12; i++) {
            for (let j = 0; j < 12; j++) {
              const x = r.left + ((i + 0.5) / 12) * r.width;
              const y = r.top + ((j + 0.5) / 12) * r.height;
              if (Math.hypot(x - cx, y - cy) < R) over++;
            }
          }
          if (over >= 14) bad.push(String(el.className || el.tagName));
        }
        return bad;
      });
      expect(hidden, "an opaque panel is drawn over the record").toEqual([]);
    });
  });
}
