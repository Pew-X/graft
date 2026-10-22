// TEMPORARY diagnosis of a Chromium page crash seen on the Linux runner. To be deleted.
import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const table = JSON.parse(readFileSync(`${root}fixtures/vectors/vectors.json`, "utf8"));
const wasm = [...readFileSync(`${root}target/wasm32-unknown-unknown/wasm/graft_render.wasm`)];
const page_js = readFileSync(new URL("../dist/page.js", import.meta.url), "utf8");

test("diagnose: which pointer case crashes the page", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium");
  const scenario = table.scenarios.find((s: { name: string }) => s.name === "bad-pointers");
  for (const c of scenario.cases) {
    const page = await browser.newPage();
    await page.route("http://localhost:4173/**", (r) =>
      r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    let crashed = false;
    page.on("crash", () => (crashed = true));
    await page.goto("http://localhost:4173/");
    await page.addScriptTag({ content: page_js });
    const single = {
      ...table,
      scenarios: [{ ...scenario, cases: [c] }],
      vectors: [],
      out_len: [],
    };
    let verdict = "ok";
    try {
      const r = await page.evaluate(
        ([tt, w]) =>
          (window as any).graftVectors.runAll(tt, w, [], { host: "wasm", group: "bad-pointers" }),
        [single, wasm] as const,
      );
      verdict = JSON.stringify(r.checks[0]?.actual);
    } catch (e) {
      verdict = `${crashed ? "CRASH" : "error"}: ${String(e).split("\n")[0]}`;
    }
    console.log(`DIAG case ${c.case}: ${verdict}`);
    await page.close();
  }
});
