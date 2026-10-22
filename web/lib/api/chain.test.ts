import assert from "node:assert/strict";
import { test } from "node:test";
import { entryLabels, fetchChain, createApi, type Chain } from "./chain.ts";

const stage = (title: string): Chain["stages"][number] => ({
  state: "available",
  id: "aaaaaaaaaaaa",
  kind: "source",
  title,
  author: "a maker",
  created_at_ms: 0,
  flipped_count: 0,
  fork_permitted: true,
  lines: [],
  details: {
    record_id: "",
    source_blob: "",
    output_blob: "",
    cut: { start: 0, end: 1 },
    renderer: { name: "graft-render", version: 1, wasm_sha256: "" },
  },
  audio: { url: "memory://x", expires_in_secs: 300 },
});

test("a missing parent reads as unavailable and the chain is not shortened", () => {
  const chain: Chain = {
    stages: [{ state: "unavailable", id: "bbbbbbbbbbbb" }, stage("slower")],
  };
  assert.deepEqual(entryLabels(chain), ["unavailable", "slower"]);
});

test("a hidden stage keeps its credit and is marked as no longer here", () => {
  const chain: Chain = {
    stages: [
      stage("a door"),
      {
        state: "no_longer_here",
        id: "cccccccccccc",
        kind: "flip",
        reason: "withdrawn",
        title: "slower",
        author: "jo",
        created_at_ms: 0,
        lines: [],
      },
      stage("slower still"),
    ],
  };
  assert.deepEqual(entryLabels(chain), ["a door", "slower (no longer here)", "slower still"]);
});

test("a 404 from the service is a missing chain, not an error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        type: "urn:graft:problem:not-found",
        title: "Not found",
        status: 404,
        detail: "no",
      }),
      {
        status: 404,
        headers: { "content-type": "application/problem+json" },
      },
    );
  try {
    assert.equal(await fetchChain(createApi("http://localhost"), "zzzzzzzzzzzz"), null);
  } finally {
    globalThis.fetch = original;
  }
});

test("a server failure throws with the problem's own words", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        type: "urn:graft:problem:internal",
        title: "Something went wrong",
        status: 500,
        detail: "the service failed to answer",
      }),
      {
        status: 500,
        headers: { "content-type": "application/problem+json" },
      },
    );
  try {
    await assert.rejects(
      fetchChain(createApi("http://localhost"), "zzzzzzzzzzzz"),
      /failed to answer/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
