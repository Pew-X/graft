// The dev deployment script. It is tested against a stand-in `aws` that records every call and answers
// reads with "nothing exists yet" (and the identity the test chooses): nothing real is ever called.
// The tests pin the guarantees that keep a first deploy safe and cheap: it refuses the wrong account,
// role or region before any change; a dry run changes nothing; nothing it plans can bill by the hour
// beyond the stated caps; teardown never touches what it did not create.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("./aws-dev.sh", import.meta.url).pathname;
// Built at run time so this file carries no real account id: this one is AWS's documented example.
const ACCOUNT = "123456789012";
const ROLE = "graft-operator";
// A call changes something unless its verb only reads.
const READS = /^(describe|list|get|head|wait|ls)/;

function sandbox({ identity = `${ACCOUNT} arn:aws:sts::${ACCOUNT}:assumed-role/${ROLE}/s`, region = "ap-south-1" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aws-dev-"));
  const log = join(dir, "calls.log");
  const sent = join(dir, "files.log");
  const ledger = join(dir, "ledger.md");
  writeFileSync(ledger, "# ledger\n");
  writeFileSync(
    join(dir, "aws"),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *"sts get-caller-identity"*) echo "${identity}" ;;
  *create-vpc\\ *) echo "vpc-0abc" ;;
  *create-subnet*) echo "subnet-0abc" ;;
  *create-security-group*) echo "sg-0abc" ;;
  *create-route-table*) echo "rtb-0abc" ;;
  *create-internet-gateway*) echo "igw-0abc" ;;
  *get-random-password*) echo "Abcdefghijklmnopqrstuvwxyz012345" ;;
  *describe-db-clusters*Endpoint*) echo "graft-dev-db.cluster-x.ap-south-1.rds.amazonaws.com" ;;
  *describe-subnets*|*describe-security-groups*) [ -z "$FAKE_NETWORK$FAKE_EXISTS" ] || echo "net-0abc" ;;
  *describe-*|*list-*) [ -z "$FAKE_EXISTS" ] || echo "res-0abc" ;;
esac
# keep what any file:// argument held, to check what would have been sent
for a in "$@"; do case "$a" in file://*) cat "\${a#file://}" >> "${dir}/files.log"; echo >> "${dir}/files.log" ;; esac; done
exit 0
`,
  );
  chmodSync(join(dir, "aws"), 0o755);
  const envFile = join(dir, "env");
  writeFileSync(
    envFile,
    `GRAFT_AWS_PROFILE=graft-dev
GRAFT_AWS_REGION=${region}
GRAFT_AWS_ACCOUNT_ID=${ACCOUNT}
GRAFT_AWS_ROLE_NAME=${ROLE}
GRAFT_DEPLOY_LEDGER=${ledger}
`,
  );
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const run = (args, env = {}) =>
    spawnSync("sh", [script, ...args], {
      encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: dir, GRAFT_DEV_ENV: envFile, ...env },
    });
  const changes = () =>
    calls()
      .map((c) => c.replace(/^--profile \S+ --region \S+ /, "").split(" "))
      .filter(([service, verb]) => !(service === "sts" || READS.test(verb ?? "")))
      .map((words) => words.join(" "));
  return { run, calls, changes, sent: () => (existsSync(sent) ? readFileSync(sent, "utf8") : ""), ledger: () => readFileSync(ledger, "utf8"), envFile, dir };
}
const plan = (r) => `${r.stdout}${r.stderr}`;

test("it refuses an account other than the expected one, before any change", () => {
  const s = sandbox({ identity: `000000000000 arn:aws:sts::000000000000:assumed-role/${ROLE}/s` });
  const r = s.run(["network"]);
  assert.notEqual(r.status, 0);
  assert.match(plan(r), /account/i);
  assert.deepEqual(s.changes(), []);
});

test("it refuses to act as anything but the operator role", () => {
  const s = sandbox({ identity: `${ACCOUNT} arn:aws:iam::${ACCOUNT}:user/someone` });
  const r = s.run(["network"]);
  assert.notEqual(r.status, 0);
  assert.match(plan(r), /role/i);
  assert.deepEqual(s.changes(), []);
});

test("it refuses any region other than ap-south-1, and a missing settings file", () => {
  const wrongRegion = sandbox({ region: "us-east-1" });
  const r = wrongRegion.run(["network"]);
  assert.notEqual(r.status, 0);
  assert.match(plan(r), /ap-south-1/);
  assert.deepEqual(wrongRegion.calls(), []);
  const none = sandbox();
  const missing = none.run(["network"], { GRAFT_DEV_ENV: "/nonexistent/settings" });
  assert.notEqual(missing.status, 0);
  assert.deepEqual(none.calls(), []);
});

test("a dry run reads and plans but makes no change", () => {
  const s = sandbox();
  for (const phase of ["network", "registry", "storage", "roles", "logs", "database"]) {
    const r = s.run([phase], { DRY_RUN: "1" });
    assert.equal(r.status, 0, `${phase}: ${r.stderr}`);
    assert.match(plan(r), /would run: aws /, `${phase} should print its plan`);
  }
  assert.deepEqual(s.changes(), [], "no mutating call may reach aws in a dry run");
});

test("the network is its own VPC, with no NAT gateway and no interface endpoints", () => {
  const out = plan(sandbox().run(["network"], { DRY_RUN: "1" }));
  assert.match(out, /create-vpc .*10\.42\.0\.0\/16/);
  assert.match(out, /create-vpc-endpoint .*com\.amazonaws\.ap-south-1\.s3 .*Gateway/);
  assert.doesNotMatch(out, /nat-gateway|allocate-address|Interface/i);
  assert.equal((out.match(/create-subnet /g) ?? []).length, 4, "two public and two private subnets");
  assert.match(out, /5432/);
});

test("everything it creates carries the project tags", () => {
  const s = sandbox();
  for (const phase of ["network", "registry", "storage", "roles", "logs", "database"]) {
    const creates = plan(s.run([phase], { DRY_RUN: "1" }))
      .split("\n")
      .filter((l) => /would run: aws \S+ (create-(vpc|subnet|security-group|route-table|internet-gateway|vpc-endpoint|repository|role|log-group|db-cluster|db-instance|db-subnet-group|secret)|put-bucket-tagging)\b/.test(l) && !/create-(db-cluster|secret)\b.*file:/.test(l));
    for (const line of creates) assert.match(line, /Project[=,]\s*graft|Key=Project,Value=graft|Project=graft/, `${phase}: ${line}`);
  }
});

test("the bucket is created in Mumbai, private, and tidies half-finished uploads", () => {
  const out = plan(sandbox().run(["storage"], { DRY_RUN: "1" }));
  assert.match(out, /create-bucket .*--bucket graft-dev-audio-[0-9a-f]+/);
  assert.match(out, /LocationConstraint=ap-south-1/);
  assert.match(out, /BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true/);
  assert.match(out, /AbortIncompleteMultipartUpload/);
});

test("the repository is immutable, scanned, and keeps only a few images", () => {
  const out = plan(sandbox().run(["registry"], { DRY_RUN: "1" }));
  assert.match(out, /create-repository .*graft-dev-service/);
  assert.match(out, /IMMUTABLE/);
  assert.match(out, /scanOnPush=true/);
  assert.match(out, /imageCountMoreThan/);
});

test("the log group keeps seven days", () => {
  const out = plan(sandbox().run(["logs"], { DRY_RUN: "1" }));
  assert.match(out, /create-log-group .*\/graft-dev\/service/);
  assert.match(out, /put-retention-policy .*--retention-in-days 7\b/);
});

test("the database is capped at 1 unit, can pause, is private and cheap, and its password is never printed", () => {
  const out = plan(sandbox().run(["database"], { DRY_RUN: "1" }));
  assert.match(out, /"MinCapacity": 0\b/);
  assert.match(out, /"MaxCapacity": 1\b/);
  assert.match(out, /"BackupRetentionPeriod": 1\b/);
  assert.match(out, /"DeletionProtection": false/);
  assert.match(out, /db\.serverless/);
  assert.match(out, /--no-publicly-accessible/);
  assert.match(out, /--monitoring-interval 0/);
  assert.match(out, /--no-enable-performance-insights/);
  assert.match(out, /"EngineVersion": "16\.\d+"/);
});

test("a real run puts the generated password in the secret and nowhere else", () => {
  const s = sandbox();
  const r = s.run(["database"], { FAKE_NETWORK: "1" });
  assert.equal(r.status, 0, r.stderr);
  const password = "Abcdefghijklmnopqrstuvwxyz012345";
  assert.match(s.sent(), new RegExp(`postgres://graft:${password}@graft-dev-db\\.cluster-x\\.ap-south-1\\.rds\\.amazonaws\\.com:5432/graft\\?sslmode=require`));
  assert.ok(s.sent().includes(`"MasterUserPassword": "${password}"`), "the cluster is created with it");
  assert.doesNotMatch(plan(r), new RegExp(password), "never printed");
  assert.doesNotMatch(s.ledger(), new RegExp(password), "never logged");
  assert.doesNotMatch(s.calls().join("\n"), new RegExp(password), "never on a command line");
});

test("the service is one small ARM task, checked on /ready, in graft's own public subnets", () => {
  const s = sandbox();
  const out = plan(s.run(["service", "--origin", "https://example.test", "--image", "img:tag"], { DRY_RUN: "1" }));
  assert.match(out, /register-task-definition/);
  assert.match(out, /"cpuArchitecture":"ARM64"/);
  assert.match(out, /"name":"Main"/, "Express requires the container to be named Main");
  assert.match(out, /"containerPort":8080,"name":"http"/);
  assert.match(out, /"cpu":"512","memory":"1024"/);
  assert.match(out, /create-express-gateway-service/);
  assert.match(out, /--task-definition-arn/);
  assert.match(out, /minTaskCount=1,maxTaskCount=1/);
  assert.match(out, /--health-check-path \/ready/);
  assert.match(out, /GRAFT_CORS_ORIGINS/);
  assert.match(out, /https:\/\/example\.test/);
  assert.doesNotMatch(out, /GRAFT_UPLOADS/, "uploads stay off");
  const refused = s.run(["service", "--image", "img:tag"], { DRY_RUN: "1" });
  assert.notEqual(refused.status, 0, "the site's origin is required");
});

test("the release task runs on the same architecture as the service", () => {
  const out = plan(sandbox().run(["release", "--origin", "https://example.test", "--image", "img:tag"], { DRY_RUN: "1" }));
  assert.match(out, /"cpuArchitecture":"ARM64"/);
  assert.match(out, /graft-seed-chain/);
});

test("a real run records what it created in the ledger, with the id and the cost note", () => {
  const s = sandbox();
  const r = s.run(["network"]);
  assert.equal(r.status, 0, r.stderr);
  const ledger = s.ledger();
  assert.match(ledger, /vpc-0abc/);
  assert.match(ledger, /graft-dev-vpc/);
  assert.match(ledger, /\| 20\d\d-\d\d-\d\d/, "each row is timestamped");
});

test("teardown refuses without --yes, and never touches the GitHub sign-in provider", () => {
  const s = sandbox();
  const no = s.run(["teardown"], { DRY_RUN: "1" });
  assert.notEqual(no.status, 0);
  assert.deepEqual(s.changes(), []);
  const yes = plan(s.run(["teardown", "--yes"], { DRY_RUN: "1", FAKE_EXISTS: "1" }));
  assert.deepEqual(s.changes(), [], "a dry-run teardown reaches aws with no change at all");
  assert.doesNotMatch(s.calls().join("\n"), /open-id-connect-provider/i);
  assert.doesNotMatch(yes, /open-id-connect-provider/i);
  assert.match(yes, /skip.*GitHub sign-in provider|GitHub sign-in provider.*left alone/i);
  assert.match(yes, /skip-final-snapshot/);
  assert.match(yes, /force-delete-without-recovery/);
  const order = ["delete-express-gateway-service", "delete-db-instance", "delete-db-cluster", "delete-bucket", "delete-vpc"];
  const at = order.map((o) => yes.indexOf(o));
  assert.ok(at.every((i) => i >= 0), `teardown should plan every step: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "in dependency order, the network last");
});

test("status is read-only", () => {
  const s = sandbox();
  const r = s.run(["status"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.changes(), []);
});
