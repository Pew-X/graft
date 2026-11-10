import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPins, parsePins, versionFromSource } from "./check-wasm-pin.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const pins = (...rows) => new Map(rows);

test("the built hash equal to the pin for the current version passes", () => {
  assert.deepEqual(checkPins({ version: 1, builtSha: A, pins: pins([1, A]) }), []);
});

test("a changed artefact under the same version fails and says to bump the version", () => {
  const problems = checkPins({ version: 1, builtSha: B, pins: pins([1, A]) });
  assert.match(problems.join("\n"), /differs from the pin for version 1/);
  assert.match(problems.join("\n"), /new VERSION/);
});

test("a new version without a pin line fails and prints the line to add", () => {
  const problems = checkPins({ version: 2, builtSha: B, pins: pins([1, A]) });
  assert.match(problems.join("\n"), new RegExp(`add the line "2 ${B}"`));
});

test("editing or removing a published pin fails", () => {
  assert.match(
    checkPins({ version: 2, builtSha: B, pins: pins([1, B], [2, B]), basePins: pins([1, A]) }).join("\n"),
    /pin for version 1 was changed/,
  );
  assert.match(
    checkPins({ version: 2, builtSha: B, pins: pins([2, B]), basePins: pins([1, A]) }).join("\n"),
    /pin for version 1 was changed or removed/,
  );
});

test("appending a pin for a new version is allowed", () => {
  assert.deepEqual(checkPins({ version: 2, builtSha: B, pins: pins([1, A], [2, B]), basePins: pins([1, A]) }), []);
});

test("pin files reject malformed and duplicate lines and ignore comments", () => {
  assert.equal(parsePins(`# note\n\n1 ${A}\n`).get(1), A);
  assert.throws(() => parsePins("1 nothex"), /malformed/);
  assert.throws(() => parsePins(`1 ${A}\n1 ${B}\n`), /pinned twice/);
});

test("the version is read from the Rust constant", () => {
  assert.equal(versionFromSource("pub const VERSION: u32 = 7;"), 7);
  assert.throws(() => versionFromSource("const X: u32 = 1;"), /cannot find/);
});
