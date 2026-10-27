// The chain route against the real service, database and bucket (scripts/service-e2e.sh). A visitor's
// flip is published through the API, the operator hides and clears through the admin routes, and the
// browser opens the link.
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, API, SEEDED_LAST, allowBucketReads, hide, publishFlip } from "./service.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const S3 = process.env["GRAFT_SERVICE_S3"] ?? "http://127.0.0.1:59000";
const roll = (page: Page) => page.locator(".roll");
const titles = (page: Page) => page.locator(".slab .title").allInnerTexts();

/** Audio requests the browser makes to the bucket. */
function watchAudio(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith(S3) && r.method() === "GET") seen.push(r.url());
  });
  return seen;
}

test.beforeEach(async ({ page }) => {
  await allowBucketReads(page);
});

test("a published flip has a link that opens the whole chain, ending with it", async ({
  page,
  request,
}) => {
  const { id } = await publishFlip(request, SEEDED_LAST, "link test flip");
  const audio = watchAudio(page);
  await page.goto(`/p/${id}`);
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
  expect(await titles(page)).toEqual([
    "dm9 chord",
    "up a fifth",
    "down a fifth",
    "down an octave",
    "link test flip",
  ]);
  await expect(page.locator('.block[data-state="available"]')).toHaveCount(5);
  await expect(page.getByText("not flipped yet").last()).toBeVisible();
  expect(audio).toHaveLength(5);
  // The roll plays from this page too: the finished flip is the new one.
  await page.getByRole("button", { name: "play", exact: true }).tap();
  await expect(roll(page)).toHaveAttribute("data-stage", "4");
  await expect(roll(page)).toHaveAttribute("data-sounding", "true");
});

test("the link preview is the final stage's title and one plain line, and nothing else", async ({
  page,
  request,
}) => {
  const { id } = await publishFlip(request, SEEDED_LAST, "preview test flip");
  await page.goto(`/p/${id}`);
  await expect(page).toHaveTitle("preview test flip");
  const meta = async (selector: string) => page.locator(selector).getAttribute("content");
  const line = "a sound and the 4 flips that came before it, rolled as credits.";
  expect(await meta('meta[name="description"]')).toBe(line);
  expect(await meta('meta[property="og:title"]')).toBe("preview test flip");
  expect(await meta('meta[property="og:description"]')).toBe(line);
  const properties = await page
    .locator('meta[property^="og:"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("property")));
  expect(properties.sort()).toEqual(["og:description", "og:title", "og:type"]);
  // The framework mirrors the title and line for other readers; there is no image of any kind.
  const names = await page
    .locator('meta[name^="twitter:"], meta[property^="og:"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("name") ?? e.getAttribute("property")));
  expect(names.filter((n) => /image/.test(n ?? ""))).toEqual([]);
  expect(names.sort()).toEqual([
    "og:description",
    "og:title",
    "og:type",
    "twitter:card",
    "twitter:description",
    "twitter:title",
  ]);
});

test("a stage withdrawn by the operator reads 'no longer here' with its credit, and its audio is never asked for", async ({
  page,
  request,
}) => {
  const a = await publishFlip(request, SEEDED_LAST, "alpha");
  const b = await publishFlip(request, a.id, "bravo");
  const c = await publishFlip(request, b.id, "charlie");
  await hide(request, b.id, "withdrawn");
  try {
    const audio = watchAudio(page);
    await page.goto(`/p/${c.id}`);
    await expect(roll(page)).toHaveAttribute("data-audio", "ready");
    const gone = page.locator('.block[data-state="no_longer_here"]');
    await expect(gone).toHaveCount(1);
    await expect(gone).toContainText("bravo");
    await expect(gone).toContainText("this sound is no longer here, but its credit is.");
    await expect(gone).toContainText("copies already downloaded cannot be recalled");
    await expect(gone.locator(".slab button")).toBeDisabled();
    // 4 seeded + alpha + charlie. Bravo's address was never issued, so it was never asked for.
    expect(audio).toHaveLength(6);
    // Stages built on it stay playable.
    await expect(page.locator('.block[data-state="available"]')).toHaveCount(6);
    await expect(page.getByRole("status").first()).toContainText(
      "one stage cannot be played here. its credit stays.",
    );
  } finally {
    await hide(request, b.id, null);
  }
});

test("the record's keyboard control makes no sound on a stage that is not here", async ({
  page,
  request,
}) => {
  const a = await publishFlip(request, SEEDED_LAST, "kilo");
  const b = await publishFlip(request, a.id, "lima");
  await hide(request, a.id, "withdrawn");
  try {
    await page.goto(`/p/${b.id}`);
    await expect(roll(page)).toHaveAttribute("data-audio", "ready");
    // Stage 5 (alpha, withdrawn) is the one above the last: up from stage 6, then Enter.
    const record = page.getByRole("slider", { name: "the record" });
    await record.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
    await expect(record).toHaveAttribute("aria-valuetext", /stage 6 of 6, lima/);
    await page.keyboard.press("ArrowUp");
    await expect(record).toHaveAttribute("aria-valuetext", /stage 5 of 6, kilo/);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await expect(roll(page)).toHaveAttribute("data-playback", "idle");
    await expect(roll(page)).toHaveAttribute("data-sounding", "false");
  } finally {
    await hide(request, a.id, null);
  }
});

test("a stage hidden for rights holds the stages built on it; lifting the hide releases them", async ({
  page,
  request,
}) => {
  const a = await publishFlip(request, SEEDED_LAST, "delta");
  const b = await publishFlip(request, a.id, "echo");
  const c = await publishFlip(request, b.id, "foxtrot");
  await hide(request, a.id, "rights");
  try {
    const audio = watchAudio(page);
    await page.goto(`/p/${c.id}`);
    await expect(roll(page)).toHaveAttribute("data-audio", "ready");
    await expect(page.locator('.block[data-state="no_longer_here"]')).toHaveCount(1);
    const held = page.locator('.block[data-state="held"]');
    await expect(held).toHaveCount(2);
    await expect(held.first()).toContainText("being looked at for rights");
    await expect(held.first()).toContainText("its credit stays");
    expect(audio, "only the four seeded stages are heard").toHaveLength(4);
  } finally {
    await hide(request, a.id, null);
  }
  const again = watchAudio(page);
  await page.goto(`/p/${c.id}`);
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
  await expect(page.locator('.block[data-state="available"]')).toHaveCount(7);
  expect(again).toHaveLength(7);
});

test("a link to nothing is a quiet empty state with a 404, and a way home", async ({ page }) => {
  const response = await page.goto("/p/doesnotexist1");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "nothing here" })).toBeVisible();
  await expect(page.getByText("this link does not lead to a sound")).toBeVisible();
  // the first stop is the way back in the corner, the second the plain link under the words; both go home
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("← graft");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
    "go to the first roll",
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/127\.0\.0\.1:3100\/$/);
});

test("an issued address that expired mid-session is replaced and the visitor sees nothing", async ({
  page,
  request,
}) => {
  const { id } = await publishFlip(request, SEEDED_LAST, "expiry flip");
  let refused = 0;
  let chains = 0;
  page.on("request", (r) => {
    if (r.url().startsWith(`${API}/v1/chains/`)) chains++;
  });
  // The first audio request is answered as an expired address would be.
  await page.route(`${S3}/**`, async (route) => {
    if (refused === 0) {
      refused++;
      await route.fulfill({ status: 403, headers: { "access-control-allow-origin": "*" } });
      return;
    }
    await route.fallback();
  });
  await page.goto(`/p/${id}`);
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
  expect(refused).toBe(1);
  expect(chains, "the chain was asked for again to get fresh addresses").toBeGreaterThanOrEqual(2);
  await expect(page.getByText("could not be loaded")).toHaveCount(0);
});

test("a service that does not answer shows the retry state, and retrying works once it is back", async ({
  page,
  request,
}) => {
  const { id } = await publishFlip(request, SEEDED_LAST, "retry flip");
  let down = true;
  await page.route(`${API}/v1/chains/**`, async (route) => {
    if (down) await route.abort("connectionrefused");
    else await route.fallback();
  });
  await page.goto(`/p/${id}`);
  await expect(roll(page)).toHaveAttribute("data-audio", "failed");
  await expect(page.getByRole("status").first()).toContainText("could not be loaded");
  down = false;
  await page.getByRole("button", { name: "try again" }).click();
  await expect(roll(page)).toHaveAttribute("data-audio", "ready");
});

test("the server page carries credits and states, never an audio address, and is never cached", async ({
  request,
}) => {
  const a = await publishFlip(request, SEEDED_LAST, "golf");
  const b = await publishFlip(request, a.id, "hotel");
  const before = await (await request.get(`${API}/v1/chains/${b.id}`)).json();
  const hiddenBlob = before.stages[4].details.output_blob as string;
  await hide(request, a.id, "rights");
  try {
    const response = await request.get(`/p/${b.id}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const html = await response.text();
    expect(html).not.toContain(":59000");
    expect(html).not.toMatch(/X-Amz|\.pcm|signature=/i);
    expect(html).not.toContain(hiddenBlob);
    expect(html).toContain("being looked at for rights");
  } finally {
    await hide(request, a.id, null);
  }
});

test("the page prints none of the words the project does not use", async ({ page, request }) => {
  const a = await publishFlip(request, SEEDED_LAST, "india");
  await hide(request, a.id, "withdrawn");
  try {
    await page.goto(`/p/${a.id}`);
    await expect(page.locator(".roll")).toBeVisible();
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(
      /\b(drop|drops|stack|stacks|take|takes|recipe|recipes|kitchen|chef|verified|proven|certified|owned by|cleared)\b/i,
    );
    expect(text).not.toContain("!");
  } finally {
    await hide(request, a.id, null);
  }
});

test("the admin routes are not reachable from the browser's origin without the secret", async ({
  request,
}) => {
  const response = await request.get(`${API}/admin/reports`);
  expect(response.status()).toBe(403);
  const ok = await request.get(`${API}/admin/reports`, { headers: ADMIN });
  expect(ok.status()).toBe(200);
});
