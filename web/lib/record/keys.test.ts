import assert from "node:assert/strict";
import { test } from "node:test";
import { moveCursor } from "./keys.ts";

const lengths = [1.2, 0.6, 0.72, 1.2];
const at = (stage: number, offset: number) => ({ stage, offset });

test("left and right move a tenth of a second within the stage and stop at its ends", () => {
  assert.deepEqual(moveCursor(at(1, 0.3), "ArrowRight", lengths), at(1, 0.4));
  assert.deepEqual(moveCursor(at(1, 0.3), "ArrowLeft", lengths), at(1, 0.2));
  assert.deepEqual(moveCursor(at(1, 0.55), "ArrowRight", lengths), at(1, 0.6), "stops at the end");
  assert.deepEqual(moveCursor(at(1, 0.05), "ArrowLeft", lengths), at(1, 0), "stops at the start");
});

test("up goes outwards towards the source, down goes inwards, keeping the same share of the stage", () => {
  // Halfway through the 1.2 s source is 0.6 s; halfway through the 0.6 s stage is 0.3 s.
  assert.deepEqual(moveCursor(at(0, 0.6), "ArrowDown", lengths), at(1, 0.3));
  assert.deepEqual(moveCursor(at(1, 0.3), "ArrowUp", lengths), at(0, 0.6));
  assert.deepEqual(
    moveCursor(at(0, 0.6), "ArrowUp", lengths),
    at(0, 0.6),
    "nothing outside the source",
  );
  assert.deepEqual(
    moveCursor(at(3, 0.6), "ArrowDown", lengths),
    at(3, 0.6),
    "nothing inside the last stage",
  );
});

test("home and end go to the start and the end of the stage", () => {
  assert.deepEqual(moveCursor(at(2, 0.3), "Home", lengths), at(2, 0));
  assert.deepEqual(moveCursor(at(2, 0.3), "End", lengths), at(2, 0.72));
});

test("a key the record does not use is left alone", () => {
  assert.equal(moveCursor(at(0, 0), "a", lengths), null);
  assert.equal(moveCursor(at(0, 0), "Tab", lengths), null);
});
