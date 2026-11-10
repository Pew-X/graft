// The site's security headers, under real use: every page works with the policy on and no page
// breaks it, and the policy is the one that was written (no wider because of how it was built).
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, API, SEEDED_LAST, allowBucketReads, publishFlip, press } from "./service.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

/** Record every policy violation the page reports, and anything the console says about one. */
async function watchViolations(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
  page.on("console", (m) => {
    if (/content security policy|CSP violation/i.test(m.text())) seen.push(m.text());
  });
  return seen;
}

test("the policy is the written one: it names the service and the bucket and nothing else", async ({
  request,
}) => {
  const response = await request.get("/");
  const policy = response.headers()["content-security-policy"] ?? "";
  const connect = policy
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("connect-src"));
  expect(connect).toBe(
    `connect-src 'self' ${API} ${process.env["GRAFT_SERVICE_S3"] ?? "http://127.0.0.1:59000"}`,
  );
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).not.toContain("*");
  const headers = response.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["strict-transport-security"]).toMatch(/^max-age=\d+/);
  expect(headers["permissions-policy"]).toContain("camera=()");
});

test("the home page, a chain page and the operator's page all work under the policy", async ({
  page,
  request,
}) => {
  await allowBucketReads(page);
  const violations = await watchViolations(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // Home: the static chain loads and plays.
  await page.goto("/");
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await page.getByRole("button", { name: "play", exact: true }).tap();
  await expect(page.locator(".roll")).toHaveAttribute("data-sounding", "true");

  // A chain page: credits from the service, audio from the bucket, events back to the service.
  const { id } = await publishFlip(request, SEEDED_LAST, "policy flip");
  await page.goto(`/p/${id}`);
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await press(page, page.getByRole("button", { name: /up a fifth/ }));
  await expect(page.locator(".roll")).toHaveAttribute("data-playback", "auditioning");

  // The operator's page: a call with the secret in a header.
  await page.goto("/admin");
  await page.getByLabel("operator secret").fill(ADMIN["x-graft-admin-secret"]!);
  await page.getByRole("button", { name: "open" }).click();
  await expect(page.getByRole("heading", { name: "reports" })).toBeVisible();

  expect(violations).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("the policy does stop what it is for: a page cannot be framed and cannot reach another origin", async ({
  page,
}) => {
  await page.goto("/");
  const blocked = await page.evaluate(async () => {
    try {
      await fetch("https://elsewhere.example/collect", { mode: "no-cors" });
      return false;
    } catch {
      return true;
    }
  });
  expect(blocked, "a connection to an origin the policy does not name is refused").toBe(true);
  // Framed from another page, the browser refuses to render the site: the child frame ends up on
  // the browser's own error page and never on the site.
  await page.setContent(
    `<iframe id="f" src="http://127.0.0.1:3100/" width="300" height="200"></iframe>`,
  );
  await expect
    .poll(() =>
      page
        .frames()
        .filter((f) => f !== page.mainFrame())
        .map((f) => f.url()),
    )
    .toEqual([expect.stringMatching(/^chrome-error:/)]);
});
