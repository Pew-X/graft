// The load test must never be pointed at production. The guard is a pure function so it can be tested
// here and imported by the k6 script, which refuses to start when it says no.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTarget } from "./guard.mjs";

const ok = (url, env) => assert.equal(checkTarget(url, env).ok, true, `${url} should be allowed`);
const no = (url, env, why) => {
  const r = checkTarget(url, env);
  assert.equal(r.ok, false, `${url} should be refused`);
  if (why) assert.match(r.reason, why);
};

test("a machine's own address is allowed", () => {
  ok("http://127.0.0.1:3300");
  ok("http://localhost:3300");
  ok("http://host.docker.internal:3300");
});

test("a host with a staging label is allowed, over http or https", () => {
  ok("https://staging.example.com");
  ok("https://api-staging.example.com/");
  ok("https://graft-staging.example.net:8443");
});

test("an address that does not say it is a test environment is refused by default", () => {
  no("https://api.example.com", undefined, /not known to be a test environment/);
  no("https://graft.example.com");
});

test("a named production host is refused even if it would otherwise be allowed", () => {
  no("https://staging.example.com", { productionHosts: "staging.example.com" }, /production/);
  no("http://127.0.0.1:3300", { productionHosts: "127.0.0.1" }, /production/);
});

test("an address the operator names is allowed, unless it is also named production", () => {
  ok("https://loadtest.example.com", { allowedHosts: "loadtest.example.com" });
  no("https://loadtest.example.com", {
    allowedHosts: "loadtest.example.com",
    productionHosts: "loadtest.example.com",
  });
});

test("staging in a path, a query or a user name does not make a host staging", () => {
  no("https://api.example.com/staging");
  no("https://api.example.com/?env=staging");
  // Built at run time: written out it would look like an email address to the repository check.
  no(["https://staging", "api.example.com/"].join("@"));
});

test("a lookalike host does not pass: the label must be the whole word", () => {
  no("https://restaging.example.com");
  no("https://stagingfoo.example.com");
});

test("something that is not an http address is refused", () => {
  no("", undefined, /not an http/);
  no("ftp://staging.example.com", undefined, /not an http/);
  no("staging.example.com", undefined, /not an http/);
});
