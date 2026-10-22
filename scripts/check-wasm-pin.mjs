#!/usr/bin/env node
// Renderer identity checks (ARCHITECTURE.md, "Determinism contract").
//   node scripts/check-wasm-pin.mjs <built.wasm> [--base <git-ref>]
// Fails when the built artefact's hash is not the pinned hash for the current VERSION (a changed
// hash needs a new version and a new pin), or when a previously published pin line was edited.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @returns {Map<number, string>} version to sha256, from the PINS text */
export function parsePins(text) {
  const pins = new Map();
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const match = line.match(/^(\d+) ([0-9a-f]{64})$/);
    if (!match) throw new Error(`malformed pin line: ${JSON.stringify(line)}`);
    if (pins.has(Number(match[1]))) throw new Error(`version ${match[1]} is pinned twice`);
    pins.set(Number(match[1]), match[2]);
  }
  return pins;
}

/** @returns {number} the renderer VERSION constant from the Rust source */
export function versionFromSource(source) {
  const match = source.match(/pub const VERSION: u32 = (\d+);/);
  if (!match) throw new Error("cannot find `pub const VERSION: u32` in crates/render/src/lib.rs");
  return Number(match[1]);
}

/** @returns {string[]} one message per problem */
export function checkPins({ version, builtSha, pins, basePins }) {
  const problems = [];
  const pinned = pins.get(version);
  if (pinned === undefined) {
    problems.push(`version ${version} has no pin; add the line "${version} ${builtSha}" to fixtures/renderer/PINS`);
  } else if (pinned !== builtSha) {
    problems.push(
      `built hash ${builtSha} differs from the pin for version ${version} (${pinned}); ` +
        "a changed artefact needs a new VERSION, new vectors and a new pin line",
    );
  }
  for (const [v, sha] of basePins ?? []) {
    if (pins.get(v) !== sha) problems.push(`published pin for version ${v} was changed or removed`);
  }
  return problems;
}

function main(argv) {
  const wasmPath = argv[0];
  const baseRef = argv[1] === "--base" ? argv[2] : undefined;
  if (!wasmPath) {
    console.error("usage: check-wasm-pin.mjs <built.wasm> [--base <git-ref>]");
    return 2;
  }
  const pins = parsePins(readFileSync("fixtures/renderer/PINS", "utf8"));
  let basePins;
  if (baseRef) {
    try {
      basePins = parsePins(execFileSync("git", ["show", `${baseRef}:fixtures/renderer/PINS`], { encoding: "utf8" }));
    } catch {
      basePins = undefined; // the base has no pin file yet
    }
  }
  const problems = checkPins({
    version: versionFromSource(readFileSync("crates/render/src/lib.rs", "utf8")),
    builtSha: createHash("sha256").update(readFileSync(wasmPath)).digest("hex"),
    pins,
    basePins,
  });
  for (const p of problems) console.error(`renderer pin: ${p}`);
  if (problems.length === 0) console.log("renderer pin: ok");
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
