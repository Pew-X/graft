// The one speed control: it walks the committed table, says each stop as a percentage and an
// interval, and a deep link can name a speed that is not in the table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSpeed } from "../roll/speed.ts";
import { RATIO_TABLE } from "./ratio-table.ts";
import { entryAt, indexOf, parseSpeed, step } from "./speed.ts";

test("the table's ends and middle are a quarter, one, and four times", () => {
  assert.deepEqual(entryAt(0), { p: 1, q: 4, cents: -2400 });
  assert.deepEqual(entryAt(indexOf(1, 1)), { p: 1, q: 1, cents: 0 });
  assert.deepEqual(entryAt(RATIO_TABLE.length - 1), { p: 4, q: 1, cents: 2400 });
});

test("the stops the product is built on are said as the percentage and interval a maker expects", () => {
  const said = (p: number, q: number) => {
    const s = describeSpeed(p, q);
    return `${s.percent} ${s.interval}`;
  };
  assert.equal(said(1, 4), "25% two octaves down");
  assert.equal(said(1, 2), "50% an octave down");
  assert.equal(said(2, 3), "67% a fifth down");
  assert.equal(said(1, 1), "100% same pitch");
  assert.equal(said(3, 2), "150% a fifth up");
  assert.equal(said(4, 1), "400% two octaves up");
});

test("stepping moves one stop and stops at the ends instead of wrapping", () => {
  assert.equal(step(0, -1), 0);
  assert.equal(step(RATIO_TABLE.length - 1, 1), RATIO_TABLE.length - 1);
  assert.equal(step(10, 1), 11);
  assert.equal(step(10, -3), 7);
});

test("a ratio in the table finds itself; one that is not finds the nearest stop", () => {
  assert.equal(entryAt(indexOf(3, 2)).p, 3);
  const near = entryAt(indexOf(1001, 1000));
  assert.deepEqual([near.p, near.q], [1, 1]);
  assert.equal(indexOf(1, 100), 0, "below the range clamps to the first stop");
  assert.equal(indexOf(100, 1), RATIO_TABLE.length - 1);
});

test("a speed written in a link, p/q, is read only when it is exactly a stop of the table", () => {
  assert.deepEqual(parseSpeed("3/2"), { p: 3, q: 2 });
  assert.equal(parseSpeed("1/1")?.q, 1);
  assert.equal(parseSpeed("1001/1000"), null);
  assert.equal(parseSpeed("3/0"), null);
  assert.equal(parseSpeed("abc"), null);
  assert.equal(parseSpeed("3/2/1"), null);
  assert.equal(parseSpeed(null), null);
});
