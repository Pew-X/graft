// The make flow's hints: one line at a time above the editor, each gone when the visitor does the thing
// it says, shown once, and replayable from a button. Each test names the guarantee it protects. These
// specs start with empty storage; every other spec starts as a visitor who has been through the guide.
// Driven in real Chromium against the built site.
import { expect, test, type Page } from "@playwright/test";
import { scan } from "./a11y.ts";
import { COACH_VALUES } from "../lib/coach/seen.ts";

test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 720 } });

const PICK = "pick a sound, or record your own. you cut a piece of it next.";
const HEAR = "this flip plays higher, a fifth up. press hear it.";
const CHANGE = "now move a bracket or the speed, and hear it change.";
const CHANGE_KEYS = "arrow keys nudge a bracket; shift nudges it ten times more.";
const KEEP = "keep a try as a sketch. a published flip is permanent; a sketch is not.";
const ANOTHER = "try another, or press go on from this on a sketch.";
const PADS = "put two sketches on the bank, then touch their pads.";
const PUBLISH = "tick the ones worth keeping and press publish these.";
const NEXT = "after a flip is published, press flip this next.";

const guide = (page: Page) => page.getByTestId("make-guide");
const stored = (page: Page) => page.evaluate(() => localStorage.getItem("graft.coach"));
const how = (page: Page) => page.getByRole("button", { name: "how it works" });
const hearIt = (page: Page) => page.getByRole("button", { name: "hear it", exact: true });

async function choose(page: Page): Promise<void> {
  await page.goto("/make");
  await expect(guide(page)).toContainText(PICK);
  await page.getByRole("button", { name: "flip this sound: saber hum" }).click();
  await expect(page.getByRole("slider", { name: "speed" })).toBeVisible();
}

test("on a first visit the picker says what to do, once, in a slot of its own", async ({
  page,
}) => {
  await page.goto("/make");
  await expect(guide(page)).toContainText(PICK);
  await expect(guide(page).getByRole("button", { name: "skip" })).toBeVisible();
  expect(await stored(page), "nothing is stored before the hints have been through").toBeNull();
});

test("the lines come one at a time, each when the last thing is done: the whole path, in order", async ({
  page,
}) => {
  await choose(page);
  await expect(guide(page)).toContainText(HEAR);
  await hearIt(page).click();
  await expect(guide(page)).toContainText(CHANGE);
  await page.getByRole("button", { name: "faster" }).click();
  await expect(guide(page)).toContainText(KEEP);
  await page.getByRole("button", { name: "keep as sketch" }).click();
  await expect(guide(page)).toContainText(ANOTHER);
  await page.getByRole("button", { name: "slower" }).click();
  await page.getByRole("button", { name: /^keep as sketch$/ }).click();
  await expect(guide(page)).toContainText(PADS);
  await page.getByRole("button", { name: "put on the bank" }).first().click();
  await expect(guide(page)).toContainText(PUBLISH);
  await page.getByRole("button", { name: "publish this flip" }).click();
  await expect(guide(page)).toContainText(NEXT);
  await expect.poll(() => stored(page)).toBe("made");
  expect(await page.evaluate(() => localStorage.getItem("graft.coach.sketch"))).toBe("next");
});

test("moving a control before pressing hear it counts as hearing it, and the line moves on", async ({
  page,
}) => {
  await choose(page);
  await page.getByRole("button", { name: "slower" }).click();
  await expect(guide(page)).toContainText(KEEP);
});

test("the last line goes by itself if it is not acted on, and the hints are over", async ({
  page,
}) => {
  await choose(page);
  await page.getByRole("button", { name: "faster" }).click();
  await expect(guide(page)).toContainText(KEEP);
  await page.getByRole("button", { name: "publish this flip" }).click();
  await expect(guide(page)).toContainText(NEXT);
  await expect(guide(page)).toHaveAttribute("data-line", "none", { timeout: 20_000 });
  await expect.poll(() => stored(page)).toBe("made");
});

test("skip ends the hints at once, and a reload shows none of them again", async ({ page }) => {
  await choose(page);
  await guide(page).getByRole("button", { name: "skip" }).click();
  await expect(guide(page)).toHaveAttribute("data-line", "none");
  await expect.poll(() => stored(page)).toBe("made");
  await page.reload();
  await expect(page.getByRole("heading", { name: "pick a sound to start from" })).toBeVisible();
  await page.getByRole("button", { name: "flip this sound: saber hum" }).click();
  await expect(page.getByRole("slider", { name: "speed" })).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
});

test("a visitor who arrives on a sound (from the header link) starts at hear it, not at the picker", async ({
  page,
}) => {
  await page.goto("/make?from=02em31vdp528&cut=0-24000&speed=3/2");
  await expect(page.getByRole("slider", { name: "speed" })).toBeVisible();
  await expect(guide(page)).toContainText(HEAR);
});

test("the line never moves the page: the stage and the controls stay where they were as it changes", async ({
  page,
}) => {
  await choose(page);
  const top = () =>
    page.evaluate(
      () => document.querySelector(".stage-head")!.getBoundingClientRect().top + window.scrollY,
    );
  const before = await top();
  await hearIt(page).click();
  await expect(guide(page)).toContainText(CHANGE);
  expect(await top()).toBe(before);
  await page.getByRole("button", { name: "faster" }).click();
  await expect(guide(page)).toContainText(KEEP);
  expect(await top()).toBe(before);
  await guide(page).getByRole("button", { name: "skip" }).click();
  await expect(guide(page)).toHaveAttribute("data-line", "none");
  expect(await top(), "the slot keeps its height when the line goes").toBe(before);
});

test("the replay button plays the hints again: at the picker, and with a sound in the editor", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("graft.coach", "keys+made");
    localStorage.setItem("graft.coach.sketch", "done");
  });
  await page.goto("/make");
  await expect(page.getByRole("heading", { name: "pick a sound to start from" })).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
  await how(page).click();
  await expect(guide(page)).toContainText(PICK);
  await page.getByRole("button", { name: "flip this sound: saber hum" }).click();
  await expect(guide(page)).toContainText(HEAR);
  await guide(page).getByRole("button", { name: "skip" }).click();
  await how(page).click();
  await expect(guide(page)).toContainText(HEAR);
  expect(await stored(page), "a replay never sends a browser back").toBe("keys+made");
});

test("the replay button is a labelled full-size target on the first screen, phone and laptop", async ({
  page,
}) => {
  for (const [width, height] of [
    [1280, 720],
    [390, 844],
    [360, 640],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/make");
    const b = await how(page).boundingBox();
    expect(b!.height).toBeGreaterThanOrEqual(44);
    await expect(how(page)).toBeInViewport({ ratio: 1 });
  }
});

test("the page keeps its one key, with a word from the list", async ({ page }) => {
  await choose(page);
  await guide(page).getByRole("button", { name: "skip" }).click();
  await expect.poll(() => stored(page)).not.toBeNull();
  const store = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  expect(
    Object.keys(store)
      .filter((k) => k !== "graft.theme")
      .sort(),
  ).toEqual(["graft.coach", "graft.coach.sketch"]);
  expect(COACH_VALUES).toContain(store["graft.coach"]);
  expect(store["graft.coach.sketch"]).toBe("done");
});

test("with a line up the page has no serious accessibility violation", async ({ page }, info) => {
  await choose(page);
  await expect(guide(page)).toContainText(HEAR);
  // the line fades in over 0.3 s; the scan reads its settled colour, not one mid-fade
  await page.waitForTimeout(600);
  await scan(page, "make flow with a hint", info);
});

test("the line is announced politely and only show me and skip take a press in the slot", async ({
  page,
}) => {
  await choose(page);
  await expect(guide(page).getByRole("status")).toHaveText(HEAR);
  await expect(guide(page).getByRole("button")).toHaveText(["show me", "skip"]);
});

test("show me brings the named control into view and focuses it, and the line stays", async ({
  page,
}) => {
  await choose(page);
  await expect(guide(page).getByRole("status")).toHaveText(HEAR);
  await guide(page).getByRole("button", { name: "show me" }).click();
  await expect(page.locator('[data-guide="hear"]')).toBeFocused();
  await expect(page.locator('[data-guide="hear"]')).toBeInViewport();
  await expect(guide(page).getByRole("status")).toHaveText(HEAR);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("the line is plain text with no entrance", async ({ page }) => {
    await choose(page);
    const name = await guide(page)
      .locator(".make-guide-text")
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(name).toBe("none");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("the line and its skip fit on a phone and the skip is a full-size target", async ({
    page,
  }) => {
    await choose(page);
    await expect(guide(page)).toContainText(HEAR);
    const skip = await guide(page).getByRole("button", { name: "skip" }).boundingBox();
    expect(skip!.height).toBeGreaterThanOrEqual(44);
    // the slot and the replay button stay inside the screen (the cut's own bracket handle is not ours)
    for (const part of [guide(page), how(page)]) {
      const b = await part.boundingBox();
      expect(b!.x).toBeGreaterThanOrEqual(0);
      expect(b!.x + b!.width).toBeLessThanOrEqual(390);
    }
  });
});

test("under the change hint a smaller line says what the arrow keys and shift do to a bracket, in the same slot", async ({
  page,
}) => {
  await choose(page);
  await expect(guide(page)).not.toContainText(CHANGE_KEYS);
  const slot = () =>
    page.evaluate(() => document.querySelector(".make-guide")!.getBoundingClientRect().height);
  const before = await slot();
  await hearIt(page).click();
  await expect(guide(page)).toContainText(CHANGE);
  await expect(guide(page)).toContainText(CHANGE_KEYS);
  expect(await slot(), "the slot did not grow for the key line").toBe(before);
  await page.getByRole("button", { name: "faster" }).click();
  await expect(guide(page)).toContainText(KEEP);
  await expect(guide(page)).not.toContainText(CHANGE_KEYS);
});

test("a browser that finished the older guide sees the sketch lines once, from keep, and then never again", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("graft.coach", "keys+made");
  });
  await page.goto("/make?from=02em31vdp528&cut=0-24000&speed=3/2");
  await expect(page.getByRole("slider", { name: "speed" })).toBeVisible();
  await expect(guide(page)).toContainText(KEEP);
  await guide(page).getByRole("button", { name: "skip" }).click();
  await page.reload();
  await expect(page.getByRole("slider", { name: "speed" })).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
  expect(await stored(page), "the roll's word is untouched").toBe("keys+made");
});

test("a reload part way resumes at the line it was on, and a skip stays skipped", async ({
  page,
}) => {
  await page.goto("/make?from=02em31vdp528&cut=0-24000&speed=3/2");
  await expect(guide(page)).toContainText(HEAR);
  await page.getByRole("button", { name: "faster" }).click();
  await page.getByRole("button", { name: "keep as sketch" }).click();
  await expect(guide(page)).toContainText(ANOTHER);
  await page.reload();
  await expect(guide(page)).toContainText(ANOTHER);
  await guide(page).getByRole("button", { name: "skip" }).click();
  await page.reload();
  await expect(guide(page)).toHaveCount(0);
});

test("a word in the sketch guide's key that this build does not know is finished, and the roll's narration is not restarted", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("graft.coach", "keys+made");
    localStorage.setItem("graft.coach.sketch", "a-word-from-the-future");
  });
  await page.goto("/make?from=02em31vdp528&cut=0-24000&speed=3/2");
  await expect(page.getByRole("slider", { name: "speed" })).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  expect(await stored(page)).toBe("keys+made");
});

test("storage that is blocked shows the guide, never an error", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("blocked");
      },
    });
  });
  await page.goto("/make");
  await expect(guide(page)).toContainText(PICK);
});

test("the sketch lines never cover the editor, the strip or the bank, and are a polite status", async ({
  page,
}) => {
  await choose(page);
  await page.getByRole("button", { name: "faster" }).click();
  await page.getByRole("button", { name: "keep as sketch" }).click();
  await expect(guide(page)).toContainText(ANOTHER);
  await expect(guide(page).getByRole("status")).toHaveText(ANOTHER);
  // The line is pinned while it runs, so while the page is scrolled it floats over whatever passes under
  // it (by design: it stays in view down at the controls). What is checked is its own slot: at the top of
  // the page nothing else is drawn in it. (Measured while scrolled, the answer only follows how far the
  // browser happened to scroll to reach the keep button, which moves whenever a control is added above.)
  await page.evaluate(() => window.scrollTo(0, 0));
  const slot = (await guide(page).boundingBox())!;
  for (const target of [".panel.result", '[data-testid="your-sketches"]']) {
    const b = (await page.locator(target).first().boundingBox())!;
    expect(b.y >= slot.y + slot.height - 1 || b.y + b.height <= slot.y + 1).toBe(true);
  }
});
