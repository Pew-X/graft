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

async function runAll(
  table: Table,
  wasm: number[],
  parityVectors: string[],
  only?: { host: "wasm" | "port"; group: string },
): Promise<PageResult> {
  const bytes = Uint8Array.from(wasm);
  const wasmHost = await WasmHost.load("wasm-in-browser", bytes);
  const checks = only
    ? await runTable(table, only.host === "wasm" ? wasmHost : new PortHost(), only.group)
    : [...(await runTable(table, wasmHost)), ...(await runTable(table, new PortHost()))];
  const outputs: Record<string, string> = {};
  for (const name of parityVectors) {
    const v = table.vectors.find((x) => x.name === name);
    if (!v) continue;
    const o = wasmHost.render(generate(v.input), v.p, v.q, v.method, v.out_cap);
    if (o.kind === "status" && o.code > 0) {
      outputs[name] = [...new Uint8Array(o.out.buffer, o.out.byteOffset, o.out.byteLength)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  }
  return { userAgent: navigator.userAgent, checks, outputs };
}

(globalThis as unknown as { graftVectors: { runAll: typeof runAll } }).graftVectors = { runAll };
