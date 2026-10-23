import assert from "node:assert/strict";
import { test } from "node:test";
import { hintText, refusalText, waitText } from "./words.ts";
import type { Refusal } from "./client.ts";

const kinds: Refusal[] = [
  { kind: "publishingOff" },
  { kind: "storageFull" },
  { kind: "rateLimited", retryAfterSecs: 120 },
  { kind: "publishCap", retryAfterSecs: 3600 },
  { kind: "forkCap", retryAfterSecs: 30 },
  { kind: "forkClosed" },
  { kind: "depthCap" },
  { kind: "parentHeld" },
  { kind: "parentGone" },
  { kind: "conflict" },
  { kind: "internal" },
  { kind: "invalid", field: "title", rule: "denied_word" },
];

test("every refusal has its own sentence, none generic, none with a placeholder left in", () => {
  const texts = kinds.map(refusalText);
  assert.equal(new Set(texts).size, kinds.length, "no two refusals say the same thing");
  for (const t of texts) {
    assert.doesNotMatch(t, /\{|undefined|null/);
    assert.ok(t.length > 30, t);
  }
});

test("a waiting refusal says when to try again in plain units", () => {
  assert.equal(waitText(null), "in a moment");
  assert.equal(waitText(0), "in a moment");
  assert.equal(waitText(45), "in about 45 seconds");
  assert.equal(waitText(120), "in about 2 minutes");
  assert.equal(waitText(90), "in about 2 minutes", "rounds up: never says sooner than it is");
  assert.equal(waitText(3600), "in about an hour");
  assert.equal(waitText(7300), "in about 3 hours");
  assert.match(refusalText({ kind: "rateLimited", retryAfterSecs: 120 }), /in about 2 minutes/);
});

test("an invalid field names the field and the rule in the maker's words", () => {
  const text = refusalText({ kind: "invalid", field: "author", rule: "too_long" });
  assert.match(text, /name/);
  assert.match(text, /too long/);
  assert.match(refusalText({ kind: "invalid", field: null, rule: null }), /rule/);
});

test("a hint reads as a short sentence naming what to fix", () => {
  assert.match(hintText({ kind: "tooLong", max: 60, over: 3 }), /3 characters too many/);
  assert.match(hintText({ kind: "character", character: "<" }), /< is not allowed/);
  assert.match(hintText({ kind: "empty" }), /empty/);
  assert.match(hintText({ kind: "adjusted" }), /removed/);
});
