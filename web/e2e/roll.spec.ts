// The home page, driven in real Chromium at a phone viewport against the built site. Audio state is
// read from the engine's observable state (the roll's data attributes), never from timing guesses.
import { expect, test, type Page } from "@playwright/test";
import { contrast } from "../lib/theme/tokens.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const roll = (page: Page) => page.locator(".roll");
const ready = (page: Page) => expect(roll(page)).toHaveAttribute("data-audio", "ready");

/** Record every value the roll's step has, in order, from before the first tap. */
async function watchSteps(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector(".roll")!;
    const seen: string[] = [];
    (window as unknown as { steps: Array<[string, string]> }).steps = seen as never;
    const record = (): void => {
      const step = el.getAttribute("data-step") ?? "";
      const stage = el.getAttribute("data-stage") ?? "";
      if (step !== "") seen.push([step, stage] as never);
    };
    new MutationObserver(record).observe(el, { attributes: true });
  });
}

test("a tap plays the finished flip first, the roll goes back to the source and rests on the finished flip", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  await expect(roll(page)).toHaveAttribute("data-playback", "idle");
  await watchSteps(page);

  await page.getByRole("button", { name: "play", exact: true }).tap();

  // Teaser: the finished flip (stage 3 of 0..3) is current at step 0, and its block is the current one.
  await expect(roll(page)).toHaveAttribute("data-step", "0");
  await expect(roll(page)).toHaveAttribute("data-stage", "3");
  await expect(page.locator('.block[data-current="true"] .title')).toHaveText("down an octave");

  // Then the source, forward through each stage, and the rest on the finished flip.
  await expect(roll(page)).toHaveAttribute("data-step", "5", { timeout: 20_000 });
  const seen = await page.evaluate(() => (window as unknown as { steps: string[][] }).steps);
  const steps = seen.map(([step]) => step);
  const stages = seen.map(([, stage]) => stage);
  expect(steps).toEqual(["0", "1", "2", "3", "4", "5"]);
  expect(stages).toEqual(["3", "0", "1", "2", "3", "3"]);

  // It rests: still sounding, still on the finished flip, no further step.
  await page.waitForTimeout(1_000);
  await expect(roll(page)).toHaveAttribute("data-step", "5");
  await expect(roll(page)).toHaveAttribute("data-sounding", "true");
});

test("opening the home page asks the API for nothing and fetches only static files", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  // Anything that is not this site is unreachable, as if the API were down.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:3100)/, (route) => route.abort());
  const audio: Array<{ url: string; cache: string | undefined }> = [];
  page.on("response", (r) => {
    if (r.url().includes("/seed/"))
      audio.push({ url: r.url(), cache: r.headers()["cache-control"] });
  });

  await page.goto("/");
  await ready(page);

  const paths = requests.map((u) => new URL(u).pathname);
  expect(
    paths.filter((p) => p.startsWith("/v1")),
    "no API request",
  ).toEqual([]);
  expect(requests.every((u) => new URL(u).origin === "http://127.0.0.1:3100")).toBe(true);
  expect(audio).toHaveLength(4);
  for (const file of audio) expect(file.cache).toContain("immutable");
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(5); // four stages and the empty label
});

test("audio stays locked until a tap, and the page says what to tap", async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    let made = 0;
    (window as unknown as { contexts: () => number }).contexts = () => made;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        made++;
      }
    };
  });
  await page.goto("/");
  await ready(page);
  await expect(page.getByRole("status").first()).toContainText("tap play to hear it");
  expect(
    await page.evaluate(() => (window as never as { contexts: () => number }).contexts()),
  ).toBe(0);

  await page.getByRole("button", { name: "play", exact: true }).tap();
  await expect(roll(page)).toHaveAttribute("data-sounding", "true");
  expect(
    await page.evaluate(() => (window as never as { contexts: () => number }).contexts()),
  ).toBe(1);
});

test("every credit line says its honesty state in words, and nothing the project avoids is printed", async ({
  page,
}) => {
  await page.goto("/");
  const lines = page.locator("[data-honesty]");
  const count = await lines.count();
  expect(count).toBeGreaterThan(20);
  for (let i = 0; i < count; i++) {
    const line = lines.nth(i);
    const state = await line.getAttribute("data-honesty");
    // The state is text inside the line itself, not an attribute or a colour.
    await expect(line.locator(".state")).toContainText(state!);
  }
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(
    /\b(drop|drops|stack|stacks|take|takes|recipe|recipes|kitchen|chef|verified|proven|certified|owned by|cleared)\b/i,
  );
  expect(text).not.toContain("!");
  await expect(page.getByText("maker unknown")).toBeVisible();
  await expect(
    page.getByText("independent experiment, not affiliated with or endorsed by"),
  ).toBeVisible();
});

test("every control is at least 44 px", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  const buttons = page.getByRole("button");
  const count = await buttons.count();
  expect(count).toBeGreaterThan(8);
  for (let i = 0; i < count; i++) {
    const box = (await buttons.nth(i).boundingBox())!;
    const name = await buttons.nth(i).innerText();
    expect(box.width, name).toBeGreaterThanOrEqual(44);
    expect(box.height, name).toBeGreaterThanOrEqual(44);
  }
});

test("the keyboard alone runs the whole loop", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  const focus = (): Promise<string> =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      // the text a screen reader would find, hidden text included
      return (el?.textContent?.trim() || el?.getAttribute("aria-label") || "").split("\n")[0] ?? "";
    });
  const tabTo = async (label: string | RegExp, key = "Tab"): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press(key);
      const now = await focus();
      if (typeof label === "string" ? now === label : label.test(now)) return;
    }
    throw new Error(`never reached ${label}`);
  };

  // The main control starts the roll from idle, and Space pauses it.
  await tabTo("play");
  await page.keyboard.press("Enter");
  await expect(roll(page)).toHaveAttribute("data-playback", "rolling");
  await page.keyboard.press("Space");
  await expect(roll(page)).toHaveAttribute("data-playback", "paused");

  // A stage's label plays that stage alone; the same key on it again pauses it.
  await tabTo(/^2\s?up a fifth/, "Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  await expect(roll(page)).toHaveAttribute("data-stage", "1");
  await page.keyboard.press("Enter");
  await expect(roll(page)).toHaveAttribute("data-playback", "paused");

  // Pause freezes the position and play resumes in the same mode: the audition, not the roll.
  await tabTo("play");
  await page.keyboard.press("Enter");
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");

  // Next stage is reachable by keyboard too: from the audition of stage 2 it auditions stage 3.
  await tabTo(/next stage/);
  await page.keyboard.press("Enter");
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  await expect(roll(page)).toHaveAttribute("data-stage", "2");
});

test("reduced motion: a list with a play button per stage, no scrolling, no animation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  await expect(roll(page)).toHaveAttribute("data-reduced", "true");
  await expect(page.getByText("play this stage")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "play all" })).toBeVisible();

  await page.getByRole("button", { name: "play all" }).tap();
  await expect(roll(page)).toHaveAttribute("data-step", "0");
  await page.getByRole("button", { name: "next stage" }).tap();
  await page.getByRole("button", { name: "next stage" }).tap();
  expect(await page.evaluate(() => window.scrollY), "the page did not scroll by itself").toBe(0);
  const animation = await page.evaluate(
    () => getComputedStyle(document.querySelector(".cursor")!).animationName,
  );
  expect(animation).toBe("none");
});

test("the roll is real text in reading order, and the controls are named", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  const tree = await page.locator("main").ariaSnapshot();
  // Order is source first; each stage is a heading with a button; the roll ends on the empty label.
  const headings = [...tree.matchAll(/heading "([^"]*)" \[level=2\]/g)].map((m) => m[1]);
  // four stages and the empty last label, which is a heading too
  expect(headings).toHaveLength(5);
  const order = headings.map(
    (h) => h!.match(/dm9 chord|up a fifth|down a fifth|down an octave/)?.[0],
  );
  expect(order).toEqual(["dm9 chord", "up a fifth", "down a fifth", "down an octave", undefined]);
  expect(headings.at(-1)).toBe("maker unknown");
  expect(tree.indexOf("maker unknown")).toBeGreaterThan(tree.lastIndexOf("down an octave"));
  expect(tree).toContain('group "playback"');
  expect(tree).toContain('button "play"');
  expect(tree).toContain('button "next stage"');
  expect(tree).toContain('button "previous stage"');
});

for (const scheme of ["light", "dark"] as const) {
  test(`contrast of all rendered text meets AA in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await ready(page);
    const pairs = await page.evaluate(() => {
      const parse = (c: string): [number, number, number, number] => {
        const m = c.match(/[\d.]+/g)!.map(Number);
        return [m[0]!, m[1]!, m[2]!, m[3] ?? 1];
      };
      const hex = (c: [number, number, number, number]): string =>
        "#" +
        c
          .slice(0, 3)
          .map((v) => Math.round(v).toString(16).padStart(2, "0"))
          .join("");
      const background = (el: Element): string => {
        for (let e: Element | null = el; e; e = e.parentElement) {
          const bg = parse(getComputedStyle(e).backgroundColor);
          if (bg[3] > 0.99) return hex(bg);
        }
        return "#ffffff";
      };
      const out: Array<{ text: string; fg: string; bg: string }> = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent!.trim();
        const el = n.parentElement!;
        if (!text || el.closest(".visually-hidden") || getComputedStyle(el).visibility === "hidden")
          continue;
        out.push({ text, fg: hex(parse(getComputedStyle(el).color)), bg: background(el) });
      }
      return out;
    });
    expect(pairs.length).toBeGreaterThan(40);
    for (const { text, fg, bg } of pairs) {
      expect(contrast(fg, bg), `"${text}" ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test("a saved theme applies before the first paint, even on a page without the toggle", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("graft-theme", "light"));
  // Checked as the document is parsed, before the page's own code has run.
  const seen: string[] = [];
  await page.exposeFunction("themeAtParse", (t: string) => seen.push(t));
  await page.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () =>
        void (window as unknown as { themeAtParse: (t: string) => void }).themeAtParse(
          document.documentElement.getAttribute("data-theme") ?? "none",
        ),
    );
  });
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  expect(seen).toEqual(["light"]);
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe("rgb(239, 235, 227)"); // the light wall, not leader black
});

for (const [name, viewport] of [
  ["a short landscape screen", { width: 1000, height: 420 }],
  ["a phone", { width: 390, height: 844 }],
] as const) {
  test(`on ${name} the stage in view scrolls, so every line and "flip this" can be reached`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await ready(page);
    // Let the roll finish sliding to its place before measuring anything.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a instanceof CSSTransition)
          .map((a) => a.finished),
      ),
    );
    const article = page.locator('.block[data-hero="true"] > article');
    const flip = page.locator('.block[data-hero="true"] .flip');
    // The stage in view is taller than the room it has, so it is its own scrolling region.
    expect(await article.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    // It stays above the controls (and, on a phone, above the record).
    const box = (await article.boundingBox())!;
    const controls = (await page.locator(".controls").boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(controls.y + 1);
    // Its last control is reachable by pointer once scrolled to, and it answers.
    await flip.scrollIntoViewIfNeeded();
    await flip.click();
    await expect(page.getByRole("status").first()).toContainText("making a flip is not open yet");
  });
}

test("the roll opens already in place: the first placement does not slide through the whole chain", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.addInitScript(() => {
    (window as unknown as { slides: number }).slides = 0;
    document.addEventListener("transitionstart", (e) => {
      if ((e.target as HTMLElement).classList?.contains("sheet"))
        (window as unknown as { slides: number }).slides++;
    });
  });
  await page.goto("/");
  await ready(page);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => (window as unknown as { slides: number }).slides)).toBe(0);
});

test("the disc keeps turning when the pointer leaves it while a stage plays", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "play", exact: true }).click();
  await expect(roll(page)).toHaveAttribute("data-sounding", "true");
  // The mouse goes over the record, then off it onto the controls (which lie above the canvas).
  await page.mouse.move(1100, 400);
  await page.mouse.move(700, 850);
  const sample = () =>
    page.locator("canvas.disc").evaluate((c: HTMLCanvasElement) => {
      const d = c
        .getContext("2d")!
        .getImageData(Math.round(c.width * 0.62), Math.round(c.height * 0.2), 300, 60).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 11) h = (h * 31 + d[i]!) >>> 0;
      return h;
    });
  const first = await sample();
  await page.waitForTimeout(500);
  expect(await sample(), "the disc is still being redrawn").not.toBe(first);
});
