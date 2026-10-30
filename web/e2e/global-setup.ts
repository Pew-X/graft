import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Bundle the test pages (the engine harness, and the twelve-stage roll) into scripts the tests load. */
export default async function globalSetup(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const common = { bundle: true, format: "iife", target: "es2022", logLevel: "warning" } as const;
  await build({
    ...common,
    entryPoints: [join(here, "harness.ts")],
    outfile: join(here, "dist", "harness.js"),
  });
  await build({
    ...common,
    entryPoints: [join(here, "telemetry-harness.ts")],
    outfile: join(here, "dist", "telemetry.js"),
  });
  await build({
    ...common,
    entryPoints: [join(here, "perform-harness.ts")],
    outfile: join(here, "dist", "perform.js"),
  });
  await build({
    ...common,
    entryPoints: [join(here, "long-fixture.tsx")],
    outfile: join(here, "dist", "long.js"),
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_GRAFT_PERFORM": '"on"',
    },
  });
}
