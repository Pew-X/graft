// Client-side hints for the two public text fields. They mirror the server's rules to spare a round
// trip; the server is authoritative, so a hint never blocks anything but an empty field.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TITLE_MAX, NAME_MAX, hintFor } from "./hints.ts";

test("the limits are the service's: 60 characters for a title, 32 for a name", () => {
  assert.equal(TITLE_MAX, 60);
  assert.equal(NAME_MAX, 32);
});

test("plain text in any script has no hint", () => {
  assert.equal(hintFor("up a fifth, then down", TITLE_MAX), null);
  assert.equal(hintFor("Zoë's  übung 2", NAME_MAX), null);
  assert.equal(hintFor("夜の音", NAME_MAX), null);
});

test("an empty or blank field says it is empty", () => {
  assert.deepEqual(hintFor("", TITLE_MAX), { kind: "empty" });
  assert.deepEqual(hintFor("   ", TITLE_MAX), { kind: "empty" });
});

test("too long counts characters, not bytes, and names the limit and the excess", () => {
  assert.equal(hintFor("é".repeat(60), TITLE_MAX), null);
  assert.deepEqual(hintFor("é".repeat(63), TITLE_MAX), { kind: "tooLong", max: 60, over: 3 });
});

test("a character outside the allowed set is named", () => {
  assert.deepEqual(hintFor("fire <b>", TITLE_MAX), { kind: "character", character: "<" });
  assert.deepEqual(hintFor("a\u200bb", TITLE_MAX), { kind: "character", character: "\u200b" });
  assert.deepEqual(hintFor("line\nbreak", TITLE_MAX)?.kind, "character");
});

test("a link or an @handle will be removed, and the hint says so instead of refusing", () => {
  assert.deepEqual(hintFor("hear https://example.com", TITLE_MAX), { kind: "adjusted" });
  assert.deepEqual(hintFor("www.example.org rocks", TITLE_MAX), { kind: "adjusted" });
  assert.deepEqual(hintFor("by @someone", NAME_MAX), { kind: "adjusted" });
  assert.deepEqual(hintFor("me example.com", NAME_MAX), { kind: "adjusted" });
  assert.equal(hintFor("v1.2 mix", TITLE_MAX), null, "a version number is not a link");
});

test("a name made only of a handle is empty once the handle goes", () => {
  assert.deepEqual(hintFor("@someone", NAME_MAX), { kind: "empty" });
});
