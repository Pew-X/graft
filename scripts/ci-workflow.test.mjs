// The workflow's gating is wired by names in three places (the outputs the `changes` job declares,
// the lines that write them, and the conditions that read them). A name that differs in one place
// makes a job silently never run while the pipeline stays green, so the names are cross-checked.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

const declared = [...workflow.matchAll(/^ {6}(\w+): \$\{\{ steps\.f\.outputs\.(\w+) \}\}$/gm)];
const written = new Set([...workflow.matchAll(/echo "(\w+)=(?:true|false)" >> "\$GITHUB_OUTPUT"/g)].map((m) => m[1]));
const read = new Set([...workflow.matchAll(/needs\.changes\.outputs\.(\w+)/g)].map((m) => m[1]));

test("each output the changes job declares reads the step output of the same name", () => {
  assert.ok(declared.length >= 3);
  for (const [, name, step] of declared) assert.equal(name, step, `output ${name} reads step output ${step}`);
});

test("every output a job reads is declared, and every declared output is written", () => {
  const names = new Set(declared.map((m) => m[1]));
  for (const name of read) assert.ok(names.has(name), `a job reads needs.changes.outputs.${name}, which is not declared`);
  for (const name of names) assert.ok(written.has(name), `${name} is declared but nothing writes it`);
});

test("every job has a time limit", () => {
  const jobs = workflow.split(/^jobs:\n/m)[1] ?? "";
  const blocks = jobs.split(/^ {2}(?=[a-z][a-z-]*:\n)/m).filter((b) => /^[a-z]/.test(b));
  assert.ok(blocks.length >= 10);
  for (const block of blocks) {
    const name = block.split(":")[0];
    assert.match(block, /^ {4}timeout-minutes: \d+$/m, `${name} has no timeout-minutes`);
  }
});
