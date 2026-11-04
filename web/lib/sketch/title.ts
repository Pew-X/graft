/**
 * A mirror of the service's rules for public text (crates/domain/src/text.rs), so a title is checked in the
 * browser the way the service will check it: whitespace made plain, control and invisible characters
 * refused, links and @handles removed (and said so), letters and digits of any script plus a short list of
 * punctuation, no word that mixes Latin with Cyrillic or Greek, a length in characters, and a few reserved
 * words. The service is the authority. What it cannot be mirrored for is its configured extra deny list: a
 * title it refuses for that reason is met when the sketch is published.
 */

export const TITLE_LIMIT = 60;
/** A note is a short line of the same plain text, in characters. */
export const NOTE_LIMIT = 140;

export type TitleRule = "empty" | "too_long" | "character" | "mixed_scripts" | "denied_word";

export type Cleaned =
  { ok: true; value: string; adjusted: boolean } | { ok: false; rule: TitleRule; detail: string };

const PUNCTUATION = "-_'’.,:;!?&()+/\"";
const BUILT_IN_DENY = ["admin", "administrator", "moderator", "riffle"];
const TLDS = new Set(
  "com net org io co me ly gg app dev xyz fm tv to link site online info biz in uk us de fr ru cn jp ai gl be page".split(
    " ",
  ),
);

const EDGES = "([{\"'.,;:!?)]}";
const trimEdges = (token: string): string => {
  let a = 0;
  let b = token.length;
  while (a < b && EDGES.includes(token[a] ?? "")) a++;
  while (b > a && EDGES.includes(token[b - 1] ?? "")) b--;
  return token.slice(a, b);
};

function isLink(token: string): boolean {
  const t = trimEdges(token).toLowerCase();
  if (t.includes("://") || t.startsWith("www.")) return true;
  const dot = t.lastIndexOf(".");
  if (dot < 0) return false;
  const host = t.slice(0, dot);
  return (
    host !== "" &&
    TLDS.has(t.slice(dot + 1)) &&
    [...host].every((c) => /[\p{Alphabetic}\p{N}]/u.test(c) || c === "-" || c === ".")
  );
}

function isHandle(token: string): boolean {
  let a = 0;
  while (a < token.length && "([{\"'".includes(token[a] ?? "")) a++;
  return token[a] === "@";
}

/** Characters that render as nothing or change how text is laid out (the service's `invisible`). */
function invisible(c: string): boolean {
  const n = c.codePointAt(0) ?? 0;
  return (
    n === 0xad ||
    (n >= 0x600 && n <= 0x605) ||
    n === 0x61c ||
    n === 0x6dd ||
    n === 0x70f ||
    n === 0x180e ||
    (n >= 0x200b && n <= 0x200f) ||
    (n >= 0x202a && n <= 0x202e) ||
    (n >= 0x2060 && n <= 0x206f) ||
    n === 0xfeff ||
    (n >= 0xfff9 && n <= 0xfffb) ||
    n === 0xfffe ||
    n === 0xffff ||
    (n >= 0xe000 && n <= 0xf8ff) ||
    (n >= 0xf0000 && n <= 0x10ffff)
  );
}

/** The blocks of combining marks the service allows (the service names the blocks, not every mark). */
function isMark(c: string): boolean {
  const n = c.codePointAt(0) ?? 0;
  return (
    (n >= 0x300 && n <= 0x36f) ||
    (n >= 0x483 && n <= 0x489) ||
    (n >= 0x591 && n <= 0x5c7) ||
    (n >= 0x64b && n <= 0x65f) ||
    (n >= 0x900 && n <= 0xdff) ||
    (n >= 0xe00 && n <= 0xe7f) ||
    (n >= 0xf00 && n <= 0xfff) ||
    (n >= 0x1ab0 && n <= 0x1aff) ||
    (n >= 0x1dc0 && n <= 0x1dff) ||
    (n >= 0x20d0 && n <= 0x20ff) ||
    (n >= 0x3099 && n <= 0x309a)
  );
}

const allowed = (c: string): boolean =>
  c === " " || /[\p{Alphabetic}\p{N}]/u.test(c) || isMark(c) || PUNCTUATION.includes(c);

function script(c: string): "latin" | "cyrillic" | "greek" | null {
  const n = c.codePointAt(0) ?? 0;
  if ((n >= 0x41 && n <= 0x5a) || (n >= 0x61 && n <= 0x7a) || (n >= 0xc0 && n <= 0x24f))
    return "latin";
  if (n >= 0x400 && n <= 0x52f) return "cyrillic";
  if (n >= 0x370 && n <= 0x3ff) return "greek";
  return null;
}

function mixesScripts(word: string): boolean {
  let seen: string | null = null;
  for (const c of word) {
    const s = script(c);
    if (s === null) continue;
    if (seen === null) seen = s;
    else if (seen !== s) return true;
  }
  return false;
}

const refuse = (rule: TitleRule, detail: string): Cleaned => ({ ok: false, rule, detail });

/** Clean one title the way the service will. `detail` is the offending character, word or limit, for the sentence that says why. */
export function cleanTitle(input: string, max = TITLE_LIMIT): Cleaned {
  if ([...input].length > max * 16) return refuse("too_long", String(max));
  for (const c of input) {
    const control = /\p{Cc}/u.test(c) && !/\s/u.test(c);
    if (invisible(c) || control) return refuse("character", c);
    if (/[\n\r\t\u2028\u2029]/.test(c)) return refuse("character", c);
  }
  let adjusted = false;
  const kept = input
    .split(/\s+/u)
    .filter((t) => t !== "")
    .filter((t) => {
      const stripped = isLink(t) || isHandle(t);
      adjusted ||= stripped;
      return !stripped;
    });
  const value = kept.join(" ");
  if (value === "") return refuse("empty", "");
  const odd = [...value].find((c) => !allowed(c));
  if (odd !== undefined) return refuse("character", odd);
  if (value.split(" ").some(mixesScripts)) return refuse("mixed_scripts", "");
  if ([...value].length > max) return refuse("too_long", String(max));
  for (const word of value.split(" ")) {
    const bare = [...word]
      .filter((c) => /[\p{Alphabetic}\p{N}]/u.test(c))
      .join("")
      .toLowerCase();
    if (BUILT_IN_DENY.includes(bare)) return refuse("denied_word", bare);
  }
  return { ok: true, value, adjusted };
}

/**
 * Clean a note: the title rules at the note's length, except that a note may be empty (it is optional).
 * Whitespace-only text is no note.
 */
export function cleanNote(input: string): Cleaned {
  if (input.trim() === "") return { ok: true, value: "", adjusted: false };
  return cleanTitle(input, NOTE_LIMIT);
}
