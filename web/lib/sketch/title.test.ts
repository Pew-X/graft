import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { RATIO_TABLE } from "../make/ratio-table.ts";
import { defaultTitle } from "./names.ts";
import { cleanTitle } from "./title.ts";

const value = (text: string): string | null => {
  const r = cleanTitle(text);
  return r.ok ? r.value : null;
};
const rule = (text: string): string | null => {
  const r = cleanTitle(text);
  return r.ok ? null : r.rule;
};

test("plain text passes unchanged, and spaces are made plain", () => {
  assert.equal(value("a door, slowed"), "a door, slowed");
  assert.equal(value("Ana-Maria O'Neil"), "Ana-Maria O'Neil");
  assert.equal(value("  a   door  "), "a door");
  assert.equal(value("a door now"), "a door now");
});

test("links and handles are removed and the title is marked adjusted, as the service does", () => {
  for (const [input, want] of [
    ["hear this https://example.com/x now", "hear this now"],
    ["see www.example.org", "see"],
    ["mine on example.com", "mine on"],
    ["go to bit.ly", "go to"],
    ["by @someone cool", "by cool"],
  ] as const) {
    const r = cleanTitle(input);
    assert.deepEqual(r, { ok: true, value: want, adjusted: true }, input);
  }
  for (const input of ["Mr. Smith", "v2.final", "take 2.5", "a.m. mix"])
    assert.equal((cleanTitle(input) as { adjusted: boolean }).adjusted, false, input);
});

test("what is only a link, a handle or space is refused as empty", () => {
  for (const input of ["@someone", "https://example.com", "   ", ""])
    assert.equal(rule(input), "empty");
});

test("control, invisible, line-break and out-of-set characters are refused", () => {
  for (const input of [
    "a\u0000b",
    "a‮b",
    "a​b",
    "a\nb",
    "a\tb",
    "a\u2028b",
    "ab",
    "a·b",
    "a–b",
    "a🙂b",
    "a<b",
  ])
    assert.equal(rule(input), "character", JSON.stringify(input));
});

test("a word mixing Latin with Cyrillic or Greek is refused, a whole word in one script is not", () => {
  assert.equal(rule("pаypal"), "mixed_scripts"); // Latin p with Cyrillic a
  assert.equal(value("привет"), "привет");
  assert.equal(value("你好 world"), "你好 world");
});

test("sixty characters pass, sixty-one do not, and reserved words are refused", () => {
  assert.notEqual(value("x".repeat(60)), null);
  assert.equal(rule("x".repeat(61)), "too_long");
  assert.equal(rule("x ".repeat(2000)), "too_long");
  assert.equal(rule("the Admin speaks"), "denied_word");
  assert.equal(rule("moderator."), "denied_word");
});

test("a default name is made of facts, in the seeded convention", () => {
  const base = { cut: { start: 0, end: 48_000 }, wholeFrames: 48_000, taken: [] };
  assert.equal(defaultTitle({ ...base, p: 3, q: 2 }), "up a fifth");
  assert.equal(defaultTitle({ ...base, p: 1, q: 2 }), "down an octave");
  assert.equal(defaultTitle({ ...base, p: 1, q: 1 }), "same pitch");
});

test("the cut is named only when it is not the whole sound, in seconds to two places", () => {
  const t = defaultTitle({
    p: 3,
    q: 2,
    cut: { start: 19_200, end: 43_200 },
    wholeFrames: 96_000,
    taken: [],
  });
  assert.equal(t, "up a fifth, 0.4 to 0.9 s");
  assert.equal(
    defaultTitle({ p: 3, q: 2, cut: { start: 0, end: 48_000 }, wholeFrames: 96_000, taken: [] }),
    "up a fifth, 0 to 1 s",
  );
});

test("a name a sibling already has gets a number, and keeps getting the next one", () => {
  const base = { p: 3, q: 2, cut: { start: 0, end: 10 }, wholeFrames: 10 };
  assert.equal(defaultTitle({ ...base, taken: ["up a fifth"] }), "up a fifth (2)");
  assert.equal(
    defaultTitle({ ...base, taken: ["up a fifth", "Up A Fifth (2)"] }),
    "up a fifth (3)",
  );
});

test("every default name, over every speed of the table, any cut, any siblings, passes the service's text check and fits sixty characters", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: RATIO_TABLE.length - 1 }),
      fc.integer({ min: 0, max: 9_000_000 }),
      fc.integer({ min: 1, max: 960_000 }),
      fc.integer({ min: 1, max: 12 }),
      (stop, start, length, siblings) => {
        const row = RATIO_TABLE[stop]!;
        const taken: string[] = [];
        for (let i = 0; i < siblings; i++) {
          const name = defaultTitle({
            p: row[0],
            q: row[1],
            cut: { start, end: start + length },
            wholeFrames: 10_000_000,
            taken,
          });
          const cleaned = cleanTitle(name);
          assert.ok(cleaned.ok, `${name}: ${JSON.stringify(cleaned)}`);
          assert.equal(cleaned.ok && cleaned.value, name, "the service would store it as it is");
          assert.equal(cleaned.ok && cleaned.adjusted, false);
          assert.ok([...name].length <= 60);
          assert.ok(!taken.some((t) => t.toLowerCase() === name.toLowerCase()), "no clash");
          taken.push(name);
        }
      },
    ),
    { numRuns: 400 },
  );
});

test("a long interval name plus a numbered suffix is cut to fit and still unique", () => {
  const taken: string[] = [];
  for (let i = 0; i < 15; i++) {
    const name = defaultTitle({
      p: 5,
      q: 1,
      cut: { start: 123_456, end: 234_567 },
      wholeFrames: 9_999_999,
      taken,
    });
    assert.ok([...name].length <= 60);
    taken.push(name);
  }
  assert.equal(new Set(taken.map((t) => t.toLowerCase())).size, 15);
});
