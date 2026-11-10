// The command that wakes the database (minimum capacity 0.5, so it stays up) and lets it sleep again
// (minimum 0, so it pauses when idle and costs nothing). It is tested against a stand-in `aws` that
// records what it is asked and answers describe calls with canned values: nothing real is ever called.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("./database-capacity.sh", import.meta.url).pathname;

function fakeAws(currentMax = "4.0") {
  const dir = mkdtempSync(join(tmpdir(), "fake-aws-"));
  const log = join(dir, "calls.log");
  writeFileSync(
    join(dir, "aws"),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *MaxCapacity*--output*) echo "${currentMax}" ;;
  *MinCapacity*--output*) echo "0.0" ;;
  *Status*--output*) echo "available" ;;
esac
exit 0
`,
  );
  chmodSync(join(dir, "aws"), 0o755);
  return { dir, calls: () => (existsLog(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}
const existsLog = (p) => {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
};
const run = (args, aws, env = {}) =>
  spawnSync("sh", [script, ...args], {
    encoding: "utf8",
    env: { PATH: `${aws.dir}:${process.env.PATH}`, HOME: process.env.HOME, ...env },
  });
const modifies = (aws) => aws.calls().filter((c) => c.includes("modify-db-cluster"));

test("wake raises the minimum to 0.5 and keeps the cluster's own maximum", () => {
  const aws = fakeAws("4.0");
  const r = run(["wake", "--cluster", "graft-staging", "--region", "eu-west-1"], aws);
  assert.equal(r.status, 0, r.stderr);
  const [call] = modifies(aws);
  assert.match(call, /--db-cluster-identifier graft-staging/);
  assert.match(call, /--region eu-west-1/);
  assert.match(call, /MinCapacity=0\.5,MaxCapacity=4\.0/);
  assert.match(call, /--apply-immediately/);
  assert.equal(modifies(aws).length, 1);
});

test("sleep lets it pause: minimum 0 and a stated time before it pauses", () => {
  const aws = fakeAws("2.0");
  const r = run(["sleep", "--cluster", "graft-staging"], aws);
  assert.equal(r.status, 0, r.stderr);
  const [call] = modifies(aws);
  assert.match(call, /MinCapacity=0,MaxCapacity=2\.0,SecondsUntilAutoPause=600/);
  const later = fakeAws("2.0");
  run(["sleep", "--cluster", "c", "--pause-after", "900"], later);
  assert.match(modifies(later)[0], /SecondsUntilAutoPause=900/);
});

test("an explicit maximum wins over the cluster's", () => {
  const aws = fakeAws("4.0");
  run(["wake", "--cluster", "c", "--max", "8"], aws);
  assert.match(modifies(aws)[0], /MinCapacity=0\.5,MaxCapacity=8\b/);
});

test("status reads and changes nothing", () => {
  const aws = fakeAws();
  const r = run(["status", "--cluster", "c"], aws);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(modifies(aws).length, 0);
  assert.match(r.stdout, /minimum/i);
});

test("a dry run says what it would do and calls nothing that changes anything", () => {
  const aws = fakeAws();
  const r = run(["wake", "--cluster", "c"], aws, { DRY_RUN: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(modifies(aws).length, 0);
  assert.match(r.stdout, /would run/);
  assert.match(r.stdout, /MinCapacity=0\.5/);
});

test("without a cluster, or with nonsense, it refuses before calling anything", () => {
  for (const args of [
    ["wake"],
    ["wake", "--cluster", "c", "--max", "0.25"],
    ["wake", "--cluster", "c", "--max", "lots"],
    ["sleep", "--cluster", "c", "--pause-after", "10"],
    ["dance", "--cluster", "c"],
  ]) {
    const aws = fakeAws();
    const r = run(args, aws);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(aws.calls().length, 0, `${args.join(" ")} called aws`);
  }
});

test("the cluster can come from the environment", () => {
  const aws = fakeAws();
  const r = run(["status"], aws, { GRAFT_DB_CLUSTER: "from-env" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(aws.calls()[0], /from-env/);
});

test("after waking it asks for the cluster's status until it is available", () => {
  const aws = fakeAws();
  const r = run(["wake", "--cluster", "c"], aws);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(aws.calls().some((c) => c.includes("describe-db-clusters") && c.includes("Status")));
});
