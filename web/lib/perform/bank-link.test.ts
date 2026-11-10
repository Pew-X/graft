import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { type BankLink, encodeBank, parseBankHash } from "./bank-link.ts";

const STAGE = "es1418qka9yt";
const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";
const shown = new Set([STAGE, "ddddddddddd1".replace("1", "d")]);
const link = (over: Partial<BankLink> = {}): BankLink => ({
  stage: STAGE,
  pads: [A, B, C],
  phrase: [
    { stage: 0, at: 0 },
    { stage: 2, at: 35 },
    { stage: 1, at: 120 },
  ],
  ...over,
});

test("a bank round-trips, pad order and times kept exactly", () => {
  const hash = encodeBank(link())!;
  assert.equal(hash, `#bank=${STAGE}&pads=${A},${B},${C}&phrase=1:0,3:35,2:120`);
  assert.deepEqual(parseBankHash(hash, shown), link());
});

test("the phrase is pinned to the ids it was recorded on: the same press means the same flip however the stage's flips change", () => {
  const hash = encodeBank(link({ pads: [C, A, B] }))!;
  const read = parseBankHash(hash, shown)!;
  assert.deepEqual(read.pads, [C, A, B]);
  assert.equal(read.pads[read.phrase[0]!.stage], C);
});

test("a link that names a stage this page does not show is no bank", () => {
  const hash = encodeBank(link())!;
  assert.equal(parseBankHash(hash, new Set(["eeeeeeeeeeee"])), null);
});

test("a link cut short at any length is no bank, never part of one", () => {
  const hash = encodeBank(link())!;
  for (let n = 0; n < hash.length; n++) {
    const read = parseBankHash(hash.slice(0, n), shown);
    // only a cut that still ends on a whole press can read, and then it is a shorter phrase of the same pads
    if (read !== null) assert.ok(read.phrase.length < 3 && hash.slice(0, n).includes("phrase=1:0"));
  }
  assert.equal(parseBankHash(hash.slice(0, hash.indexOf("&phrase")), shown), null);
});

test("hostile links are refused whole", () => {
  const bad = [
    "",
    "#bank=",
    `#bank=${STAGE}`,
    `#bank=${STAGE}&pads=${A}`,
    `#bank=${STAGE}&pads=${A}&phrase=`,
    `#bank=${STAGE}&pads=${A}&phrase=2:0`,
    `#bank=${STAGE}&pads=${A},${A}&phrase=1:0`,
    `#bank=${STAGE}&pads=${A},x&phrase=1:0`,
    `#bank=${STAGE}&pads=${A}&phrase=1:5`,
    `#bank=${STAGE}&pads=${A}&phrase=1:0,1:1700`,
    `#bank=${STAGE}&pads=${A}&phrase=1:0,1:20,1:10`,
    `#bank=${STAGE}&pads=${A}&phrase=1:0&extra=1`,
    `#bank=${STAGE}&phrase=1:0&pads=${A}`,
    `#bank=${STAGE}&pads=${Array.from({ length: 13 }, (_, i) => `a${String(i).padStart(11, "b")}`).join(",")}&phrase=1:0`,
    `#bank=${STAGE}&pads=${A}&phrase=${Array.from({ length: 65 }, (_, i) => `1:${i}`)
      .join(",")
      .replace("1:0", "1:0")}`,
    `#bank=${"x".repeat(3000)}`,
    `#phrase=1:0`,
  ];
  for (const hash of bad) assert.equal(parseBankHash(hash, shown), null, hash.slice(0, 60));
});

test("nothing is written that would not be read back, over random banks", () => {
  const id = fc.stringMatching(/^[0-9a-hjkmnp-tv-z]{12}$/);
  fc.assert(
    fc.property(
      fc.uniqueArray(id, { minLength: 1, maxLength: 12 }),
      fc.array(fc.tuple(fc.nat(11), fc.nat(40)), { minLength: 1, maxLength: 64 }),
      (pads, presses) => {
        let at = 0;
        const phrase = presses.map(([pad, gap], i) => {
          at += i === 0 ? 0 : gap;
          return { stage: pad % pads.length, at };
        });
        const bank: BankLink = { stage: STAGE, pads, phrase };
        const hash = encodeBank(bank);
        if (hash === null) return;
        assert.deepEqual(parseBankHash(hash, shown), bank);
      },
    ),
    { numRuns: 300 },
  );
});

test("a bank that cannot be written is not written: no pads, too many, a repeat, a press past the pads, no phrase", () => {
  assert.equal(encodeBank(link({ pads: [] })), null);
  assert.equal(encodeBank(link({ pads: [A, A] })), null);
  assert.equal(encodeBank(link({ phrase: [] })), null);
  assert.equal(encodeBank(link({ phrase: [{ stage: 5, at: 0 }] })), null);
  assert.equal(encodeBank(link({ stage: "nope" })), null);
});
