import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "./cut.ts";
import {
  DEFAULT_SPEED,
  editingFor,
  nudge,
  parseCut,
  speedOf,
  startEditing,
  valueOf,
  withCut,
  withStop,
} from "./editing.ts";
import { RATIO_TABLE } from "./ratio-table.ts";

test("with no link the whole sound opens at a fifth up", () => {
  const e = startEditing(48_000, { cut: null, speed: null });
  assert.deepEqual(e.cut, { start: 0, end: 48_000 });
  const { p, q } = speedOf(e);
  assert.deepEqual({ p, q }, DEFAULT_SPEED);
});

test("a sound longer than the longest cut opens on its first ten seconds", () => {
  const e = startEditing(2_000_000, { cut: null, speed: null });
  assert.deepEqual(e.cut, { start: 0, end: LIMITS.maxCutFrames });
});

test("a link's cut and speed are used, and a speed that is not a table stop is ignored", () => {
  assert.deepEqual(startEditing(48_000, { cut: "100-9000", speed: "1/2" }).cut, {
    start: 100,
    end: 9000,
  });
  const given = speedOf(startEditing(48_000, { cut: null, speed: "1/2" }));
  assert.deepEqual({ p: given.p, q: given.q }, { p: 1, q: 2 });
  const odd = speedOf(startEditing(48_000, { cut: null, speed: "5/1" }));
  assert.deepEqual({ p: odd.p, q: odd.q }, DEFAULT_SPEED);
});

test("a cut text is read only in its exact shape", () => {
  assert.deepEqual(parseCut("1-2"), { start: 1, end: 2 });
  for (const bad of [null, "", "1", "1-", "-2", "1-2-3", "a-b", "12345678-1", "1.5-2"])
    assert.equal(parseCut(bad), null, String(bad));
});

test("changing the cut or the speed changes only that, and the value follows", () => {
  const e = startEditing(48_000, { cut: null, speed: null });
  const moved = withCut(e, { start: 10, end: 20_000 });
  assert.equal(moved.stop, e.stop);
  assert.deepEqual(valueOf(moved).cut, { start: 10, end: 20_000 });
  const faster = nudge(moved, 1);
  assert.equal(faster.stop, e.stop + 1);
  assert.deepEqual(faster.cut, moved.cut);
});

test("the speed stops at both ends of the table", () => {
  const e = startEditing(48_000, { cut: null, speed: null });
  assert.equal(nudge(e, -10_000).stop, 0);
  assert.equal(nudge(e, 10_000).stop, RATIO_TABLE.length - 1);
  assert.equal(withStop(e, -5).stop, 0);
  assert.equal(withStop(e, 10_000).stop, RATIO_TABLE.length - 1);
});

test("a value round-trips through editing for every stop of the table", () => {
  for (let stop = 0; stop < RATIO_TABLE.length; stop++) {
    const value = valueOf({ cut: { start: 0, end: 1000 }, stop });
    assert.equal(editingFor(value).stop, stop);
  }
});

test("a value is a copy: changing it never changes the editing state it came from", () => {
  const e = startEditing(48_000, { cut: null, speed: null });
  const value = valueOf(e);
  value.cut.start = 99;
  assert.equal(e.cut.start, 0);
});
