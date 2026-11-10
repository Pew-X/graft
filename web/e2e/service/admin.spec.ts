// The operator's page against the real service: the gate, a report through hide and lift, the kill
// switch refusing a real publish, and that nothing the page prints can run as code.
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, API, SEEDED_LAST, allowBucketReads, publishFlip } from "./service.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const SECRET = ADMIN["x-graft-admin-secret"]!;
const REFUSED = "that was not accepted. wait a little before trying again.";

test.beforeEach(async ({ page }) => {
  await allowBucketReads(page);
});

async function signIn(page: Page, secret = SECRET): Promise<void> {
  await page.goto("/admin");
  await page.getByLabel("operator secret").fill(secret);
  await page.getByRole("button", { name: "open" }).click();
}

test("the page is a locked form until the right secret is typed; a wrong one gets one plain message", async ({
  page,
}) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "reports" })).toHaveCount(0);
  await page.getByLabel("operator secret").fill("a-wrong-secret-0123456789abc");
  await page.getByRole("button", { name: "open" }).click();
  await expect(page.getByRole("status").first()).toHaveText(REFUSED);
  await expect(page.getByRole("heading", { name: "reports" })).toHaveCount(0);

  await signIn(page);
  await expect(page.getByRole("heading", { name: "reports" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "switches" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "events by hour" })).toBeVisible();
});

test("the secret is held in memory and sent in a header: not in the address, storage or cookies", async ({
  page,
  context,
}) => {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  page.on("request", (r) => {
    urls.push(r.url());
    if (r.url().startsWith(API)) headers.push(r.headers());
  });
  await signIn(page);
  await expect(page.getByRole("heading", { name: "reports" })).toBeVisible();
  expect(page.url()).toBe("http://127.0.0.1:3100/admin");
  expect(urls.filter((u) => u.includes(SECRET))).toEqual([]);
  expect(headers.length).toBeGreaterThan(0);
  expect(headers.every((h) => h["x-graft-admin-secret"] === SECRET)).toBe(true);
  expect(await context.cookies()).toEqual([]);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(SECRET);
  // Locking forgets it: the form is back, empty.
  await page.getByRole("button", { name: "lock" }).click();
  await expect(page.getByLabel("operator secret")).toHaveValue("");
});

test("the page is kept out of search engines and is not linked from anywhere", async ({
  page,
  request,
}) => {
  const response = await request.get("/admin");
  expect(response.headers()["x-robots-tag"]).toMatch(/noindex/);
  await page.goto("/admin");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  const { id } = await publishFlip(request, SEEDED_LAST, "a link check flip");
  for (const path of ["/", `/p/${id}`]) {
    await page.goto(path);
    await expect(page.locator(".roll")).toBeVisible();
    await expect(page.locator('a[href*="admin"]')).toHaveCount(0);
  }
});

test("the service refuses markup in a report's note before it can reach the page", async ({
  request,
}) => {
  const a = await publishFlip(request, SEEDED_LAST, "markup target");
  const filed = await request.post(`${API}/v1/reports`, {
    data: { publication_id: a.id, category: "other", note: "<script>window.__pwned = 1</script>" },
  });
  expect(filed.status()).toBe(422);
});

test("a report is listed with its state; hide for rights holds the stages built on it; lifting releases them", async ({
  page,
  context,
  request,
}) => {
  const a = await publishFlip(request, SEEDED_LAST, "report target");
  const b = await publishFlip(request, a.id, "built on the target");
  const filed = await request.post(`${API}/v1/reports`, {
    data: {
      publication_id: a.id,
      category: "rights",
      note: "&lt;b&gt;bold&lt;/b&gt; &amp; please look at this",
    },
  });
  expect(filed.status(), await filed.text()).toBe(201);

  await signIn(page);
  const item = page.locator("li", { hasText: "report target" });
  await expect(item).toBeVisible();
  await expect(item).toContainText("rights");
  await expect(item).toContainText("visible");
  // The note is text, shown exactly as typed. (The service already refuses "<" in any public text;
  // entities are what is left to get wrong, and a page that decoded them would print real markup.)
  await expect(item).toContainText("&lt;b&gt;bold&lt;/b&gt; &amp; please look at this");
  await expect(item.locator("b")).toHaveCount(0);

  const chain = await context.newPage();
  await allowBucketReads(chain);
  try {
    await item.getByRole("button", { name: "hide: rights" }).click();
    await expect(item).toContainText("hidden: rights");
    await chain.goto(`/p/${b.id}`);
    await expect(chain.locator('.block[data-state="held"]')).toHaveCount(1);
    await expect(chain.locator('.block[data-state="no_longer_here"]')).toHaveCount(1);
  } finally {
    // Whatever happened above, leave the stage visible.
    const lifted = await request.delete(`${API}/admin/publications/${a.id}/hide`, {
      headers: ADMIN,
    });
    expect([200]).toContain(lifted.status());
  }
  await page.getByRole("button", { name: "refresh" }).click();
  await expect(item).toContainText("visible");
  await chain.reload();
  await expect(chain.locator('.block[data-state="available"]')).toHaveCount(6);
});

test("the lift button on the page does what the service does", async ({ page, request }) => {
  const a = await publishFlip(request, SEEDED_LAST, "to hide and lift");
  await request.post(`${API}/v1/reports`, { data: { publication_id: a.id, category: "spam" } });
  await signIn(page);
  const item = page.locator("li", { hasText: "to hide and lift" });
  await item.getByRole("button", { name: "hide: withdrawn" }).click();
  await expect(item).toContainText("hidden: withdrawn");
  await item.getByRole("button", { name: "lift the hide" }).click();
  await expect(item).toContainText("visible");
  await expect(item).toContainText("no note");
});

test("closing publishing from the page makes a real publish refuse, and opening it brings it back", async ({
  page,
  request,
}) => {
  const publish = () =>
    request.post(`${API}/v1/publications`, {
      data: {
        parent_id: SEEDED_LAST,
        cut: { start: 0, end: 24000 },
        speed: { p: 1, q: 1 },
        title: "switch test",
        author: "test maker",
        retry_key: `svc-test-switch-${Date.now().toString(36)}-0123456789`,
      },
    });
  await signIn(page);
  try {
    await expect(page.locator("[data-publishing]")).toHaveText("open");
    await page.getByRole("button", { name: "close publishing" }).click();
    await expect(page.locator("[data-publishing]")).toHaveText("closed");
    expect((await publish()).status()).toBe(503);
    await page.getByRole("button", { name: "open publishing" }).click();
    await expect(page.locator("[data-publishing]")).toHaveText("open");
    expect((await publish()).status()).toBe(201);
  } finally {
    await request.put(`${API}/admin/switch`, { headers: ADMIN, data: { publishing: true } });
  }
  await expect(page.locator("[data-uploads]")).toHaveText("off");
});

test("the event view says sessions and best-effort, and never counts people", async ({
  page,
  request,
}) => {
  await request.post(`${API}/v1/events`, {
    data: {
      events: [
        {
          event_id: `admin-view-${Date.now().toString(36)}-0123456789`,
          session_id: "admin-view-session",
          kind: "roll_opened",
          occurred_at_ms: Date.now(),
          publication_id: SEEDED_LAST,
        },
      ],
    },
  });
  await signIn(page);
  const events = page
    .getByRole("region", { name: "events by hour" })
    .or(page.locator("section", { hasText: "events by hour" }));
  await expect(events.first()).toContainText("best-effort");
  await expect(events.first()).toContainText("sessions");
  await expect(page.locator("body")).not.toContainText(/people|users|visitors counted/i);
  // The relay and the consumer take a moment; the page shows what the service has when asked.
  await expect(async () => {
    await page.getByRole("button", { name: "refresh" }).click();
    await expect(page.getByRole("columnheader", { name: "roll_opened" })).toBeVisible({
      timeout: 1_500,
    });
  }).toPass({ timeout: 20_000 });
});

test("it fits and works on a phone: controls are 44 px, nothing scrolls sideways, it is all labelled", async ({
  page,
  request,
}) => {
  const a = await publishFlip(request, SEEDED_LAST, "phone fit");
  await request.post(`${API}/v1/reports`, {
    data: { publication_id: a.id, category: "other", note: "x".repeat(400) },
  });
  await signIn(page);
  await expect(page.getByRole("heading", { name: "reports" })).toBeVisible();
  const buttons = page.getByRole("button");
  for (let i = 0; i < (await buttons.count()); i++) {
    const box = (await buttons.nth(i).boundingBox())!;
    const name = await buttons.nth(i).innerText();
    expect(box.height, name).toBeGreaterThanOrEqual(44);
    expect(box.width, name).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
