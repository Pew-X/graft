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

/** Fetch a stage's audio. Static assets only: this never touches the API. */
export async function fetchPcm(path: string, signal?: AbortSignal): Promise<Int16Array> {
  const response = await fetch(path, signal ? { signal } : {});
  if (!response.ok) throw new Error(`${path} could not be read (${response.status})`);
  return decodePcm16le(await response.arrayBuffer());
}
