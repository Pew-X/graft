// "Your flips" lists only what the browser's kept keys name, newest first, and says how each stands.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ID_SHAPE, flipIds, stateOf } from "./list.ts";

test("the newest kept flip comes first", () => {
  assert.deepEqual(flipIds({ aaaaaaaaaaaa: "k1", bbbbbbbbbbbb: "k2", cccccccccccc: "k3" }), [
    "cccccccccccc",
    "bbbbbbbbbbbb",
    "aaaaaaaaaaaa",
  ]);
  assert.deepEqual(flipIds({}), []);
});

test("anything that is not a publication id is left out, whatever the storage holds", () => {
  const kept = {
    e790b6ycz0yd: "k",
    "": "k",
    short: "k",
    e790b6ycz0yd0: "k", // 13 characters
    E790B6YCZ0YD: "k", // capitals
    "e790b6ycz0y/": "k",
    "../manage/xxxx": "k",
    e790b6ycz0yl: "k", // l is not in the alphabet
    "<script>alert(1)</sc": "k",
    q0yjjgng394w: "k",
  };
  assert.deepEqual(flipIds(kept), ["q0yjjgng394w", "e790b6ycz0yd"]);
});

test("the id shape is the service's: twelve characters without i, l, o and u", () => {
  for (const id of ["e790b6ycz0yd", "0123456789ab", "zzzzzzzzzzzz"])
    assert.ok(ID_SHAPE.test(id), id);
  for (const id of ["iiiiiiiiiiii", "llllllllllll", "oooooooooooo", "uuuuuuuuuuuu"])
    assert.ok(!ID_SHAPE.test(id), id);
});

test("a flip is open, closed to new flips, withdrawn or not found", () => {
  assert.equal(stateOf({ state: "available", forkPermitted: true }), "open");
  assert.equal(stateOf({ state: "available", forkPermitted: null }), "open");
  assert.equal(stateOf({ state: "available", forkPermitted: false }), "closed");
  assert.equal(stateOf({ state: "withdrawn", forkPermitted: true }), "withdrawn");
  assert.equal(stateOf({ state: "hidden", forkPermitted: null }), "withdrawn");
  assert.equal(stateOf(null), "missing");
});
