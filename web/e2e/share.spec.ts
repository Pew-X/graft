// The share card: the picture a chat or a feed shows for a link. Each test names the guarantee it protects.
// Driven against the built site with no service running, which is the hard case: a crawler arrives while
// the service sleeps, and must still get a card, quickly, and one that says nothing the page does not.
import { expect, test } from "@playwright/test";

/** The width and height written in a PNG's header (bytes 16 to 23), and whether it is a PNG at all. */
function dimensions(png: Buffer): { png: boolean; width: number; height: number } {
  const signature = png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { png: signature, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test("the home page's card is a 1200 by 630 picture of a sensible weight", async ({ request }) => {
  const response = await request.get("/opengraph-image");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/png");
  const body = await response.body();
  expect(dimensions(body)).toEqual({ png: true, width: 1200, height: 630 });
  expect(body.length, "light enough for a chat preview").toBeLessThan(900_000);
  expect(body.length, "not an empty picture").toBeGreaterThan(100_000);
});

test("a flip's card is still drawn when the service is asleep, and fast: a crawler will not wait", async ({
  request,
}) => {
  const started = Date.now();
  const response = await request.get("/p/q0yjjgng394w/opengraph-image");
  expect(response.status()).toBe(200);
  expect(dimensions(await response.body())).toEqual({ png: true, width: 1200, height: 630 });
  expect(Date.now() - started, "inside the time a crawler gives").toBeLessThan(6_000);
});

test("an address that is not a publication id gets the plain card, never an error or a lookup", async ({
  request,
}) => {
  for (const bad of [
    "x",
    "..%2F..%2Fadmin",
    "%3Cscript%3E",
    "AAAAAAAAAAAA",
    "iiiiiiiiiiii",
    "a".repeat(80),
  ]) {
    const response = await request.get(`/p/${bad}/opengraph-image`);
    expect(response.status(), bad).toBe(200);
    expect(dimensions(await response.body()).png, bad).toBe(true);
  }
});

test("the card is never cached for a flip: a withdrawal must show at once", async ({ request }) => {
  const response = await request.get("/p/q0yjjgng394w/opengraph-image");
  const control = (response.headers()["cache-control"] ?? "").toLowerCase();
  expect(control, control).not.toMatch(/max-age=[1-9]/);
  expect(control).not.toContain("immutable");
});

test("the home page and a chain page both advertise the card and a large summary", async ({
  page,
}) => {
  for (const path of ["/", "/p/q0yjjgng394w"]) {
    await page.goto(path);
    const og = await page.locator('meta[property="og:image"]').first().getAttribute("content");
    expect(og, `${path} has og:image`).toMatch(/opengraph-image/);
    const tw = await page.locator('meta[name="twitter:image"]').first().getAttribute("content");
    expect(tw, `${path} has twitter:image`).toBeTruthy();
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      "content",
      "summary_large_image",
    );
    await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute(
      "content",
      "1200",
    );
  }
});
