// Bundles the browser page (src/browser-entry.ts) to dist/page.js.
import { build } from "esbuild";

export async function buildPage() {
  await build({
    entryPoints: ["src/browser-entry.ts"],
    outfile: "dist/page.js",
    bundle: true,
    format: "iife",
    target: "es2022",
    logLevel: "warning",
  });
}

if (import.meta.url === `file://${process.argv[1]}`) await buildPage();
