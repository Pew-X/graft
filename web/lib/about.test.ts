// The about page may only say what the repository keeps: every claim names the tests that would
// fail if it stopped being true, and those tests must exist. A claim that is only a limit ("a
// downloaded copy cannot be recalled") has no test, and says so here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { privacyClaims, takedownClaims } from "./about.ts";
import { copy } from "./copy.ts";

const root = new URL("../../", import.meta.url);
const text = (file: string) => readFileSync(new URL(file, root), "utf8");

test("every claim on the page appears in the claims table, so none is unreferenced", () => {
  const listed = new Set([...privacyClaims, ...takedownClaims].map((c) => c.text));
  const onPage = [
    ...Object.values(copy.about.privacy.claims),
    ...Object.values(copy.about.takedown.claims),
  ];
  for (const claim of onPage) assert.ok(listed.has(claim), `no evidence entry for: ${claim}`);
  assert.equal(listed.size, onPage.length);
});

test("each named test exists in the file named, by its exact name", () => {
  for (const claim of [...privacyClaims, ...takedownClaims]) {
    for (const { file, test: name } of claim.evidence) {
      assert.ok(text(file).includes(name), `${file} has no test called "${name}"`);
    }
  }
});

test("only a limit may stand without a test: a claim about what the system does always names one", () => {
  const untested = [...privacyClaims, ...takedownClaims].filter((c) => c.evidence.length === 0);
  assert.deepEqual(
    untested.map((c) => c.text),
    [copy.about.takedown.claims.copies],
  );
});
