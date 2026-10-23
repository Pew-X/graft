/**
 * Helpers for the service specs: the service's address, the seeded chain's ids (they are the same
 * everywhere), and calls to the service that a visitor's browser would make or the operator would.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const API = process.env["GRAFT_API_URL"] ?? "http://127.0.0.1:3300";
export const ADMIN = { "x-graft-admin-secret": "svc-test-admin-secret-0123456789" };

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(
  readFileSync(join(here, "..", "..", "snapshot", "chain.json"), "utf8"),
) as { stages: Array<{ id: string; title: string }> };

/** Public ids of the seeded chain, source first. */
export const SEEDED = snapshot.stages.map((s) => s.id);
export const SEEDED_LAST = SEEDED.at(-1)!;

let counter = 0;
const unique = (): string => `${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Publish a flip of `parent` as a visitor would, and return its public id. */
export async function publishFlip(
  request: APIRequestContext,
  parent: string,
  title = "a test flip",
): Promise<{ id: string; manageKey: string }> {
  const response = await request.post(`${API}/v1/publications`, {
    data: {
      parent_id: parent,
      cut: { start: 0, end: 24000 },
      speed: { p: 1, q: 1 },
      title,
      author: "test maker",
      retry_key: `svc-test-${unique()}-0123456789`,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as {
    publication: { id: string };
    manage_key: string | null;
  };
  return { id: body.publication.id, manageKey: body.manage_key ?? "" };
}

/** The operator hides a publication (`withdrawn` or `rights`), or clears the hide when `reason` is null. */
export async function hide(
  request: APIRequestContext,
  id: string,
  reason: "withdrawn" | "rights" | null,
): Promise<void> {
  const response =
    reason === null
      ? await request.delete(`${API}/admin/publications/${id}/hide`, { headers: ADMIN })
      : await request.post(`${API}/admin/publications/${id}/hide`, {
          headers: ADMIN,
          data: { reason },
        });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * The object store does not send cross-origin headers, and a real bucket needs them configured for
 * the site's origin (a deployment step). For the browser to read issued addresses here, add them.
 */
export async function allowBucketReads(page: Page): Promise<void> {
  const s3 = process.env["GRAFT_SERVICE_S3"] ?? "http://127.0.0.1:59000";
  await page.route(`${s3}/**`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "access-control-allow-origin": "*" },
    });
  });
}
