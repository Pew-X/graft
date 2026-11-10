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
  assert.equal(/perform|\bpads?\b/i.test(JSON.stringify(sheetFor("make", false))), false);
});

test("the make sheet lists the sketch bank's keys only when perform is on", () => {
  assert.match(JSON.stringify(sheetFor("make", true)), /number keys: off, on/);
  assert.equal(/number keys/.test(JSON.stringify(sheetFor("make", false))), false);
});

test("the phrase controls are listed with perform and go with it", () => {
  assert.match(JSON.stringify(sheetFor("roll", true)), /play phrase/);
  assert.equal(/phrase|rec\b/i.test(JSON.stringify(sheetFor("roll", false))), false);
});
