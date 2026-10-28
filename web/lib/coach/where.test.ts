// The caption must lie wholly off the record at every size the site is checked at.
import assert from "node:assert/strict";
import { test } from "node:test";
import { layout } from "../record/disc.ts";
import { captionBox } from "./where.ts";

const SIZES = [
  [1280, 720],
  [1440, 900],
  [390, 844],
  [360, 640],
  [676, 1000],
  [1024, 600],
] as const;
/** Two lines of the caption's type, the most it takes. */
const HEIGHT = 70;

for (const [w, h] of SIZES) {
  test(`at ${w}x${h} every corner of the caption is outside the record`, () => {
    for (const stages of [1, 4, 12]) {
      const l = layout(w, h, stages);
      const box = captionBox(w, h, stages);
      const width = box.maxWidth;
      const x0 = box.left ?? (w - width) / 2;
      const y1 = h - box.bottom;
      const corners = [
        [x0, y1 - HEIGHT],
        [x0 + width, y1 - HEIGHT],
        [x0, y1],
        [x0 + width, y1],
      ] as const;
      for (const [x, y] of corners) {
        assert.ok(
          Math.hypot(x - l.cx, y - l.cy) > l.R,
          `(${x}, ${y}) is on the record, ${stages} stages`,
        );
      }
      assert.ok(x0 >= 0 && x0 + width <= w, "and on the screen");
    }
  });
}

test("it keeps the status pill's place when there is room, and rises only for a disc that is in the way", () => {
  assert.equal(captionBox(1280, 720, 4).bottom, 84);
  assert.ok(captionBox(390, 844, 4).bottom > 84);
});
