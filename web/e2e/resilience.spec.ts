// What the roll does when the network is slow or the audio is not available: it stays usable and
// says what is happening; and what it does not ask for (the home route reads no API).
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test("the home route makes no request to any API: the seeded chain is static, and its audio is cacheable", async ({
  page,
}) => {
  const requests: Array<{ url: string; method: string }> = [];
  page.on("request", (r) => requests.push({ url: r.url(), method: r.method() }));
  const audio: Array<{ url: string; cache: string }> = [];
  page.on("response", (r) => {
    if (r.url().includes("/seed/"))
      audio.push({ url: r.url(), cache: r.headers()["cache-control"] ?? "" });
  });
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  const origin = new URL(page.url()).origin;
  expect(requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith("data:"))).toEqual(
    [],
  );
  expect(requests.filter((r) => new URL(r.url).pathname.startsWith("/v1/"))).toEqual([]);
  expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  expect(audio.length).toBe(4);
  for (const a of audio) expect(a.cache, a.url).toBe("public, max-age=31536000, immutable");
});

test("on a slow connection the page is interactive before the audio is: it says it is loading, then plays", async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  // Slow 3G: about 400 kbit/s down and 400 ms of latency.
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 400,
    downloadThroughput: (400 * 1024) / 8,
    uploadThroughput: (400 * 1024) / 8,
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const play = page.getByRole("button", { name: "play", exact: true });
  await expect(play).toBeVisible();
  await expect(page.locator(".notes")).toContainText("loading the sounds");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready", { timeout: 55_000 });
  await play.click();
  await expect(page.getByRole("button", { name: "pause", exact: true })).toBeVisible();
});

test("when audio cannot start the page says so and stays usable, instead of failing silently", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    class Blocked extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        // A browser that keeps the context suspended until a gesture it will not accept.
        Object.defineProperty(this, "state", { get: () => "suspended" });
      }
      override resume(): Promise<void> {
        return Promise.reject(new DOMException("not allowed", "NotAllowedError"));
      }
    }
    window.AudioContext = Blocked;
  });
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await page.getByRole("button", { name: "play", exact: true }).click();
  await expect(page.locator(".notes")).toContainText("could not start");
  await expect(page.getByRole("button", { name: "play", exact: true })).toBeEnabled();
});

test("a browser that refuses 48 kHz gets its own rate, and the roll still plays", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    class NoRate extends Original {
      constructor(options?: AudioContextOptions) {
        if (options && "sampleRate" in options)
          throw new DOMException("unsupported rate", "NotSupportedError");
        super(options);
      }
    }
    window.AudioContext = NoRate;
  });
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await page.getByRole("button", { name: "play", exact: true }).click();
  await expect(page.getByRole("button", { name: "pause", exact: true })).toBeVisible();
});

test("the sounds that could not be fetched give a retry, not a blank page", async ({ page }) => {
  await page.route("**/seed/*.pcm", (route) => route.abort("connectionreset"));
  await page.goto("/");
  await expect(page.locator(".notes")).toContainText("could not be loaded");
});
