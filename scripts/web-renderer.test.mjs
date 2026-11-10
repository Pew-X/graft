import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parsePins, versionFromSource } from "./check-wasm-pin.mjs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url));

test("the renderer the web app serves is the pinned artefact of the current version, byte for byte", () => {
  const version = versionFromSource(read("crates/render/src/lib.rs").toString("utf8"));
  const pinned = parsePins(read("fixtures/renderer/PINS").toString("utf8")).get(version);
  assert.ok(pinned, `version ${version} has a pin`);
  const served = read(`web/public/renderer/v${version}.wasm`);
  assert.equal(
    createHash("sha256").update(served).digest("hex"),
    pinned,
    `web/public/renderer/v${version}.wasm is not the pinned artefact: copy target/wasm32-unknown-unknown/wasm/graft_render.wasm to it after building`,
  );
});
