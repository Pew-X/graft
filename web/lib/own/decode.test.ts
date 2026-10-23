import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_FILE_BYTES, tooBigToRead } from "./decode.ts";

test("a file over the limit is turned away by its size, before a byte of it is read", () => {
  assert.equal(tooBigToRead({ size: MAX_FILE_BYTES + 1 }), true);
  assert.equal(tooBigToRead({ size: MAX_FILE_BYTES }), false);
  assert.equal(tooBigToRead({ size: 0 }), false);
});
