// The ready-made flip is a way in, so it must always be one the make page accepts as it stands.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCut, checkOutput, checkSpeed, outputFrames } from "./cut.ts";
import { READY_SPEED, readyCut } from "./ready.ts";
import { parseSpeed } from "./speed.ts";

test("for the seeded sounds it keeps the first 0.9 seconds, hand-worked: 43200 frames", () => {
  assert.deepEqual(readyCut(57_600), { start: 0, end: 43_200 });
  // at 3/2 that comes out floor((43200 - 1) * 2 / 3) + 1 = 28800 frames, 0.6 s
  assert.equal(outputFrames(43_200, 3, 2), 28_800);
});

test("a short sound is kept whole, and one too short to cut or to flip has no ready-made cut", () => {
  assert.deepEqual(readyCut(20_000), { start: 0, end: 20_000 });
  assert.equal(readyCut(900), null);
  assert.equal(readyCut(0), null);
  assert.equal(readyCut(Number.NaN), null);
});

test("whatever the length, the cut and the speed are ones the make page accepts and the service stores", () => {
  for (const frames of [960, 5_000, 43_200, 57_600, 480_000, 9_000_000]) {
    const cut = readyCut(frames);
    if (cut === null) continue;
    assert.equal(checkCut(cut, frames), null, `${frames}`);
    assert.equal(checkSpeed(READY_SPEED.p, READY_SPEED.q), null);
    assert.equal(
      checkOutput(outputFrames(cut.end - cut.start, READY_SPEED.p, READY_SPEED.q)),
      null,
      `${frames}`,
    );
  }
  assert.deepEqual(parseSpeed(`${READY_SPEED.p}/${READY_SPEED.q}`), READY_SPEED);
});
