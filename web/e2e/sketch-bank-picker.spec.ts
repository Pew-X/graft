// A sketch kept on the bank can be played from the picker of the make page: a page that has only just loaded has
// no renderer yet, and a pad that was tried then must be tried again once the renderer is ready (it used to stay
// on "getting the renderer ready" for good). Against the built site and its shipped snapshots.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const first = (
  JSON.parse(readFileSync("snapshot/sources.json", "utf8")) as { stages: Array<{ id: string }> }
).stages[0]!;

test.use({ bypassCSP: true });

test("a pad on the bank at the picker becomes playable once the renderer is ready", async ({
  page,
}) => {
  const sketch = {
    id: "sk0123456789ab",
    parent: { kind: "stage", id: first.id },
    cut: { start: 0, end: 24000 },
    p: 3,
    q: 2,
    title: "a try",
    retryKey: "web-0123456789abcdef0123456789abcd",
    at: 1,
  };
  await page.addInitScript((s) => {
    localStorage.setItem("graft.sketches", JSON.stringify({ v: 1, sketches: [s], bank: [s.id] }));
  }, sketch);
  await page.goto("/make");
  const pad = page.getByRole("button", { name: /^pad 1, a try/ });
  await expect(pad).toBeEnabled({ timeout: 15_000 });
  await pad.click();
  await expect(page.getByTestId("sketch-bank")).not.toContainText("getting the renderer ready");
  await expect(page.getByTestId("sketch-bank")).not.toContainText("cannot be played");
});
