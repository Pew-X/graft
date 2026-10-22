// The page the browsers run. It receives the table and the artefact bytes from the test (the browser
// reads no files), runs both the artefact and the TypeScript port, and hands back every check.

import { PortHost, WasmHost } from "./host.ts";
import { runTable, type Check } from "./run.ts";
import { generate, type Table } from "./table.ts";

export interface PageResult {
  userAgent: string;
  checks: Check[];
  /** Output of the artefact for a few vectors, as hex, for byte-for-byte comparison with native output. */
  outputs: Record<string, string>;
}

async function runAll(table: Table, wasm: number[], parityVectors: string[]): Promise<PageResult> {
  const bytes = Uint8Array.from(wasm);
  const wasmHost = await WasmHost.load("wasm-in-browser", bytes);
  const checks = [...(await runTable(table, wasmHost)), ...(await runTable(table, new PortHost()))];
  const outputs: Record<string, string> = {};
  for (const name of parityVectors) {
    const v = table.vectors.find((x) => x.name === name);
    if (!v) throw new Error(`parity vector ${name} is not in the table`);
    const o = wasmHost.render(generate(v.input), v.p, v.q, v.method, v.out_cap);
    if (o.kind !== "status" || o.code <= 0) throw new Error(`parity vector ${name} did not render`);
    outputs[name] = [...new Uint8Array(o.out.buffer, o.out.byteOffset, o.out.byteLength)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return { userAgent: navigator.userAgent, checks, outputs };
}

/** The surface the page exposes to the Playwright test; both sides use this type. */
export interface GraftVectors {
  runAll(table: Table, wasm: number[], parityVectors: string[]): Promise<PageResult>;
}

(globalThis as unknown as { graftVectors: GraftVectors }).graftVectors = { runAll };
