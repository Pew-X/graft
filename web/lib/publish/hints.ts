/**
 * Hints for a title or a name as it is typed. They follow the service's rules for public text (the
 * service is authoritative): letters and digits of any script, a short list of punctuation, no
 * control or invisible characters, links and @handles removed. A hint explains; it never blocks,
 * except that an empty field has nothing to publish.
 */
export const TITLE_MAX = 60;
export const NAME_MAX = 32;
/** A maker's note: the title rules at this length. It is optional, so an empty note is fine. */
export const NOTE_MAX = 140;

export type Hint =
  | { kind: "empty" }
  | { kind: "tooLong"; max: number; over: number }
  | { kind: "character"; character: string }
  | { kind: "adjusted" };

const PUNCTUATION = "-_'\u2019.,:;!?&()+/\"";
const TLDS = new Set(
  "com net org io co me ly gg app dev xyz fm tv to link site online info biz in uk us de fr ru cn jp ai gl be page".split(
    " ",
  ),
);

const trimEdges = (token: string) => token.replace(/^[([{"'.,;:!?)\]}]+|[([{"'.,;:!?)\]}]+$/g, "");

function isLink(token: string): boolean {
  const t = trimEdges(token).toLowerCase();
  if (t.includes("://") || t.startsWith("www.")) return true;
  const dot = t.lastIndexOf(".");
  if (dot <= 0) return false;
  return TLDS.has(t.slice(dot + 1)) && /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*$/u.test(t.slice(0, dot));
}

const isHandle = (token: string) => trimEdges(token).startsWith("@");

export function hintFor(text: string, max: number): Hint | null {
  const bad = [...text].find((c) => /[\p{C}\u2028\u2029]/u.test(c) || /[\n\r\t]/.test(c));
  if (bad !== undefined) return { kind: "character", character: bad };
  const tokens = text.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((t) => !isLink(t) && !isHandle(t));
  const adjusted = kept.length !== tokens.length;
  const value = kept.join(" ");
  if (value === "") return { kind: "empty" };
  const odd = [...value].find(
    (c) => c !== " " && !/[\p{L}\p{N}]/u.test(c) && !PUNCTUATION.includes(c),
  );
  if (odd !== undefined) return { kind: "character", character: odd };
  const length = [...value].length;
  if (length > max) return { kind: "tooLong", max, over: length - max };
  return adjusted ? { kind: "adjusted" } : null;
}
