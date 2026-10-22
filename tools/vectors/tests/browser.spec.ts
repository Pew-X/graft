// Seam 2 in the browsers: the artefact (empty import object) and the TypeScript port run the whole
// table inside Chromium, Firefox and WebKit, and the artefact's bytes are compared with the native output.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PageResult } from "../src/browser-entry.ts";
import { failures } from "../src/run.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const table = JSON.parse(readFileSync(`${root}fixtures/vectors/vectors.json`, "utf8"));
const wasm = [...readFileSync(`${root}target/wasm32-unknown-unknown/wasm/graft_render.wasm`)];
const page_js = readFileSync(new URL("../dist/page.js", import.meta.url), "utf8");

/** Vectors whose output bytes are compared with the native renderer's. */
const PARITY = ["up3/2-cr", "dn2/3-cr", "sq-cr", "odd-lin", "out-cap-exact"];

function nativeHex(vector: string): string {
  const run = spawnSync(
    "cargo",
    [
      "run",
      "-q",
      "-p",
      "graft-vectors",
      "--bin",
      "vectors-replay",
      "--",
      "--host",
      "native",
      "--emit",
      vector,
    ],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  expect(run.status, run.stderr?.toString()).toBe(0);
  return run.stdout.toString("hex");
}

test("the whole table passes in the browser, for the artefact and for the TypeScript port", async ({
  page,
  browserName,
}) => {
  // http://localhost is a secure context, so SubtleCrypto is available; nothing is actually served.
  await page.route("http://localhost:4173/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>vectors</title>" }),
  );
  await page.goto("http://localhost:4173/");
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  await page.addScriptTag({ content: page_js });

  const result: PageResult = await page.evaluate(
    ([t, w, p]) =>
      (
        window as unknown as {
          graftVectors: { runAll(t: unknown, w: number[], p: string[]): Promise<PageResult> };
        }
      ).graftVectors.runAll(t, w, p),
    [table, wasm, PARITY] as const,
  );
  test
    .info()
    .annotations.push({ type: "browser", description: `${browserName}: ${result.userAgent}` });

  expect(result.checks.length).toBeGreaterThan(150);
  const hosts = new Set(result.checks.map((c) => c.host));
  expect([...hosts].sort()).toEqual(["typescript-port", "wasm-in-browser"]);
  // The pointer scenario must really have run for the artefact (including the trap), not been skipped.
  const pointers = result.checks.find(
    (c) => c.host === "wasm-in-browser" && c.name === "scenario bad-pointers",
  );
  expect(pointers?.actual).toBe("every pointer case as expected");
  expect(failures(result.checks).map((f) => `[${browserName}] ${f}`)).toEqual([]);

  // Preview parity: the bytes the browser's artefact produces equal the native renderer's, not just their hashes.
  for (const name of PARITY) {
    expect(result.outputs[name], `${browserName} produced no output for ${name}`).toBeDefined();
    expect(
      result.outputs[name] === nativeHex(name),
      `${browserName}: ${name} differs from native`,
    ).toBe(true);
  }
});
