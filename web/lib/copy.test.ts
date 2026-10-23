// The words the project does not use never reach a visitor, whichever string they sit in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { copy, detailLabels, fill, roles } from "./copy.ts";

/// Words that belong to another product or that overclaim (the repository guard has the same list).
const BANNED =
  /\b(drop|drops|stack|stacks|take|takes|recipe|recipes|kitchen|chef|verified|proven|certified|owned by|cleared)\b/i;

function strings(value: unknown, path = ""): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  }
  return [];
}

const all = [
  ...strings(copy, "copy"),
  ...strings(roles, "roles"),
  ...strings(detailLabels, "detailLabels"),
];

test("there are strings to check", () => {
  assert.ok(all.length > 40);
});

test("no string uses a word the project does not use", () => {
  for (const [path, text] of all) assert.doesNotMatch(text, BANNED, path);
});

test("no exclamation marks, and lowercase by default", () => {
  for (const [path, text] of all) {
    assert.ok(!text.includes("!"), `${path} has an exclamation mark`);
    if (path === "copy.site.description") continue; // metadata reads as a sentence
    assert.equal(text, text.toLowerCase(), `${path} is not lowercase`);
  }
});

test("fill puts values in and leaves a missing one visible", () => {
  assert.equal(fill("stage {n} of {total}", { n: 2, total: 4 }), "stage 2 of 4");
  assert.equal(fill("stage {n} of {total}", { n: 2 }), "stage 2 of {total}");
});
