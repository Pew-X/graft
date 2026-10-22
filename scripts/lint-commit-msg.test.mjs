import { test } from "node:test";
import assert from "node:assert/strict";
import { lintMessage } from "./lint-commit-msg.mjs";

const ok = (m) => assert.deepEqual(lintMessage(m), [], m);
const bad = (m, pattern) => assert.match(lintMessage(m).join("\n"), pattern, m);

test("plain conventional messages pass, with and without scope and body", () => {
  ok("feat(render): add the integer varispeed core");
  ok("chore: add gitignore");
  ok("fix(api)!: refuse a retry key reused with a different body\n\nThe second request now gets a conflict.");
});

test("a message that is not conventional is rejected", () => {
  bad("update stuff", /header must look like/);
  bad("Feat: capitalised type", /header must look like/);
  bad("feat:no space", /header must look like/);
});

test("an over-long header and a trailing full stop are rejected", () => {
  bad(`feat: ${"x".repeat(80)}`, /limit is 72/);
  bad("feat: add a thing.", /full stop/);
});

test("attribution trailers are rejected in any case", () => {
  bad(`feat: x\n\nCo-Authored-By: Someone <a${"@"}b.co>`, /forbidden trailer/);
  bad("feat: x\n\nsigned-off-by: Someone", /forbidden trailer/);
});

test("email addresses are rejected anywhere in the message", () => {
  bad(`feat: x\n\nContact me at name${"@"}example.com`, /forbidden email/);
});

test("tool and AI disclosure lines are rejected, including emoji", () => {
  bad("feat: x\n\nGenerated with a tool", /forbidden tool or AI disclosure/);
  bad("feat: x\n\nAI-assisted change", /forbidden AI disclosure/);
  bad("docs: mention Claude", /forbidden tool or AI name/);
  bad("feat: x\n\n\u{1F916}", /forbidden emoji/);
});

test("git comment lines are ignored", () => {
  ok("feat: add thing\n\n# Please enter the commit message");
});
