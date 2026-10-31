// The sketch bank on the make page: sketches on pads, played together with the roll's rules, on the page's one
// audio context. Against the built site and its shipped snapshots. Each test names what it protects.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scan, smallTargets } from "./a11y.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = (
  JSON.parse(readFileSync(join(web, "snapshot", "sources.json"), "utf8")) as {
    stages: Array<{ id: string }>;
  }
).stages[0]!;
const KEY = "graft.sketches";

test.use({ bypassCSP: true });

declare global {
  interface Window {
    __started: number[];
    __contexts: number;
  }
}

/** Sketches written the way the page writes them: three short cuts of one source, at three speeds. */
async function seed(
  page: Page,
  count = 3,
  over: Array<Record<string, unknown>> = [],
): Promise<void> {
  await page.addInitScript(
    ([key, id, n, extra]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      const speeds = [
        [1, 1],
        [3, 2],
        [1, 2],
      ];
      const sketches = Array.from({ length: n! }, (_, i) => ({
        id: `sk${String(i).padStart(12, "0")}`,
        parent: { kind: "stage", id },
        cut: { start: 0, end: 6000 + i * 500 },
        p: speeds[i % 3]![0],
        q: speeds[i % 3]![1],
        title: `try ${i + 1}`,
        retryKey: `web-0123456789abcdef0123456789ab${String(i).padStart(2, "0")}`,
        at: i,
        ...(extra![i] ?? {}),
      }));
      localStorage.setItem(key!, JSON.stringify({ v: 1, sketches, bank: [] }));
    },
    [KEY, SOURCE.id, count, over] as const,
  );
  await page.addInitScript(() => {
    window.__started = [];
    window.__contexts = 0;
    const Real = window.AudioContext;
    window.AudioContext = class extends Real {
      constructor(options?: AudioContextOptions) {
        super(options);
        window.__contexts++;
      }
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

const row = (page: Page, title: string) =>
  page.locator(".your-sketch", {
    has: page.locator(".sketch-title", { hasText: new RegExp(`^${title}$`) }),
  });
const pad = (page: Page, n: number) => page.locator(`.sketch-bank .pad[data-pad="${n}"]`);
const started = (page: Page) => page.evaluate(() => window.__started);

async function putOn(page: Page, titles: string[]): Promise<void> {
  for (const t of titles)
    await row(page, t).getByRole("button", { name: "put on the bank" }).click();
  await expect(page.locator(".sketch-bank .pad")).toHaveCount(titles.length);
  // every pad's sound is made before it is pressed
  await expect(
    page.locator(".sketch-bank .pad-t", { hasText: "getting the sound ready" }),
  ).toHaveCount(0);
}

test("three sketches on pads: the number keys play them, only once turned on, on one audio context", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/make");
  await putOn(page, ["try 1", "try 2", "try 3"]);
  // keys are off until they are turned on: a digit does nothing
  await page.keyboard.press("Digit1");
  await page.waitForTimeout(200);
  expect(await started(page)).toEqual([]);
  await page.getByRole("button", { name: "number keys: off" }).click();
  await expect(page.getByRole("button", { name: "number keys: on" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Digit1");
  await expect.poll(() => started(page)).toHaveLength(1);
  await page.keyboard.press("Digit2");
  await page.keyboard.press("Digit3");
  await expect.poll(() => started(page)).toHaveLength(3);
  const lengths = await started(page);
  // the pads play the sound each sketch makes: 6000 frames at 1/1, 6500 at 3/2, 7000 at 1/2
  expect(lengths).toEqual([6000, 4333, 13999]);
  expect(await page.evaluate(() => window.__contexts)).toBe(1);
  // escape stops the sound first, then turns the keys off
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "number keys: off" })).toBeVisible();
});

test("a digit typed in a field is typed, never played", async ({ page }) => {
  await seed(page);
  await page.goto(`/make?from=${SOURCE.id}&cut=0-12000&speed=3/2`);
  await expect(page.locator("[data-output-hash]")).not.toHaveAttribute("data-output-hash", "");
  await putOn(page, ["try 1"]);
  await page.getByRole("button", { name: "number keys: off" }).click();
  await page.getByLabel(/^name of this try/).fill("");
  await page.getByLabel(/^name of this try/).press("Digit1");
  await page.getByLabel(/^name of this try/).pressSequentially("12");
  await expect(page.getByLabel(/^name of this try/)).toHaveValue("112");
  expect(await started(page)).toEqual([]);
});

test("one at a time stops the last pad; overlap lets pads sound together", async ({ page }) => {
  await seed(page);
  await page.goto("/make");
  await putOn(page, ["try 1", "try 3"]);
  await pad(page, 0).click();
  await expect(pad(page, 0)).toHaveAttribute("data-sounding", "true");
  await pad(page, 1).click();
  await expect(pad(page, 1)).toHaveAttribute("data-sounding", "true");
  await expect(pad(page, 0)).toHaveAttribute("data-sounding", "false");
  await page.getByRole("button", { name: "overlap" }).click();
  await pad(page, 0).click();
  await expect(pad(page, 0)).toHaveAttribute("data-sounding", "true");
  await expect(pad(page, 1)).toHaveAttribute("data-sounding", "true");
  await page.getByRole("button", { name: "stop", exact: true }).first().click();
  await expect(pad(page, 0)).toHaveAttribute("data-sounding", "false");
});

test("rec keeps a run of presses for this visit only, play runs it, loop repeats it, and it is not in the address", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/make");
  await putOn(page, ["try 1", "try 2", "try 3"]);
  await page.getByRole("button", { name: "rec", exact: true }).click();
  await pad(page, 0).click();
  await pad(page, 1).click();
  await pad(page, 2).click();
  await page.getByRole("button", { name: /stop rec/ }).click();
  await expect(page.getByTestId("bank-status")).toContainText(
    "phrase kept: 3 presses, for this visit only",
  );
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.getByRole("button", { name: "copy link" })).toHaveCount(0);
  const before = (await started(page)).length;
  await page.getByRole("button", { name: "play phrase" }).click();
  await expect.poll(async () => (await started(page)).length).toBeGreaterThanOrEqual(before + 3);
  const once = (await started(page)).length;
  await page.getByRole("button", { name: "stop", exact: true }).first().click();
  await page.getByRole("button", { name: "loop" }).click();
  await page.getByRole("button", { name: "play phrase" }).click();
  await expect
    .poll(async () => (await started(page)).length, { timeout: 15_000 })
    .toBeGreaterThan(once + 3);
  await page.getByRole("button", { name: "stop", exact: true }).first().click();
  expect(await page.evaluate(() => window.__contexts)).toBe(1);
});

test("the order can be changed from the keyboard, and it is kept across a reload", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/make");
  await putOn(page, ["try 1", "try 2", "try 3"]);
  await page.getByRole("button", { name: "move later: try 1" }).click();
  const order = () => page.locator(".bank-order .bank-title").allInnerTexts();
  expect(await order()).toEqual(["try 2", "try 1", "try 3"]);
  await page.reload();
  await expect(page.locator(".bank-order .bank-title")).toHaveText(["try 2", "try 1", "try 3"]);
  await page.getByRole("button", { name: "remove from the bank: try 2" }).click();
  await expect(page.locator(".bank-order .bank-title")).toHaveText(["try 1", "try 3"]);
});

test("discarding a sketch on the bank takes its pad away, and a phrase says its pad was removed", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/make");
  await putOn(page, ["try 1", "try 2"]);
  await page.getByRole("button", { name: "rec", exact: true }).click();
  await pad(page, 0).click();
  await pad(page, 1).click();
  await page.getByRole("button", { name: /stop rec/ }).click();
  await row(page, "try 1").getByRole("button", { name: "discard" }).click();
  await row(page, "try 1").getByRole("button", { name: "yes, discard" }).click();
  await expect(page.locator(".sketch-bank .pad")).toHaveCount(1);
  await page.getByRole("button", { name: "play phrase" }).click();
  await expect(page.getByTestId("bank-status")).toContainText("this pad was removed");
});

test("a pad that cannot be made says why on the pad, and the others still play", async ({
  page,
}) => {
  await seed(page, 2, [{ cut: { start: 0, end: 90_000 } }]);
  await page.goto("/make");
  await row(page, "try 1").getByRole("button", { name: "put on the bank" }).click();
  await row(page, "try 2").getByRole("button", { name: "put on the bank" }).click();
  await expect(pad(page, 0).locator(".pad-t")).not.toHaveText("getting the sound ready");
  await expect(pad(page, 0)).toHaveAttribute("aria-disabled", "true");
  await pad(page, 1).click();
  await expect.poll(() => started(page)).toHaveLength(1);
});

test("a bank holds twelve, and says so at the thirteenth", async ({ page }) => {
  await seed(page, 13);
  await page.goto("/make");
  for (let n = 1; n <= 12; n++)
    await row(page, `try ${n}`).getByRole("button", { name: "put on the bank" }).click();
  await row(page, "try 13").getByRole("button", { name: "put on the bank" }).click();
  await expect(row(page, "try 13").getByText(/holds at most 12 sketches/)).toBeVisible();
  await expect(page.locator(".sketch-bank .pad")).toHaveCount(12);
});

test("pads are real buttons with names, every control is big enough, and the page passes an accessibility scan", async ({
  page,
}, info) => {
  await seed(page);
  await page.goto("/make");
  await putOn(page, ["try 1", "try 2"]);
  await expect(page.locator(".sketch-bank button.pad")).toHaveCount(2);
  await expect(pad(page, 0)).toHaveAttribute("aria-label", /^pad 1, try 1$/);
  await scan(page, "the sketch bank", info);
  const small = (await smallTargets(page)).filter((t) => t.includes("pad") || t.includes("bank"));
  expect(small).toEqual([]);
});

test("pressing the pads fast keeps every press sounding, with no error in the console", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    // there is no service in this run: the page's own read of what is open is refused, which is not the bank
    if (m.type() === "error" && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await seed(page, 6);
  await page.goto("/make");
  await putOn(page, ["try 1", "try 2", "try 3", "try 4", "try 5", "try 6"]);
  await page.getByRole("button", { name: "overlap" }).click();
  for (let round = 0; round < 3; round++) for (let i = 0; i < 6; i++) await pad(page, i).click();
  await expect.poll(() => started(page)).toHaveLength(18);
  expect(await page.evaluate(() => window.__contexts)).toBe(1);
  expect(errors).toEqual([]);
});
