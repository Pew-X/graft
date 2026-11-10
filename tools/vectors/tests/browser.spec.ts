// Seam 2 in the browsers: the artefact (empty import object) and the TypeScript port run the whole
// table inside Chromium, Firefox and WebKit, and the artefact's bytes are compared with the native output.
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { GraftVectors, PageResult } from "../src/browser-entry.ts";
import { failures } from "../src/run.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const here = fileURLToPath(new URL("..", import.meta.url));
const table = JSON.parse(readFileSync(join(root, "fixtures/vectors/vectors.json"), "utf8"));
const wasm = [...readFileSync(join(root, "target/wasm32-unknown-unknown/wasm/graft_render.wasm"))];
const pageJs = readFileSync(join(here, "dist/page.js"), "utf8");

/** Vectors whose output bytes are compared with the native renderer's. */
const PARITY = ["up3/2-cr", "dn2/3-cr", "sq-cr", "odd-lin", "out-cap-exact"];

/** The native renderer's output for a vector, as hex. Uses the built replay command when there is one. */
function nativeHex(vector: string): string {
  const built = join(root, "target/debug/vectors-replay");
  const [cmd, args] = existsSync(built)
    ? [built, ["--host", "native", "--emit", vector]]
    : [
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
      ];
  const run = spawnSync(cmd, args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  expect(run.status, run.stderr?.toString()).toBe(0);
  return run.stdout.toString("hex");
}

/** Index of the first byte at which two equal-length hex strings differ, or -1. */
function firstDifference(a: string, b: string): number {
  if (a.length !== b.length) return Math.min(a.length, b.length) / 2;
  for (let i = 0; i < a.length; i += 2) if (a.slice(i, i + 2) !== b.slice(i, i + 2)) return i / 2;
  return -1;
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
  await page.addScriptTag({ content: pageJs });

  const result: PageResult = await page.evaluate(
    ([t, w, p]) =>
      (window as unknown as { graftVectors: GraftVectors }).graftVectors.runAll(t, w, p),
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
  // Each kind of scenario must really have run in the artefact, not merely be absent from the table.
  for (const scenario of ["repeat-200", "growth-then-repeat", "bad-pointers"]) {
    const check = result.checks.find(
      (c) => c.host === "wasm-in-browser" && c.name === `scenario ${scenario}`,
    );
    expect(check, `${browserName}: scenario ${scenario} did not run`).toBeDefined();
  }
  expect(failures(result.checks).map((f) => `[${browserName}] ${f}`)).toEqual([]);

  // Preview parity: the bytes the browser's artefact produces equal the native renderer's, not just their hashes.
  for (const name of PARITY) {
    const browserHex = result.outputs[name] ?? "";
    expect(browserHex.length, `${browserName} produced no output for ${name}`).toBeGreaterThan(0);
    expect(
      firstDifference(browserHex, nativeHex(name)),
      `${browserName}: ${name} first differs from native at byte`,
    ).toBe(-1);
  }
});
