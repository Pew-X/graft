import assert from "node:assert/strict";
import { test } from "node:test";
import { newRetryKey } from "./retry-key.ts";

test("a retry key is 16 to 128 characters from the set the service accepts", () => {
  for (let i = 0; i < 50; i++) {
    const key = newRetryKey();
    assert.match(key, /^[A-Za-z0-9._:-]{16,128}$/);
  }
});

test("keys do not repeat: a new attempt is never mistaken for a retry of an old one", () => {
  const keys = new Set(Array.from({ length: 500 }, newRetryKey));
  assert.equal(keys.size, 500);
});

test("the key says nothing about the maker, the sound or the time", () => {
  const key = newRetryKey();
  assert.ok(!key.includes(String(new Date().getFullYear())));
});
