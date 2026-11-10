// A maker's note against the real service: written when publishing, shown on the roll as the maker's own
// words, changed and removed from the manage page with the key, and left alone once the flip is withdrawn.
import { expect, test } from "@playwright/test";
import { API, SEEDED_LAST, allowBucketReads, publishFlip } from "./service.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await allowBucketReads(page);
});

test("a note written when publishing shows on the flip, and the maker changes and removes it from the manage page", async ({
  page,
  request,
}) => {
  const parent = (await publishFlip(request, SEEDED_LAST, "parent for a note test")).id;
  await page.goto(`/make?from=${parent}&cut=0-12000&speed=3/2`);
  await expect(page.locator("[data-output-hash]:not([data-output-hash=''])")).toBeVisible();
  await page.getByRole("button", { name: "publish this flip" }).click();
  await page.getByLabel(/^title/).fill("a flip with a note");
  await page.getByLabel(/^your name/).fill("page maker");
  await page
    .locator(".publish")
    .getByLabel(/^a note/)
    .fill("from the tape at the lake");
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(page.getByRole("heading", { name: "published" })).toBeVisible();
  const key = await page.getByTestId("manage-key").innerText();
  const href = (await page.getByTestId("published-link").getAttribute("href"))!;
  const id = href.replace("/p/", "");

  // the service has it, as the maker's declared words
  const shown = (await (await request.get(`${API}/v1/publications/${id}`)).json()) as {
    note: string | null;
    lines: Array<{ role: string; value: string; honesty: string }>;
  };
  expect(shown.note).toBe("from the tape at the lake");
  expect(shown.lines.find((l) => l.role === "note")).toEqual({
    role: "note",
    value: "from the tape at the lake",
    honesty: "declared",
  });

  // the roll shows it on the face of the stage
  await page.goto(href);
  await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
  await expect(page.locator('.block[data-hero="true"] .face')).toContainText(
    "from the tape at the lake",
  );

  // changed from the manage page with the key
  await page.goto(`/manage/${id}`);
  await expect(page.getByText("the publication", { exact: true })).toBeVisible();
  await page.locator("input[type=password]").fill(key);
  const note = page.getByTestId("manage-note");
  await expect(note).toHaveValue("from the tape at the lake");
  await note.fill("second thoughts, see example.com");
  await page.getByRole("button", { name: "save the note" }).click();
  await expect(page.getByTestId("manage-note-said")).toContainText(
    "a link or a handle was removed",
  );
  expect(
    ((await (await request.get(`${API}/v1/publications/${id}`)).json()) as { note: string }).note,
  ).toBe("second thoughts, see");

  // a wrong key is turned away and changes nothing
  await page.locator("input[type=password]").fill("0".repeat(64));
  await note.fill("not mine");
  await page.getByRole("button", { name: "save the note" }).click();
  await expect(page.getByTestId("manage-note-said")).toContainText("that key was not accepted");
  expect(
    ((await (await request.get(`${API}/v1/publications/${id}`)).json()) as { note: string }).note,
  ).toBe("second thoughts, see");

  // removed
  await page.locator("input[type=password]").fill(key);
  await note.fill("");
  await page.getByRole("button", { name: "remove the note" }).click();
  await expect(page.getByTestId("manage-note-said")).toContainText("the note is removed");
  expect(
    ((await (await request.get(`${API}/v1/publications/${id}`)).json()) as { note: unknown }).note,
  ).toBeNull();
});

test("a withdrawn flip shows no note and its note can no longer be changed", async ({
  request,
}) => {
  const parent = (await publishFlip(request, SEEDED_LAST, "parent for a withdrawn note")).id;
  const made = await request.post(`${API}/v1/publications`, {
    data: {
      parent_id: parent,
      cut: { start: 0, end: 12000 },
      speed: { p: 1, q: 1 },
      title: "to withdraw",
      author: "x",
      note: "before",
      retry_key: "e2e-note-withdraw-0123456789",
    },
  });
  const body = (await made.json()) as { publication: { id: string }; manage_key: string };
  const id = body.publication.id;
  const headers = { "x-graft-manage-key": body.manage_key };
  expect((await request.post(`${API}/v1/publications/${id}/withdraw`, { headers })).status()).toBe(
    200,
  );
  const edit = await request.put(`${API}/v1/publications/${id}/note`, {
    headers,
    data: { note: "after" },
  });
  expect(edit.status()).toBe(409);
  const chain = (await (await request.get(`${API}/v1/chains/${id}`)).json()) as {
    stages: Array<{ state: string; lines: Array<{ role: string }> }>;
  };
  const gone = chain.stages.at(-1)!;
  expect(gone.state).toBe("no_longer_here");
  expect(gone.lines.some((l) => l.role === "note")).toBe(false);
});
