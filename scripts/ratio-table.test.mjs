import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTable, centsOf, renderModule } from "./ratio-table.mjs";

const table = buildTable();
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

test("the committed table is exactly what the generator makes", () => {
  const committed = readFileSync(new URL("../web/lib/make/ratio-table.ts", import.meta.url), "utf8");
  assert.equal(committed, renderModule(table));
});

test("the table runs strictly upward, so a control that walks it never goes backwards or repeats", () => {
  for (let i = 1; i < table.length; i++) {
    const [p, q] = table[i];
    const [pp, pq] = table[i - 1];
    assert.ok(p * pq > pp * q, `entry ${i}: ${p}/${q} is not above ${pp}/${pq}`);
    assert.ok(table[i][2] >= table[i - 1][2], `cents never fall at ${i}`);
  }
});

test("every entry is a pair the renderer accepts: lowest terms, terms at most 2^20, ratio from 1/4 to 4", () => {
  for (const [p, q] of table) {
    assert.equal(gcd(p, q), 1, `${p}/${q}`);
    assert.ok(p >= 1 && q >= 1 && p <= 2 ** 20 && q <= 2 ** 20, `${p}/${q}`);
    assert.ok(4 * p >= q && p <= 4 * q, `${p}/${q} is outside 1/4 .. 4`);
  }
});

test("the ends and the musical ratios are exact entries with their known intervals", () => {
  const find = (p, q) => table.find((e) => e[0] === p && e[1] === q);
  assert.deepEqual(table[0], [1, 4, -2400]);
  assert.deepEqual(table.at(-1), [4, 1, 2400]);
  assert.equal(find(1, 2)[2], -1200);
  assert.equal(find(2, 3)[2], -702);
  assert.equal(find(3, 2)[2], 702);
  assert.equal(find(1, 1)[2], 0);
  assert.equal(find(2, 1)[2], 1200);
});

test("the stated cents are the nearest whole cent of the exact interval, checked against floating point only here", () => {
  for (const [p, q, cents] of table) {
    const exact = 1200 * Math.log2(p / q);
    assert.ok(Math.abs(exact - cents) <= 0.5 + 1e-9, `${p}/${q}: ${cents} vs ${exact}`);
  }
  assert.equal(centsOf(2, 1), 1200);
  assert.equal(centsOf(81, 64), Math.round(1200 * Math.log2(81 / 64)));
});

test("no gap between neighbours is wider than the step plus the replacement window: 37 cents", () => {
  for (let i = 1; i < table.length; i++) {
    assert.ok(table[i][2] - table[i - 1][2] <= 25 + 12, `${table[i - 1]} to ${table[i]}`);
  }
});
