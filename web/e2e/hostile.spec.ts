// Titles and names are typed by strangers (up to 60 and 32 characters) and drawn on torn paper. The service
// already refuses control, invisible and bidirectional-override characters; what is left is the shape of
// the text: one huge word, wide letters, emoji, stacked marks, right-to-left and CJK. Each text is put
// into the real page (the built site, with its real fonts) and the page must hold it: nothing wider than
// its paper, no sideways scrolling, nothing drawn off the screen.
import { expect, test, type Page } from "@playwright/test";

const HOSTILE: ReadonlyArray<readonly [string, string]> = [
  ["one 60-letter word", "x".repeat(60)],
  ["sixty wide capitals", "W".repeat(60)],
  ["emoji", "😀".repeat(30)],
  ["stacked marks", "z̸̡̛͎͙̾a̶̙̓l̵̡̛g̷̨̛o̸̡͙ ".repeat(5).slice(0, 60)],
  ["right to left with latin", "مرحبا بالعالم hello שלום עולם مرحبا بالعالم hello"],
  [
    "cjk",
    "你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界",
  ],
  ["long words with spaces", "supercalifragilistic expialidocious antidisestablishment"],
];
const NAME = "N".repeat(32);

const SIZES = [
  { name: "laptop", width: 1280, height: 720 },
  { name: "phone", width: 390, height: 844 },
  { name: "small phone", width: 360, height: 640 },
] as const;

async function measure(page: Page) {
  return page.evaluate(() => {
    const article = document.querySelector<HTMLElement>('.block[data-hero="true"] > article')!;
    const box = article.getBoundingClientRect();
    const button = article.querySelector<HTMLElement>(".slab button")!.getBoundingClientRect();
    const values = [...article.querySelectorAll<HTMLElement>(".face .value")];
    return {
      articleSideways: article.scrollWidth - article.clientWidth,
      slabRight: button.right - box.right,
      slabLeft: box.left - button.left,
      valuesSideways: Math.max(0, ...values.map((v) => v.scrollWidth - v.clientWidth)),
      pageSideways: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

async function ready(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForTimeout(700);
}

for (const size of SIZES) {
  test.describe(`hostile text at ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    for (const [label, text] of HOSTILE) {
      test(`the roll holds ${label}`, async ({ page }, info) => {
        await ready(page, "/");
        await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
        // what the page already measures with its own words: the slab's tilted corners sit in the stage's
        // side room, so zero is not the floor
        const baseline = await measure(page);
        await page.evaluate(
          ([title, name]) => {
            const hero = document.querySelector('.block[data-hero="true"]');
            for (const el of hero?.querySelectorAll(".slab .title, .face .value") ?? [])
              el.textContent = el.classList.contains("title") ? title! : name!;
          },
          [text, NAME],
        );
        await page.waitForTimeout(300);
        const result = await page.evaluate(() => {
          const article = document.querySelector<HTMLElement>(
            '.block[data-hero="true"] > article',
          )!;
          const box = article.getBoundingClientRect();
          const button = article
            .querySelector<HTMLElement>(".slab button")!
            .getBoundingClientRect();
          const values = [...article.querySelectorAll<HTMLElement>(".face .value")];
          return {
            articleSideways: article.scrollWidth - article.clientWidth,
            slabRight: button.right - box.right,
            slabLeft: box.left - button.left,
            valuesSideways: Math.max(0, ...values.map((v) => v.scrollWidth - v.clientWidth)),
            pageSideways: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        await page.screenshot({
          path: info.outputPath(`roll-${size.name}-${label.replace(/\W+/g, "-")}.png`),
        });
        // the article has 14 px of room on each side for the slab's rotated corners
        expect(result.articleSideways, "the stage scrolls sideways").toBeLessThanOrEqual(
          baseline.articleSideways + 1,
        );
        expect(result.slabRight, "the title slab runs past the stage").toBeLessThanOrEqual(16);
        expect(result.slabLeft, "the title slab runs off the left").toBeLessThanOrEqual(16);
        expect(result.valuesSideways, "a credit value is wider than its line").toBeLessThanOrEqual(
          1,
        );
        expect(result.pageSideways, "the page scrolls sideways").toBeLessThanOrEqual(0);
      });
    }

    test("the slab's own label sits on a band of its paper above the title, so stacked marks cannot write over it", async ({
      page,
    }) => {
      await ready(page, "/");
      await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
      const marks = "\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030a\u0312\u0316";
      await page.evaluate((m) => {
        const title = document.querySelector('.block[data-hero="true"] .slab .title')!;
        title.textContent = [...title.textContent!].map((c) => (c === " " ? c : c + m)).join("");
      }, marks);
      const band = await page.evaluate(() => {
        const label = document.querySelector<HTMLElement>(
          '.block[data-hero="true"] .slab .play-word',
        )!;
        const paper = document.querySelector<HTMLElement>('.block[data-hero="true"] .slab button')!;
        const l = getComputedStyle(label);
        return {
          position: l.position,
          background: l.backgroundColor,
          paper: getComputedStyle(paper).backgroundColor,
        };
      });
      // positioned content paints above the title's inline text, and its background is the paper's own
      expect(band.position).toBe("relative");
      expect(band.background).toBe(band.paper);
      // what spills past the slab is cut by its torn edge (the slab clips to its polygon)
      const clipped = await page.evaluate(
        () =>
          getComputedStyle(document.querySelector('.block[data-hero="true"] .slab button')!)
            .clipPath,
      );
      expect(clipped).not.toBe("none");
    });

    test("a credit line keeps its own ink: stacked marks in a name are cut at the line, not drawn into its neighbours", async ({
      page,
    }) => {
      await ready(page, "/");
      await expect(page.locator(".roll")).toHaveAttribute("data-audio", "ready");
      const result = await page.evaluate(() => {
        const marks = "\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030a";
        const value = document.querySelector<HTMLElement>(
          '.block[data-hero="true"] .face .line .value',
        )!;
        value.textContent = [..."a name typed by a stranger"]
          .map((c) => (c === " " ? c : c + marks))
          .join("");
        const line = value.closest<HTMLElement>(".line")!;
        return {
          overflow: getComputedStyle(line).overflowY,
          pad: getComputedStyle(line).paddingTop,
        };
      });
      expect(result.overflow).toBe("clip");
      // the line's own padding is the room its ink has: a few pixels at least, more on a laptop
      expect(Number.parseFloat(result.pad)).toBeGreaterThanOrEqual(4);
    });

    test("the make page holds a long title and its keyboard note", async ({ page }) => {
      await ready(page, "/make?from=es1418qka9yt");
      await page.evaluate((title) => {
        for (const el of document.querySelectorAll(".slab-text")) el.textContent = title;
      }, "x".repeat(60));
      await page.waitForTimeout(300);
      const pageSideways = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(pageSideways, "the make page scrolls sideways").toBeLessThanOrEqual(0);
    });
  });
}
