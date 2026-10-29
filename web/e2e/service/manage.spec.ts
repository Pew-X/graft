// The maker's controls, the report dialog and the about page, against the real service. The manage
// key is typed into a page and sent in a header; it is never in an address, a storage entry or a
// cookie unless the maker chose to keep it.
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, API, SEEDED_LAST, allowBucketReads, publishFlip } from "./service.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await allowBucketReads(page);
});

async function useKey(page: Page, id: string, key: string): Promise<void> {
  await page.goto(`/manage/${id}`);
  await expect(page.getByText("the publication", { exact: true })).toBeVisible();
  await page.locator("input[type=password]").fill(key);
}

test("closing a stage to flips refuses a new flip of it, reopening allows one, and nothing already made changes", async ({
  page,
  request,
}) => {
  const stage = await publishFlip(request, SEEDED_LAST, "stage to manage");
  const child = await publishFlip(request, stage.id, "a flip made before");
  await useKey(page, stage.id, stage.manageKey);
  await page.getByRole("button", { name: "close it to new flips" }).click();
  await expect(page.getByText("closed to new flips.")).toBeVisible();

  const refused = await request.post(`${API}/v1/publications`, {
    data: {
      parent_id: stage.id,
      cut: { start: 0, end: 12000 },
      speed: { p: 1, q: 1 },
      title: "too late",
      author: "x",
      retry_key: "e2e-closed-0123456789abcdef",
    },
  });
  expect(refused.status()).toBe(403);
  // The flip made before is untouched, and the page that tries to flip says why it cannot.
  expect((await request.get(`${API}/v1/chains/${child.id}`)).status()).toBe(200);
  await page.goto(`/make?from=${stage.id}&cut=0-12000&speed=3/2`);
  await page.getByRole("button", { name: "publish this flip" }).click();
  await page.getByLabel(/^title/).fill("a refused flip");
  await page.getByLabel(/^your name/).fill("page maker");
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.locator(".publish .problem")).toContainText("closed it to new flips");

  await useKey(page, stage.id, stage.manageKey);
  await expect(page.getByText("closed to new flips", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "open it to new flips again" }).click();
  await expect(page.getByText("open to new flips again.")).toBeVisible();
  const allowed = await request.post(`${API}/v1/publications`, {
    data: {
      parent_id: stage.id,
      cut: { start: 0, end: 12000 },
      speed: { p: 1, q: 1 },
      title: "now allowed",
      author: "x",
      retry_key: "e2e-reopened-0123456789abcdef",
    },
  });
  expect(allowed.status()).toBe(201);
});

test("withdrawing leaves the credit as no longer here while the stage built on it still plays", async ({
  page,
  request,
}) => {
  const stage = await publishFlip(request, SEEDED_LAST, "stage to withdraw");
  const child = await publishFlip(request, stage.id, "built on the withdrawn stage");
  await useKey(page, stage.id, stage.manageKey);
  await page.getByRole("button", { name: "withdraw it" }).click();
  await expect(page.getByText("you cannot undo this").first()).toBeVisible();
  await page.getByRole("button", { name: "yes, withdraw it" }).click();
  await expect(page.getByText("withdrawn.")).toBeVisible();
  await expect(page.getByRole("button", { name: "withdraw it" })).toHaveCount(0);

  await page.goto(`/p/${child.id}`);
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  const blocks = page.locator(".block");
  await expect(blocks.nth(4)).toContainText("no longer here");
  await expect(blocks.nth(4)).toContainText("stage to withdraw");
  await expect(blocks.nth(5)).toContainText("built on the withdrawn stage");
});

test("a wrong key gets the one refusal, and the key is in no address, storage entry or cookie", async ({
  page,
  context,
  request,
}) => {
  const stage = await publishFlip(request, SEEDED_LAST, "stage with a key");
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  page.on("request", (r) => requests.push({ url: r.url(), headers: r.headers() }));
  await useKey(page, stage.id, "not-the-key-0123456789abcdefghijklmnop");
  await page.getByRole("button", { name: "close it to new flips" }).click();
  await expect(page.getByText("that key was not accepted.")).toBeVisible();

  await page.locator("input[type=password]").fill(stage.manageKey);
  await page.getByRole("button", { name: "close it to new flips" }).click();
  await expect(page.getByText("closed to new flips.")).toBeVisible();

  expect(page.url()).not.toContain(stage.manageKey);
  expect(requests.filter((r) => r.url.includes(stage.manageKey))).toEqual([]);
  const sent = requests.filter((r) => r.headers["x-graft-manage-key"]);
  expect(sent.length).toBe(2);
  expect(await context.cookies()).toEqual([]);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain(stage.manageKey);
});

test("a key kept in this browser can be used from there, and forgotten", async ({
  page,
  request,
}) => {
  const parent = (await publishFlip(request, SEEDED_LAST, "parent")).id;
  await page.goto(`/make?from=${parent}&cut=0-12000&speed=3/2`);
  await page.getByRole("button", { name: "publish this flip" }).click();
  await page.getByLabel(/^title/).fill("keep my key");
  await page.getByLabel(/^your name/).fill("page maker");
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await page.getByLabel(/keep this key in this browser/).check();
  await page.getByRole("link", { name: "manage this publication" }).click();
  await expect(page.getByText("the publication", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "use the key kept in this browser" }).click();
  await page.getByRole("button", { name: "close it to new flips" }).click();
  await expect(page.getByText("closed to new flips.")).toBeVisible();
  await page.getByRole("button", { name: "forget the key kept in this browser" }).click();
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((k) => k !== "graft.coach").length),
  ).toBe(0);
});

test("a flip this browser holds a key for is listed, managed from the list, shown withdrawn, and forgotten", async ({
  page,
  request,
}) => {
  const stage = await publishFlip(request, SEEDED_LAST, "listed flip");
  await page.addInitScript(
    ([id, key]) => {
      // seeded once per tab: a reload must keep what the page itself has stored since
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("graft.manage-keys", JSON.stringify({ [id!]: key! }));
    },
    [stage.id, stage.manageKey] as const,
  );
  await page.goto("/flips");
  const row = page.locator(".your-flip");
  await expect(row).toContainText("listed flip");
  await expect(row).toContainText("open to new flips");
  await row.getByRole("link", { name: "manage" }).click();
  await page.getByRole("button", { name: "use the key kept in this browser" }).click();
  await page.getByRole("button", { name: "withdraw it" }).click();
  await page.getByRole("button", { name: "yes, withdraw it" }).click();
  await expect(page.getByText("withdrawn.")).toBeVisible();
  // the list says so, and no longer offers to open it
  await page.goto("/flips");
  await expect(row).toContainText("withdrawn");
  await expect(row.getByRole("link", { name: "open", exact: true })).toHaveCount(0);
  // forgetting the key is the browser's own act, and leaves nothing behind
  await row.getByRole("button", { name: "forget", exact: true }).click();
  await row.getByRole("button", { name: "yes, forget it" }).click();
  await expect(page.getByText("no flips here yet")).toBeVisible();
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((k) => k !== "graft.coach").length),
  ).toBe(0);
});

test("a link to nothing says there is no publication, and the controls are not shown", async ({
  page,
}) => {
  await page.goto("/manage/doesnotexist");
  await expect(page.getByText("there is no publication with this link.")).toBeVisible();
  await expect(page.getByRole("button", { name: "withdraw it" })).toHaveCount(0);
});

test.describe("the report dialog", () => {
  async function openReport(page: Page, id: string): Promise<void> {
    await page.goto(`/p/${id}`);
    await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
    await page.locator('.block[data-hero="true"] button.report').click();
  }

  test("a report from the roll is stored, with the confirmation and what happens next", async ({
    page,
    request,
  }) => {
    const { id } = await publishFlip(request, SEEDED_LAST, "reported flip");
    await openReport(page, id);
    const dialog = page.getByRole("dialog", { name: "report this sound" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("it is spam").check();
    await dialog.getByLabel(/^a note/).fill("looks like an advert");
    await dialog.getByRole("button", { name: "send the report" }).click();
    await expect(dialog.getByRole("status").first()).toHaveText("the report was received.");
    await expect(dialog).toContainText("you will not hear back");
    const listed = await request.get(`${API}/admin/reports`, { headers: ADMIN });
    const text = await listed.text();
    expect(text).toContain(id);
    expect(text).toContain("looks like an advert");
  });

  test("focus goes into the dialog, escape closes it, and focus returns to the control that opened it", async ({
    page,
    request,
  }) => {
    const { id } = await publishFlip(request, SEEDED_LAST, "focus flip");
    await page.goto(`/p/${id}`);
    await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
    const opener = page.locator('.block[data-hero="true"] button.report');
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "report this sound" });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  for (const [name, status, body, words] of [
    [
      "rate limited",
      429,
      { type: "urn:graft:problem:rate-limited", retry_after_secs: 120 },
      /sent a lot of reports.*in about 2 minutes/,
    ],
    ["gone", 404, { type: "urn:graft:problem:not-found" }, /no longer here/],
    [
      "a note that breaks a rule",
      422,
      { type: "urn:graft:problem:invalid-field", field: "note", rule: "character" },
      /the note breaks a rule: character/,
    ],
  ] as const) {
    test(`a report the service refuses as "${name}" says so kindly`, async ({ page, request }) => {
      const { id } = await publishFlip(request, SEEDED_LAST, "refused report");
      await page.route(`${API}/v1/reports`, (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status,
              contentType: "application/problem+json",
              body: JSON.stringify({ title: "x", status, detail: "x", ...body }),
            })
          : route.continue(),
      );
      await openReport(page, id);
      const dialog = page.getByRole("dialog", { name: "report this sound" });
      await dialog.getByRole("button", { name: "send the report" }).click();
      await expect(dialog.getByRole("alert")).toContainText(words);
    });
  }
});

test("the about page says what graft is and is not, lists the sounds, and the footer line is on every page", async ({
  page,
}) => {
  await page.goto("/about");
  await expect(page.getByRole("heading", { name: "what graft is" })).toBeVisible();
  await expect(page.getByText("not a sampler")).toBeVisible();
  await expect(page.getByText("no ip address in its own records")).toBeVisible();
  await expect(page.getByText("cannot be recalled")).toBeVisible();
  await expect(page.locator("main li").filter({ hasText: "dm9 chord" })).toBeVisible();
  for (const path of ["/about", "/make", "/manage/anything", "/", "/does-not-exist"]) {
    await page.goto(path);
    await expect(page.locator("footer.footer")).toContainText(
      "independent experiment, not affiliated with or endorsed by any product named",
    );
    await expect(page.getByRole("link", { name: "about" })).toHaveAttribute("href", "/about");
  }
  const response = await page.goto("/about");
  expect(response?.status()).toBe(200);
});
