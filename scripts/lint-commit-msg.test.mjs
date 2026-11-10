import { test } from "node:test";
import assert from "node:assert/strict";
import { isAccepted, lintMessage, stripEditorTemplate } from "./lint-commit-msg.mjs";

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

test("lines starting with # are linted in titles and recorded commits (nothing may hide behind a hash)", () => {
  bad(`feat: x\n\n# leaked a${"@"}b.com`, /forbidden email/);
  bad("#1 junk\nfeat: ok", /header must look like/);
});

test("editor template comments and the verbose diff after the scissors line are not part of the message", () => {
  const raw = `feat: add thing\n\nBody.\n# Please enter the commit message\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n+// ${"\u00a9"} gemini name${"@"}example.com\n`;
  assert.equal(stripEditorTemplate(raw).trim(), "feat: add thing\n\nBody.");
  ok(stripEditorTemplate(raw));
});

test("any other trailer-shaped final line is rejected, an allowlisted key is fine", () => {
  bad("feat: x\n\nBody.\n\nCo-developed-by: Someone", /forbidden trailer/);
  bad("feat: x\n\nBody.\n\nMade-with: an editor", /forbidden trailer \(Made-with\)/);
  bad("feat: x\n\nBody.\n\nChange-Id: I123", /forbidden trailer/);
  ok("fix: x\n\nBody.\n\nRefs: 12");
  ok("feat: x\n\nA body paragraph that mentions a colon: here.");
});

test("the one merged squash commit that began with a sentence is accepted, and nothing else is", () => {
  assert.equal(isAccepted("f5f89e7d0b4bab5f38c358b16f9ef0ec86ecbb5b"), true);
  assert.equal(isAccepted("f5f89e7d0"), true);
  assert.equal(isAccepted("f5f89e7d1"), false);
  assert.equal(isAccepted("4a92322eb"), false);
  // and the rule itself is unchanged: such a body is still refused in a new commit
  bad("feat: x\n\nPerform: number keys and pads.", /forbidden trailer \(Perform\)/);
});
