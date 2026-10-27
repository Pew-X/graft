// A stage's face: the trace drawn from its public id sits at the top of its label, is the same line
// every time, differs between stages, and plays the stage when it is tapped. Each test names the
// guarantee it protects. Driven in real Chromium against the built site.
import { expect, test, type Page } from "@playwright/test";

const SIZES = [
  { name: "13-inch laptop", width: 1280, height: 720 },
  { name: "phone", width: 390, height: 844 },
] as const;

const roll = (page: Page) => page.locator(".roll");

async function arrive(page: Page): Promise<void> {
  await page.goto("/");
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
}

const beams = (page: Page) =>
  page.locator(".trace-face .beam").evaluateAll((paths) => paths.map((p) => p.getAttribute("d")));

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height }, hasTouch: size.width < 600 });

    test("every stage that can be heard has a trace, and no two stages draw the same line", async ({
      page,
    }) => {
      await arrive(page);
      const lines = await beams(page);
      expect(lines).toHaveLength(4);
      expect(new Set(lines).size).toBe(4);
    });

    test("a stage draws the same line on every visit", async ({ page }) => {
      await arrive(page);
      const first = await beams(page);
      await page.reload();
      await expect(roll(page)).toHaveAttribute("data-audio", "ready");
      expect(await beams(page)).toEqual(first);
    });

    test("the trace is drawn, never announced and never a tab stop", async ({ page }) => {
      await arrive(page);
      await expect(page.locator(".trace-face")).toHaveCount(4);
      await expect(page.locator('.trace-face[aria-hidden="true"]')).toHaveCount(4);
      expect(
        await page.locator(".trace-face button, .trace-face a, .trace-face [tabindex]").count(),
      ).toBe(0);
      await expect(page.getByRole("img", { name: /trace/i })).toHaveCount(0);
    });

    test("the trace sits above its title and inside its label", async ({ page }) => {
      await arrive(page);
      const hero = page.locator('.block[data-hero="true"]');
      const [face, slab, label] = await Promise.all([
        hero.locator(".trace-face").boundingBox(),
        hero.locator(".slab").boundingBox(),
        hero.locator("article").boundingBox(),
      ]);
      expect(face!.y + face!.height).toBeLessThanOrEqual(slab!.y + 2);
      expect(face!.x).toBeGreaterThanOrEqual(label!.x - 1);
      expect(face!.x + face!.width).toBeLessThanOrEqual(label!.x + label!.width + 1);
    });

    test("tapping the trace plays that stage", async ({ page }) => {
      await arrive(page);
      await expect(roll(page)).toHaveAttribute("data-playback", "idle");
      await page.locator('.block[data-hero="true"] .trace-face').click();
      await expect(roll(page)).not.toHaveAttribute("data-playback", "idle");
    });
  });
}

test.describe("the details layer", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the sound's code is drawn first and written out only when asked for", async ({ page }) => {
    await arrive(page);
    const hero = page.locator('.block[data-hero="true"]');
    await hero.locator(".details > summary").click();
    const drawn = hero.getByRole("img", { name: "a line drawn from this sound's code" });
    await expect(drawn).toBeVisible();
    await expect(hero.getByText(/not of how the sound goes/)).toBeVisible();
    const hex = hero.locator(".details .code code");
    await expect(hex).toBeHidden();
    await hero.locator(".details .code > summary").click();
    await expect(hex).toBeVisible();
    await expect(hex).toHaveText(/^[0-9a-f]{64}$/);
  });

  test("stages with different sounds draw different code lines, the same sound the same line", async ({
    page,
  }) => {
    await arrive(page);
    const lines = await page.evaluate(() =>
      [...document.querySelectorAll('.details [data-testid="trace"] .beam')].map((p) =>
        p.getAttribute("d"),
      ),
    );
    expect(lines).toHaveLength(4);
    expect(new Set(lines).size).toBe(4);
    await page.reload();
    await expect(roll(page)).toHaveAttribute("data-audio", "ready");
    const again = await page.evaluate(() =>
      [...document.querySelectorAll('.details [data-testid="trace"] .beam')].map((p) =>
        p.getAttribute("d"),
      ),
    );
    expect(again).toEqual(lines);
  });
});
