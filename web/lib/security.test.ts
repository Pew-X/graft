// The headers the site sends on every page. Each test names the guarantee it protects.
import assert from "node:assert/strict";
import { test } from "node:test";
import config from "../next.config.ts";
import { contentSecurityPolicy, securityHeaders } from "./security.ts";

const directive = (policy: string, name: string): string[] =>
  (
    policy
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `)) ?? ""
  )
    .split(/\s+/)
    .slice(1);

test("nothing may frame the site, embed it as an object, or change where its links point", () => {
  const policy = contentSecurityPolicy({ production: true });
  assert.deepEqual(directive(policy, "frame-ancestors"), ["'none'"]);
  assert.deepEqual(directive(policy, "object-src"), ["'none'"]);
  assert.deepEqual(directive(policy, "base-uri"), ["'none'"]);
  assert.deepEqual(directive(policy, "form-action"), ["'self'"]);
  assert.deepEqual(directive(policy, "default-src"), ["'self'"]);
});

test("the page may talk to itself and to exactly the origins it is told about, and no others", () => {
  const policy = contentSecurityPolicy({
    production: true,
    connectOrigins: "https://api.example.test, http://127.0.0.1:59000",
  });
  assert.deepEqual(directive(policy, "connect-src"), [
    "'self'",
    "https://api.example.test",
    "http://127.0.0.1:59000",
  ]);
  assert.doesNotMatch(policy, /\*/, "no wildcard anywhere");
  assert.deepEqual(directive(contentSecurityPolicy({ production: true }), "connect-src"), [
    "'self'",
  ]);
});

test("an origin that is not an origin is refused when the site is built, not ignored", () => {
  for (const bad of [
    "api.example.test",
    "https://api.example.test/path",
    "javascript:alert(1)",
    "https://*.example.test",
    "https://a.example.test; script-src *",
    "https://a.example.test https://b.example.test",
    "ftp://files.example.test",
  ]) {
    assert.throws(
      () => contentSecurityPolicy({ production: true, connectOrigins: bad }),
      /origin/,
      bad,
    );
  }
});

test("scripts may not be evaluated from strings in production; development needs it for reloading", () => {
  assert.ok(
    !directive(contentSecurityPolicy({ production: true }), "script-src").includes("'unsafe-eval'"),
  );
  assert.ok(
    directive(contentSecurityPolicy({ production: false }), "script-src").includes("'unsafe-eval'"),
  );
  assert.ok(
    directive(contentSecurityPolicy({ production: true }), "script-src").includes("'self'"),
  );
});

test("a production page is only ever loaded securely", () => {
  assert.match(contentSecurityPolicy({ production: true }), /upgrade-insecure-requests/);
  assert.doesNotMatch(contentSecurityPolicy({ production: false }), /upgrade-insecure-requests/);
});

test("every page carries the policy, secure transport, no sniffing, no referrer and a narrow device policy", () => {
  const headers = Object.fromEntries(
    securityHeaders({ production: true }).map((h) => [h.key.toLowerCase(), h.value]),
  );
  assert.match(headers["content-security-policy"]!, /frame-ancestors 'none'/);
  assert.match(headers["strict-transport-security"]!, /^max-age=\d{8,}; includeSubDomains$/);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["referrer-policy"], "no-referrer");
  // The microphone is for the maker's own recording later; nothing else on the device is asked for.
  assert.equal(headers["permissions-policy"], "camera=(), geolocation=(), microphone=(self)");
});

test("the site's configuration applies those headers to every path", async () => {
  const rules = await config.headers!();
  const all = rules.find((r) => r.source === "/:path*");
  assert.ok(all, "a rule covers every path");
  assert.ok(all.headers.some((h) => h.key.toLowerCase() === "content-security-policy"));
});
