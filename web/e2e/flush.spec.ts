// The page-hide flush is the part of telemetry that differs between browser engines, so this spec
// runs in Chromium, Firefox and WebKit. The page is a bare one served from the site's own origin
// with the real adapter on it, and the endpoint is a stub that records what arrives.
import { expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

interface Telemetry {
  track(kind: string, publicationId: string): void;
  queued: number;
}

test("hiding the page sends what is waiting, as one JSON batch, without cookies or a referrer", async ({
  page,
}) => {
  const received: Array<{ body: string; headers: Record<string, string> }> = [];
  await page.route("**/flush-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta charset="utf-8"><title>flush</title><body>flush</body><script src="/telemetry.js"></script>',
    }),
  );
  await page.route("**/telemetry.js", (route) =>
    route.fulfill({ contentType: "text/javascript", path: join(here, "dist", "telemetry.js") }),
  );
  await page.route("**/v1/events", async (route) => {
    received.push({ body: route.request().postData() ?? "", headers: route.request().headers() });
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"accepted":2}' });
  });
  await page.goto("/flush-harness");
  await page
    .context()
    .addCookies([{ name: "unrelated", value: "1", url: "http://127.0.0.1:3100/" }]);

  await page.evaluate(() => {
    const t = (window as unknown as { graftTelemetry: Telemetry }).graftTelemetry;
    t.track("roll_opened", "e790b6ycz0yd");
    t.track("stage_played", "e790b6ycz0yd");
  });
  expect(received, "waiting for a batch: nothing sent yet").toHaveLength(0);

  // The page goes to the background.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => received.length).toBe(1);

  const batch = JSON.parse(received[0]!.body) as { events: Array<Record<string, string>> };
  expect(batch.events.map((e) => e["kind"])).toEqual(["roll_opened", "stage_played"]);
  expect(new Set(batch.events.map((e) => e["session_id"])).size).toBe(1);
  // Plain text, so a cross-origin send needs no preflight (which could not finish while a page unloads).
  expect(received[0]!.headers["content-type"]).toContain("text/plain");
  expect(received[0]!.headers["cookie"], "no cookies travel with it").toBeUndefined();
  expect(received[0]!.headers["referer"], "no referrer either").toBeUndefined();
  expect(
    await page.evaluate(
      () => (window as never as { graftTelemetry: Telemetry }).graftTelemetry.queued,
    ),
  ).toBe(0);
});

test("a failing endpoint never throws into the page", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.route("**/flush-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta charset="utf-8"><title>flush</title><body>flush</body><script src="/telemetry.js"></script>',
    }),
  );
  await page.route("**/telemetry.js", (route) =>
    route.fulfill({ contentType: "text/javascript", path: join(here, "dist", "telemetry.js") }),
  );
  await page.route("**/v1/events", (route) => route.abort("connectionrefused"));
  await page.goto("/flush-harness");
  await page.evaluate(() => {
    const t = (window as unknown as { graftTelemetry: Telemetry }).graftTelemetry;
    t.track("roll_opened", "e790b6ycz0yd");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(500);
  expect(problems).toEqual([]);
});
