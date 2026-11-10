// The closed loop of performing, against the real service, database and bucket (scripts/service-e2e.sh):
// perform a chain, flip the stage you were just on, publish, open the new page, and perform again with the
// new flip as the last pad. Also what a pad does for stages the service does not serve.
import { expect, test, type Page } from "@playwright/test";
import { SEEDED_LAST, allowBucketReads, hide, publishFlip } from "./service.ts";

test.use({ viewport: { width: 1280, height: 720 } });

declare global {
  interface Window {
    __started: number[];
  }
}

test.beforeEach(async ({ page }) => {
  await allowBucketReads(page);
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
});

const roll = (page: Page) => page.locator(".roll");
const toggle = (page: Page) => page.getByRole("button", { name: "perform", exact: true });
const pad = (page: Page, n: number) => page.locator(`.pad[data-pad="${n}"]`);

async function perform(page: Page): Promise<void> {
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
  await toggle(page).click();
  await expect(roll(page)).toHaveAttribute("data-latency", /\d/);
}

test("perform, flip the stage you were on, publish, open it, perform: the new flip is the last pad and plays", async ({
  page,
  request,
}) => {
  const parent = await publishFlip(request, SEEDED_LAST, "loop parent");
  await page.goto(`/p/${parent.id}`);
  await perform(page);
  // five stages: the seeded four and the parent
  await expect(page.locator(".pad")).toHaveCount(5);
  await page.keyboard.press("Digit5");
  await expect(roll(page)).toHaveAttribute("data-hero", "4");
  await expect(pad(page, 4)).toHaveAttribute("data-sounding", "true");

  // "flip this" on the stage in view is the way from playing to making
  await page.locator('.block[data-hero="true"]').getByRole("button", { name: "flip this" }).click();
  await expect(page).toHaveURL(new RegExp(`/make\\?from=${parent.id}`));

  // make and publish a flip of it (the cut and speed are set in the address, as the make specs do)
  await page.goto(`/make?from=${parent.id}&cut=0-12000&speed=3/2`);
  await expect(page.locator("[data-output-hash]:not([data-output-hash=''])")).toBeVisible();
  await page.getByRole("button", { name: "publish this flip" }).click();
  await page.getByLabel(/^title/).fill("loop flip");
  await page.getByLabel(/^your name/).fill("loop maker");
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.getByRole("heading", { name: "published" })).toBeVisible();
  const href = (await page.getByTestId("published-link").getAttribute("href"))!;

  await page.goto(href);
  await perform(page);
  await expect(page.locator(".pad")).toHaveCount(6);
  await expect(pad(page, 5)).toHaveAccessibleName("stage 6, loop flip");
  const before = await page.evaluate(() => window.__started.length);
  await page.keyboard.press("Digit6");
  await expect(pad(page, 5)).toHaveAttribute("data-sounding", "true");
  await expect(roll(page)).toHaveAttribute("data-hero", "5");
  expect(await page.evaluate(() => window.__started.length)).toBe(before + 1);
  await expect(page.locator('.block[data-hero="true"] .slab .title')).toHaveText("loop flip");
});

test("a withdrawn stage keeps its pad in place, disabled with its reason, and the stages after it keep their numbers", async ({
  page,
  request,
}) => {
  const middle = await publishFlip(request, SEEDED_LAST, "to be withdrawn");
  const last = await publishFlip(request, middle.id, "after the withdrawn one");
  await hide(request, middle.id, "withdrawn");
  await page.goto(`/p/${last.id}`);
  await perform(page);
  await expect(page.locator(".pad")).toHaveCount(6);
  await expect(pad(page, 4)).toHaveAttribute("aria-disabled", "true");
  await expect(pad(page, 4).locator(".pad-t")).toHaveText("no longer here");
  await expect(pad(page, 5)).not.toHaveAttribute("aria-disabled", "true");
  const before = await page.evaluate(() => window.__started.length);
  await page.keyboard.press("Digit5");
  // never a silent dead press: it says why, and nothing sounded
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /stage 5/ })
      .first(),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__started.length)).toBe(before);
  await page.keyboard.press("Digit6");
  await expect(pad(page, 5)).toHaveAttribute("data-sounding", "true");
});

test("a stage built on one that is held for rights is held: its pad says so and nothing reaches the speakers", async ({
  page,
  request,
}) => {
  const middle = await publishFlip(request, SEEDED_LAST, "held for rights");
  const last = await publishFlip(request, middle.id, "built on the held one");
  await hide(request, middle.id, "rights");
  await page.goto(`/p/${last.id}`);
  await perform(page);
  await expect(page.locator(".pad")).toHaveCount(6);
  // the held stage and the one built on it both keep their places, disabled, with a reason in words
  await expect(pad(page, 4)).toHaveAttribute("aria-disabled", "true");
  await expect(pad(page, 5)).toHaveAttribute("aria-disabled", "true");
  await expect(pad(page, 5).locator(".pad-t")).toHaveText("held");
  const before = await page.evaluate(() => window.__started.length);
  await page.keyboard.press("Digit6");
  await expect(
    page.getByRole("status").filter({ hasText: "stage 6 cannot be played: held" }).first(),
  ).toBeVisible();
  await page.keyboard.press("Digit5");
  expect(await page.evaluate(() => window.__started.length)).toBe(before);
  // the earlier stages still play
  await page.keyboard.press("Digit2");
  await expect(pad(page, 1)).toHaveAttribute("data-sounding", "true");
});
