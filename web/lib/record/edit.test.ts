import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSpeed } from "../make/speed.ts";
import { EDIT_SPEEDS, semitoneLabel, speedParam } from "./edit.ts";
import { makeAddress } from "./mark.ts";

test("every speed offered on the record is a stop of the table, so make and the service accept it", () => {
  for (const [p, q] of EDIT_SPEEDS) {
    assert.deepEqual(parseSpeed(`${p}/${q}`), { p, q }, `${p}/${q}`);
  }
});

test("the speeds are named in whole semitones, worked by hand", () => {
  // an octave is 12; a fifth 3/2 is 7.02; a fourth 4/3 is 4.98
  assert.deepEqual(
    EDIT_SPEEDS.map(([p, q]) => semitoneLabel(p, q)),
    ["−12", "−7", "−5", "+5", "+7", "+12"],
  );
  assert.equal(semitoneLabel(1, 1), "0");
});

test("the speeds run from slowest to fastest, no two alike", () => {
  const ratios = EDIT_SPEEDS.map(([p, q]) => p / q);
  assert.deepEqual(
    ratios,
    [...ratios].sort((a, b) => a - b),
  );
  assert.equal(new Set(ratios).size, ratios.length);
});

test("a speed is written in the address as p/q, encoded", () => {
  assert.equal(speedParam(3, 2), "3%2F2");
});

test("the make address carries the part and its speed, and only what was chosen", () => {
  const cut = { start: 14_400, end: 43_200 };
  assert.equal(
    makeAddress("es1418qka9yt", cut, { p: 3, q: 2 }),
    "/make?from=es1418qka9yt&cut=14400-43200&speed=3%2F2",
  );
  assert.equal(makeAddress("es1418qka9yt", cut), "/make?from=es1418qka9yt&cut=14400-43200");
  // a speed with no part is still carried: the part is the whole stage
  assert.equal(
    makeAddress("es1418qka9yt", null, { p: 1, q: 2 }),
    "/make?from=es1418qka9yt&speed=1%2F2",
  );
});
