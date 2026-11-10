/**
 * A bank of a stage's flips, and a phrase played on it, as an address: `#bank=<stage>&pads=<id,id,...>&phrase=1:0,2:35`.
 * The phrase PINS the flips it was recorded on, in pad order, so a flip published (or withdrawn) later can
 * never move a pad under someone else's phrase: the bank a link opens is rebuilt from those ids alone. The
 * address comes from outside, so reading it is strict and bounded: anything that is not exactly what
 * `encodeBank` writes is no bank at all (the whole link is refused, never read in part), and a link that
 * names a stage the page does not show is refused too. It carries no sound and no name.
 */
import { ID_SHAPE } from "../flips/list.ts";
import { MOST_PRESSES, MOST_UNITS, type Phrase, type Press } from "./phrase.ts";

export const MOST_BANK_PADS = 12;
const FRAGMENT = "#bank=";
const LONGEST = 2048;
const ITEM = /^(1[0-2]|[1-9]):(0|[1-9]\d{0,3})$/;

export interface BankLink {
  /** The stage whose flips these are. */
  stage: string;
  /** The flips on the pads, in pad order. */
  pads: string[];
  phrase: Phrase;
}

export function encodeBank(link: BankLink): string | null {
  const { stage, pads, phrase } = link;
  if (!ID_SHAPE.test(stage)) return null;
  if (pads.length === 0 || pads.length > MOST_BANK_PADS) return null;
  if (new Set(pads).size !== pads.length || !pads.every((p) => ID_SHAPE.test(p))) return null;
  if (phrase.length === 0 || phrase.length > MOST_PRESSES) return null;
  const first = phrase[0]?.at ?? 0;
  const items: string[] = [];
  let before = 0;
  for (const { stage: pad, at } of phrase) {
    const t = at - first;
    if (!Number.isInteger(pad) || pad < 0 || pad >= pads.length) return null;
    if (!Number.isInteger(t) || t < before || t > MOST_UNITS) return null;
    items.push(`${pad + 1}:${t}`);
    before = t;
  }
  return `${FRAGMENT}${stage}&pads=${pads.join(",")}&phrase=${items.join(",")}`;
}

/**
 * The bank a fragment carries, or null. `shown` is the ids of the stages this page shows: a link naming a
 * stage that is not one of them is no bank here.
 */
export function parseBankHash(hash: string, shown: ReadonlySet<string>): BankLink | null {
  if (hash.length > LONGEST || !hash.startsWith(FRAGMENT)) return null;
  const parts = hash.slice(FRAGMENT.length).split("&");
  if (parts.length !== 3) return null;
  const [stage, padsPart, phrasePart] = parts as [string, string, string];
  if (!ID_SHAPE.test(stage) || !shown.has(stage)) return null;
  if (!padsPart.startsWith("pads=") || !phrasePart.startsWith("phrase=")) return null;
  const pads = padsPart.slice("pads=".length).split(",");
  if (pads.length === 0 || pads.length > MOST_BANK_PADS) return null;
  if (!pads.every((p) => ID_SHAPE.test(p)) || new Set(pads).size !== pads.length) return null;
  const items = phrasePart.slice("phrase=".length).split(",");
  if (items.length === 0 || items.length > MOST_PRESSES) return null;
  const phrase: Press[] = [];
  let before = 0;
  for (const item of items) {
    const found = ITEM.exec(item);
    if (!found) return null;
    const pad = Number(found[1]) - 1;
    const at = Number(found[2]);
    if (pad >= pads.length || at < before || at > MOST_UNITS) return null;
    if (phrase.length === 0 && at !== 0) return null;
    phrase.push({ stage: pad, at });
    before = at;
  }
  return { stage, pads, phrase };
}
