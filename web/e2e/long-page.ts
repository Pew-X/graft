/** The twelve-stage roll (thirteen rings) on a page of its own, served from the site's origin so its audio loads. */
import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { themeCss } from "../lib/theme/tokens.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Open the roll over `stages` stages (twelve unless said). */
export async function openLong(page: Page, stages = 12): Promise<void> {
  const css = readFileSync(join(here, "..", "app", "roll.css"), "utf8");
  await page.route("**/long-fixture*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${themeCss()}${css}</style></head><body><main><div id="root"></div></main><script src="/long.js"></script></body></html>`,
    }),
  );
  await page.route("**/long.js", (route) =>
    route.fulfill({ contentType: "text/javascript", path: join(here, "dist", "long.js") }),
  );
  await page.goto(`/long-fixture?n=${stages}`);
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
}
