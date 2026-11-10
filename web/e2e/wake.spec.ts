// Waking the service: the site asks its own server once per visit, and a chain page opened while the
// service is asleep says so and opens by itself. Each test names the guarantee it protects. Driven in real
// Chromium against the built site; the service is not running in these specs, which is the point.
import { expect, test, type Page } from "@playwright/test";
import { scan } from "./a11y.ts";

test.use({ viewport: { width: 390, height: 844 } });

/** The site's server does not need to reach anything here: the wake call is answered by the test. */
async function stubWake(page: Page): Promise<{ count: () => number }> {
  let n = 0;
  await page.route("**/api/wake", (route) => {
    n += 1;
    return route.fulfill({ status: 204 });
  });
  return { count: () => n };
}

test("opening the site asks the site's own server to wake the service, once, and a reload does not ask again", async ({
  page,
}) => {
  const wake = await stubWake(page);
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await expect.poll(wake.count).toBe(1);
  for (let i = 0; i < 5; i++) {
    await page.reload();
    await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  }
  await page.waitForTimeout(500);
  expect(wake.count(), "five reloads asked no more than the first visit did").toBe(1);
});

test("the wake call carries nothing about the visitor and the browser keeps nothing for it", async ({
  page,
}) => {
  const seen: Array<{ method: string; body: string | null; headers: Record<string, string> }> = [];
  await page.route("**/api/wake", (route) => {
    const r = route.request();
    seen.push({ method: r.method(), body: r.postData(), headers: r.headers() });
    return route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await expect.poll(() => seen.length).toBe(1);
  expect(seen[0]!.method).toBe("POST");
  expect(seen[0]!.body).toBeNull();
  const keys = await page.evaluate(() => [
    ...Object.keys(localStorage),
    ...Object.keys(sessionStorage),
  ]);
  expect(
    keys.filter((k) => k !== "graft.coach" && k !== "graft.coach.sketch" && k !== "graft.theme"),
  ).toEqual([]);
});

test("the route answers at once with nothing in the body, so a browser learns nothing from it", async ({
  request,
}) => {
  const response = await request.post("/api/wake");
  expect(response.status()).toBe(204);
  expect(await response.text()).toBe("");
  expect((await request.get("/api/wake")).status(), "and only a post is answered").toBe(405);
});

test.describe("a chain page opened while the service is asleep", () => {
  test("says so, kindly, and is announced once", async ({ page }) => {
    await stubWake(page);
    // the service answers nothing yet
    await page.route("http://127.0.0.1:8080/**", (route) => route.abort());
    await page.goto("/p/someid");
    const waking = page.getByTestId("waking");
    await expect(waking).toBeVisible();
    await expect(waking).toContainText("waking up.");
    await expect(page, "the tab says it too, not that nothing is here").toHaveTitle("waking up.");
    await expect(waking).toContainText("about a minute");
    await expect(waking.getByRole("button", { name: "try now" })).toBeVisible();
    await expect(waking).toHaveAttribute("data-mood", "waking");
    // the one status line is what is announced; it does not change at every attempt
    const status = waking.getByRole("status");
    await expect(status).toHaveText("checking again in a moment.");
    await page.waitForTimeout(7_000);
    await expect(status).toHaveText("checking again in a moment.");
  });

  test("opens by itself when the service starts to answer, without a reload by the visitor", async ({
    page,
  }) => {
    await stubWake(page);
    let up = false;
    await page.route("http://127.0.0.1:8080/**", (route) =>
      up
        ? route.fulfill({
            status: 200,
            contentType: "text/plain",
            body: "ready",
            headers: { "access-control-allow-origin": "*" },
          })
        : route.abort(),
    );
    const refreshes: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("_rsc=")) refreshes.push(r.url());
    });
    await page.goto("/p/someid");
    await expect(page.getByTestId("waking")).toBeVisible();
    up = true;
    await page.getByRole("button", { name: "try now" }).click();
    // the page asks the site for the chain again, by itself
    await expect.poll(() => refreshes.length, { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test("tells waking apart from the visitor being offline", async ({ page, context }) => {
    await stubWake(page);
    await page.route("http://127.0.0.1:8080/**", (route) => route.abort());
    await page.goto("/p/someid");
    await expect(page.getByTestId("waking")).toHaveAttribute("data-mood", "waking");
    await context.setOffline(true);
    await page.getByRole("button", { name: "try now" }).click();
    await expect(page.getByTestId("waking")).toHaveAttribute("data-mood", "offline");
    await expect(page.getByTestId("waking")).toContainText("you look to be offline");
  });

  test("with reduced motion the progress cue does not move", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await stubWake(page);
    await page.route("http://127.0.0.1:8080/**", (route) => route.abort());
    await page.goto("/p/someid");
    const animation = await page
      .locator(".waking-bar span")
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).toBe("none");
  });

  test("the waking state has no serious accessibility violation", async ({ page }, info) => {
    await stubWake(page);
    await page.route("http://127.0.0.1:8080/**", (route) => route.abort());
    await page.goto("/p/someid");
    await expect(page.getByTestId("waking")).toBeVisible();
    await scan(page, "the waking state", info);
  });
});
