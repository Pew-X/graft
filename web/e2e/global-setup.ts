import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Bundle the harness (the real engine and adapter) into one script the test page loads. */
export default async function globalSetup(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  await build({
    entryPoints: [join(here, "harness.ts")],
    outfile: join(here, "dist", "harness.js"),
    bundle: true,
    format: "iife",
    target: "es2022",
    logLevel: "warning",
  });
}
