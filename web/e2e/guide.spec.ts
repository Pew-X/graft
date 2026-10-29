// The first-visit guide: what a stranger reads before they touch anything, the narration that rides on
// their first play, and two small hints after it. Each test names the guarantee it protects. These specs
// start with empty storage (every other spec starts as a visitor who has finished the guide). Driven in
// real Chromium against the built site.
import { expect, test, type Page } from "@playwright/test";
import { scan } from "./a11y.ts";
import { layout, pointOn } from "./disc.ts";
import { COACH_VALUES } from "../lib/coach/seen.ts";

test.use({ storageState: { cookies: [], origins: [] } });

const SIZES = [
  { name: "13-inch laptop", width: 1280, height: 720 },
  { name: "large laptop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
  { name: "small phone", width: 360, height: 640 },
  { name: "tall tablet", width: 676, height: 1000 },
] as const;

const SENTENCE = "a sound has a past. hear how this one was made, then make the next step.";
/** The seeded chain has four stages. */
const STAGES = 4;
/** What the roll says, moment by moment, for the seeded chain: wording hand-worked from its data. */
const NARRATION = [
  ["teaser:3", "this is the finished sound. now hear how it was made."],
  ["stage:0", "it began as “dm9 chord”."],
  ["stage:1", "then a piece was cut out and sped up."],
  ["stage:2", "then a piece was cut out and slowed down."],
  ["stage:3", "then a piece was cut out and slowed down."],
  ["rest:3", "that is how it was made. tap any ring to hear that step."],
] as const;

async function arrive(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
}
async function arriveWith(page: Page, value: string | null): Promise<void> {
  if (value !== null) {
    // seeded once per tab: a reload must keep what the page itself has stored since
    await page.addInitScript((v) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem("graft.coach", v);
        sessionStorage.setItem("seeded", "1");
      }
    }, value);
  }
  await arrive(page);
}

const caption = (page: Page) => page.getByTestId("narration");
const hint = (page: Page) => page.getByTestId("hint");
const play = (page: Page) => page.locator(".controls .primary");
const stored = (page: Page) => page.evaluate(() => localStorage.getItem("graft.coach"));

type Box = { x: number; y: number; w: number; h: number };
async function box(page: Page, selector: string): Promise<Box | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width < 1 ? null : { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
}
const overlap = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

test("before play a first visit shows the sentence and nothing else: no caption, no hint, nothing over the page", async ({
  page,
}) => {
  await arrive(page);
  await expect(page.locator(".bar .sentence")).toHaveText(SENTENCE);
  // the line over the controls says what the first play is, in the words of the sentence
  await expect(page.getByRole("status").first()).toContainText(
    "tap play to hear how this was made",
  );
  await page.waitForTimeout(1500);
  await expect(caption(page)).toHaveCount(0);
  await expect(hint(page)).toHaveCount(0);
  expect(await stored(page), "nothing is stored before the first play is over").toBeNull();
});

test("the first play is narrated in the order the sound plays, each caption on the step the engine is on", async ({
  page,
}) => {
  await arrive(page);
  // record every change of caption together with the engine's own step, from inside the page
  await page.evaluate(() => {
    const seen: Array<[string, string]> = [];
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    const roll = document.querySelector(".roll")!;
    const note = (): void => {
      const c = document.querySelector("[data-testid=narration]");
      if (!c) return;
      const entry: [string, string] = [
        c.getAttribute("data-moment")!,
        roll.getAttribute("data-step")!,
      ];
      const last = seen.at(-1);
      if (!last || last[0] !== entry[0]) seen.push(entry);
    };
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    });
  });
  await play(page).click();
  await expect(caption(page)).toHaveAttribute("data-moment", "rest:3", { timeout: 40_000 });
  const seen = await page.evaluate(() => (window as unknown as { __seen: string[][] }).__seen);
  expect(seen.map(([moment]) => moment)).toEqual(NARRATION.map(([moment]) => moment));
  // the caption of step n is only ever up while the engine is on step n
  expect(seen.map(([, step]) => Number(step))).toEqual([0, 1, 2, 3, 4, 5]);
  await expect(caption(page)).toContainText(NARRATION.at(-1)![1]);
});

test("each caption says what is true of its moment", async ({ page }) => {
  await arrive(page);
  await play(page).click();
  for (const [moment, text] of NARRATION) {
    await expect(caption(page)).toHaveAttribute("data-moment", moment, { timeout: 30_000 });
    await expect(caption(page)).toContainText(text);
  }
});

test("no caption names a maker", async ({ page }) => {
  await arrive(page);
  await play(page).click();
  await expect(caption(page)).toHaveAttribute("data-moment", "rest:3", { timeout: 40_000 });
  await expect(caption(page)).not.toContainText(/graft|\bby\b/i);
});

test("skip ends the captions, not the sound, and leads to the first hint and only that", async ({
  page,
}) => {
  await arrive(page);
  await play(page).click();
  await expect(caption(page)).toBeVisible();
  await caption(page).getByRole("button", { name: "skip" }).click();
  await expect(caption(page)).toHaveCount(0);
  await expect(page.locator(".roll")).toHaveAttribute("data-sounding", "true");
  await expect(hint(page)).toHaveCount(1);
  await expect(hint(page)).toContainText("drag the needle to hear any moment.");
  await expect(hint(page)).not.toContainText("mark it");
  expect(await stored(page)).toBe("narrated");
});

test("escape skips the narration", async ({ page }) => {
  await arrive(page);
  await play(page).click();
  await expect(caption(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(caption(page)).toHaveCount(0);
});

test("taking over ends it: pressing next, or tapping a ring, leaves the narration behind", async ({
  page,
}) => {
  await arrive(page);
  await play(page).click();
  await expect(caption(page)).toBeVisible();
  await page.getByRole("button", { name: "next stage" }).click();
  await expect(caption(page)).toHaveCount(0);
  await expect(page.locator(".roll")).toHaveAttribute("data-sounding", "true");
});

test("a second visit sees no narration and no hint", async ({ page }) => {
  await arriveWith(page, "done");
  await play(page).click();
  await expect(page.locator(".roll")).toHaveAttribute("data-sounding", "true");
  await page.waitForTimeout(1500);
  await expect(caption(page)).toHaveCount(0);
  await expect(hint(page)).toHaveCount(0);
});

test("a browser that kept the earlier coach's word is shown the new narration once", async ({
  page,
}) => {
  await arriveWith(page, "seen");
  await play(page).click();
  await expect(caption(page)).toBeVisible();
});

test("how it works in the footer plays the narration again from the start, and the hints again", async ({
  page,
}) => {
  await arriveWith(page, "done");
  await page.getByRole("button", { name: "how it works" }).click();
  await expect(page.locator(".roll")).toHaveAttribute("data-sounding", "true");
  await expect(caption(page)).toHaveAttribute("data-moment", "teaser:3");
  await caption(page).getByRole("button", { name: "skip" }).click();
  await expect(hint(page)).toContainText("drag the needle");
  expect(await stored(page), "a replay never sends a browser back").toBe("done");
});

test("the hints come one at a time: the first goes when the needle is used, then the second, then none", async ({
  page,
}) => {
  await arriveWith(page, "narrated");
  await expect(hint(page)).toContainText("drag the needle to hear any moment.");
  // use the needle on the record: the hint is gone at once
  const a = await pointOn(page, STAGES, 3, 0.2);
  const b = await pointOn(page, STAGES, 3, 0.7);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await expect(hint(page)).toContainText("like a part? mark it, change its speed, flip it.");
  expect(await stored(page)).toBe("needle");
  await page.getByRole("button", { name: "cut on the record" }).click();
  await expect(hint(page)).toHaveCount(0);
  await expect.poll(() => stored(page)).toBe("done");
  await page.reload();
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await page.waitForTimeout(1500);
  await expect(hint(page)).toHaveCount(0);
  await expect(caption(page)).toHaveCount(0);
});

test("a hint that is not acted on fades by itself and the next follows; neither returns after a reload", async ({
  page,
}) => {
  await arriveWith(page, "narrated");
  await expect(hint(page)).toContainText("drag the needle");
  await expect(hint(page)).toContainText("like a part?", { timeout: 15_000 });
  await expect(hint(page)).toHaveCount(0, { timeout: 15_000 });
  expect(await stored(page)).toBe("done");
  await page.reload();
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await page.waitForTimeout(1500);
  await expect(hint(page)).toHaveCount(0);
});

test("a hint catches no press, never covers what it points at, and never moves the stage", async ({
  page,
}) => {
  await arriveWith(page, "narrated");
  await expect(hint(page)).toContainText("drag the needle");
  await expect(hint(page)).toHaveAttribute("data-shown", "true");
  const before = await box(page, '.block[data-hero="true"] > article');
  const note = await box(page, ".hint-note");
  expect(note).not.toBeNull();
  const through = await page.evaluate(() => {
    const el = document.querySelector(".hint-note")!;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { pointer: getComputedStyle(el).pointerEvents, ontop: top === el || el.contains(top) };
  });
  expect(through.pointer).toBe("none");
  expect(through.ontop, "the hint is the element a press would land on").toBe(false);
  const hero = Number(await page.locator(".roll").getAttribute("data-hero"));
  const tip = await pointOn(page, STAGES, hero, 0);
  expect(overlap(note!, { x: tip.x - 20, y: tip.y - 20, w: 40, h: 40 }), "over the needle").toBe(0);
  const after = await box(page, '.block[data-hero="true"] > article');
  expect(after).toEqual(before);
});

test("the browser keeps one key with one word from a short list, and nothing else", async ({
  page,
}) => {
  await arrive(page);
  await play(page).click();
  await caption(page).getByRole("button", { name: "skip" }).click();
  const store = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  expect(Object.keys(store).filter((k) => k !== "graft.theme")).toEqual(["graft.coach"]);
  expect(COACH_VALUES).toContain(store["graft.coach"]);
});

test("a browser that blocks storage still shows the guide, and moving through it does not throw", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
  });
  await arrive(page);
  await play(page).click();
  await expect(caption(page)).toBeVisible();
  await caption(page).getByRole("button", { name: "skip" }).click();
  await expect(hint(page)).toBeVisible();
  expect(errors).toEqual([]);
});

test("while the captions speak the stage is not read out a second time", async ({ page }) => {
  await arrive(page);
  await play(page).click();
  await expect(caption(page)).toBeVisible();
  const spoken = await page.locator(".notes .visually-hidden").innerText();
  expect(spoken).toBe("");
  await expect(page.locator(".notes [role=status]").filter({ hasText: /\S/ })).toHaveCount(1);
});

test("with a caption up the page has no serious accessibility violation", async ({
  page,
}, info) => {
  await arrive(page);
  await play(page).click();
  await expect(caption(page)).toBeVisible();
  await scan(page, "roll with a caption", info);
});

test("with a hint up the page has no serious accessibility violation", async ({ page }, info) => {
  await arriveWith(page, "narrated");
  await expect(hint(page)).toContainText("drag the needle");
  await scan(page, "roll with a hint", info);
});

test("with reduced motion the captions are plain text and the underline is already drawn", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await arrive(page);
  await page.getByRole("button", { name: "play all" }).click();
  await expect(caption(page)).toBeVisible();
  const state = await page.evaluate(() => {
    const path = document.querySelector(".caption-text path")!;
    const text = document.querySelector(".caption-text")!;
    return {
      dash: getComputedStyle(path).strokeDashoffset,
      animated: getComputedStyle(text).animationName,
    };
  });
  expect(parseFloat(state.dash)).toBe(0);
  expect(state.animated).toBe("none");
});

for (const size of SIZES) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${size.name} ${size.width}x${size.height}, ${scheme}`, () => {
      test.use({ viewport: { width: size.width, height: size.height }, colorScheme: scheme });

      test("the sentence is on the first screen, wholly, and covers nothing a visitor reads or presses", async ({
        page,
      }) => {
        await arrive(page);
        const s = await box(page, ".bar .sentence");
        expect(s).not.toBeNull();
        expect(s!.x).toBeGreaterThanOrEqual(0);
        expect(s!.y).toBeGreaterThanOrEqual(0);
        expect(s!.x + s!.w).toBeLessThanOrEqual(size.width);
        expect(s!.y + s!.h).toBeLessThanOrEqual(size.height);
        await page.waitForTimeout(900); // the roll slides to its stage, then rests
        for (const other of [
          ".bar h1",
          ".bar .make-link",
          ".bar .theme",
          ".controls",
          '.block[data-hero="true"] > article',
          ".notes",
        ]) {
          const o = await box(page, other);
          if (o) expect(overlap(s!, o), `the sentence is over ${other}`).toBeLessThanOrEqual(4);
        }
        // and it is real text, early in the reading order: the next paragraph after the site's title
        const next = await page.evaluate(() => {
          const title = document.querySelector(".roll h1")!;
          const all = [...document.querySelectorAll(".roll h1, .roll p")];
          return all[all.indexOf(title) + 1]?.className;
        });
        expect(next).toBe("sentence");
      });

      test("each caption is wholly on screen, off the record, clear of the controls, with a touchable skip", async ({
        page,
      }) => {
        await arrive(page);
        await play(page).click();
        for (const [moment] of NARRATION.slice(0, 3)) {
          await expect(caption(page)).toHaveAttribute("data-moment", moment, { timeout: 30_000 });
          await page.waitForTimeout(450);
          const info = await page.evaluate(() => {
            const text = document.querySelector(".caption-text")!.getBoundingClientRect();
            const skip = document.querySelector(".caption-skip")!.getBoundingClientRect();
            const controls = document.querySelector(".controls")!.getBoundingClientRect();
            return {
              text: { x: text.x, y: text.y, w: text.width, h: text.height },
              skip: { x: skip.x, y: skip.y, w: skip.width, h: skip.height },
              controls: { x: controls.x, y: controls.y, w: controls.width, h: controls.height },
            };
          });
          const l = layout(size.width, size.height, STAGES);
          for (const part of [info.text, info.skip]) {
            expect(part.x, `${moment}: left`).toBeGreaterThanOrEqual(0);
            expect(part.y, `${moment}: top`).toBeGreaterThanOrEqual(0);
            expect(part.x + part.w, `${moment}: right`).toBeLessThanOrEqual(size.width);
            expect(part.y + part.h, `${moment}: bottom`).toBeLessThanOrEqual(size.height);
            expect(
              overlap(part, info.controls),
              `${moment}: over the controls`,
            ).toBeLessThanOrEqual(4);
            // every corner of the words is off the record
            for (const [x, y] of [
              [part.x, part.y],
              [part.x + part.w, part.y],
              [part.x, part.y + part.h],
              [part.x + part.w, part.y + part.h],
            ] as const) {
              if (part === info.skip) continue; // a press target; it sits beside the words
              expect(Math.hypot(x - l.cx, y - l.cy), `${moment}: on the record`).toBeGreaterThan(
                l.R,
              );
            }
          }
          expect(info.skip.h, "a touch target").toBeGreaterThanOrEqual(43);
          expect(info.skip.w, "a touch target").toBeGreaterThanOrEqual(43);
          const stage = await box(page, '.block[data-hero="true"] > article');
          if (stage)
            expect(overlap(stage, info.text), `${moment}: over the stage`).toBeLessThanOrEqual(4);
        }
      });
    });
  }
}

test("while the guide speaks the plain 'drag the needle.' caption stays out of the way, and comes back after", async ({
  page,
}) => {
  await arrive(page);
  await play(page).click();
  await expect(caption(page)).toBeVisible();
  await expect(page.locator(".record-caption")).toBeHidden();
  await caption(page).getByRole("button", { name: "skip" }).click();
  await expect(hint(page)).toContainText("drag the needle");
  await expect(page.locator(".record-caption")).toBeHidden();
  // the hint goes by itself, then the second, then nothing: the caption is back
  await expect(hint(page)).toHaveCount(0, { timeout: 25_000 });
  await expect(page.locator(".record-caption")).toBeVisible();
});

// ---- replay: a click anywhere the guide lives plays it again, whatever state the page is in ----------

const how = (page: Page) => page.getByRole("button", { name: "how it works" });

for (const size of SIZES) {
  test.describe(`replay at ${size.name} ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    test("the replay button is on the first screen, labelled, and a full-size target", async ({
      page,
    }) => {
      await arriveWith(page, "done+made");
      const b = await box(page, ".how-link");
      expect(b, "the button is drawn").not.toBeNull();
      expect(b!.h).toBeGreaterThanOrEqual(44);
      await expect(how(page)).toBeInViewport({ ratio: 1 });
      await expect(how(page)).toContainText("how it works");
    });
  });
}

test("replay in the middle of the narration starts it again from the first caption", async ({
  page,
}) => {
  await arrive(page);
  await play(page).click();
  await expect(caption(page)).toHaveAttribute("data-moment", "stage:1", { timeout: 20_000 });
  await how(page).click();
  await expect(caption(page)).toHaveAttribute("data-moment", "teaser:3");
});

test("an arrow pressed on a fresh page starts the first play, as play does", async ({ page }) => {
  await arrive(page);
  await page.getByRole("button", { name: "next stage" }).click();
  await expect(caption(page)).toHaveAttribute("data-moment", "teaser:3");
  await expect(page.locator(".roll")).toHaveAttribute("data-playback", "rolling");
});

test("replay while a hint is up ends the hint and narrates again", async ({ page }) => {
  await arriveWith(page, "narrated");
  await expect(hint(page)).toContainText("drag the needle");
  await how(page).click();
  await expect(hint(page)).toHaveCount(0);
  await expect(caption(page)).toHaveAttribute("data-moment", "teaser:3");
});

test("replay while marking a part narrates again and nothing throws", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await arriveWith(page, "done+made");
  await page.getByRole("button", { name: "cut on the record" }).click();
  await how(page).click();
  await expect(caption(page)).toHaveAttribute("data-moment", "teaser:3");
  expect(errors).toEqual([]);
});

test("replay with a part marked closes the cut, so its menu is not left over the captions", async ({
  page,
}) => {
  await arriveWith(page, "done+made");
  await page.getByRole("button", { name: "cut on the record" }).click();
  const a = await pointOn(page, STAGES, 3, 0.25);
  const b = await pointOn(page, STAGES, 3, 0.75);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  const menu = page.getByRole("group", { name: "cut on the record" });
  await expect(menu).toBeVisible();
  await how(page).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("button", { name: "cut on the record" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(caption(page)).toHaveAttribute("data-moment", "teaser:3");
});

test("a link ending in #how plays the guide from the start, even for a browser that finished it", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("graft.coach", "done+made"));
  await page.goto("/#how");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await play(page).click();
  await expect(caption(page)).toHaveAttribute("data-moment", "teaser:3");
  expect(await stored(page), "a replay never sends a browser back").toBe("done+made");
});

test("the about page has a link that plays the guide again", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("graft.coach", "done+made"));
  await page.goto("/about");
  await page.getByRole("link", { name: "play the guide again" }).click();
  await expect(page).toHaveURL(/\/#how$/);
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await play(page).click();
  await expect(caption(page)).toHaveAttribute("data-moment", "teaser:3");
});

test("with the replay button in view the page has no serious accessibility violation", async ({
  page,
}, info) => {
  await arriveWith(page, "done+made");
  await scan(page, "roll with the replay button", info);
});
