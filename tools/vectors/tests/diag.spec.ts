// TEMPORARY diagnosis of a Chromium page crash seen on the Linux runner. To be deleted.
import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const table = JSON.parse(readFileSync(`${root}fixtures/vectors/vectors.json`, "utf8"));
const wasm = [...readFileSync(`${root}target/wasm32-unknown-unknown/wasm/graft_render.wasm`)];
const page_js = readFileSync(new URL("../dist/page.js", import.meta.url), "utf8");

test("diagnose: which group crashes the page", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium");
  const groups = ["out_len", "canon", ...table.scenarios.map((s: { name: string }) => s.name)];
  const vectorNames: string[] = table.vectors.map((v: { name: string }) => v.name);
  for (const host of ["wasm", "port"] as const) {
    for (const group of [...groups, ...vectorNames.map((n) => `vector:${n}`)]) {
      const page = await browser.newPage();
      await page.route("http://localhost:4173/**", (r) =>
        r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
      );
      let crashed = false;
      page.on("crash", () => (crashed = true));
      await page.goto("http://localhost:4173/");
      await page.addScriptTag({ content: page_js });
      const only = group.startsWith("vector:") ? undefined : { host, group };
      const t = group.startsWith("vector:")
        ? {
            ...table,
            vectors: table.vectors.filter((v: { name: string }) => `vector:${v.name}` === group),
            scenarios: [],
            out_len: [],
          }
        : table;
      const o = group.startsWith("vector:") ? { host, group: "vectors" } : only;
      let verdict = "ok";
      try {
        await page.evaluate(([tt, w, oo]) => (window as any).graftVectors.runAll(tt, w, [], oo), [
          t,
          wasm,
          o,
        ] as const);
      } catch (e) {
        verdict = `${crashed ? "CRASH" : "error"}: ${String(e).split("\n")[0]}`;
      }
      if (verdict !== "ok") console.log(`DIAG ${host} ${group}: ${verdict}`);
      await page.close();
    }
  }
  console.log("DIAG finished");
});
