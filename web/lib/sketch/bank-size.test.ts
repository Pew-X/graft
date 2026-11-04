import assert from "node:assert/strict";
import { test } from "node:test";
import { LONG_BANK_SECONDS, bankSeconds, isLongBank } from "./bank-size.ts";
import type { Sketch } from "./sketch.ts";

const sk = (n: number, frames: number, p = 1, q = 1): Sketch => ({
  id: `sk${String(n).padStart(12, "0")}`,
  parent: { kind: "stage", id: "es1418qka9yt" },
  cut: { start: 0, end: frames },
  p,
  q,
  title: `s${n}`,
  retryKey: `web-0123456789abcdef0123456789ab${String(n).padStart(2, "0")}`,
  at: n,
});

test("the seconds are the rendered length of each sketch on the bank, and only those on it", () => {
  const a = sk(1, 48_000);
  const slow = sk(2, 48_000, 1, 2); // half speed: twice as long
  const off = sk(3, 480_000);
  assert.ok(Math.abs(bankSeconds([a, slow, off], [a.id, slow.id]) - 3) < 0.001);
  assert.equal(bankSeconds([a], ["skzzzzzzzzzzzz"]), 0);
  assert.equal(bankSeconds([], []), 0);
});

test("twelve flips at the longest output are a long bank, and twelve short ones are not", () => {
  const long = Array.from({ length: 12 }, (_, i) => sk(i + 1, 1_440_000, 1, 2));
  assert.ok(
    isLongBank(
      bankSeconds(
        long,
        long.map((s) => s.id),
      ),
    ),
  );
  const short = Array.from({ length: 12 }, (_, i) => sk(i + 1, 48_000));
  assert.ok(
    !isLongBank(
      bankSeconds(
        short,
        short.map((s) => s.id),
      ),
    ),
  );
  assert.ok(!isLongBank(LONG_BANK_SECONDS));
});
