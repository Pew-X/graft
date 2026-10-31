// The guided path, end to end against the real service (scripts/service-e2e.sh): a visitor who opens the make
// page and does only what the on-screen guide says keeps two sketches, plays them together as pads, publishes
// one flip and reaches "flip this next", without opening a second tab. It is walked from three starting
// states of the browser (nothing stored, the older guide finished, the roll's guide finished) at laptop and
// phone width. Each test names the guarantee it protects.
import { expect, test, type Page } from "@playwright/test";
import { allowBucketReads } from "./service.ts";

declare global {
  interface Window {
    __started: number[];
  }
}

const STATES: ReadonlyArray<readonly [string, string | null]> = [
  ["nothing stored", null],
  ["the older guide finished (keys+made)", "keys+made"],
  ["the roll's guide finished (done+made)", "done+made"],
];
const SIZES = [
  ["laptop", 1280, 900],
  ["phone", 390, 844],
] as const;

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

for (const [label, coach] of STATES) {
  for (const [size, width, height] of SIZES) {
    test.describe(`${label}, ${size}`, () => {
      test.use({
        viewport: { width, height },
        hasTouch: size === "phone",
        storageState: {
          cookies: [],
          origins: coach
            ? [
                {
                  origin: "http://127.0.0.1:3100",
                  localStorage: [{ name: "graft.coach", value: coach }],
                },
              ]
            : [],
        },
      });

      test("only the guide: keep two sketches, play them as pads, publish one, and flip the next from it, in one tab", async ({
        page,
      }) => {
        await allowBucketReads(page);
        await spy(page);
        const guide = page.getByTestId("make-guide");
        await page.goto("/make");
        if (coach === null) {
          await expect(guide).toContainText("pick a sound. you cut a piece of it next.");
        }
        await page.getByRole("button", { name: "flip this sound: saber hum" }).click();
        await expect(page.getByRole("slider", { name: "speed" })).toBeVisible();
        await expect(page.locator("[data-output-hash]:not([data-output-hash=''])")).toBeVisible();
        if (coach === null) {
          await expect(guide).toContainText("this flip plays higher, a fifth up. press hear it.");
          await page.getByRole("button", { name: "hear it", exact: true }).click();
          await expect(guide).toContainText("now move a bracket or the speed, and hear it change.");
          await page.getByRole("button", { name: "faster" }).click();
        }
        await expect(guide).toContainText("like a try? keep it as a sketch. only you can hear it.");
        const tabs = page.context().pages().length;
        await page.getByRole("button", { name: "keep as sketch" }).click();
        await expect(guide).toContainText("try another, or press go on from this on a sketch.");
        await page.getByRole("button", { name: "slower" }).click();
        await page.getByRole("button", { name: "keep as sketch" }).click();
        await expect(guide).toContainText("put two sketches on the bank, then touch their pads.");
        const puts = page.getByRole("button", { name: "put on the bank" });
        await puts.first().click();
        await puts.first().click();
        await expect(guide).toContainText("tick the ones worth keeping and press publish these.");
        await expect(page.locator(".sketch-bank .pad")).toHaveCount(2);
        await expect(
          page.locator(".sketch-bank .pad-t", { hasText: "getting the sound ready" }),
        ).toHaveCount(0);
        await page.locator('.sketch-bank .pad[data-pad="0"]').click();
        await page.locator('.sketch-bank .pad[data-pad="1"]').click();
        await expect
          .poll(() => page.evaluate(() => window.__started.length))
          .toBeGreaterThanOrEqual(2);
        // publish one flip from the editor
        await page.getByRole("button", { name: "publish this flip" }).click();
        await expect(guide).toContainText("after a flip is published, press flip this next.");
        await page.getByLabel(/^title/).fill("from the guide");
        await page.getByLabel(/^your name/).fill("guided");
        await page.getByRole("button", { name: "publish", exact: true }).click();
        await expect(page.getByTestId("key-stub")).toBeVisible();
        await page.getByTestId("flip-next").click();
        await expect(page).toHaveURL(/\/make\?from=[0-9a-z]{12}$/);
        expect(page.context().pages().length, "never a second tab").toBe(tabs);
        await expect(page.locator("[data-output-hash]:not([data-output-hash=''])")).toBeVisible();
      });
    });
  }
}
