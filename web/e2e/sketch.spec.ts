// Sketches: private tries kept in this browser. Against the built site and its shipped snapshots (no service:
// a sketch is never sent anywhere). Each test names the guarantee it protects.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "./a11y.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = (
  JSON.parse(readFileSync(join(web, "snapshot", "sources.json"), "utf8")) as {
    stages: Array<{ id: string; title: string; frames: number }>;
  }
).stages;
const FIRST = sources[0]!;
const KEY = "graft.sketches";

test.use({ bypassCSP: true });

const hash = (page: Page) => page.locator("[data-output-hash]");
const ready = (page: Page) => expect(hash(page)).not.toHaveAttribute("data-output-hash", "");
const link = (cut = "0-24000", speed = "3/2") => `/make?from=${FIRST.id}&cut=${cut}&speed=${speed}`;
const stored = (page: Page) =>
  page.evaluate(
    (key) =>
      JSON.parse(localStorage.getItem(key) ?? "null") as {
        v: number;
        sketches: Array<Record<string, unknown>>;
      } | null,
    KEY,
  );

async function keepOne(page: Page, title?: string): Promise<void> {
  if (title !== undefined)
    await page
      .getByLabel(/^name of this try/)
      .first()
      .fill(title);
  await page.getByRole("button", { name: "keep as sketch" }).click();
}

test("keeping a try makes a private sketch: stored as specs, listed, and nothing is sent anywhere", async ({
  page,
}) => {
  // the page's own wake call is not a sketch; what matters is that no request names a sketch or a key
  const leaks: string[] = [];
  page.on("request", (r) => {
    const text = `${r.url()} ${r.postData() ?? ""}`;
    if (/sk[0-9a-z]{12}|retryKey|retry_key|graft\.sketches/.test(text)) leaks.push(text);
  });
  await page.goto(link(`0-${Math.min(FIRST.frames, 480_000)}`));
  await ready(page);
  await keepOne(page);
  await expect(page.getByText("kept as a sketch: up a fifth. nothing is published.")).toBeVisible();
  const book = await stored(page);
  expect(book?.v).toBe(1);
  expect(book?.sketches).toHaveLength(1);
  const sketch = book!.sketches[0]!;
  expect(sketch["parent"]).toEqual({ kind: "stage", id: FIRST.id });
  expect(sketch["cut"]).toEqual({ start: 0, end: Math.min(FIRST.frames, 480_000) });
  expect([sketch["p"], sketch["q"]]).toEqual([3, 2]);
  expect(String(sketch["retryKey"]).length).toBeGreaterThanOrEqual(16);
  // specs only: no audio is ever stored
  expect(JSON.stringify(book).length).toBeLessThan(1000);
  const item = page.getByTestId("your-sketches").locator(".your-sketch");
  await expect(item).toHaveCount(1);
  await expect(item.locator(".sketch-title")).toHaveText("up a fifth");
  await expect(item.locator(".sketch-facts")).toHaveText(/^up a fifth, [0-9.]+ s$/);
  await expect(item.locator(".sketch-cut")).toHaveText(
    /^cut 0 to [0-9.]+ s of the sound it starts from\.$/,
  );
  expect(leaks, "keeping a sketch sends nothing").toEqual([]);
});

test("a sketch is still there after a reload and opens to the same sound: the same hash it had when kept", async ({
  page,
}) => {
  await page.goto(link("1200-31000", "3/2"));
  await ready(page);
  const kept = await hash(page).getAttribute("data-output-hash");
  await keepOne(page, "my try");
  await page.goto("/make");
  const section = page.getByTestId("your-sketches");
  await expect(section.locator(".sketch-title")).toHaveText("my try");
  await section.getByRole("button", { name: "open" }).click();
  await ready(page);
  await expect(hash(page)).toHaveAttribute("data-output-hash", kept!);
});

test("a title can be changed, and discarding asks once and can be backed out of", async ({
  page,
}) => {
  await page.goto(link());
  await ready(page);
  await keepOne(page, "first name");
  const item = page.getByTestId("your-sketches").locator(".your-sketch");
  await item.getByRole("button", { name: "rename" }).click();
  await item.getByRole("textbox").fill("second name");
  await item.getByRole("button", { name: "save the name" }).click();
  await expect(item.locator(".sketch-title")).toHaveText("second name");
  expect((await stored(page))?.sketches[0]?.["title"]).toBe("second name");
  await item.getByRole("button", { name: "discard" }).click();
  await expect(page.getByText("discard this sketch?").first()).toBeVisible();
  await item.getByRole("button", { name: "keep it" }).click();
  await expect(item).toHaveCount(1);
  await item.getByRole("button", { name: "discard" }).click();
  await item.getByRole("button", { name: "yes, discard" }).click();
  await expect(item).toHaveCount(0);
  expect((await stored(page))?.sketches).toHaveLength(0);
});

test("a browser that will not store says so, changes nothing, and the whole flow still works", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "graft.sketches") throw new DOMException("full", "QuotaExceededError");
      return real.call(this, key, value);
    };
  });
  await page.goto(link());
  await ready(page);
  const before = await hash(page).getAttribute("data-output-hash");
  await keepOne(page);
  await expect(page.getByText(/this browser would not keep it/)).toBeVisible();
  await expect(hash(page)).toHaveAttribute("data-output-hash", before!);
  await expect(page.getByTestId("your-sketches")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "publish this flip" })).toBeEnabled();
});

test("storage that cannot be read at all shows no sketches and no error", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("blocked");
      },
    });
  });
  await page.goto(link());
  await ready(page);
  await expect(page.getByTestId("your-sketches")).toHaveCount(0);
  await keepOne(page);
  await expect(page.getByText(/this browser would not keep it/)).toBeVisible();
});

test("two tabs: a sketch kept in one appears in the other without a reload, and a discard says so there", async ({
  context,
  page,
}) => {
  await page.goto(link());
  await ready(page);
  const other = await context.newPage();
  await other.goto(link());
  await ready(other);
  await expect(other.getByTestId("your-sketches")).toHaveCount(0);
  await keepOne(page, "from tab one");
  await expect(other.getByTestId("your-sketches").locator(".sketch-title")).toHaveText(
    "from tab one",
  );
  // open it in tab two, then discard it in tab one
  await other.getByTestId("your-sketches").getByRole("button", { name: "open" }).click();
  await ready(other);
  const item = page.getByTestId("your-sketches").locator(".your-sketch");
  await item.getByRole("button", { name: "discard" }).click();
  await item.getByRole("button", { name: "yes, discard" }).click();
  await expect(other.getByText("this sketch was discarded in another tab")).toBeVisible();
  // the editor keeps its values
  await expect(other.locator("[data-output-hash]")).not.toHaveAttribute("data-output-hash", "");
});

test("corrupt stored data is ignored sketch by sketch and never an error page", async ({
  page,
}) => {
  await page.addInitScript(
    ([key, id]) => {
      localStorage.setItem(
        key!,
        JSON.stringify({
          v: 1,
          sketches: [
            null,
            "x",
            { id: "nope" },
            {
              id: "sk0000000000aa",
              parent: { kind: "stage", id },
              cut: { start: 0, end: 24000 },
              p: 3,
              q: 2,
              title: "survivor",
              retryKey: "web-0123456789abcdef0123456789abcdef",
              at: 1,
            },
          ],
        }),
      );
    },
    [KEY, FIRST.id] as const,
  );
  await page.goto("/make");
  await expect(page.getByTestId("your-sketches").locator(".sketch-title")).toHaveText(["survivor"]);
});

test("a store from a newer version is left alone and nothing new is written over it", async ({
  page,
}) => {
  const future = JSON.stringify({ v: 2, sketches: [{ anything: 1 }] });
  await page.addInitScript(
    ([key, text]) => {
      if (!sessionStorage.getItem("seeded")) {
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem(key!, text!);
      }
    },
    [KEY, future] as const,
  );
  await page.goto(link());
  await ready(page);
  await keepOne(page);
  await expect(page.getByText(/newer version of graft/)).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(future);
});

test("the limit refuses the forty-first, offers the oldest unused one for discard, and drops nothing", async ({
  page,
}) => {
  await page.addInitScript(
    ([key, id]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      const sketches = Array.from({ length: 40 }, (_, i) => ({
        id: `sk${String(i).padStart(12, "0")}`,
        parent: { kind: "stage", id },
        cut: { start: 0, end: 1000 + i },
        p: 3,
        q: 2,
        title: `try ${i}`,
        retryKey: `web-0123456789abcdef0123456789ab${String(i).padStart(2, "0")}`,
        at: 100 + i,
      }));
      localStorage.setItem(key!, JSON.stringify({ v: 1, sketches }));
    },
    [KEY, FIRST.id] as const,
  );
  await page.goto(link());
  await ready(page);
  await keepOne(page);
  await expect(page.getByText(/keeps at most 40 sketches/)).toBeVisible();
  await expect(page.getByText("discard the oldest one nothing goes on from, try 0?")).toBeVisible();
  expect((await stored(page))?.sketches).toHaveLength(40);
  await page.getByRole("button", { name: "yes, discard" }).last().click();
  await keepOne(page);
  await expect(page.getByText(/kept as a sketch/)).toBeVisible();
  const after = await stored(page);
  expect(after?.sketches).toHaveLength(40);
  expect(after?.sketches.some((s) => s["title"] === "try 0")).toBe(false);
});

test("a sketch that no longer fits its sound opens as a plain statement, not a crash", async ({
  page,
}) => {
  await page.addInitScript(
    ([key, id]) => {
      localStorage.setItem(
        key!,
        JSON.stringify({
          v: 1,
          sketches: [
            {
              id: "sk0000000000aa",
              parent: { kind: "stage", id },
              cut: { start: 0, end: 9_000_000 },
              p: 3,
              q: 2,
              title: "too long",
              retryKey: "web-0123456789abcdef0123456789abcdef",
              at: 1,
            },
          ],
        }),
      );
    },
    [KEY, FIRST.id] as const,
  );
  await page.goto("/make");
  await page.getByTestId("your-sketches").getByRole("button", { name: "open" }).click();
  await expect(page.getByTestId("no-fit")).toContainText("this try no longer fits");
});

test("a sketch whose sound was withdrawn says it cannot be published, and still plays", async ({
  page,
}) => {
  await page.route("**/v1/publications/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "no_longer_here",
        title: "gone",
        author: "x",
        fork_permitted: true,
      }),
    }),
  );
  await page.goto(link());
  await ready(page);
  await keepOne(page);
  await page.getByTestId("your-sketches").getByRole("button", { name: "open" }).click();
  await ready(page);
  await expect(
    page.getByText("cannot be published: the sound it was cut from was withdrawn"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^(hear it|pause)/ })).toBeEnabled();
});

test("the editor says it is not saved by itself, and sketches say where they live", async ({
  page,
}) => {
  await page.goto(link());
  await ready(page);
  await expect(page.getByText("the editor is not saved by itself")).toBeVisible();
  await keepOne(page);
  await expect(page.getByText(/kept in this browser only/)).toBeVisible();
});

test("the sketch controls are reachable by keyboard and pass an accessibility scan", async ({
  page,
}, info) => {
  await page.goto(link());
  await ready(page);
  await page
    .getByLabel(/^name of this try/)
    .first()
    .fill("by keyboard");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "keep as sketch" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/kept as a sketch: by keyboard/)).toBeVisible();
  await scan(page, "make page with a sketch", info);
});

test("an empty title is named from the speed, the cut when it is not the whole sound, and a clash gets a number", async ({
  page,
}) => {
  await page.goto(link("0-24000", "3/2"));
  await ready(page);
  await keepOne(page);
  await expect(page.getByText(/kept as a sketch: up a fifth, 0 to 0\.5 s\./)).toBeVisible();
  await keepOne(page);
  await expect(page.getByText(/kept as a sketch: up a fifth, 0 to 0\.5 s \(2\)\./)).toBeVisible();
  const titles = (await stored(page))!.sketches.map((s) => s["title"]);
  expect(titles).toEqual(["up a fifth, 0 to 0.5 s", "up a fifth, 0 to 0.5 s (2)"]);
});

test("a typed title is checked as the service will: links are removed and said, bad ones are refused with the reason", async ({
  page,
}) => {
  await page.goto(link());
  await ready(page);
  await keepOne(page, "listen at example.com now");
  await expect(
    page.getByText(/kept as a sketch: listen at now\. a link or a handle/),
  ).toBeVisible();
  await keepOne(page, "a\u202eb");
  await expect(page.getByText(/the title has a character that is not allowed/)).toBeVisible();
  await keepOne(page, "p\u0430ypal");
  await expect(page.getByText(/mixes letters from different scripts/)).toBeVisible();
  await keepOne(page, "@someone");
  await expect(
    page.getByText(/the title is empty once links and handles are removed/),
  ).toBeVisible();
  expect((await stored(page))!.sketches).toHaveLength(1);
});
