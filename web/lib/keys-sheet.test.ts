import assert from "node:assert/strict";
import { test } from "node:test";
import { sheetFor } from "./keys-sheet.ts";

test("the roll's sheet lists perform when this build has it, and not otherwise", () => {
  assert.deepEqual(
    sheetFor("roll", true).map((s) => s.id),
    ["roll", "perform"],
  );
  assert.deepEqual(
    sheetFor("roll", false).map((s) => s.id),
    ["roll"],
  );
});

test("a sheet that holds perform back never says the word in what it lists", () => {
  const text = JSON.stringify(sheetFor("roll", false));
  assert.equal(/perform|pad/i.test(text), false);
  assert.equal(/\bpads?\b/i.test(JSON.stringify(sheetFor("make", true))), false);
});

test("the make sheet is the same either way", () => {
  assert.deepEqual(sheetFor("make", true), sheetFor("make", false));
});
