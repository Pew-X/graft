// The way in, for someone who has never seen graft: from the first screen they can tell what this is,
// find how to make a flip of their own, and nothing is drawn over anything they have to read or press.
// Found on the live site: at a laptop's height the status pill covered the stage's flip button, the
// independence note covered the record's caption, and nothing said what to do. Driven in real
// Chromium against the built site, at laptop and phone sizes.
import { expect, test, type Page } from "@playwright/test";

const SIZES = [
  { name: "laptop", width: 1280, height: 720 },
  { name: "large laptop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
  { name: "small phone", width: 360, height: 640 },
] as const;

type Box = { x: number; y: number; w: number; h: number };

/** The boxes of whatever of these is on screen, by name; hidden and empty ones are left out. */
async function boxes(page: Page, selectors: Record<string, string>): Promise<Record<string, Box>> {
  return page.evaluate((map) => {
    const out: Record<string, Box> = {};
    for (const [name, selector] of Object.entries(map)) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out[name] = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return out;
  }, selectors);
}

const overlap = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

for (const size of SIZES) {
  test.describe(`${size.name} ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("the way into making a flip is on the first screen, named plainly, and nothing covers it", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
      const link = page.getByRole("link", { name: "make a flip" });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", "/make");
      const box = await link.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
      expect(box!.width, "a touch target").toBeGreaterThanOrEqual(44 - 1);
      expect(box!.height, "a touch target").toBeGreaterThanOrEqual(44 - 1);
      const covered = await link.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !(top === el || el.contains(top));
      });
      expect(covered, "something is on top of it").toBe(false);
    });

    test("the page says in two plain lines what to do, before anything is played", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
      const how = page.getByTestId("how-it-works");
      await expect(how).toBeVisible();
      const text = (await how.innerText()).toLowerCase();
      expect(text).toContain("play");
      expect(text).toContain("needle");
      expect(text).toContain("make a flip");
    });

    test("nothing on the roll is drawn over anything else that is read or pressed", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
      const found = await boxes(page, {
        name: ".bar h1",
        meta: ".bar .meta",
        make: ".bar .make-link",
        theme: ".bar .theme",
        notes: ".notes",
        controls: ".controls",
        footer: ".roll .footer",
        caption: ".record-caption",
      });
      const names = Object.keys(found);
      const clashes: string[] = [];
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const a = found[names[i]!]!;
          const b = found[names[j]!]!;
          if (overlap(a, b) > 4) clashes.push(`${names[i]} over ${names[j]}`);
        }
      }
      expect(clashes, "elements drawn over each other").toEqual([]);
    });

    test("the stage in view can be flipped: its button, scrolled to, is not under the status text", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
      const flip = page.locator('.block[data-hero="true"] .flip').first();
      await flip.scrollIntoViewIfNeeded();
      const flipBox = (await boxes(page, { flip: '.block[data-hero="true"] .flip' }))["flip"];
      const found = await boxes(page, { notes: ".notes", controls: ".controls" });
      expect(flipBox).toBeDefined();
      for (const [name, box] of Object.entries(found)) {
        expect(overlap(flipBox!, box), `the flip button is under ${name}`).toBeLessThanOrEqual(4);
      }
      expect(flipBox!.y + flipBox!.h).toBeLessThanOrEqual(size.height);
    });

    test("making a flip starts with a clear first step and the choices to record or pick a sound on the first screen", async ({
      page,
    }) => {
      await page.goto("/make");
      const steps = page.getByTestId("steps");
      await expect(steps).toBeVisible();
      await expect(steps.locator('[aria-current="step"]')).toHaveCount(1);
      await expect(steps.locator("li")).toHaveCount(3);
      for (const name of ["record with the microphone", "pick an audio file"]) {
        const button = page.getByRole("button", { name });
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box!.y + box!.height, `${name} is on the first screen`).toBeLessThanOrEqual(
          size.height,
        );
      }
      await expect(page.getByTestId("make-intro")).toBeVisible();
    });
  });
}

/**
 * Answer the service's features as a test chooses. The site's own policy lets a page call only its
 * own origin unless it was built with the service's address, so the test relaxes that for the one page
 * it loads, and sends the cross-origin header a real service sends.
 */
async function serviceSays(
  page: Page,
  features: { publishing: boolean; uploads: boolean } | "down",
) {
  await page.route("**/make", async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    headers["content-security-policy"] = (headers["content-security-policy"] ?? "").replace(
      "connect-src 'self'",
      "connect-src *",
    );
    await route.fulfill({ response, headers });
  });
  await page.route("**/v1/features", (route) =>
    features === "down"
      ? route.abort("connectionrefused")
      : route.fulfill({ json: features, headers: { "access-control-allow-origin": "*" } }),
  );
}

test("the own-sound block says up front when publishing your own sound is switched off", async ({
  page,
}) => {
  await serviceSays(page, { publishing: true, uploads: false });
  await page.goto("/make");
  const note = page.getByTestId("uploads-off");
  await expect(note).toBeVisible();
  const text = (await note.innerText()).toLowerCase();
  expect(text).toContain("switched off");
  // It does not stop anyone from recording and trying, and it points at what can be published.
  await expect(page.getByRole("button", { name: "record with the microphone" })).toBeEnabled();
});

test("and says nothing when it is on", async ({ page }) => {
  await serviceSays(page, { publishing: true, uploads: true });
  await page.goto("/make");
  await expect(page.getByRole("button", { name: "pick an audio file" })).toBeVisible();
  // Give the answer time to arrive; a note that appeared late would still be a wrong note.
  await page.waitForTimeout(500);
  await expect(page.getByTestId("uploads-off")).toHaveCount(0);
});

test("and says nothing when the service cannot be asked, and the choices still work", async ({
  page,
}) => {
  await serviceSays(page, "down");
  await page.goto("/make");
  await expect(page.getByRole("button", { name: "pick an audio file" })).toBeEnabled();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("uploads-off")).toHaveCount(0);
});
