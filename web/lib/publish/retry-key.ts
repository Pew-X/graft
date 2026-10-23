/** A key chosen when the publish step opens, 128 random bits: the same key means the same attempt. */
export function newRetryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `web-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
