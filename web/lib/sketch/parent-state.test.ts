import assert from "node:assert/strict";
import { test } from "node:test";
import { copy } from "../copy.ts";
import { whyNotPublishable } from "./parent-state.ts";

const shown = (state: string, forkPermitted: boolean | null = true) => ({
  state,
  title: "t",
  author: "a",
  note: null,
  forkPermitted,
});

test("each state a parent can be in says its own reason, and an open one says none", () => {
  const c = copy.sketch.cannot;
  assert.equal(whyNotPublishable(shown("available")), null);
  assert.equal(whyNotPublishable(shown("available", null)), null);
  assert.equal(whyNotPublishable(shown("available", false)), c.closed);
  assert.equal(whyNotPublishable(shown("no_longer_here")), c.withdrawn);
  assert.equal(whyNotPublishable(shown("held")), c.held);
  assert.equal(whyNotPublishable(shown("unavailable")), c.withdrawn);
  assert.equal(whyNotPublishable(null), c.missing);
});
