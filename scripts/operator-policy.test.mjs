// The operator role's permission files. The files hold the account id, so they are never committed (they live in
// .deploy/iam/ on the operator's machine, or where GRAFT_OPERATOR_POLICY_DIR points): the rules below always run on small stand-in policies (so the check itself is
// tested), and run on the real files when they are on this machine. They pin what the role may never
// be able to do: act outside Mumbai (the one budget excepted), touch anything outside graft, or change its
// own permissions.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const policyDir = (process.env["GRAFT_OPERATOR_POLICY_DIR"] ?? new URL("../.deploy/iam", import.meta.url).pathname).replace(/\/?$/, "/");

// Actions that cannot be scoped to a resource; they may sit on "*" only if they only read or list.
const UNSCOPED_OK = /^(ec2:Describe|lambda:ListFunctions$|s3:ListAllMyBuckets$|ecr:GetAuthorizationToken$|iam:(Get|List)|kms:(DescribeKey|ListAliases)$|secretsmanager:(GetRandomPassword|ListSecrets)$)/;
// The only service whose API is global, so it carries no region condition.
const GLOBAL_OK = /^budgets:/;
const SELF = "arn:aws:iam::123456789012:role/graft-operator";

const list = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

function globMatches(pattern, text) {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return re.test(text);
}

/** What is wrong with the allow statements of these policies together, as readable sentences. */
export function problems(policies) {
  const out = [];
  for (const policy of policies) {
    for (const s of policy.Statement) {
      if (s.Effect !== "Allow") continue;
      const actions = list(s.Action);
      const resources = list(s.Resource);
      const where = s.Sid ?? "(no sid)";
      for (const a of actions) {
        if (a === "*" || a.endsWith(":*") && /^(iam|lambda|budgets|sts|organizations|account):/.test(a)) {
          out.push(`${where}: ${a} is a wildcard on a service that must be listed by action`);
        }
        if (/^iam:(Put|Attach|Create|Update|Delete)(User|Group|AccessKey|LoginProfile)/.test(a)) {
          out.push(`${where}: ${a} changes people or keys`);
        }
        if (/^sts:/.test(a)) out.push(`${where}: ${a} lets the role move to another role`);
      }
      if (resources.includes("*")) {
        for (const a of actions) {
          if (!UNSCOPED_OK.test(a) && !/^[a-z-]+:\*$/.test(a)) {
            out.push(`${where}: ${a} is on every resource`);
          }
        }
      }
      const region = s.Condition?.StringEquals?.["aws:RequestedRegion"];
      const global = actions.length > 0 && actions.every((a) => GLOBAL_OK.test(a));
      const bound = Object.keys(s.Condition ?? {}).length > 0;
      // IAM is global (a pass of one role carries its own condition); everything else must name Mumbai
      const iamOnly = actions.length > 0 && actions.every((a) => a.startsWith("iam:"));
      if (!global && !iamOnly && region === undefined) out.push(`${where}: no region condition`);
      if (!global && !bound) out.push(`${where}: no condition at all`);
      if (region !== undefined && region !== "ap-south-1") out.push(`${where}: allows ${region}`);
      if (global && resources.some((r) => !r.includes(":budget/graft-"))) {
        out.push(`${where}: a budget statement that is not the project's own budget`);
      }
      // the role must not be able to rewrite itself
      const writes = actions.some((a) =>
        /^iam:(PutRolePolicy|AttachRolePolicy|UpdateAssumeRolePolicy|DeleteRolePolicy|PutRolePermissionsBoundary|CreatePolicyVersion)$/.test(a),
      );
      if (writes && resources.some((r) => globMatches(r, SELF))) {
        out.push(`${where}: could change the operator role's own permissions`);
      }
      for (const a of actions) {
        if (
          /^iam:(Attach|Put)RolePolicy$/.test(a) &&
          list(s.Condition?.ArnLike?.["iam:PolicyARN"]).some((p) => /AdministratorAccess|PowerUserAccess|IAMFullAccess/.test(p))
        ) {
          out.push(`${where}: attaches an admin policy`);
        }
      }
    }
  }
  return out;
}

const fine = {
  Statement: [
    {
      Sid: "Fn",
      Effect: "Allow",
      Action: ["lambda:GetFunction", "lambda:AddPermission"],
      Resource: "arn:aws:lambda:ap-south-1:123456789012:function:graft-dev-*",
      Condition: { StringEquals: { "aws:RequestedRegion": "ap-south-1" } },
    },
    {
      Sid: "Budget",
      Effect: "Allow",
      Action: ["budgets:ViewBudget", "budgets:ModifyBudget"],
      Resource: "arn:aws:budgets::123456789012:budget/graft-dev-month",
    },
  ],
};

test("a policy that only adds scoped Mumbai functions and the one budget has nothing wrong", () => {
  assert.deepEqual(problems([fine]), []);
});

test("every way of widening the role is caught", () => {
  const bad = (statement) => problems([{ Statement: [{ Effect: "Allow", Sid: "x", ...statement }] }]);
  const region = { StringEquals: { "aws:RequestedRegion": "ap-south-1" } };
  assert.match(bad({ Action: "lambda:*", Resource: "arn:aws:lambda:ap-south-1:1:function:graft-dev-*", Condition: region })[0], /wildcard/);
  assert.match(bad({ Action: "lambda:InvokeFunction", Resource: "*", Condition: region })[0], /every resource/);
  assert.match(bad({ Action: "lambda:GetFunction", Resource: "arn:aws:lambda:ap-south-1:1:function:graft-dev-*" })[0], /no region condition/);
  assert.match(
    bad({ Action: "lambda:GetFunction", Resource: "arn:aws:lambda:us-east-1:1:function:graft-dev-*", Condition: { StringEquals: { "aws:RequestedRegion": "us-east-1" } } })[0],
    /allows us-east-1/,
  );
  assert.match(bad({ Action: "budgets:ModifyBudget", Resource: "arn:aws:budgets::1:budget/other-team" })[0], /not the project's own/);
  assert.match(bad({ Action: "iam:PutRolePolicy", Resource: SELF, Condition: region })[0], /own permissions/);
  assert.match(bad({ Action: "iam:PutRolePolicy", Resource: "arn:aws:iam::123456789012:role/*", Condition: region }).join("\n"), /own permissions/);
  assert.match(bad({ Action: "iam:CreateAccessKey", Resource: "arn:aws:iam::1:user/x", Condition: region })[0], /people or keys/);
  assert.match(bad({ Action: "sts:AssumeRole", Resource: "arn:aws:iam::1:role/graft-dev-x", Condition: region })[0], /another role/);
  assert.match(
    bad({ Action: "iam:AttachRolePolicy", Resource: "arn:aws:iam::123456789012:role/graft-dev-*", Condition: { ArnLike: { "iam:PolicyARN": "arn:aws:iam::aws:policy/AdministratorAccess" } } })[0],
    /admin policy/,
  );
});

const named = existsSync(policyDir) ? readdirSync(policyDir).filter((f) => f.endsWith(".json") && /permissions|wake/.test(f)) : [];
const real = Object.fromEntries(named.map((f) => [f, JSON.parse(readFileSync(`${policyDir}${f}`, "utf8"))]));
// The files name the real account; the self-check names AWS's example one, so the real id is swapped for it.
const example = (policy) =>
  JSON.parse(JSON.stringify(policy).replace(/(arn:aws:[a-z0-9-]*:[a-z0-9-]*:)\d{12}:/g, "$1123456789012:"));
const wake = Object.entries(real).find(([f]) => f.includes("wake"))?.[1];
const absent = (why) => (why ? { skip: why } : {});

test(
  "the wake permissions add only scoped Mumbai functions, the wake role's pass and the one budget",
  absent(wake === undefined && "the real policy files are not on this machine"),
  () => assert.deepEqual(problems([example(wake)]), []),
);

test(
  "no file of the operator's permissions lets the role change its own",
  absent(named.length === 0 && "the real policy files are not on this machine"),
  () => {
    const all = Object.values(real).map(example);
    assert.deepEqual(problems(all).filter((p) => /own permissions|admin policy|people or keys/.test(p)), []);
  },
);
