import assert from "node:assert/strict";
import { test } from "node:test";
import { positionHint, printedMarks } from "./layout.ts";

const azerty = new Map([
  ["Digit1", "&"],
  ["Digit2", "é"],
  ["Digit9", "ç"],
  ["Digit0", "à"],
  ["Minus", ")"],
  ["Equal", "="],
]);

test("where the browser can name the printed keys, a pad's corner shows what is printed there", async () => {
  const marks = await printedMarks({ getLayoutMap: async () => azerty });
  assert.equal(marks?.[0], "&");
  assert.equal(marks?.[9], "à");
  assert.equal(marks?.[10], ")");
  assert.equal(marks?.[11], "=");
});

test("a key the layout map does not know, or one that prints nothing single, is left out", async () => {
  const marks = await printedMarks({
    getLayoutMap: async () =>
      new Map([
        ["Digit1", "1"],
        ["Digit2", "Dead"],
        ["Digit3", ""],
        ["Digit4", "ab"],
      ]),
  });
  assert.equal(marks?.[0], "1");
  assert.equal(marks?.[1], undefined);
  assert.equal(marks?.[2], undefined);
  assert.equal(marks?.[3], undefined);
  assert.equal(marks?.[4], undefined);
});

test("a browser without the keyboard map, or one that refuses it, gives nothing and never throws", async () => {
  assert.equal(await printedMarks(undefined), null);
  assert.equal(await printedMarks({}), null);
  assert.equal(
    await printedMarks({
      getLayoutMap: async () => {
        throw new Error("not allowed here");
      },
    }),
    null,
  );
});

test("the plain position hint names the row and the place along it", () => {
  assert.equal(positionHint(0), "top row, 1st key");
  assert.equal(positionHint(1), "top row, 2nd key");
  assert.equal(positionHint(2), "top row, 3rd key");
  assert.equal(positionHint(9), "top row, 10th key");
  assert.equal(positionHint(10), "top row, 11th key");
  assert.equal(positionHint(11), "top row, 12th key");
  assert.equal(positionHint(12), null);
});
