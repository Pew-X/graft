import assert from "node:assert/strict";
import { test } from "node:test";
import type { Chain } from "../api/chain.ts";
import { liveLoader } from "./audio.ts";
import { HttpError } from "./pcm.ts";

const available = (id: string, url: string) => ({ state: "available", id, audio: { url } });
const chainOf = (round: number): Chain =>
  ({
    stages: [
      available("a", `https://blobs.example/a?round=${round}`),
      { state: "no_longer_here", id: "b" },
      { state: "held", id: "c" },
      available("d", `https://blobs.example/d?round=${round}`),
    ],
    truncated: null,
  }) as unknown as Chain;

const pcmFor = (url: string): Int16Array => Int16Array.from([url.length]);

test("audio is fetched for the stages that can be heard, and for no others", async () => {
  const asked: string[] = [];
  const load = liveLoader({
    chain: async () => chainOf(1),
    pcm: async (url) => {
      asked.push(url);
      return pcmFor(url);
    },
  });
  const out = await load(new AbortController().signal);
  assert.deepEqual(asked, ["https://blobs.example/a?round=1", "https://blobs.example/d?round=1"]);
  assert.equal(out.length, 4);
  assert.deepEqual([out[0] !== null, out[1], out[2], out[3] !== null], [true, null, null, true]);
});

test("an address that expired mid-session is replaced by a fresh one, and the visitor sees nothing", async () => {
  let rounds = 0;
  const asked: string[] = [];
  const load = liveLoader({
    chain: async () => chainOf(++rounds),
    pcm: async (url) => {
      asked.push(url);
      if (url.includes("/d?round=1")) throw new HttpError(403);
      return pcmFor(url);
    },
  });
  const out = await load(new AbortController().signal);
  assert.equal(rounds, 2, "the chain was asked for again to get fresh addresses");
  assert.equal(asked.at(-1), "https://blobs.example/d?round=2");
  assert.ok(out[3] !== null);
});

test("a stage that keeps failing is an error, not a silent gap", async () => {
  const load = liveLoader({
    chain: async () => chainOf(1),
    pcm: async () => {
      throw new HttpError(403);
    },
  });
  await assert.rejects(load(new AbortController().signal), HttpError);
});

test("a failure that is not an expiry is not retried", async () => {
  let rounds = 0;
  const load = liveLoader({
    chain: async () => chainOf(++rounds),
    pcm: async () => {
      throw new HttpError(500);
    },
  });
  await assert.rejects(load(new AbortController().signal), HttpError);
  assert.equal(rounds, 1);
});

test("a chain that is no longer there is an error", async () => {
  const load = liveLoader({ chain: async () => null, pcm: async () => new Int16Array(0) });
  await assert.rejects(load(new AbortController().signal));
});

test("many addresses expiring together cost one fresh read of the chain, not one each", async () => {
  let rounds = 0;
  const many = (round: number): Chain =>
    ({
      stages: Array.from({ length: 8 }, (_, i) =>
        available(`s${i}`, `https://blobs.example/s${i}?round=${round}`),
      ),
      truncated: null,
    }) as unknown as Chain;
  const load = liveLoader({
    chain: async () => many(++rounds),
    pcm: async (url) => {
      if (url.includes("round=1")) throw new HttpError(403);
      return pcmFor(url);
    },
  });
  const out = await load(new AbortController().signal);
  assert.equal(rounds, 2, "the first read, and one shared refresh");
  assert.ok(out.every((pcm) => pcm !== null));
});
