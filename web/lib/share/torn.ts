/**
 * The paper of the share card. A cut-paper title slab has an edge torn by hand: this makes the same
 * tear for the same seed (a flip's public id), so a flip always has the card it had. It is the geometry
 * of an edge and the fitting of a typed title to it, and nothing more: it draws nothing.
 */

function seeded(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The outline of a torn rectangle, as points. Each edge wanders by a few pixels with the coarse sway of a
 * hand-torn line and the fine bite of paper fibres, and the four corners are not square. Closed: the last
 * point is not the first, a polygon joins them.
 */
export function tornPoints(seed: string, width: number, height: number): Array<[number, number]> {
  const rand = seeded(seed);
  const out: Array<[number, number]> = [];
  const AMP = 5;
  const edge = (
    from: [number, number],
    to: [number, number],
    normal: [number, number],
    steps: number,
  ): void => {
    // two slow waves for the sway, random bites for the fibres
    const w1 = 1 + rand() * 2.2;
    const w2 = 3 + rand() * 3;
    const p1 = rand() * Math.PI * 2;
    const p2 = rand() * Math.PI * 2;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const sway = Math.sin(t * Math.PI * w1 + p1) * 0.55 + Math.sin(t * Math.PI * w2 + p2) * 0.3;
      const bite = (rand() - 0.5) * 0.9;
      const d = (sway + bite) * AMP * 0.8;
      const x = from[0] + (to[0] - from[0]) * t + normal[0] * d;
      const y = from[1] + (to[1] - from[1]) * t + normal[1] * d;
      out.push([Math.min(width, Math.max(0, x)), Math.min(height, Math.max(0, y))]);
    }
  };
  // the corners are a little out of square
  const c = (): number => rand() * AMP * 0.9;
  const tl: [number, number] = [c(), c()];
  const tr: [number, number] = [width - c(), c() * 0.4];
  const br: [number, number] = [width - c() * 0.5, height - c()];
  const bl: [number, number] = [c() * 0.6, height - c() * 0.5];
  const along = (a: [number, number], b: [number, number]): number =>
    Math.max(24, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 7));
  edge(tl, tr, [0, 1], along(tl, tr));
  edge(tr, br, [-1, 0], along(tr, br));
  edge(br, bl, [0, -1], along(br, bl));
  edge(bl, tl, [1, 0], along(bl, tl));
  return out;
}

export type Lettering = "src" | "up" | "down";

/**
 * What of a typed title the card's fonts can draw: Latin letters with their accents, digits, spaces and the
 * common punctuation, and nothing else. Other scripts have no letters in these fonts, emoji would be fetched
 * from a server while the card is drawn, and invisible characters have no business on a card; a title of
 * only such things comes back empty. The card says less than the page's own words, never more.
 */
export function printable(title: string): string {
  const kept = [...title].filter((ch) => {
    const c = ch.codePointAt(0)!;
    return (
      (c >= 0x20 && c <= 0x7e) ||
      (c >= 0xa1 && c <= 0x24f && c !== 0xad) ||
      c === 0xa0 ||
      (c >= 0x2010 &&
        c <= 0x2027 &&
        c !== 0x200b &&
        c !== 0x200c &&
        c !== 0x200d &&
        c !== 0x200e &&
        c !== 0x200f) ||
      c === 0x20ac
    );
  });
  return kept.join("").replace(/\s+/g, " ").trim();
}

/** How wide a letter is as a share of its size, a little over the real average so a line never runs long. */
const ADVANCE: Record<Lettering, number> = { src: 0.5, up: 0.46, down: 0.68 };
/** How tall a line is as a share of the size the title is set in (the credits' own leading for each lettering). */
export const LEADING: Record<Lettering, number> = { src: 1.02, up: 0.92, down: 1.08 };
/** The largest and smallest a title is set, in pixels. */
const BIGGEST: Record<Lettering, number> = { src: 150, up: 170, down: 120 };
const SMALLEST = 44;
const MOST_LINES = 3;
const ZERO_WIDTH_SPACE = "\u200b";

/** How many lines `words` fill at `perLine` letters a line, a word longer than a line being cut across lines. */
function linesFor(words: readonly string[], perLine: number): number {
  let lines = 1;
  let used = 0;
  for (const word of words) {
    const len = [...word].length;
    if (len > perLine) {
      if (used > 0) lines++;
      const across = Math.ceil(len / perLine);
      lines += across - 1;
      used = len - (across - 1) * perLine;
    } else if (used === 0) used = len;
    else if (used + 1 + len <= perLine) used += 1 + len;
    else {
      lines++;
      used = len;
    }
  }
  return lines;
}

/** `text` with a break point after every `perLine` letters of any word longer than a line. */
function breakable(text: string, perLine: number): string {
  return text
    .split(" ")
    .map((w) =>
      [...w].length > perLine
        ? [...w].reduce(
            (out, ch, i) => out + (i > 0 && i % perLine === 0 ? ZERO_WIDTH_SPACE : "") + ch,
            "",
          )
        : w,
    )
    .join(" ");
}

/**
 * A typed title fitted to a slab `width` pixels wide and at most `height` tall inside: the size (as large as
 * the slab allows, at most three lines), how many lines it fills, and the text to set. A word with no spaces
 * too long for a line gets break points; one that cannot fit even so is shortened. Titles are typed by
 * strangers.
 */
export function fitTitle(
  title: string,
  lettering: Lettering,
  width: number,
  height = Infinity,
): { size: number; lines: number; text: string } {
  const clean = [...printable(title)].slice(0, 60).join("") || "a flip";
  const advance = ADVANCE[lettering];
  for (let size = BIGGEST[lettering]; size >= SMALLEST; size -= 4) {
    const perLine = Math.max(1, Math.floor(width / (size * advance)));
    const lines = linesFor(clean.split(" "), perLine);
    if (lines <= MOST_LINES && lines * size * LEADING[lettering] <= height)
      return { size, lines, text: breakable(clean, perLine) };
  }
  // even the smallest size cannot hold it in three lines: shorten to what three lines hold
  const perLine = Math.max(1, Math.floor(width / (SMALLEST * advance)));
  const room = perLine * MOST_LINES - 1;
  const chars = [...clean];
  const cut = chars.length > room ? `${chars.slice(0, room).join("")}…` : clean;
  return { size: SMALLEST, lines: MOST_LINES, text: breakable(cut, perLine) };
}
