// The torn paper of the share card: the same flip always gets the same tear, the edge stays near its
// rectangle, and a long title is fitted to the slab by its length and lettering, never overflowing it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitTitle, printable, tornPoints } from "./torn.ts";

test("the same seed tears the same paper, and another seed a different one", () => {
  const a = tornPoints("q0yjjgng394w", 600, 200);
  assert.deepEqual(tornPoints("q0yjjgng394w", 600, 200), a);
  assert.notDeepEqual(tornPoints("e790b6ycz0yd", 600, 200), a);
});

test("every point stays within a few pixels of the rectangle, and the shape has real tears along each edge", () => {
  const w = 600;
  const h = 200;
  const pts = tornPoints("q0yjjgng394w", w, h);
  assert.ok(pts.length > 60, "many small tears, not four corners");
  for (const [x, y] of pts) {
    assert.ok(x >= -1 && x <= w + 1 && y >= -1 && y <= h + 1, `inside the box: ${x},${y}`);
  }
  // the edge is rough: not all points on the top edge share a height
  const top = pts.filter(([, y]) => y < h / 2).map(([, y]) => y);
  assert.ok(new Set(top.map((y) => Math.round(y))).size > 3, "the top edge is irregular");
});

test("a short title is set large and a long one smaller, always in at most three lines", () => {
  for (const lettering of ["src", "up", "down"] as const) {
    let last = Infinity;
    for (const text of ["up", "up a fifth", "down an octave", "x".repeat(30), "x".repeat(60)]) {
      const fit = fitTitle(text, lettering, 560);
      assert.ok(
        fit.lines >= 1 && fit.lines <= 3,
        `${lettering} ${text.length}: ${fit.lines} lines`,
      );
      assert.ok(fit.size <= last + 1e-9, "never larger for a longer title");
      last = fit.size;
    }
  }
  assert.ok(fitTitle("up", "up", 560).size <= 170, "capped");
  assert.ok(fitTitle("x".repeat(60), "down", 560).size >= 44, "still readable");
});

test("a title is also kept inside the slab's height: more lines, a smaller size", () => {
  const roomy = fitTitle("808 up a fifth", "up", 526);
  const tight = fitTitle("808 up a fifth", "up", 526, 150);
  assert.ok(tight.size < roomy.size, "smaller when the slab is shorter");
  assert.ok(tight.lines * tight.size * 0.92 <= 150 || tight.size === 44, "inside the height");
  for (const lettering of ["src", "up", "down"] as const) {
    const fit = fitTitle("x".repeat(60), lettering, 526, 230);
    assert.ok(
      fit.lines * fit.size * { src: 1.02, up: 0.92, down: 1.08 }[lettering] <= 230 ||
        fit.size === 44,
    );
  }
});

test("a title that is one long word is cut into the slab, not left to run off it", () => {
  const fit = fitTitle("W".repeat(60), "down", 560);
  assert.ok(fit.lines <= 3);
  assert.ok(fit.text.length <= 60);
  assert.ok(fit.text.includes("​") || fit.text.length <= 24, "gets break points or is shortened");
});

test("nothing typed can break the layout: empty, blank and odd titles fit", () => {
  for (const t of ["", "   ", "😀".repeat(30), "مرحبا بالعالم hello שלום", "你好世界".repeat(15)]) {
    const fit = fitTitle(t, "up", 560);
    assert.ok(Number.isFinite(fit.size) && fit.size > 0);
    assert.ok(fit.lines >= 1 && fit.lines <= 3);
  }
});

test("only what the card's fonts can draw is kept of a typed title: Latin letters, digits and common punctuation", () => {
  assert.equal(printable("808 up a fifth"), "808 up a fifth");
  assert.equal(printable("café ñandú — “quoted” it’s…"), "café ñandú — “quoted” it’s…");
  assert.equal(printable("hello שלום עולם"), "hello", "what the fonts lack is left out");
  assert.equal(
    printable("a 😀 b"),
    "a b",
    "emoji are left out (the renderer would fetch them over the network)",
  );
  assert.equal(printable("مرحبا بالعالم"), "", "nothing drawable");
  assert.equal(printable("你好世界"), "");
  assert.equal(
    printable("a\u200b\u202eb\u0000c"),
    "abc",
    "invisible and control characters are left out",
  );
});

test("a title with nothing drawable gets a plain word, and a fit is always made", () => {
  for (const text of ["مرحبا", "😀😀😀", "你好世界".repeat(10), "   "]) {
    const fit = fitTitle(text, "up", 526, 214);
    assert.equal(fit.text, "a flip");
  }
});
