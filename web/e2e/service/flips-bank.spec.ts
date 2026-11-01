// A stage's flips as pads, and a phrase for that bank, against the real service (scripts/service-e2e.sh): publish
// three flips of a stage, open the stage, play them as pads, record a run, copy the link and open it in a fresh
// browser: the invitation appears and sound plays only on press. A flip withdrawn since the link was made is a
// silent pad that says so. Each test names what it protects.
import { expect, test, type Page } from "@playwright/test";
import { SEEDED_LAST, allowBucketReads, hide, publishFlip } from "./service.ts";

test.use({ viewport: { width: 1280, height: 900 } });

declare global {
  interface Window {
    __started: number[];
    __contexts: number;
    __copied: string[];
  }
}

async function spy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__started = [];
    window.__contexts = 0;
    window.__copied = [];
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
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (t: string) => {
          window.__copied.push(t);
          return Promise.resolve();
        },
      },
    });
  });
  await allowBucketReads(page);
}

/** A visitor who has been through the first-visit guide: an invitation shows at once, as it does for anyone returning. */
const RETURNING = {
  cookies: [],
  origins: [
    {
      origin: "http://127.0.0.1:3100",
      localStorage: [{ name: "graft.coach", value: "keys+made" }],
    },
  ],
};

const pad = (page: Page, n: number) => page.locator(`.flips-bank .pad[data-pad="${n}"]`);

async function stageWith(
  request: Parameters<typeof publishFlip>[0],
  titles: string[],
): Promise<{ parent: string; ids: string[] }> {
  const parent = (await publishFlip(request, SEEDED_LAST, "parent of a bank")).id;
  const ids: string[] = [];
  for (const t of titles) ids.push((await publishFlip(request, parent, t)).id);
  return { parent, ids };
}

async function openBank(page: Page, parent: string): Promise<void> {
  await page.goto(`/p/${parent}`);
  await page.getByRole("button", { name: /^flips of this stage/ }).click();
  await page.getByRole("button", { name: "play these flips as pads" }).click();
  await expect(page.locator(".flips-bank .pad")).not.toHaveCount(0);
  await expect(
    page.locator(".flips-bank .pad-t", { hasText: "getting the sound ready" }),
  ).toHaveCount(0, { timeout: 20_000 });
}

test("three flips become three pads, newest first, played on the roll's one audio context; nothing is mixed or published", async ({
  page,
  request,
}) => {
  await spy(page);
  const { parent } = await stageWith(request, ["first try", "second try", "third try"]);
  await openBank(page, parent);
  await expect(page.locator(".flips-bank .pad")).toHaveCount(3);
  await expect(pad(page, 0)).toHaveAttribute("aria-label", "pad 1, third try");
  await expect(page.getByText(/these are other people's flips of this stage/)).toBeVisible();
  await pad(page, 0).click();
  await expect.poll(() => page.evaluate(() => window.__started.length)).toBe(1);
  await page.getByRole("button", { name: "overlap" }).click();
  await pad(page, 1).click();
  await pad(page, 2).click();
  await expect.poll(() => page.evaluate(() => window.__started.length)).toBe(3);
  expect(await page.evaluate(() => window.__contexts)).toBe(1);
  // opening the bank sent nothing but reads
  expect(page.url()).not.toContain("#bank");
});

test("a recorded run goes in the address with the ids of the flips it was played on; a fresh browser is invited and plays only on press", async ({
  page,
  request,
  browser,
}) => {
  await spy(page);
  const { parent, ids } = await stageWith(request, ["one", "two", "three"]);
  await openBank(page, parent);
  await page.getByRole("button", { name: "rec", exact: true }).click();
  await pad(page, 0).click();
  await pad(page, 2).click();
  await pad(page, 1).click();
  await page.getByRole("button", { name: /stop rec/ }).click();
  await expect(page.getByTestId("flips-bank-status")).toContainText(
    "the address of this page carries it",
  );
  const hash = new URL(page.url()).hash;
  expect(hash).toMatch(
    /^#bank=[0-9a-z]{12}&pads=([0-9a-z]{12},){2}[0-9a-z]{12}&phrase=1:0,3:\d+,2:\d+$/,
  );
  for (const id of ids) expect(hash).toContain(id);
  await page.getByRole("button", { name: "copy link" }).click();
  const link = await page.evaluate(() => window.__copied[0]!);
  expect(link).toContain(hash);

  const other = await (await browser.newContext({ storageState: RETURNING })).newPage();
  await spy(other);
  await other.goto(link);
  await expect(other.getByText("a run of pads came with this link")).toBeVisible({
    timeout: 30_000,
  });
  await expect(other.locator(".flips-bank .pad")).toHaveCount(3);
  // never plays by itself
  await other.waitForTimeout(1500);
  expect(await other.evaluate(() => window.__started.length)).toBe(0);
  await other.getByRole("button", { name: "play the phrase" }).click();
  await expect
    .poll(() => other.evaluate(() => window.__started.length), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(3);
  await other.context().close();
});

test("a flip withdrawn since the link was made is a silent pad that says so; the rest play", async ({
  page,
  request,
  browser,
}) => {
  await spy(page);
  const { parent, ids } = await stageWith(request, ["stays", "goes", "stays too"]);
  await openBank(page, parent);
  await page.getByRole("button", { name: "rec", exact: true }).click();
  await pad(page, 0).click();
  await pad(page, 1).click();
  await pad(page, 2).click();
  await page.getByRole("button", { name: /stop rec/ }).click();
  const link = page.url();
  await hide(request, ids[1]!, "withdrawn");
  const other = await (await browser.newContext({ storageState: RETURNING })).newPage();
  await spy(other);
  await other.goto(link);
  await expect(other.locator(".flips-bank .pad")).toHaveCount(3);
  await expect(other.locator(".flips-bank .pad[aria-disabled='true']")).toHaveCount(1);
  await expect(other.locator(".flips-bank .pad[aria-disabled='true'] .pad-t")).toHaveText(
    "no longer here",
  );
  await other.getByRole("button", { name: "play the phrase" }).click();
  await expect
    .poll(() => other.evaluate(() => window.__started.length), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  await other.context().close();
});

test("a link naming a stage this page does not show, or cut short, is no bank at all", async ({
  page,
  request,
}) => {
  await spy(page);
  const { parent } = await stageWith(request, ["only"]);
  await page.goto(`/p/${parent}#bank=eeeeeeeeeeee&pads=eeeeeeeeeeee&phrase=1:0`);
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await expect(page.getByText("a run of pads came with this link")).toHaveCount(0);
  await expect(page.locator(".flips-bank")).toHaveCount(0);
});

test("a slow or failed pad says so on itself, offers its own try again, and the others are not held up", async ({
  page,
  request,
}) => {
  await spy(page);
  const { parent, ids } = await stageWith(request, ["a", "b"]);
  let refuse = true;
  await page.route(`**/v1/publications/${ids[0]}`, (route) =>
    refuse ? route.abort() : route.continue(),
  );
  await page.goto(`/p/${parent}`);
  await page.getByRole("button", { name: /^flips of this stage/ }).click();
  await page.getByRole("button", { name: "play these flips as pads" }).click();
  await expect(page.locator(".flips-bank .pad-t", { hasText: "could not be read" })).toHaveCount(
    1,
    {
      timeout: 20_000,
    },
  );
  await pad(page, 0).click(); // the other (newer) pad is not held up by the one that failed
  await expect.poll(() => page.evaluate(() => window.__started.length)).toBe(1);
  refuse = false;
  await page.getByRole("button", { name: /^try again: / }).click();
  await expect(page.locator(".flips-bank .pad[aria-disabled='true']")).toHaveCount(0, {
    timeout: 20_000,
  });
});

test("a single flip is one pad and says so", async ({ page, request }) => {
  await spy(page);
  const { parent } = await stageWith(request, ["just one"]);
  await openBank(page, parent);
  await expect(page.locator(".flips-bank .pad")).toHaveCount(1);
  await expect(
    page.getByText("there is one flip of this stage, so there is one pad."),
  ).toBeVisible();
});
