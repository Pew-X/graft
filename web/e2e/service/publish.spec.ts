// The publish step against the real service, database and bucket (scripts/service-e2e.sh): a flip
// is made in the page and published, an answer lost on the way back does not make a second one,
// and every refusal the service can give is met with its own words.
import { expect, test, type Page, type Route } from "@playwright/test";
import { API, SEEDED_LAST, allowBucketReads, publishFlip } from "./service.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const POSTS = `${API}/v1/publications`;

test.beforeEach(async ({ page }) => {
  await allowBucketReads(page);
});

/** A parent of its own, so counting its flips counts only what this test made. */
async function parentFor(request: Parameters<typeof publishFlip>[0]): Promise<string> {
  return (await publishFlip(request, SEEDED_LAST, "parent for a publish test")).id;
}

async function open(page: Page, parent: string): Promise<void> {
  await page.goto(`/make?from=${parent}&cut=0-12000&speed=3/2`);
  await expect(page.locator("[data-output-hash]:not([data-output-hash=''])")).toBeVisible();
  await page.getByRole("button", { name: "publish this flip" }).click();
}

async function fill(
  page: Page,
  title = "a flip from the page",
  name = "page maker",
): Promise<void> {
  await page.getByLabel(/^title/).fill(title);
  await page.getByLabel(/^your name/).fill(name);
}

/** How many flips the service holds on this parent. */
async function flipsOf(request: Parameters<typeof publishFlip>[0], id: string): Promise<number> {
  const response = await request.get(`${API}/v1/chains/${id}`);
  const chain = (await response.json()) as {
    stages: Array<{ id: string; flipped_count?: number }>;
  };
  return chain.stages.find((s) => s.id === id)?.flipped_count ?? -1;
}

function watchPosts(page: Page): Array<{ key: string; status?: number }> {
  const seen: Array<{ key: string }> = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === POSTS) {
      seen.push({ key: (JSON.parse(r.postData() ?? "{}") as { retry_key: string }).retry_key });
    }
  });
  return seen;
}

test("publishing makes one flip: the link opens the chain with it last, and the key is shown once", async ({
  page,
  request,
}) => {
  const parent = await parentFor(request);
  await open(page, parent);
  await fill(page, "published from the page", "page maker");
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.getByRole("heading", { name: "published" })).toBeVisible();
  const key = await page.getByTestId("manage-key").innerText();
  expect(key.length).toBeGreaterThanOrEqual(32);
  await expect(page.getByText("shown once")).toBeVisible();
  const href = (await page.getByTestId("published-link").getAttribute("href"))!;
  expect(await flipsOf(request, parent)).toBe(1);

  await page.goto(href);
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  const titles = await page.locator(".slab .title").allInnerTexts();
  expect(titles.at(-1)).toBe("published from the page");

  // The key is not on this page, nor in anything the service answers about the publication.
  expect(await page.content()).not.toContain(key);
  const chain = await request.get(`${API}/v1${href.replace("/p/", "/chains/")}`);
  expect(await chain.text()).not.toContain(key);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(key);
});

test("an answer lost on the way back is retried with the same key and makes exactly one flip", async ({
  page,
  request,
}) => {
  const parent = await parentFor(request);
  const posts = watchPosts(page);
  let lost = false;
  await page.route(POSTS, async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    if (!lost) {
      lost = true;
      await route.fetch(); // the service gets it and makes the flip ...
      await route.abort("connectionreset"); // ... and the answer never arrives
      return;
    }
    return route.continue();
  });
  await open(page, parent);
  await fill(page);
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.getByRole("heading", { name: "published" })).toBeVisible();
  expect(posts.length).toBe(2);
  expect(posts[0]!.key).toBe(posts[1]!.key);
  expect(await flipsOf(request, parent)).toBe(1);
  await expect(page.getByText("already published by an earlier try")).toBeVisible();
});

test("tapping publish twice quickly sends one request", async ({ page, request }) => {
  const parent = await parentFor(request);
  const posts = watchPosts(page);
  await open(page, parent);
  await fill(page);
  await page.getByRole("button", { name: "publish", exact: true }).dblclick();
  await expect(page.getByRole("heading", { name: "published" })).toBeVisible();
  expect(posts.length).toBe(1);
  expect(await flipsOf(request, parent)).toBe(1);
});

test("when the service stays busy it retries with one key, gives up kindly, and a manual retry makes one flip", async ({
  page,
  request,
}) => {
  const parent = await parentFor(request);
  const posts = watchPosts(page);
  await page.route(POSTS, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 503,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "urn:graft:problem:retry-later",
            title: "Busy",
            status: 503,
            detail: "busy",
          }),
        })
      : route.continue(),
  );
  await open(page, parent);
  await fill(page);
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.locator(".publish .problem")).toContainText("did not finish after 4 tries", {
    timeout: 15_000,
  });
  expect(posts.length).toBe(4);
  expect(new Set(posts.map((p) => p.key)).size).toBe(1);
  expect(await flipsOf(request, parent)).toBe(0);

  await page.unroute(POSTS);
  await page.getByRole("button", { name: "try again" }).click();
  await expect(page.getByRole("heading", { name: "published" })).toBeVisible();
  expect(posts.at(-1)!.key).toBe(posts[0]!.key);
  expect(await flipsOf(request, parent)).toBe(1);
});

test("offline, it says so after its tries, and coming back online a retry publishes once", async ({
  page,
  context,
  request,
}) => {
  const parent = await parentFor(request);
  await open(page, parent);
  await fill(page);
  await context.setOffline(true);
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.locator(".publish .problem")).toContainText("network did not answer", {
    timeout: 15_000,
  });
  await context.setOffline(false);
  await page.getByRole("button", { name: "try again" }).click();
  await expect(page.getByRole("heading", { name: "published" })).toBeVisible();
  expect(await flipsOf(request, parent)).toBe(1);
});

test("a key reused for different content is explained, and a fresh attempt publishes", async ({
  page,
  request,
}) => {
  const parent = await parentFor(request);
  const posts = watchPosts(page);
  let once = true;
  await page.route(POSTS, (route) => {
    if (route.request().method() === "POST" && once) {
      once = false;
      return route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "urn:graft:problem:key-conflict",
          title: "Conflict",
          status: 409,
          detail: "x",
        }),
      });
    }
    return route.continue();
  });
  await open(page, parent);
  await fill(page);
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.locator(".publish .problem")).toContainText(
    "already used for a different flip",
  );
  await page.getByRole("button", { name: "start a fresh attempt" }).click();
  await expect(page.getByRole("heading", { name: "published" })).toBeVisible();
  expect(posts.length).toBe(2);
  expect(posts[1]!.key).not.toBe(posts[0]!.key);
  expect(await flipsOf(request, parent)).toBe(1);
});

const refusals: Array<[string, number, Record<string, unknown>, RegExp]> = [
  ["publishing-off", 503, {}, /publishing is switched off/],
  ["storage-full", 503, {}, /reached the storage/],
  ["rate-limited", 429, { retry_after_secs: 120 }, /published a lot.*in about 2 minutes/],
  ["publish-cap", 429, { retry_after_secs: 3600 }, /everyone together.*in about an hour/],
  [
    "fork-cap",
    429,
    { retry_after_secs: 30 },
    /flipped as often as is allowed.*in about 30 seconds/,
  ],
  ["fork-not-permitted", 403, {}, /closed it to new flips/],
  ["depth-cap", 409, {}, /as long as chains can be/],
  ["parent-held", 409, {}, /held while its rights are looked at/],
  ["parent-unavailable", 409, {}, /no longer here/],
  ["internal", 500, {}, /something went wrong on our side/],
];
for (const [type, status, extra, words] of refusals) {
  test(`the service's "${type}" answer is met with its own sentence, never a generic error`, async ({
    page,
    request,
  }) => {
    const parent = await parentFor(request);
    await page.route(POSTS, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: `urn:graft:problem:${type}`,
              title: "x",
              status,
              detail: "x",
              ...extra,
            }),
          })
        : route.continue(),
    );
    await open(page, parent);
    await fill(page);
    await page.getByRole("button", { name: "publish", exact: true }).click();
    const alert = page.locator(".publish .problem");
    await expect(alert).toContainText(words, { timeout: 15_000 });
    await expect(alert).not.toContainText(/error|failed|oops/i);
  });
}

test("a title the service refuses is named: the real rule, in the maker's words", async ({
  page,
  request,
}) => {
  const parent = await parentFor(request);
  await open(page, parent);
  await fill(page, "the admin cut", "page maker");
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.locator(".publish .problem")).toContainText(
    "the title breaks a rule: it uses a word that is not allowed",
  );
  expect(await flipsOf(request, parent)).toBe(0);
});

test("a link in the title is removed by the service and the page says so", async ({
  page,
  request,
}) => {
  const parent = await parentFor(request);
  await open(page, parent);
  await page.getByLabel(/^title/).fill("hear https://example.com now");
  await expect(page.locator('.publish [id$="-title-hint"]')).toContainText(
    "links and @handles are removed",
  );
  await page.getByLabel(/^your name/).fill("page maker");
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.getByText("a link or a handle was removed from your title")).toBeVisible();
});

test("a preview that differs from the service's render is said plainly, and the service's audio is what stays", async ({
  page,
  request,
}) => {
  const parent = await parentFor(request);
  await page.route(POSTS, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    json["preview_matches"] = false;
    return route.fulfill({ response, json });
  });
  await open(page, parent);
  await fill(page);
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.getByText("which differs from the preview you heard")).toBeVisible();
});

test("the key is kept in this browser only when the maker chooses, and then it is the one thing stored", async ({
  page,
  request,
}) => {
  const parent = await parentFor(request);
  await open(page, parent);
  await fill(page);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.getByRole("heading", { name: "published" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.length), "publishing alone stores nothing").toBe(0);
  const key = await page.getByTestId("manage-key").innerText();
  await page.getByLabel(/keep this key in this browser/).check();
  await expect(page.getByText("kept in this browser.")).toBeVisible();
  const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  expect(Object.keys(stored)).toEqual(["graft.manage-keys"]);
  expect(Object.values(JSON.parse(stored["graft.manage-keys"]!) as Record<string, string>)).toEqual(
    [key],
  );
});

test("the step is keyboard-complete: focus lands on the title, errors take focus, and the dialog's labels are real", async ({
  page,
  request,
}) => {
  const parent = await parentFor(request);
  await open(page, parent);
  await expect(page.getByLabel(/^title/)).toBeFocused();
  await expect(page.getByRole("button", { name: "publish", exact: true })).toBeDisabled();
  await page.keyboard.type("typed by keyboard");
  await page.keyboard.press("Tab");
  await page.keyboard.type("key maker");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "published" })).toBeFocused();
});

test("changing the cut after publishing does not take the result, or the one-time key, off the screen", async ({
  page,
  request,
}) => {
  const parent = await parentFor(request);
  await open(page, parent);
  await fill(page);
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.getByRole("heading", { name: "published" })).toBeVisible();
  const key = await page.getByTestId("manage-key").innerText();
  // A handle dragged past the other makes the cut invalid: the controls say so, the result stays.
  const start = page.getByRole("slider", { name: "start of the cut" });
  await start.focus();
  await page.keyboard.press("End");
  await expect(page.locator("#why-not")).toContainText("ends before it starts");
  await expect(page.getByRole("heading", { name: "published" })).toBeVisible();
  await expect(page.getByTestId("manage-key")).toHaveText(key);
});
