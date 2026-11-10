import { execFileSync } from "node:child_process";
import { buildPage } from "./build-page.ts";

/** Builds the page bundle and the artefact once before any browser test runs. */
export default async function globalSetup() {
  await buildPage();
  execFileSync("sh", ["../../scripts/build-wasm.sh"], { stdio: "ignore" });
}
