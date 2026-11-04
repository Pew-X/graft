// What is sent when a maker publishes their own recording: the canonical bytes as base64, the
// declaration word for word as the service expects it, and nothing else about the person.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DECLARATION_TEXT, MAX_FRAMES, checkTrim, sourceBody, toBase64 } from "./source.ts";

test("the declaration is exactly the text the service checks against", () => {
  const rust = readFileSync(new URL("../../../crates/api/src/source.rs", import.meta.url), "utf8");
  const match = rust.match(/pub const DECLARATION_TEXT: &str = "(.*)";/);
  assert.ok(match, "the service names its declaration text");
  assert.equal(DECLARATION_TEXT, match[1]!.replace(/\\"/g, '"'));
});

test("the declaration says the sound must not hold anyone's private conversation", () => {
  assert.match(DECLARATION_TEXT, /private conversation/);
});

test("base64 of canonical audio is of the little-endian bytes, whatever the machine", () => {
  assert.equal(toBase64(Int16Array.of(1, -2, 258)), "AQD+/wIB");
  assert.equal(toBase64(new Int16Array(0)), "");
});

test("a long recording encodes without running out of call depth", () => {
  const long = new Int16Array(1_440_000).fill(1234);
  const text = toBase64(long);
  assert.equal(text.length, Math.ceil((1_440_000 * 2) / 3) * 4);
  assert.equal(Buffer.from(text, "base64").length, 2_880_000);
});

test("the body carries the audio, the title, the name, the retry key and the declaration, and no more", () => {
  const body = sourceBody({
    samples: Int16Array.of(1, 2, 3),
    title: "my door",
    author: "pat",
    retryKey: "web-0123456789abcdef",
    basis: "own_recording",
  });
  assert.deepEqual(Object.keys(body).sort(), [
    "audio",
    "author",
    "declaration",
    "retry_key",
    "title",
  ]);
  assert.deepEqual(body.declaration, { statement: DECLARATION_TEXT, basis: "own_recording" });
  assert.equal(body.audio, toBase64(Int16Array.of(1, 2, 3)));
});

test("a region to keep is refused when it is under 480 frames, over 30 seconds, backwards or outside", () => {
  assert.equal(MAX_FRAMES, 1_440_000);
  assert.equal(checkTrim({ start: 0, end: 1_440_000 }, 2_000_000), null);
  assert.equal(checkTrim({ start: 0, end: 1_440_001 }, 2_000_000)?.kind, "cutLong");
  assert.equal(checkTrim({ start: 0, end: 479 }, 2_000_000)?.kind, "cutShort");
  assert.equal(checkTrim({ start: 900, end: 100 }, 2_000_000)?.kind, "cutInverted");
  assert.equal(checkTrim({ start: 0, end: 3_000_000 }, 2_000_000)?.kind, "cutOutside");
});
