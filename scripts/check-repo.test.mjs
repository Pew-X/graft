import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFiles } from "./check-repo.mjs";

const run = (files) => checkFiles(Object.keys(files), (p) => files[p]);

test("code, scripts, the two allowed documents and config pass", () => {
  assert.deepEqual(
    run({
      "README.md": "# graft\n",
      "ARCHITECTURE.md": "# Architecture\n",
      "crates/render/src/lib.rs": "pub fn drop_it() {}\n", // Rust code is not prose
      "package.json": "{}",
    }),
    [],
  );
});

test("planning artefacts and stray markdown are rejected", () => {
  const found = run({
    "vault/notes.txt": "x",
    "SPEC.md": "x",
    "GLOSSARY.md": "x",
    "docs/plan.md": "x",
    "NOTES.md": "x",
    "crates/render/README.md": "x",
  }).join("\n");
  for (const path of ["vault/notes.txt", "SPEC.md", "GLOSSARY.md", "docs/plan.md", "NOTES.md", "crates/render/README.md"]) {
    assert.ok(found.includes(path), `${path} should be reported`);
  }
});

test("an email address in any text file is rejected, lockfiles excepted", () => {
  assert.match(run({ "scripts/x.mjs": `// me${"@"}example.com` }).join("\n"), /scripts\/x\.mjs: contains an email address/);
  assert.deepEqual(run({ "pnpm-lock.yaml": `resolution: pkg${"@"}1.2.3.tgz` }), []);
});

test("banned vocabulary is rejected in documentation and web copy, with the line number", () => {
  const found = run({ "README.md": "ok line\nWe take a cut and drop it.\n", "web/app/page.tsx": "<p>verified by us</p>" });
  assert.match(found.join("\n"), /README\.md:2: "take" is not graft vocabulary/);
  assert.match(found.join("\n"), /web\/app\/page\.tsx:1: "verified"/);
});

test("words that only contain a banned word are fine", () => {
  assert.deepEqual(run({ "README.md": "an unverified host, a stacked bar, undropped\n" }), []);
});
