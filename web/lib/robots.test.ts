import assert from "node:assert/strict";
import { test } from "node:test";
import robots from "../app/robots.ts";

test("robots.txt lets the shared pages be read and keeps the private ones out of an index", () => {
  const r = robots();
  const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
  assert.equal(rules?.userAgent, "*");
  assert.equal(rules?.allow, "/");
  assert.deepEqual(rules?.disallow, ["/admin", "/manage/", "/flips", "/api/"]);
});
