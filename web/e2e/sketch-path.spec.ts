// Going on from a sketch, other tries, comparing two, stepping back, and the depth budget. Against the
// built site and its shipped snapshots (a sketch is never sent anywhere). Each test names what it protects.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "./a11y.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (n: string) =>
  JSON.parse(readFileSync(join(web, "snapshot", `${n}.json`), "utf8")) as {
    stages: Array<{ id: string; frames: number }>;
  };
const CHAIN = read("chain").stages;
const LAST = CHAIN.at(-1)!;
const SOURCE = read("sources").stages[0]!;
const KEY = "graft.sketches";

test.use({ bypassCSP: true });

declare global {
  interface Window {
    __started: number[];
  }
}

const hash = (page: Page) => page.locator("[data-output-hash]");
const ready = (page: Page) => expect(hash(page)).not.toHaveAttribute("data-output-hash", "");
const link = (id: string, cut: string, speed = "3/2") =>
  `/make?from=${id}&cut=${cut}&speed=${speed}`;
const book = (page: Page) =>
  page.evaluate(
    (key) =>
      (
        JSON.parse(localStorage.getItem(key) ?? "null") as {
          sketches: Array<{ id: string; title: string; parent: { kind: string; id: string } }>;
        } | null
      )?.sketches ?? [],
    KEY,
  );

async function keep(page: Page, title: string): Promise<void> {
  await page.getByLabel(/^name of this try/).fill(title);
  await page.getByRole("button", { name: /^keep as (sketch|another try)$/ }).click();
  await expect(page.getByText(new RegExp(`kept as a sketch: ${title}`))).toBeVisible();
}
const row = (page: Page, title: string) =>
  page.locator(".your-sketch", {
    has: page.locator(".sketch-title", { hasText: new RegExp(`^${title}$`) }),
  });

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

test("three other tries of one sound and one that goes on from a try, in one tab, all still there after a reload", async ({
  page,
}) => {
  await page.goto(link(LAST.id, "0-24000"));
  await ready(page);
  await keep(page, "one");
  await page.getByRole("button", { name: "slower" }).click();
  await ready(page);
  await keep(page, "two");
  await page.getByRole("button", { name: "slower" }).click();
  await keep(page, "three");
  const tabs = page.context().pages().length;
  await row(page, "two").getByRole("button", { name: "go on from this" }).click();
  await ready(page);
  await keep(page, "child of two");
  const all = await book(page);
  expect(all).toHaveLength(4);
  const two = all.find((s) => s.title === "two")!;
  const child = all.find((s) => s.title === "child of two")!;
  expect(child.parent).toEqual({ kind: "sketch", id: two.id });
  await expect(row(page, "child of two").locator(".sketch-from")).toHaveText("from sketch 'two'");
  await expect(row(page, "one").locator(".sketch-from")).toHaveText(/from stage \d+/);
  expect(page.context().pages().length).toBe(tabs);
  // a reload: all four, and the child reopens on the very sound it was kept on
  await ready(page);
  const keptHash = await hash(page).getAttribute("data-output-hash");
  await page.goto("/make");
  await expect(page.locator(".your-sketch")).toHaveCount(4);
  await row(page, "child of two").getByRole("button", { name: "open" }).click();
  await ready(page);
  await expect(hash(page)).toHaveAttribute("data-output-hash", keptHash!);
});

test("a sketch cut from another sketch is made from that sketch's output: its sound is not the stage's", async ({
  page,
}) => {
  await page.goto(link(SOURCE.id, "0-12000", "1/1"));
  await ready(page);
  const direct = await hash(page).getAttribute("data-output-hash");
  await keep(page, "first");
  await row(page, "first").getByRole("button", { name: "go on from this" }).click();
  await ready(page);
  // the editor opened on the first sketch's output, which is a new sound: cutting it the same way differs
  await expect(page.getByRole("heading", { name: "first" })).toBeVisible();
  const second = await hash(page).getAttribute("data-output-hash");
  expect(second).not.toBe(direct);
});

test("another try: open a sketch, change it, keep it as another try, and step back to the first", async ({
  page,
}) => {
  await page.goto(link(SOURCE.id, "0-12000"));
  await ready(page);
  const first = await hash(page).getAttribute("data-output-hash");
  await keep(page, "original");
  await row(page, "original").getByRole("button", { name: "open" }).click();
  await ready(page);
  await expect(page.getByRole("button", { name: /^back to sketch/ })).toHaveCount(0);
  await page.getByRole("button", { name: "faster" }).click();
  await expect(hash(page)).not.toHaveAttribute("data-output-hash", first!);
  await expect(page.getByRole("button", { name: "back to sketch 'original'" })).toBeVisible();
  await keep(page, "variation");
  expect((await book(page)).map((s) => s.title)).toEqual(["original", "variation"]);
  await page.getByRole("button", { name: "back to sketch 'original'" }).click();
  await expect(hash(page)).toHaveAttribute("data-output-hash", first!);
  await expect(page.getByRole("button", { name: /^back to sketch/ })).toHaveCount(0);
});

test("comparing: A then B plays the two in order from the start, one at a time, on one audio context", async ({
  page,
}) => {
  await spy(page);
  await page.addInitScript(() => {
    (window as unknown as { __contexts: number }).__contexts = 0;
    const Real = window.AudioContext;
    window.AudioContext = class extends Real {
      constructor(options?: AudioContextOptions) {
        super(options);
        (window as unknown as { __contexts: number }).__contexts++;
      }
    };
  });
  await page.goto(link(SOURCE.id, "0-12000", "1/1"));
  await ready(page);
  await keep(page, "short");
  await page.getByRole("button", { name: "slower" }).click();
  await page.getByRole("button", { name: "slower" }).click();
  await keep(page, "slow");
  await row(page, "short").getByRole("button", { name: "marked A" }).click();
  await row(page, "slow").getByRole("button", { name: "marked B" }).click();
  await expect(page.getByTestId("compare")).toBeVisible();
  await page.getByRole("button", { name: "play A then B" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__started.length), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  const started = await page.evaluate(() => window.__started);
  expect(started[0]).toBeLessThan(started[1]!); // the slow one is longer
  // "play one" alternates which side it plays
  await page.getByRole("button", { name: "stop" }).first().click();
  const before = (await page.evaluate(() => window.__started)).length;
  await page.getByRole("button", { name: "play one: A" }).click();
  await expect.poll(() => page.evaluate(() => window.__started.length)).toBe(before + 1);
  await expect(page.getByRole("button", { name: "play one: B" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __contexts: number }).__contexts)).toBe(
    1,
  );
});

test("deleting a sketch that is being compared clears the comparison", async ({ page }) => {
  await page.goto(link(SOURCE.id, "0-12000", "1/1"));
  await ready(page);
  await keep(page, "gone soon");
  await keep(page, "stays");
  await row(page, "gone soon").getByRole("button", { name: "marked A" }).click();
  await expect(page.getByTestId("compare")).toBeVisible();
  await row(page, "gone soon").getByRole("button", { name: "discard" }).click();
  await row(page, "gone soon").getByRole("button", { name: "yes, discard" }).click();
  await expect(page.getByTestId("compare")).toHaveCount(0);
});

test("the budget is the service's rule: the seeded chain's last stage leaves room for eight more, a source ten", async ({
  page,
}) => {
  await page.goto(link(LAST.id, "0-24000"));
  await ready(page);
  await keep(page, "on the last");
  await expect(row(page, "on the last").locator(".sketch-room")).toHaveText(
    `${12 - CHAIN.length - 1 === 1 ? "one more stage fits" : `${12 - CHAIN.length - 1} more stages fit`} after this one.`,
  );
  await page.goto(link(SOURCE.id, "0-12000"));
  await ready(page);
  await keep(page, "on a source");
  await expect(row(page, "on a source").locator(".sketch-room")).toHaveText(
    "10 more stages fit after this one.",
  );
  await expect(page.locator(".sketch-budget")).toHaveText("10 more stages fit after this one.");
});

test("at zero, go on from this is disabled with the reason", async ({ page }) => {
  // a path of sketches as deep as the chain allows from the seeded last stage
  const room = 12 - CHAIN.length;
  await page.addInitScript(
    ([key, id, depth]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      const sketches = Array.from({ length: depth! }, (_, i) => ({
        id: `sk${String(i).padStart(12, "0")}`,
        parent:
          i === 0
            ? { kind: "stage", id }
            : { kind: "sketch", id: `sk${String(i - 1).padStart(12, "0")}` },
        cut: { start: 0, end: 12000 - i * 100 },
        p: 1,
        q: 1,
        title: `deep ${i}`,
        retryKey: `web-0123456789abcdef0123456789ab${String(i).padStart(2, "0")}`,
        at: i,
      }));
      localStorage.setItem(key!, JSON.stringify({ v: 1, sketches, bank: [] }));
    },
    [KEY, LAST.id, room] as const,
  );
  await page.goto("/make");
  const deepest = row(page, `deep ${room - 1}`);
  await expect(deepest.locator(".sketch-room")).toHaveText(/no more stages fit/);
  await expect(deepest.getByRole("button", { name: "go on from this" })).toBeDisabled();
  await expect(deepest.getByText(/cannot go on from this: no more stages fit/)).toBeVisible();
  await expect(
    row(page, `deep ${room - 2}`).getByRole("button", { name: "go on from this" }),
  ).toBeEnabled();
});

test("a try that goes on from an unpublished sketch cannot be published alone, and says so", async ({
  page,
}) => {
  await page.goto(link(SOURCE.id, "0-12000", "1/1"));
  await ready(page);
  await keep(page, "parent try");
  await row(page, "parent try").getByRole("button", { name: "go on from this" }).click();
  await ready(page);
  await expect(page.getByText(/goes on from a sketch that is not published yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "publish this flip" })).toBeDisabled();
});

test("a side that cannot be made says which side and why, and the other still plays", async ({
  page,
}) => {
  await page.addInitScript(
    ([key, id]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      const mk = (n: number, end: number, parent: object, title: string) => ({
        id: `sk${String(n).padStart(12, "0")}`,
        parent,
        cut: { start: 0, end },
        p: 1,
        q: 1,
        title,
        retryKey: `web-0123456789abcdef0123456789ab0${n}`,
        at: n,
      });
      localStorage.setItem(
        key!,
        JSON.stringify({
          v: 1,
          sketches: [
            mk(1, 600, { kind: "stage", id }, "tiny parent"),
            // this one asks for more than its parent's output has
            mk(2, 9_000, { kind: "sketch", id: "sk000000000001" }, "too long for it"),
            mk(3, 12_000, { kind: "stage", id }, "fine"),
          ],
          bank: [],
        }),
      );
    },
    [KEY, SOURCE.id] as const,
  );
  await page.goto("/make");
  await row(page, "too long for it").getByRole("button", { name: "marked A" }).click();
  await row(page, "fine").getByRole("button", { name: "marked B" }).click();
  await page.getByRole("button", { name: "play A then B" }).click();
  await expect(page.getByTestId("compare")).toContainText(/A cannot be played/);
});

test("the strip passes an accessibility scan and its controls are reachable by keyboard", async ({
  page,
}, info) => {
  await page.goto(link(SOURCE.id, "0-12000"));
  await ready(page);
  await keep(page, "scanned");
  await keep(page, "second");
  await row(page, "scanned").getByRole("button", { name: "marked A" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("compare")).toBeVisible();
  await scan(page, "the sketch strip with a comparison", info);
});

test("with one sketch there is only what one sketch needs; the second brings the rest", async ({
  page,
}) => {
  await page.goto(link(SOURCE.id, "0-12000", "1/1"));
  await ready(page);
  await keep(page, "only one");
  const one = row(page, "only one");
  for (const name of ["open", "go on from this", "rename", "discard"]) {
    await expect(one.getByRole("button", { name })).toBeVisible();
  }
  await expect(one.getByRole("button", { name: "marked A" })).toHaveCount(0);
  await expect(one.getByRole("button", { name: "put on the bank" })).toHaveCount(0);
  await expect(one.getByLabel("publish this one")).toHaveCount(0);
  await expect(page.getByTestId("sketch-bank")).toHaveCount(0);
  await expect(page.getByTestId("set-publisher")).toHaveCount(0);
  await keep(page, "and two");
  await expect(one.getByRole("button", { name: "marked A" })).toBeVisible();
  await expect(one.getByRole("button", { name: "put on the bank" })).toBeVisible();
  await expect(one.getByLabel("publish this one")).toBeVisible();
  await expect(page.getByTestId("sketch-bank")).toBeVisible();
  await expect(page.getByTestId("set-publisher")).toBeVisible();
});

test("the sketches say why they exist: a published flip cannot be changed and a sketch can", async ({
  page,
}) => {
  await page.goto(link(SOURCE.id, "0-12000", "1/1"));
  await ready(page);
  await expect(page.getByTestId("no-sketches")).toBeVisible();
  await keep(page, "why");
  await expect(page.getByTestId("your-sketches")).toContainText(
    "a published flip is public and its sound cannot be changed",
  );
});
