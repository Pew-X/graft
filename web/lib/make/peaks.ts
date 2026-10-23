/** Waveform drawing data: the lowest and highest sample in each of `buckets` equal stretches. */
export function peaks(samples: Int16Array, buckets: number): Array<[low: number, high: number]> {
  const count = Math.min(Math.floor(buckets), samples.length);
  if (count <= 0) return [];
  const out: Array<[number, number]> = [];
  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * samples.length) / count);
    const to = Math.floor(((b + 1) * samples.length) / count);
    let low = samples[from] ?? 0;
    let high = low;
    for (let i = from + 1; i < to; i++) {
      const v = samples[i] ?? 0;
      if (v < low) low = v;
      if (v > high) high = v;
    }
    out.push([low, high]);
  }
  return out;
}

/**
 * An SVG path that draws the peaks as one filled shape, `width` units across and `height` tall, with
 * silence on the middle line. Full scale (32768) reaches 96% of the way to each edge.
 */
export function outline(
  data: ReadonlyArray<readonly [low: number, high: number]>,
  height = 100,
): string {
  if (data.length === 0) return "";
  const mid = height / 2;
  const reach = (mid * 96) / 100 / 32768;
  const y = (value: number) => (mid - value * reach).toFixed(2);
  // Each bucket is one unit wide: along its top going right, then back along its bottom going left.
  const along = data.flatMap(([, high], i) => [`${i} ${y(high)}`, `${i + 1} ${y(high)}`]);
  const back = data.flatMap(([low], i) => [`${i} ${y(low)}`, `${i + 1} ${y(low)}`]).reverse();
  return `M${[...along, ...back].join(" L")} Z`;
}
