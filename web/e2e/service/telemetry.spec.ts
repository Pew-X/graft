// Client telemetry against the real service: events reach the ledger as client events, the privacy
// signals switch everything off, and nothing about the visit is left in the browser.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN, API, SEEDED_LAST, allowBucketReads, publishFlip } from "./service.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const roll = (page: Page) => page.locator(".roll");

test.beforeEach(async ({ page }) => {
  await allowBucketReads(page);
});

/** Hourly client counts from the operator's read of the rollups, summed over the last two hours. */
async function counts(request: APIRequestContext): Promise<Record<string, number>> {
  const body = (await (
    await request.get(`${API}/admin/rollups?hours=2`, { headers: ADMIN })
  ).json()) as {
    hours: Array<{ counts: Record<string, number> }>;
  };
  const total: Record<string, number> = {};
  for (const hour of body.hours)
    for (const [kind, n] of Object.entries(hour.counts)) total[kind] = (total[kind] ?? 0) + n;
  return total;
}

/** Wait until the relay and the consumer have caught up, so a count read now is settled. */
async function settled(request: APIRequestContext): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = (await (
          await request.get(`${API}/admin/rollups`, { headers: ADMIN })
        ).json()) as {
          relay: { unsent: number };
          consumer: { unapplied: number };
        };
        return r.relay.unsent + r.consumer.unapplied;
      },
      { timeout: 15_000 },
    )
    .toBe(0);
}

const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

/**
 * Posts to the events endpoint, with the receipt the service answered each. The request goes on to
 * the real service; the route only reads what passes.
 */
async function watchEvents(page: Page) {
  const posts: Array<{ events: Array<Record<string, string>> }> = [];
  const receipts: number[] = [];
  await page.route("**/v1/events", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts.push(JSON.parse(route.request().postData() ?? "{}"));
    try {
      const response = await route.fetch();
      receipts.push(
        ((await response.json().catch(() => ({}))) as { accepted?: number }).accepted ?? -1,
      );
      await route.fulfill({ response });
    } catch {
      // The page moved on or closed while this was in flight: nothing is waiting for the answer.
    }
  });
  return { posts, receipts };
}

test("opening a roll and playing a stage put client events in the ledger", async ({
  page,
  request,
}) => {
  const { id } = await publishFlip(request, SEEDED_LAST, "telemetry flip");
  await settled(request);
  const before = await counts(request);
  const { posts, receipts } = await watchEvents(page);
  await page.goto(`/p/${id}`);
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
  await page.getByRole("button", { name: /up a fifth/ }).tap();
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  await hide(page);

  await expect
    .poll(() => posts.flatMap((p) => p.events.map((e) => e["kind"])).sort())
    .toEqual(["roll_opened", "stage_played"]);
  await expect.poll(() => receipts.reduce((a, b) => a + b, 0)).toBe(2);
  // They carry ids and a kind and nothing else.
  for (const e of posts.flatMap((p) => p.events)) {
    expect(Object.keys(e).sort()).toEqual([
      "event_id",
      "kind",
      "occurred_at_ms",
      "publication_id",
      "session_id",
    ]);
  }
  await settled(request);
  const after = await counts(request);
  expect((after["roll_opened"] ?? 0) - (before["roll_opened"] ?? 0)).toBe(1);
  expect((after["stage_played"] ?? 0) - (before["stage_played"] ?? 0)).toBe(1);
});

test("a stage is counted once a visit, however often the roll goes round it", async ({
  page,
  request,
}) => {
  const { id } = await publishFlip(request, SEEDED_LAST, "once flip");
  const { posts } = await watchEvents(page);
  await page.goto(`/p/${id}`);
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
  const label = page.getByRole("button", { name: /up a fifth/ });
  await label.tap(); // play
  await label.tap(); // pause
  await label.tap(); // play again
  await hide(page);
  await expect
    .poll(() => posts.flatMap((p) => p.events).filter((e) => e["kind"] === "stage_played"))
    .toHaveLength(1);
});

for (const [name, init] of [
  [
    "Global Privacy Control",
    "Object.defineProperty(navigator, 'globalPrivacyControl', { value: true });",
  ],
  ["Do Not Track", "Object.defineProperty(navigator, 'doNotTrack', { value: '1' });"],
  [
    "both",
    "Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }); Object.defineProperty(navigator, 'doNotTrack', { value: '1' });",
  ],
] as const) {
  test(`with ${name} on, no request is made to the events endpoint or a tracker`, async ({
    page,
    request,
  }) => {
    const { id } = await publishFlip(request, SEEDED_LAST, "private flip");
    await page.addInitScript(init);
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    await page.goto(`/p/${id}`);
    await expect(roll(page)).toHaveAttribute("data-audio", "ready");
    await page.getByRole("button", { name: /up a fifth/ }).tap();
    await page.getByRole("button", { name: "flip this" }).first().tap();
    await hide(page);
    await page.goto("about:blank");
    await page.waitForTimeout(1_500);
    expect(urls.filter((u) => u.includes("/v1/events"))).toEqual([]);
    // Nothing left the page for anywhere but the site, the bucket it plays from, and the chain read.
    const others = urls.filter(
      (u) =>
        !/^http:\/\/127\.0\.0\.1:(3100|59000)\//.test(u) &&
        !u.startsWith(`${API}/v1/chains/`) &&
        u !== "about:blank",
    );
    expect(others).toEqual([]);
  });
}

test("after a full session the browser holds no session id, no event and no cookie", async ({
  page,
  request,
  context,
}) => {
  const { id } = await publishFlip(request, SEEDED_LAST, "storage flip");
  const { posts } = await watchEvents(page);
  await page.goto(`/p/${id}`);
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
  await page.getByRole("button", { name: /up a fifth/ }).tap();
  await page.getByRole("button", { name: "flip this" }).first().tap();
  await hide(page);
  await expect.poll(() => posts.length).toBeGreaterThan(0);
  const sessionId = posts[0]!.events[0]!["session_id"]!;
  const eventId = posts[0]!.events[0]!["event_id"]!;

  expect(await context.cookies()).toEqual([]);
  const stored = await page.evaluate(async () => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
    databases: (await indexedDB.databases()).map((d) => d.name),
    cacheNames: await caches.keys(),
  }));
  expect(stored.local).toEqual({});
  expect(stored.session).toEqual({});
  expect(stored.databases).toEqual([]);
  const everything = JSON.stringify(stored);
  expect(everything).not.toContain(sessionId);
  expect(everything).not.toContain(eventId);
});

test("sending the same batch twice stores each event once", async ({ request }) => {
  const batch = {
    events: [
      {
        event_id: `dedupe-${Date.now().toString(36)}-0123456789`,
        session_id: "dedupe-session-0123",
        kind: "roll_opened",
        occurred_at_ms: Date.now(),
        publication_id: SEEDED_LAST,
      },
    ],
  };
  const first = await request.post(`${API}/v1/events`, { data: batch });
  const second = await request.post(`${API}/v1/events`, { data: batch });
  expect((await first.json()).accepted).toBe(1);
  expect((await second.json()).accepted).toBe(0);
});

test("leaving the page sends what was waiting, in a request that outlives it", async ({
  page,
  request,
}) => {
  const { id } = await publishFlip(request, SEEDED_LAST, "unload flip");
  await settled(request);
  const before = await counts(request);
  await page.goto(`/p/${id}`);
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
  await page.getByRole("button", { name: /up a fifth/ }).tap();
  await expect(roll(page)).toHaveAttribute("data-playback", "auditioning");
  // Gone before the five-second timer could have fired.
  await page.goto("about:blank");
  await expect
    .poll(
      async () => ((await counts(request))["stage_played"] ?? 0) - (before["stage_played"] ?? 0),
      { timeout: 10_000 },
    )
    .toBe(1);
});
