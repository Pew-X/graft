// What a place that can run the renderer looks like to the table, and the two implementations here:
// the .wasm artefact (instantiated with an empty import object, as the browser does) and the TypeScript port.

import * as port from "./port.ts";

export type Outcome =
  | { kind: "status"; code: number; out: Int16Array }
  | { kind: "trap"; message: string }
  | { kind: "harness"; message: string };

export type PointerCase =
  "null-input" | "odd-input" | "odd-output" | "overlap" | "wraps-address-space" | "wild-output";

export interface Host {
  name: string;
  /** True where raw pointers exist and the pointer scenario must run; false hosts are exempt by declaration. */
  rawPointers: boolean;
  outLen(inLen: number, p: number, q: number): number;
  render(input: Int16Array, p: number, q: number, method: number, outCap: number): Outcome;
  pointerCase?(c: PointerCase, inLen: number, p: number, q: number, method: number): Outcome;
  memoryBytes?(): number;
}

interface Exports {
  memory: WebAssembly.Memory;
  graft_alloc(size: number): number;
  graft_free(ptr: number, size: number): void;
  graft_out_len(inLen: number, p: number, q: number): number;
  graft_render(
    inPtr: number,
    inLen: number,
    p: number,
    q: number,
    method: number,
    outPtr: number,
    outCap: number,
  ): number;
}

export class WasmHost implements Host {
  readonly rawPointers = true;
  readonly name: string;
  private readonly x: Exports;

  constructor(name: string, instance: WebAssembly.Instance) {
    this.name = name;
    this.x = instance.exports as unknown as Exports;
  }

  static async load(name: string, bytes: Uint8Array): Promise<WasmHost> {
    // An empty import object: the artefact imports nothing.
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
    return new WasmHost(name, instance);
  }

  outLen(inLen: number, p: number, q: number): number {
    return this.x.graft_out_len(inLen, p, q);
  }

  render(input: Int16Array, p: number, q: number, method: number, outCap: number): Outcome {
    const x = this.x;
    try {
      const inBytes = input.length * 2;
      const outBytes = outCap * 2;
      const inPtr = x.graft_alloc(inBytes);
      const outPtr = x.graft_alloc(outBytes);
      if ((inBytes > 0 && inPtr === 0) || (outBytes > 0 && outPtr === 0)) {
        return { kind: "harness", message: "graft_alloc failed" };
      }
      // Views are made after both allocations: growing memory detaches earlier buffers.
      if (inBytes > 0) new Int16Array(x.memory.buffer, inPtr, input.length).set(input);
      const code = x.graft_render(inPtr, input.length, p, q, method, outPtr, outCap);
      const out =
        code > 0
          ? new Int16Array(x.memory.buffer.slice(outPtr, outPtr + code * 2))
          : new Int16Array(0);
      x.graft_free(inPtr, inBytes);
      x.graft_free(outPtr, outBytes);
      return { kind: "status", code, out };
    } catch (e) {
      return classify(e);
    }
  }

  pointerCase(c: PointerCase, inLen: number, p: number, q: number, method: number): Outcome {
    const x = this.x;
    try {
      const cap = x.graft_out_len(inLen, p, q);
      if (cap < 1 || inLen < 2) return { kind: "harness", message: "bad case setup" };
      const inPtr = x.graft_alloc(inLen * 2);
      const outPtr = x.graft_alloc(cap * 2);
      const wild = x.memory.buffer.byteLength + 65536;
      const [i, o] = {
        "null-input": [0, outPtr],
        "odd-input": [inPtr + 1, outPtr],
        "odd-output": [inPtr, outPtr + 1],
        overlap: [inPtr, inPtr + 2],
        "wraps-address-space": [0xfffffff0, outPtr],
        "wild-output": [inPtr, wild],
      }[c] as [number, number];
      const code = x.graft_render(i, inLen, p, q, method, o, cap);
      return { kind: "status", code, out: new Int16Array(0) };
    } catch (e) {
      return classify(e);
    }
  }

  memoryBytes(): number {
    return this.x.memory.buffer.byteLength;
  }
}

/** Only an out-of-bounds memory trap counts as the renderer failing; anything else is the harness. */
function classify(e: unknown): Outcome {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof WebAssembly.RuntimeError && /bounds/i.test(message))
    return { kind: "trap", message };
  return { kind: "harness", message: `${(e as Error)?.name ?? "error"}: ${message}` };
}

export class PortHost implements Host {
  readonly name = "typescript-port";
  readonly rawPointers = false;

  outLen(inLen: number, p: number, q: number): number {
    return port.outLen(inLen, p, q);
  }

  render(input: Int16Array, p: number, q: number, method: number, outCap: number): Outcome {
    const code = port.status(input.length, p, q, method, outCap);
    if (code < 0) return { kind: "status", code, out: new Int16Array(0) };
    return { kind: "status", code, out: port.render(input, p, q, method) };
  }
}
