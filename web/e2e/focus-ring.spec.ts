// One focus ring across the site (audit 15.1: "focus outlines sometimes shabby"). Every control shows the same
// ring: three pixels, solid, two pixels off the control, in a colour that holds contrast against what it is
// drawn on, in both themes. The exceptions are named and checked: the record draws its own ring on the stylus,
// the torn title slab draws its ring inside (an outside ring would be cut off by the torn edge), and the footer's
// panel is dark in both themes, so its ring is the bright green. Driven in real Chromium over the built site.
import { expect, test, type Page } from "@playwright/test";
import { contrast, dark, light } from "../lib/theme/tokens.ts";

const rgbToHex = (rgb: string): string => {
  const m = /rgba?\((\d+), (\d+), (\d+)/.exec(rgb)!;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
};

async function ring(page: Page, selector: string) {
  await page.evaluate((s) => {
    // `focusVisible` is a newer option than the DOM typings know: it asks for the keyboard-style ring
    (document.querySelector(s) as HTMLElement).focus({ focusVisible: true } as FocusOptions);
  }, selector);
  return page.evaluate((s) => {
    const el = document.querySelector(s)!;
    const css = getComputedStyle(el);
    return {
      style: css.outlineStyle,
      width: css.outlineWidth,
      offset: css.outlineOffset,
      colour: css.outlineColor,
    };
  }, selector);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme}`, () => {
    test.use({ colorScheme: scheme });
    const theme = scheme === "light" ? light : dark;

    test("the roll's controls share one ring", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
      for (const selector of [
        ".controls .primary",
        ".flip.primary",
        ".bar .make-link",
        ".bar .theme",
        ".mark-toggle",
      ]) {
        const r = await ring(page, selector);
        expect(r.style, selector).toBe("solid");
        expect(r.width, selector).toBe("3px");
        expect(r.offset, selector).toBe("2px");
        expect(
          contrast(rgbToHex(r.colour), theme.bg),
          `${selector} against the page`,
        ).toBeGreaterThanOrEqual(3);
      }
    });

    test("the footer's dark panel gets the bright ring in both themes", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
      for (const selector of [".footer a", ".footer .how-link"]) {
        const r = await ring(page, selector);
        expect(r.width).toBe("3px");
        expect(contrast(rgbToHex(r.colour), "#0a0b0a"), selector).toBeGreaterThanOrEqual(7);
      }
    });

    test("the pads sit on a dark panel in both themes and get the bright ring", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
      await page.getByRole("button", { name: "perform", exact: true }).click();
      await expect(page.locator(".bank")).toBeVisible();
      for (const selector of [".pad", ".bank-side .stop"]) {
        const r = await ring(page, selector);
        expect(r.width, selector).toBe("3px");
        expect(contrast(rgbToHex(r.colour), "#0a0b0a"), selector).toBeGreaterThanOrEqual(7);
      }
    });

    test("the title slab shows its ring, inside the paper, in the colour of its lettering", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
      const selector = '.block[data-hero="true"] .slab button';
      const r = await ring(page, selector);
      expect(r.style).toBe("solid");
      expect(r.width).toBe("3px");
      // negative: drawn inside the box, where the slab's torn clip does not reach
      expect(Number.parseFloat(r.offset)).toBeLessThan(0);
      const text = await page.evaluate(
        (s) => getComputedStyle(document.querySelector(s)!).color,
        selector,
      );
      expect(r.colour).toBe(text);
    });

    test("the other pages use the same ring", async ({ page }) => {
      for (const [path, selector] of [
        ["/about", "a"],
        ["/make", ".make a, .make button"],
        ["/flips", "a"],
      ] as const) {
        await page.goto(path);
        const r = await ring(page, selector);
        expect(r.style, path).toBe("solid");
        expect(r.width, path).toBe("3px");
        expect(r.offset, path).toBe("2px");
        expect(contrast(rgbToHex(r.colour), theme.bg), path).toBeGreaterThanOrEqual(3);
      }
    });
  });
}
