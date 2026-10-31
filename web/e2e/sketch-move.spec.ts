// "Move my sketches": a link (in the address fragment) or a small file carries them to another browser. Each
// test names the guarantee it protects. Nothing here needs the service: a sketch is never sent anywhere.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "./a11y.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIRST = (
  JSON.parse(readFileSync(join(web, "snapshot", "sources.json"), "utf8")) as {
    stages: Array<{ id: string }>;
  }
).stages[0]!;
const KEY = "graft.sketches";

test.use({ bypassCSP: true, acceptDownloads: true });

const ready = (page: Page) =>
  expect(page.locator("[data-output-hash]")).not.toHaveAttribute("data-output-hash", "");

/** Keep three sketches (one goes on from another) by writing the book the page itself would have written. */
async function seed(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, id]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      const mk = (n: number, parent: object, title: string) => ({
        id: `sk00000000000${n}`,
        parent,
        cut: { start: 0, end: 20_000 + n },
        p: 3,
        q: 2,
        title,
        retryKey: `web-0123456789abcdef0123456789abcd0${n}`,
        at: n,
      });
      localStorage.setItem(
        key!,
        JSON.stringify({
          v: 1,
          sketches: [
            mk(1, { kind: "stage", id }, "low"),
            mk(2, { kind: "sketch", id: "sk000000000001" }, "low, then up"),
            mk(3, { kind: "stage", id }, "high"),
          ],
          bank: [],
        }),
      );
    },
    [KEY, FIRST.id] as const,
  );
  await page.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (t: string) => {
          (window as unknown as { __copied: string[] }).__copied.push(t);
          return Promise.resolve();
        },
      },
    });
  });
}

async function copiedLink(page: Page): Promise<string> {
  await page.goto("/make");
  await page.getByTestId("move-sketches").locator("summary").click();
  await page.getByRole("button", { name: "copy my sketchbook link" }).click();
  await expect(page.getByText(/link copied/)).toBeVisible();
  return (await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied[0]))!;
}

const book = (page: Page) =>
  page.evaluate(
    (key) =>
      (
        JSON.parse(localStorage.getItem(key) ?? "null") as {
          sketches: Array<{
            id: string;
            retryKey: string;
            title: string;
            parent: { kind: string; id: string };
          }>;
        } | null
      )?.sketches ?? [],
    KEY,
  );

async function fresh(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    bypassCSP: true,
    acceptDownloads: true,
    storageState: { cookies: [], origins: [] },
  });
  return context.newPage();
}

test("the link carries the sketches in the fragment, and says what it carries and what it does not", async ({
  page,
}) => {
  await seed(page);
  const url = await copiedLink(page);
  const u = new URL(url);
  expect(u.pathname).toBe("/make");
  expect(u.search).toBe("");
  expect(u.hash.startsWith("#sketchbook=g1.3.")).toBe(true);
  await expect(
    page.getByText(
      /anyone you send it to can read them\. it carries no keys and nothing that publishes anything/,
    ),
  ).toBeVisible();
  // nothing of it is in what the browser sent to anyone
  const payload = u.hash.slice("#sketchbook=".length);
  expect(payload).not.toContain("web-0123");
});

test("opened in a fresh browser it is a question; yes adds them with fresh ids and keys; the fragment is cleaned", async ({
  page,
  browser,
}) => {
  await seed(page);
  const url = await copiedLink(page);
  const here = await book(page);

  const other = await fresh(browser);
  const sent: string[] = [];
  other.on("request", (r) => sent.push(`${r.url()} ${r.postData() ?? ""}`));
  await other.goto(url);
  const question = other.getByTestId("import-question");
  await expect(question).toContainText("this carries 3 sketches. add them to this browser?");
  await expect(question.locator("li")).toHaveText(["low", "low, then up", "high"]);
  expect(await book(other), "nothing is added before the answer").toHaveLength(0);
  await question.getByRole("button", { name: "add them" }).click();
  await expect(other.getByTestId("import-result")).toContainText("added 3.");
  await other.getByTestId("import-result").getByRole("button").click();
  expect(new URL(other.url()).hash).toBe("");
  const there = await book(other);
  expect(there.map((s) => s.title).sort()).toEqual(["high", "low", "low, then up"]);
  for (const s of there)
    for (const mine of here) {
      expect(s.id).not.toBe(mine.id);
      expect(s.retryKey).not.toBe(mine.retryKey);
    }
  const child = there.find((s) => s.title === "low, then up")!;
  expect(child.parent).toEqual({ kind: "sketch", id: there.find((s) => s.title === "low")!.id });
  // a reload cannot import twice, and nothing was sent anywhere with the payload
  await other.reload();
  await expect(other.getByTestId("import-question")).toHaveCount(0);
  expect(await book(other)).toHaveLength(3);
  const payload = new URL(url).hash.slice("#sketchbook=".length);
  expect(sent.filter((s) => s.includes(payload.slice(0, 40)))).toEqual([]);
  await other.context().close();
});

test("no discards the fragment and adds nothing; what is already here is skipped and counted", async ({
  page,
  browser,
}) => {
  await seed(page);
  const url = await copiedLink(page);
  const other = await fresh(browser);
  await other.goto(url);
  await other.getByTestId("import-question").getByRole("button", { name: "not now" }).click();
  expect(new URL(other.url()).hash).toBe("");
  expect(await book(other)).toHaveLength(0);
  // import, then the same link again: all three were already here
  await other.goto(url);
  await other.getByRole("button", { name: "add them" }).click();
  await other.goto("/make");
  // a hash change that lands while the page is still starting up is not what is under test
  await other.waitForLoadState("networkidle");
  await other.goto(url);
  await other.getByRole("button", { name: "add them" }).click();
  await expect(other.getByTestId("import-result")).toContainText("added 0. 3 were already here.");
  expect(await book(other)).toHaveLength(3);
  await other.context().close();
});

test("a link cut short, or changed by one character, is refused whole with the reason in words", async ({
  page,
  browser,
}) => {
  await seed(page);
  const url = await copiedLink(page);
  const other = await fresh(browser);
  await other.goto(url.slice(0, url.length - 20));
  await expect(other.getByTestId("import-result")).toContainText("this link looks cut short");
  await other.getByTestId("import-result").getByRole("button").click();
  expect(new URL(other.url()).hash).toBe("");
  const damaged = url.slice(0, 60) + (url[60] === "A" ? "B" : "A") + url.slice(61);
  await other.goto(damaged);
  await expect(other.getByTestId("import-result")).toContainText(/changed or damaged|cut short/);
  expect(await book(other)).toHaveLength(0);
  await other.context().close();
});

test("hostile links are refused whole: random text, a huge fragment, other versions", async ({
  browser,
}) => {
  const other = await fresh(browser);
  for (const [fragment, words] of [
    ["not-a-link", /not a sketchbook link/],
    ["g9.1.abcd.00000000", /newer version of graft/],
    ["x".repeat(9000), /too long/],
    ["g1.99.abcd.00000000", /more than 40 sketches/],
  ] as const) {
    await other.goto("/make");
    await other.evaluate((f) => {
      window.location.hash = `sketchbook=${f}`;
    }, fragment);
    await expect(other.getByTestId("import-result")).toContainText(words);
    await other.getByTestId("import-result").getByRole("button").click();
  }
  expect(await book(other)).toHaveLength(0);
  await other.context().close();
});

test("a link pasted into a make tab that is already open asks the same question", async ({
  page,
  browser,
}) => {
  await seed(page);
  const url = await copiedLink(page);
  const other = await fresh(browser);
  await other.goto("/make");
  await other.evaluate((hash) => {
    window.location.hash = hash.slice(1);
  }, new URL(url).hash);
  await expect(other.getByTestId("import-question")).toBeVisible();
  await other.context().close();
});

test("opened on another page, it offers the make page instead of importing out of context", async ({
  page,
  browser,
}) => {
  await seed(page);
  const url = await copiedLink(page);
  const other = await fresh(browser);
  await other.goto(`/${new URL(url).hash}`);
  const offer = other.getByTestId("import-elsewhere");
  await expect(offer).toContainText("they are added on the make page");
  expect(await book(other)).toHaveLength(0);
  await offer.getByRole("link", { name: "open the make page" }).click();
  await expect(other).toHaveURL(/\/make#sketchbook=/);
  await expect(other.getByTestId("import-question")).toBeVisible();
  await other.context().close();
});

test("a file does the same: saved from one browser, added in another, and bad files are refused", async ({
  page,
  browser,
}) => {
  await seed(page);
  await page.goto("/make");
  await page.getByTestId("move-sketches").locator("summary").click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "save my sketches to a file" }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("graft-sketches.txt");
  const path = await saved.path();
  const text = readFileSync(path!, "utf8");
  expect(text).toMatch(/^g1\.3\./);
  expect(text).not.toContain("web-0123");

  const other = await fresh(browser);
  await other.goto("/make");
  await other.getByTestId("move-sketches").locator("summary").click();
  const input = other.getByTestId("sketch-file");
  await input.setInputFiles({
    name: "big.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(70_000, "a"),
  });
  await expect(other.getByText(/that is not a sketchbook file/)).toBeVisible();
  await input.setInputFiles({ name: "x.png", mimeType: "image/png", buffer: Buffer.from("png") });
  await expect(other.getByText(/that is not a sketchbook file/)).toBeVisible();
  await input.setInputFiles({
    name: "junk.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("junk"),
  });
  await expect(other.getByTestId("import-result")).toContainText("not a sketchbook link");
  await other.getByTestId("import-result").getByRole("button").click();
  await input.setInputFiles({
    name: "graft-sketches.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(text),
  });
  await other.getByRole("button", { name: "add them" }).click();
  await expect(other.getByTestId("import-result")).toContainText("added 3.");
  expect(await book(other)).toHaveLength(3);
  await other.context().close();
});

test("with nothing kept there is nothing to move, and the question passes an accessibility scan", async ({
  page,
  browser,
}, info) => {
  await page.goto("/make");
  await page.getByTestId("move-sketches").locator("summary").click();
  await expect(page.getByText("keep a sketch first")).toBeVisible();
  await expect(page.getByRole("button", { name: "copy my sketchbook link" })).toBeDisabled();
  const seeded = await browser.newPage({ storageState: { cookies: [], origins: [] } });
  await seed(seeded);
  const url = await copiedLink(seeded);
  await page.goto(url);
  await expect(page.getByTestId("import-question")).toBeVisible();
  await scan(page, "the import question", info);
  void ready;
  await seeded.close();
});
