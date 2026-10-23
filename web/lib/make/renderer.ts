/**
 * The renderer in the browser: the same `.wasm` artefact the service runs, instantiated with an empty
 * import object (it imports nothing), so a preview is made by the code that makes the stored audio.
 * Hermite is the only method the product uses (method id 1).
 */

const HERMITE = 1;

/** Where the site serves the pinned artefact. The file name carries the renderer version. */
export const RENDERER_PATH = "/renderer/v1.wasm";

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

/** The renderer refused or failed: a negative code, or a trap. */
export class RenderError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "RenderError";
    this.code = code;
  }
}

export interface Renderer {
  /** The audio of `slice` played at p/q: the canonical output, ready to hear or to hash. */
  render(slice: Int16Array, p: number, q: number): Int16Array;
}

const REQUIRED = ["graft_alloc", "graft_free", "graft_out_len", "graft_render"] as const;

export function rendererFrom(instance: WebAssembly.Instance): Renderer {
  const x = instance.exports;
  for (const name of REQUIRED) {
    if (typeof x[name] !== "function") throw new TypeError(`the renderer lacks ${name}`);
  }
  if (!(x["memory"] instanceof WebAssembly.Memory))
    throw new TypeError("the renderer lacks memory");
  const api = x as unknown as Exports;
  return {
    render(slice, p, q) {
      const outLen = api.graft_out_len(slice.length, p, q);
      if (outLen < 1) throw new RenderError("the renderer refused the cut or the speed", outLen);
      const inBytes = slice.length * 2;
      const outBytes = outLen * 2;
      const inPtr = api.graft_alloc(inBytes);
      const outPtr = api.graft_alloc(outBytes);
      try {
        if (inPtr === 0 || outPtr === 0) throw new RenderError("the renderer is out of memory");
        // Views are made after both allocations: growing the memory detaches an earlier buffer.
        new Int16Array(api.memory.buffer, inPtr, slice.length).set(slice);
        const code = api.graft_render(inPtr, slice.length, p, q, HERMITE, outPtr, outLen);
        if (code < 1) throw new RenderError("the renderer refused the cut or the speed", code);
        return new Int16Array(api.memory.buffer.slice(outPtr, outPtr + code * 2));
      } finally {
        api.graft_free(inPtr, inBytes);
        api.graft_free(outPtr, outBytes);
      }
    },
  };
}

/** Instantiate the artefact from its bytes. An empty import object: it imports nothing. */
export async function loadRenderer(bytes: BufferSource): Promise<Renderer> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return rendererFrom(instance);
}

/** Canonical bytes of samples: signed 16-bit little-endian, the same on any machine. */
export function toBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true);
  return out;
}

/** SHA-256 of bytes, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
