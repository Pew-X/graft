/** Canonical audio files are signed 16-bit little-endian mono. Decode them the same on any machine. */
export function decodePcm16le(buffer: ArrayBuffer): Int16Array {
  if (buffer.byteLength % 2 !== 0) {
    throw new RangeError(`16-bit audio has an even number of bytes, got ${buffer.byteLength}`);
  }
  const view = new DataView(buffer);
  const out = new Int16Array(buffer.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** A fetch that answered with a status that is not success. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`the request was answered with ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

/** Fetch a stage's audio from a static path or an issued address. */
export async function fetchPcm(path: string, signal?: AbortSignal): Promise<Int16Array> {
  const response = await fetch(path, signal ? { signal } : {});
  if (!response.ok) throw new HttpError(response.status);
  return decodePcm16le(await response.arrayBuffer());
}
