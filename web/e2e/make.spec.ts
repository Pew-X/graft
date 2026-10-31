// The make flow in a real browser, against the built site and its shipped snapshots (no service).
import { expect, test, type Page } from "@playwright/test";
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Stage {
  id: string;
  title: string;
  output_blob: string;
  cut_start: number;
  cut_end: number;
  speed_p: number | null;
  speed_q: number | null;
}
const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name: string) =>
  JSON.parse(readFileSync(join(web, "snapshot", `${name}.json`), "utf8")) as { stages: Stage[] };
const chain = read("chain").stages;
const sources = read("sources").stages;

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const hash = (page: Page) => page.locator("[data-output-hash]");
const ready = (page: Page) => expect(hash(page)).not.toHaveAttribute("data-output-hash", "");
const link = (from: string, cut: [number, number], p: number, q: number) =>
  `/make?from=${from}&cut=${cut[0]}-${cut[1]}&speed=${p}/${q}`;

test("the picker offers the ten curated sources with their declared licence line, and the roll's flips", async ({
  page,
}) => {
  await page.goto("/make");
  await expect(page.getByRole("heading", { name: "pick a sound to start from" })).toBeVisible();
  const rows = page.locator(".sound");
  await expect(rows).toHaveCount(13);
  const licence = page.locator(".sound-licence");
  await expect(licence).toHaveCount(10);
  await expect(licence.first()).toContainText("own work, synthesized for graft");
  await expect(licence.first().locator(".stated")).toHaveText("declared");
  for (const s of sources)
    await expect(page.getByRole("button", { name: `flip this sound: ${s.title}` })).toBeVisible();
});

// A visitor who came to use their own sound must find the way in without scrolling past thirteen
// rows (the builder did not see it when it sat below them).
test("recording or picking your own sound is on the first screen of the picker", async ({
  page,
}) => {
  await page.goto("/make");
  const record = page.getByRole("button", { name: "record with the microphone" });
  await expect(record).toBeInViewport();
  await expect(page.locator("label.file")).toBeInViewport();
});

test("choosing a sound opens the cut and the speed with a flip already sounding at a fifth up", async ({
  page,
}) => {
  await page.goto("/make");
  await page.getByRole("button", { name: "flip this sound: saber hum" }).click();
  await expect(page.getByRole("slider", { name: "start of the cut" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "speed" })).toHaveAttribute(
    "aria-valuetext",
    "150%, a fifth up",
  );
  await ready(page);
});

// Browser against service: each flip of the seeded chain, made here from its parent with the shared
// artefact, has the hash the service stored (the service made it and an independent renderer checked it).
for (const [i, stage] of chain.slice(1).entries()) {
  test(`the browser's render of the seeded flip "${stage.title}" has the service's hash`, async ({
    page,
  }) => {
    await page.goto(
      link(chain[i]!.id, [stage.cut_start, stage.cut_end], stage.speed_p!, stage.speed_q!),
    );
    await ready(page);
    await expect(hash(page)).toHaveAttribute("data-output-hash", stage.output_blob);
  });
}

test("a one-frame change to the cut changes the sound, so a frame handling mistake would be seen", async ({
  page,
}) => {
  const f = chain[1]!;
  await page.goto(link(chain[0]!.id, [f.cut_start + 1, f.cut_end], 3, 2));
  await ready(page);
  await expect(hash(page)).not.toHaveAttribute("data-output-hash", f.output_blob);
});

test("a cut that is too short is refused in words, and the play button is disabled with the reason beside it", async ({
  page,
}) => {
  await page.goto(link(chain[0]!.id, [0, 100], 3, 2));
  const play = page.getByRole("button", { name: "hear it" });
  await expect(play).toBeDisabled();
  await expect(page.locator("#why-not")).toContainText("the cut is too short");
  await expect(play).toHaveAttribute("aria-describedby", "why-not");
});

test("an inverted cut and an output that would be too short each say so", async ({ page }) => {
  await page.goto(link(chain[0]!.id, [900, 100], 3, 2));
  await expect(page.locator("#why-not")).toContainText("ends before it starts");
  await page.goto(link(chain[0]!.id, [0, 480], 4, 1));
  await expect(page.locator("#why-not")).toContainText("too short");
  await expect(page.getByRole("button", { name: "hear it" })).toBeDisabled();
});

test("each handle is a slider with a value in seconds, moved by the keyboard in exact steps", async ({
  page,
}) => {
  await page.goto(link(chain[0]!.id, [4800, 33600], 1, 2));
  const start = page.getByRole("slider", { name: "start of the cut" });
  await expect(start).toHaveAttribute("aria-valuenow", "4800");
  await expect(start).toHaveAttribute("aria-valuetext", "0.100 seconds");
  await start.focus();
  await page.keyboard.press("ArrowRight");
  await expect(start).toHaveAttribute("aria-valuenow", "4848");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(start).toHaveAttribute("aria-valuenow", "5328");
  await page.keyboard.press("PageDown");
  await expect(start).toHaveAttribute("aria-valuenow", "528");
  await page.keyboard.press("Home");
  await expect(start).toHaveAttribute("aria-valuenow", "0");
  const end = page.getByRole("slider", { name: "end of the cut" });
  await end.focus();
  await page.keyboard.press("End");
  await expect(end).toHaveAttribute("aria-valuenow", "57600");
});

test("dragging a handle moves the cut and the sound follows", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(link(chain[0]!.id, [0, 43200], 3, 2));
  await ready(page);
  const before = await hash(page).getAttribute("data-output-hash");
  const end = page.getByRole("slider", { name: "end of the cut" });
  const box = (await end.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 150, box.y + 40, { steps: 6 });
  await page.mouse.up();
  const now = Number(await end.getAttribute("aria-valuenow"));
  expect(now).toBeLessThan(43200);
  expect(now).toBeGreaterThan(20000);
  await expect(hash(page)).not.toHaveAttribute("data-output-hash", before!);
});

test("the speed control walks the table: a quarter at one end, four times at the other", async ({
  page,
}) => {
  await page.goto(link(chain[0]!.id, [0, 43200], 3, 2));
  const speed = page.getByRole("slider", { name: "speed" });
  await speed.focus();
  await page.keyboard.press("Home");
  await expect(speed).toHaveAttribute("aria-valuetext", "25%, two octaves down");
  await page.keyboard.press("End");
  await expect(speed).toHaveAttribute("aria-valuetext", "400%, two octaves up");
  await page.getByRole("button", { name: "slower" }).click();
  await expect(speed).not.toHaveAttribute("aria-valuetext", "400%, two octaves up");
});

test("the preview updates within half a second of a change, and the loop plays the bytes that are hashed", async ({
  page,
}) => {
  // Record what is handed to Web Audio: the exact samples of each buffer, as hashed bytes.
  await page.addInitScript(() => {
    const heard: string[] = [];
    (window as unknown as { heard: string[] }).heard = heard;
    const original = AudioBuffer.prototype.copyToChannel;
    AudioBuffer.prototype.copyToChannel = function (
      source: Float32Array<ArrayBuffer>,
      ...rest: [number]
    ) {
      const bytes = new Uint8Array(source.length * 2);
      const view = new DataView(bytes.buffer);
      source.forEach((v, i) => view.setInt16(i * 2, Math.round(v * 32768), true));
      void crypto.subtle.digest("SHA-256", bytes).then((d) => {
        heard.push([...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""));
      });
      return original.call(this, source, ...rest);
    };
  });
  await page.goto(link(chain[0]!.id, [0, 43200], 3, 2));
  await ready(page);
  await page.getByRole("button", { name: "hear it" }).click();
  await expect(page.getByRole("button", { name: "pause" })).toBeVisible();
  const first = await hash(page).getAttribute("data-output-hash");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { heard: string[] }).heard.at(-1)))
    .toBe(first);
  // Move the speed and time how long the new bytes take to reach the speaker.
  const speed = page.getByRole("slider", { name: "speed" });
  await speed.focus();
  const t0 = Date.now();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => hash(page).getAttribute("data-output-hash")).not.toBe(first);
  const second = await hash(page).getAttribute("data-output-hash");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { heard: string[] }).heard.at(-1)))
    .toBe(second);
  expect(Date.now() - t0).toBeLessThan(500);
});

test("nothing is sent anywhere while making: only reads from the site's own origin", async ({
  page,
}) => {
  const requests: Array<{ method: string; url: string; body: string | null }> = [];
  page.on("request", (r) =>
    requests.push({ method: r.method(), url: r.url(), body: r.postData() }),
  );
  await page.goto(link(chain[0]!.id, [0, 43200], 3, 2));
  await ready(page);
  await page.getByRole("button", { name: "hear it" }).click();
  await page.getByRole("slider", { name: "speed" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  // the one thing sent is the quiet wake call to the site's own server, and it carries nothing
  const sent = requests.filter((r) => r.method !== "GET");
  expect(sent.map((r) => new URL(r.url).pathname)).toEqual(["/api/wake"]);
  expect(sent.every((r) => r.body === null)).toBe(true);
  const origin = new URL(page.url()).origin;
  expect(requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith("data:"))).toEqual(
    [],
  );
});

test("a sound that is not in the shipped lists and cannot be read says it cannot be flipped", async ({
  page,
}) => {
  await page.route("**/v1/chains/**", (route) =>
    route.fulfill({ status: 404, contentType: "application/problem+json", body: "{}" }),
  );
  await page.goto("/make?from=nonesuchid1");
  await expect(page.getByRole("status").first()).toContainText(
    /no longer here|could not be loaded/,
  );
});

test("the flip button on the roll opens the make flow for that stage", async ({ page }) => {
  await page.goto("/");
  await page.locator('.block[data-hero="true"] .flip').scrollIntoViewIfNeeded();
  await page.locator('.block[data-hero="true"] .flip').click();
  await expect(page).toHaveURL(/\/make\?from=/);
  await expect(page.getByRole("slider", { name: "start of the cut" })).toBeVisible();
});

test("a sound that fails to load gives a way back to the list, not a dead end", async ({
  page,
}) => {
  await page.route("**/seed/*.pcm", (route) => route.abort("connectionreset"));
  await page.goto("/make");
  await page.getByRole("button", { name: "flip this sound: saber hum" }).click();
  await expect(page.getByRole("status").first()).toContainText("could not be loaded");
  await page.getByRole("button", { name: "pick another sound" }).click();
  await expect(page.getByRole("heading", { name: "pick a sound to start from" })).toBeVisible();
});

test("a file over the size limit is refused by its size alone, without being read", async ({
  page,
}) => {
  // a sparse file one byte over 150 megabytes: it takes no disk and is never read
  const dir = mkdtempSync(join(tmpdir(), "graft-big-"));
  const path = join(dir, "huge.wav");
  const fd = openSync(path, "w");
  ftruncateSync(fd, 150_000_001);
  closeSync(fd);
  try {
    await page.goto("/make");
    await page.locator("input[type=file]").setInputFiles(path);
    await expect(page.getByText("that file is too large")).toBeVisible();
    await expect(page.getByText("limit is 150 megabytes")).toBeVisible();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The way in from the header: a visitor who presses "make a flip" has not picked anything yet, so the
// page opens on the sound on the roll with a ready cut and speed, and one tap gives sound.
test.describe("arriving from the header's make a flip", () => {
  test("it opens on the sound that was on the roll, already cut and sped up, and one tap plays it", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
    const finished = chain.at(-1)!;
    await page.getByRole("link", { name: "make a flip" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/make\\?from=${finished.id}&cut=0-43200&speed=3%2F2$`),
    );
    await ready(page);
    await expect(page.getByTestId("cut-readout")).toContainText("0.000 to 0.900");
    await expect(page.locator(".speed-readout .percent")).toHaveText("150%");
    const hear = page.getByRole("button", { name: "hear it" });
    await expect(hear).toBeEnabled();
    await hear.click();
    await expect(page.getByRole("button", { name: "pause" })).toBeVisible();
  });

  test("the way in follows the stage in view: a different stage on the roll, a different sound", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
    const link = page.getByRole("link", { name: "make a flip" });
    await expect(link).toHaveAttribute("href", new RegExp(`from=${chain.at(-1)!.id}`));
    // playing walks the roll from the source forward: the stage in view, and so the sound, changes
    await page.locator(".controls .primary").click();
    await expect(page.locator(".roll")).toHaveAttribute("data-hero", "0", { timeout: 15_000 });
    await expect(link).toHaveAttribute("href", new RegExp(`from=${chain[0]!.id}`));
  });

  test("a stage's own flip this keeps its own start: whole sound, no ready-made cut", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
    await page.locator('.block[data-hero="true"] .flip').click();
    await expect(page).toHaveURL(/\/make\?from=[a-z0-9]+$/);
  });

  test("the hash of what you hear is one level down, in the details, and the page speaks plainly", async ({
    page,
  }) => {
    await page.goto(link(chain.at(-1)!.id, [0, 43200], 3, 2));
    await ready(page);
    const main = page.locator("main");
    await expect(main.locator(".panel.result > .actions")).toBeVisible();
    // the code is not on the page until the details are opened
    await expect(main.getByText("hash of what you hear")).toBeHidden();
    await main.locator("details.details summary").click();
    await expect(main.getByText("hash of what you hear")).toBeVisible();
    // one-line hints, and no frames or hash in the flow itself
    await expect(main.getByText("drag the brackets to keep a piece")).toBeVisible();
    await expect(main.getByText("faster is higher, slower is lower")).toBeVisible();
    // the keyboard's part is said on the page (the first audit found nobody knew the arrows worked) and
    // is still what a screen reader hears with each bracket
    await expect(main.locator(".cut-editor .help")).toHaveText(/arrow keys/);
    await expect(main.locator(".cut-editor .help")).toBeVisible();
  });

  test("a returning visitor finds the explanation folded, and it opens when asked", async ({
    page,
  }) => {
    await page.goto("/make");
    const card = page.getByTestId("how-card");
    await expect(card).toBeVisible();
    await expect(card).not.toHaveAttribute("open", "");
    await card.getByText("how graft works").click();
    await expect(card).toHaveAttribute("open", "");
    await expect(card.locator(".how-name")).toHaveCount(5);
  });

  test.describe("a first visit", () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    test("the picker explains the idea in five steps and the steps read pick, cut and speed, share", async ({
      page,
    }) => {
      await page.goto("/make");
      const card = page.getByTestId("how-card");
      await expect(card).toHaveAttribute("open", "");
      await expect(card.locator(".how-name")).toHaveText([
        "a flip",
        "a lineage",
        "publishing",
        "sketches",
        "your key",
      ]);
      await expect(card).toContainText("follow that back and you have its lineage");
      await expect(page.getByTestId("steps").locator("li")).toHaveText([
        /pick/,
        /cut and speed/,
        /share/,
      ]);
    });
  });
});

test("the make page has one top heading", async ({ page }) => {
  await page.goto("/make?from=es1418qka9yt&cut=0-43200&speed=3/2");
  await ready(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/make a flip/i);
});

test("the about page tells the same five steps, open", async ({ page }) => {
  await page.goto("/about");
  const card = page.getByTestId("how-card");
  await expect(card).toHaveAttribute("open", "");
  await expect(card.locator(".how-name")).toHaveText([
    "a flip",
    "a lineage",
    "publishing",
    "sketches",
    "your key",
  ]);
});

test("how it works on the editor opens the plain explanation above it", async ({ page }) => {
  await page.goto("/make?from=es1418qka9yt&cut=0-43200&speed=3/2");
  await ready(page);
  await expect(page.getByTestId("how-card")).toHaveCount(0);
  await page.getByRole("button", { name: /how it works/ }).click();
  await expect(page.getByTestId("how-card")).toBeVisible();
  await expect(page.getByTestId("how-card")).toHaveAttribute("open", "");
});
