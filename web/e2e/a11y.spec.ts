// Accessibility of every route and state that needs no service, in both themes at a phone width:
// an axe scan with zero serious or critical violations, and every control at least 44 px.
import { expect, test, type Page } from "@playwright/test";
import { noSmallTargets, scan } from "./a11y.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const SEEDED = "e790b6ycz0yd";
const tone = (i: number) =>
  Math.round(9000 * Math.exp(-i / 60000) * Math.sin(i / 11) + 1500 * Math.sin(i * 0.37));
function wav(frames: number): Buffer {
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) data.writeInt16LE(tone(i), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(48000, 24);
  h.writeUInt32LE(96000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

type Screen = { name: string; go: (page: Page) => Promise<void> };
const screens: Screen[] = [
  {
    name: "home",
    go: async (page) => {
      await page.goto("/");
      await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
    },
  },
  { name: "about", go: (page) => page.goto("/about").then(() => undefined) },
  {
    name: "not found",
    go: async (page) => {
      await page.goto("/nonesuch");
    },
  },
  {
    name: "make: the list of sounds",
    go: async (page) => {
      await page.goto("/make");
      await expect(page.getByRole("heading", { name: "pick a sound to start from" })).toBeVisible();
    },
  },
  {
    name: "make: the cut and the speed",
    go: async (page) => {
      await page.goto(`/make?from=${SEEDED}&cut=960-43200&speed=3/2`);
      await expect(page.locator("[data-output-hash]:not([data-output-hash=''])")).toBeVisible();
    },
  },
  {
    name: "make: a refused cut",
    go: async (page) => {
      await page.goto(`/make?from=${SEEDED}&cut=0-100&speed=3/2`);
      await expect(page.locator("#why-not")).toContainText("too short");
    },
  },
  {
    name: "make: the publish step",
    go: async (page) => {
      await page.goto(`/make?from=${SEEDED}&cut=960-43200&speed=3/2`);
      await expect(page.locator("[data-output-hash]:not([data-output-hash=''])")).toBeVisible();
      await page.getByRole("button", { name: "publish this flip" }).click();
      await page.getByLabel(/^title/).fill("a title");
    },
  },
  {
    name: "make: trimming a long recording",
    go: async (page) => {
      await page.goto("/make");
      await page
        .locator("input[type=file]")
        .setInputFiles({ name: "long.wav", mimeType: "audio/wav", buffer: wav(40 * 48000) });
      await expect(page.getByRole("heading", { name: /pick the part to keep/ })).toBeVisible();
    },
  },
  {
    name: "make: your own sound and its declaration",
    go: async (page) => {
      // Uploads on, whatever service (or none) this run has: the declaration is what is scanned.
      await page.route("**/v1/features", (r) =>
        r.fulfill({
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ publishing: true, uploads: true }),
        }),
      );
      await page.goto("/make");
      await page
        .locator("input[type=file]")
        .setInputFiles({ name: "s.wav", mimeType: "audio/wav", buffer: wav(60_000) });
      await page.getByRole("button", { name: "publish your sound" }).click();
      await expect(page.getByLabel(/i confirm/)).toBeVisible();
    },
  },
  {
    name: "manage: no such publication",
    go: async (page) => {
      await page.route("**/v1/publications/**", (r) =>
        r.fulfill({ status: 404, contentType: "application/problem+json", body: "{}" }),
      );
      await page.goto("/manage/nonesuch");
    },
  },
];

for (const scheme of ["light", "dark"] as const) {
  for (const screen of screens) {
    test(`${screen.name} (${scheme}): no serious or critical axe violations`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await screen.go(page);
      await scan(page, `${screen.name} ${scheme}`, info);
    });
  }
}

for (const screen of screens.filter(
  (s) => !s.name.startsWith("home") && !s.name.startsWith("not found"),
)) {
  test(`${screen.name}: every control is at least 44 px`, async ({ page }) => {
    await screen.go(page);
    await noSmallTargets(page, screen.name);
  });
}
