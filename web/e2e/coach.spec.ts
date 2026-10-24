// The first-visit coach: three notes drawn over the real screen, shown once, never in the way. Each
// test names the guarantee it protects. These specs start with empty storage (every other spec starts
// as a visitor who has seen it). Driven in real Chromium against the built site.
import { expect, test, type Page } from "@playwright/test";
import { scan } from "./a11y.ts";

test.use({ storageState: { cookies: [], origins: [] } });

const SIZES = [
  { name: "13-inch laptop", width: 1280, height: 720 },
  { name: "large laptop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
  { name: "small phone", width: 360, height: 640 },
  { name: "tall tablet", width: 676, height: 1000 },
] as const;

async function arrive(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
}

const coach = (page: Page) => page.getByTestId("coach");
const stored = (page: Page) => page.evaluate(() => localStorage.getItem("graft.coach"));

test("a first visit is told, in three notes, how to play, how to use the needle and how to make a flip", async ({
  page,
}) => {
  await arrive(page);
  await expect(coach(page)).toBeVisible();
  await expect(coach(page)).toHaveAttribute("data-step", "play");
  await expect(coach(page)).toContainText("press play");
  await expect(coach(page)).toContainText("1 of 3");
  await coach(page).getByRole("button", { name: "next" }).click();
  await expect(coach(page)).toHaveAttribute("data-step", "needle");
  await expect(coach(page)).toContainText("drag the needle");
  await coach(page).getByRole("button", { name: "next" }).click();
  await expect(coach(page)).toHaveAttribute("data-step", "make");
  await expect(coach(page)).toContainText("make your own");
  await expect(coach(page)).toContainText("3 of 3");
  await coach(page).getByRole("button", { name: "start listening" }).click();
  await expect(coach(page)).toHaveCount(0);
});

test("back goes to the note before, and skip is there until the last note", async ({ page }) => {
  await arrive(page);
  await expect(coach(page)).toBeVisible();
  await expect(coach(page).getByRole("button", { name: "back" })).toHaveCount(0);
  await coach(page).getByRole("button", { name: "next" }).click();
  await coach(page).getByRole("button", { name: "back" }).click();
  await expect(coach(page)).toHaveAttribute("data-step", "play");
  await coach(page).getByRole("button", { name: "next" }).click();
  await coach(page).getByRole("button", { name: "next" }).click();
  await expect(coach(page).getByRole("button", { name: "skip" })).toHaveCount(0);
});

test("it is shown once: finishing, skipping or escape each mean it is not shown again", async ({
  page,
}) => {
  await arrive(page);
  await expect(coach(page)).toBeVisible();
  expect(await stored(page), "nothing is stored before it is dismissed").toBeNull();
  await coach(page).getByRole("button", { name: "skip" }).click();
  await expect(coach(page)).toHaveCount(0);
  expect(await stored(page)).toBe("seen");
  await page.reload();
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await page.waitForTimeout(1500);
  await expect(coach(page)).toHaveCount(0);
});

test("escape closes it and counts as seen", async ({ page }) => {
  await arrive(page);
  await expect(coach(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(coach(page)).toHaveCount(0);
  expect(await stored(page)).toBe("seen");
});

test("a visitor who reaches the last note and walks away has seen it", async ({ page }) => {
  await arrive(page);
  await expect(coach(page)).toBeVisible();
  await coach(page).getByRole("button", { name: "next" }).click();
  await coach(page).getByRole("button", { name: "next" }).click();
  expect(await stored(page)).toBe("seen");
});

test("how it works in the footer brings it back, from the first note", async ({ page }) => {
  await arrive(page);
  await coach(page).getByRole("button", { name: "skip" }).click();
  await page.getByRole("button", { name: "how it works" }).click();
  await expect(coach(page)).toBeVisible();
  await expect(coach(page)).toHaveAttribute("data-step", "play");
});

test("it never blocks the page: pressing play goes straight through it, and moves it to the next note", async ({
  page,
}) => {
  await arrive(page);
  await expect(coach(page)).toBeVisible();
  await expect(coach(page)).toHaveAttribute("data-step", "play");
  await page.locator(".controls .primary").click();
  await expect(page.locator(".roll")).toHaveAttribute("data-sounding", "true");
  await expect(coach(page)).toHaveAttribute("data-step", "needle");
});

test("a browser that blocks storage still shows it, and dismissing it does not throw", async ({
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
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await expect(coach(page)).toBeVisible();
  await coach(page).getByRole("button", { name: "skip" }).click();
  await expect(coach(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("with the coach open the page has no serious accessibility violation", async ({
  page,
}, info) => {
  await arrive(page);
  await expect(coach(page)).toBeVisible();
  await scan(page, "roll with the coach", info);
});

for (const size of SIZES) {
  test.describe(`${size.name} ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("each note is wholly on screen, covers what it points at no more than the marker does, and its buttons are touchable", async ({
      page,
    }) => {
      await arrive(page);
      await expect(coach(page)).toBeVisible();
      for (const step of ["play", "needle", "make"] as const) {
        await expect(coach(page)).toHaveAttribute("data-step", step);
        await page.waitForTimeout(1100); // the marker draws, the page settles
        const info = await page.evaluate(() => {
          const card = document.querySelector(".coach-card")!.getBoundingClientRect();
          const loop = document.querySelector(".coach-marks .mark")?.getBoundingClientRect();
          const buttons = [...document.querySelectorAll(".coach-actions button")].map((b) => {
            const r = b.getBoundingClientRect();
            return { w: r.width, h: r.height };
          });
          return {
            card: { x: card.x, y: card.y, w: card.width, h: card.height },
            loop: loop ? { x: loop.x, y: loop.y, w: loop.width, h: loop.height } : null,
            buttons,
            vw: window.innerWidth,
            vh: window.innerHeight,
          };
        });
        expect(info.card.x, `${step}: left edge`).toBeGreaterThanOrEqual(0);
        expect(info.card.y, `${step}: top edge`).toBeGreaterThanOrEqual(0);
        expect(info.card.x + info.card.w, `${step}: right edge`).toBeLessThanOrEqual(info.vw);
        expect(info.card.y + info.card.h, `${step}: bottom edge`).toBeLessThanOrEqual(info.vh);
        expect(info.loop, `${step}: a marker is drawn`).not.toBeNull();
        const overlap =
          Math.max(
            0,
            Math.min(info.card.x + info.card.w, info.loop!.x + info.loop!.w) -
              Math.max(info.card.x, info.loop!.x),
          ) *
          Math.max(
            0,
            Math.min(info.card.y + info.card.h, info.loop!.y + info.loop!.h) -
              Math.max(info.card.y, info.loop!.y),
          );
        expect(overlap, `${step}: the note sits on the thing it points at`).toBe(0);
        for (const b of info.buttons)
          expect(b.h, `${step}: a touch target`).toBeGreaterThanOrEqual(43);
        if (step !== "make") await coach(page).getByRole("button", { name: "next" }).click();
      }
    });
  });
}
