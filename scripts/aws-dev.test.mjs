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
  *describe-db-clusters*DBClusterIdentifier*) [ -z "$FAKE_CLUSTER" ] || echo "graft-dev-db" ;;
  *describe-services*PRIMARY*taskDefinition*) cat "${dir}/td-primary" 2>/dev/null || echo "arn:td/old:1" ;;
  *describe-services*PRIMARY*rolloutState*) echo "COMPLETED" ;;
  *describe-task-definition*) echo '{"taskDefinitionArn":"arn:td/old:1","revision":1,"status":"ACTIVE","family":"graft-dev-service","containerDefinitions":[{"name":"Main","image":"old:image"}]}' ;;
  *register-task-definition*) echo "arn:td/new:2" ;;
  *describe-express-gateway-service*endpoint*) echo "https://svc.test" ;;
  *describe-express-gateway-service*statusCode*) if [ -n "$FAKE_SERVICE_STATUS" ]; then echo "$FAKE_SERVICE_STATUS"; elif [ -n "$FAKE_EXISTS" ]; then echo "res-0abc"; fi ;;
  *describe-subnets*|*describe-security-groups*) [ -z "$FAKE_NETWORK$FAKE_EXISTS" ] || echo "net-0abc" ;;
  *describe-*|*list-*) [ -z "$FAKE_EXISTS" ] || echo "res-0abc" ;;
esac
# an update the service accepts makes that revision the primary one, unless the roll is stalled
if [ -z "$FAKE_STALL" ]; then prev=""; for a in "$@"; do [ "$prev" = "--task-definition-arn" ] && echo "$a" > "${dir}/td-primary"; prev="$a"; done; fi
# keep what any file:// argument held, to check what would have been sent
for a in "$@"; do case "$a" in file://*) cat "\${a#file://}" >> "${dir}/files.log"; echo >> "${dir}/files.log" ;; esac; done
exit 0
`,
  );
  chmodSync(join(dir, "aws"), 0o755);
  // a service that answers: the readiness probe asks curl for the status code
  writeFileSync(join(dir, "curl"), "#!/bin/sh\necho 200\n");
  chmodSync(join(dir, "curl"), 0o755);
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

test("status is read-only, and an empty account is not alarming", () => {
  const s = sandbox();
  const r = s.run(["status"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.changes(), []);
  assert.doesNotMatch(r.stdout, /^WARN/m);
  assert.match(r.stdout, /nothing unexpected/);
});

test("status warns about an address attached to nothing, not about the load balancer's own", () => {
  const s = sandbox();
  const r = s.run(["status"], { FAKE_EXISTS: "1" });
  assert.match(r.stdout, /^WARN\s+Elastic IPs attached to nothing/m);
  const addresses = s.calls().filter((c) => c.includes("describe-addresses"));
  assert.ok(addresses.every((c) => c.includes("AssociationId==`null`") || !c.includes("--query")), "only unattached addresses are queried");
});

test("park stops the task so the database can pause, and unpark brings the one task back", () => {
  const s = sandbox();
  const park = plan(s.run(["park"], { DRY_RUN: "1" }));
  assert.match(park, /update-express-gateway-service .*--scaling-target minTaskCount=0,maxTaskCount=0,autoScalingMetric=AVERAGE_CPU,autoScalingTargetValue=60/, "the update call needs the target value too");
  const unpark = plan(s.run(["unpark"], { DRY_RUN: "1" }));
  assert.match(unpark, /update-express-gateway-service .*--scaling-target minTaskCount=1,maxTaskCount=1,autoScalingMetric=AVERAGE_CPU,autoScalingTargetValue=60/);
  assert.doesNotMatch(unpark, /maxTaskCount=[2-9]/, "never more than one task");
  assert.deepEqual(s.changes(), [], "a dry run changes nothing");
});

test("the load copy is a separate database, a separate service and its own blob prefix, with the caps lifted only there", () => {
  const s = sandbox();
  const up = plan(s.run(["load-up", "--origin", "https://example.test", "--image", "img:tag"], { DRY_RUN: "1" }));
  assert.match(up, /CREATE DATABASE graft_load/);
  assert.match(up, /public\.ecr\.aws\/docker\/library\/postgres/);
  assert.match(up, /create-secret --name graft-dev\/load-database-url/);
  assert.match(up, /"family":"graft-dev-release-load"/);
  assert.match(up, /load-database-url/);
  assert.match(up, /"GRAFT_BLOB_S3_PREFIX","value":"audio\/load\/"/);
  assert.match(up, /create-express-gateway-service --service-name graft-dev-load\b/);
  assert.match(up, /minTaskCount=1,maxTaskCount=1/);
  assert.match(up, /GRAFT_PUBLISH_PER_IP/, "the limits are lifted for the measurement, and the run says so");
  assert.doesNotMatch(up, /GRAFT_UPLOADS/, "uploads stay off");
  assert.match(up, /"secrets":\[\{"name":"GRAFT_DATABASE_URL","valueFrom":"<load-database-url-arn>"/, "the copy's tasks read the copy's secret, not the live one");
  const live = plan(s.run(["service", "--origin", "https://example.test", "--image", "img:tag"], { DRY_RUN: "1" }));
  assert.doesNotMatch(live, /GRAFT_PUBLISH_PER_IP/, "the live service keeps its defaults");
  assert.deepEqual(s.changes(), []);
});

test("taking the load copy down removes only what it made", () => {
  const s = sandbox();
  const no = s.run(["load-down"], { DRY_RUN: "1" });
  assert.notEqual(no.status, 0, "needs --yes");
  const down = plan(s.run(["load-down", "--yes"], { DRY_RUN: "1", FAKE_EXISTS: "1" }));
  assert.match(down, /delete-express-gateway-service --service-arn \S+service\/graft-dev\/graft-dev-load/);
  assert.match(down, /DROP DATABASE IF EXISTS graft_load/);
  assert.match(down, /delete-secret --secret-id graft-dev\/load-database-url/);
  assert.match(down, /s3 rm s3:\/\/\S+\/audio\/load\/ --recursive/);
  assert.doesNotMatch(down, /delete-bucket|delete-db|delete-vpc|graft-dev\/database-url|graft-dev\/admin-secret|service\/graft-dev\/graft-dev\b(?!-load)/);
  assert.deepEqual(s.changes(), []);
});

test("service refuses to create over a service that already exists", () => {
  const s = sandbox();
  const r = s.run(["service", "--origin", "https://example.test", "--image", "img:tag"], { FAKE_EXISTS: "1" });
  assert.notEqual(r.status, 0);
  assert.match(plan(r), /already exists.*redeploy/);
  assert.deepEqual(s.changes(), [], "nothing is created or changed");
});

test("redeploy swaps only the image of the running task definition, through the Express update, and says how it would roll back", () => {
  const s = sandbox();
  const out = plan(s.run(["redeploy", "--image", "img:new"], { DRY_RUN: "1", FAKE_EXISTS: "1" }));
  assert.match(out, /register-task-definition/);
  assert.match(out, /img:new/);
  assert.match(out, /update-express-gateway-service --service-arn \S+service\/graft-dev\/graft-dev --task-definition-arn/);
  assert.doesNotMatch(out, /create-express-gateway-service/, "an existing service is updated, never created");
  assert.doesNotMatch(out, /GRAFT_CORS_ORIGINS/, "settings are inherited from the running revision, not rewritten");
  assert.match(out, /rolled back to/);
  // An Express service has no task definition on the service itself: the running revision is the
  // primary deployment's. Reading the service's own field returns None (found on the live service).
  const asked = s.calls().find((c) => c.includes("describe-services") && c.includes("taskDefinition")) ?? "";
  assert.match(asked, /deployments\[\?status==.PRIMARY.\]\.taskDefinition/, "reads the primary deployment");
  assert.notEqual(s.run(["redeploy"], { DRY_RUN: "1" }).status, 0, "needs --image");
  assert.deepEqual(s.changes(), []);
});

test("a database that exists but whose URL secret was never stored gets a new password and its secret, not a skip", () => {
  const s = sandbox();
  const r = s.run(["database"], { FAKE_NETWORK: "1", FAKE_CLUSTER: "1" });
  assert.equal(r.status, 0, r.stderr);
  const calls = s.calls().join("\n");
  assert.doesNotMatch(calls, /create-db-cluster/, "the cluster is not created again");
  assert.match(calls, /modify-db-cluster/, "the password the lost run generated is replaced");
  assert.match(calls, /create-secret --name graft-dev\/database-url/);
  const password = "Abcdefghijklmnopqrstuvwxyz012345";
  assert.match(s.sent(), new RegExp(`postgres://graft:${password}@graft-dev-db\\.cluster-x`), "the secret holds the new password");
  assert.ok(s.sent().includes(`"MasterUserPassword": "${password}"`), "and the cluster got the same one");
  assert.doesNotMatch(plan(r), new RegExp(password));
  assert.doesNotMatch(s.ledger(), new RegExp(password));
  assert.doesNotMatch(calls, new RegExp(password), "never on a command line");
});

test("teardown also removes the load copy, so nothing keeps billing and the cluster can go", () => {
  const out = plan(sandbox().run(["teardown", "--yes"], { DRY_RUN: "1", FAKE_EXISTS: "1" }));
  assert.match(out, /delete-express-gateway-service --service-arn \S+service\/graft-dev\/graft-dev-load/);
  assert.match(out, /delete-secret --secret-id graft-dev\/load-database-url/);
  assert.ok(
    out.indexOf("graft-dev-load") < out.indexOf("delete-cluster"),
    "the load service goes before the cluster is deleted",
  );
});

test("status looks at every service in the cluster, not only the live one", () => {
  const s = sandbox();
  const r = s.run(["status"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(s.calls().some((c) => c.includes("ecs list-services")), "it lists the cluster's services");
});

test("a deleted service does not block creating it again, and a live one does", () => {
  const args = ["service", "--origin", "https://example.test", "--image", "img:tag"];
  for (const gone of ["INACTIVE", "DRAINING"]) {
    const r = sandbox().run(args, { DRY_RUN: "1", FAKE_SERVICE_STATUS: gone });
    assert.equal(r.status, 0, `${gone}: ${r.stderr}`);
    assert.match(plan(r), /create-express-gateway-service/);
  }
  const live = sandbox().run(args, { DRY_RUN: "1", FAKE_SERVICE_STATUS: "ACTIVE" });
  assert.notEqual(live.status, 0);
  assert.match(plan(live), /already exists/);
});

test("redeploy calls the roll ready only once the NEW revision is the primary one and answers", () => {
  const s = sandbox();
  const r = s.run(["redeploy", "--image", "img:new"], { GRAFT_READY_WAIT_SECS: "20", GRAFT_READY_POLL_SECS: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(plan(r), /ready on the new revision/);
  const updates = s.calls().filter((c) => c.includes("update-express-gateway-service"));
  assert.equal(updates.length, 1, "one update, no rollback");
  assert.match(updates[0], /--task-definition-arn arn:td\/new:2/);
  assert.match(s.ledger(), /redeploy finished, ready/);
});

test("redeploy rolls back to the previous revision when the new one never becomes primary, and fails", () => {
  const s = sandbox();
  const r = s.run(["redeploy", "--image", "img:new"], {
    FAKE_STALL: "1",
    GRAFT_READY_WAIT_SECS: "3",
    GRAFT_READY_POLL_SECS: "1",
  });
  assert.notEqual(r.status, 0, "a roll that never completes is a failure");
  assert.match(plan(r), /did not become ready/);
  const updates = s.calls().filter((c) => c.includes("update-express-gateway-service"));
  assert.equal(updates.length, 2, "the update, then the rollback");
  assert.match(updates[1], /--task-definition-arn arn:td\/old:1/, "back to the revision that was running");
  assert.doesNotMatch(plan(r), /ready on the new revision/, "never claims it worked");
});
