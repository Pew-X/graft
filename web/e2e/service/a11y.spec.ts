// Accessibility of what needs the real service: a chain route, the operator's page before and after
// sign-in, the manage screen with a real publication, the report dialog and the publish step's
// refusals and success. Zero serious or critical axe violations, in both themes, every control 44 px.
import { expect, test, type Page } from "@playwright/test";
import { noSmallTargets, scan } from "../a11y.ts";
import { API, SEEDED_LAST, allowBucketReads, publishFlip } from "./service.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await allowBucketReads(page);
});

async function publishFrom(
  page: Page,
  parent: string,
  route?: () => Promise<unknown>,
): Promise<void> {
  await route?.();
  await page.goto(`/make?from=${parent}&cut=0-12000&speed=3/2`);
  await page.getByRole("button", { name: "publish this flip" }).click();
  await page.getByLabel(/^title/).fill("scanned flip");
  await page.getByLabel(/^your name/).fill("scanner");
  await page.getByRole("button", { name: "publish", exact: true }).click();
}

for (const scheme of ["light", "dark"] as const) {
  test(`a chain, its report dialog and the operator's page pass the scan (${scheme})`, async ({
    page,
    request,
  }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    const { id } = await publishFlip(request, SEEDED_LAST, "a flip to scan");
    await page.goto(`/p/${id}`);
    await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
    await scan(page, `chain ${scheme}`, info);
    await noSmallTargets(page, "chain");
    await page.locator('.block[data-hero="true"] button.report').click();
    await expect(page.getByRole("dialog", { name: "report this sound" })).toBeVisible();
    await scan(page, `report dialog ${scheme}`, info);
    await noSmallTargets(page, "report dialog");
    await page.keyboard.press("Escape");
    await page.goto("/admin");
    await scan(page, `admin gate ${scheme}`, info);
    await page.getByLabel("operator secret").fill("svc-test-admin-secret-0123456789");
    await page.getByRole("button", { name: "open" }).click();
    await expect(page.getByRole("heading", { name: "reports" })).toBeVisible();
    await scan(page, `admin ${scheme}`, info);
  });

  test(`the manage screen, the publish step's success and a refusal pass the scan (${scheme})`, async ({
    page,
    request,
  }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    const stage = await publishFlip(request, SEEDED_LAST, "stage to scan");
    await page.goto(`/manage/${stage.id}`);
    await expect(page.getByText("the publication", { exact: true })).toBeVisible();
    await scan(page, `manage ${scheme}`, info);
    await noSmallTargets(page, "manage");
    await page.locator("input[type=password]").fill(stage.manageKey);
    await page.getByRole("button", { name: "withdraw it" }).click();
    await scan(page, `manage confirm ${scheme}`, info);

    const parent = (await publishFlip(request, SEEDED_LAST, "parent to scan")).id;
    await publishFrom(page, parent);
    await expect(page.getByRole("heading", { name: "published" })).toBeVisible();
    await scan(page, `publish success ${scheme}`, info);
    await noSmallTargets(page, "publish success");

    await publishFrom(page, parent, () =>
      page.route(`${API}/v1/publications`, (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: 429,
              contentType: "application/problem+json",
              body: JSON.stringify({
                type: "urn:graft:problem:rate-limited",
                title: "x",
                status: 429,
                detail: "x",
                retry_after_secs: 60,
              }),
            })
          : route.continue(),
      ),
    );
    await expect(page.locator(".publish .problem")).toContainText("published a lot");
    await scan(page, `publish refusal ${scheme}`, info);
  });
}
