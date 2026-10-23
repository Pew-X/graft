/** The sentences for a refusal, a wait and a hint, from the copy and the numbers they carry. */
import { copy, fill } from "../copy.ts";
import type { Refusal } from "./client.ts";
import type { Hint } from "./hints.ts";

/** "in about 2 minutes": never sooner than the service says, so it rounds up. */
export function waitText(secs: number | null): string {
  const w = copy.publish.when;
  if (secs === null || secs <= 0) return w.soon;
  if (secs < 60) return fill(w.seconds, { n: secs });
  if (secs < 3600) return fill(w.minutes, { n: Math.ceil(secs / 60) });
  const hours = Math.ceil(secs / 3600);
  return hours === 1 ? w.hour : fill(w.hours, { n: hours });
}

const asRule = (rule: string): string =>
  (copy.publish.rules as Record<string, string>)[rule] ?? rule.replace(/_/g, " ");
const asField = (field: string): string =>
  (copy.publish.fields as Record<string, string>)[field] ?? field;

export function refusalText(refusal: Refusal): string {
  const r = copy.publish.refusals;
  switch (refusal.kind) {
    case "rateLimited":
    case "publishCap":
    case "forkCap":
      return fill(r[refusal.kind], { when: waitText(refusal.retryAfterSecs) });
    case "invalid":
      return fill(r.invalid, {
        field: refusal.field ? asField(refusal.field) : "text",
        rule: refusal.rule ? asRule(refusal.rule) : "a rule",
      });
    default:
      return r[refusal.kind];
  }
}

export function hintText(hint: Hint): string {
  const h = copy.publish.hints;
  switch (hint.kind) {
    case "empty":
      return h.empty;
    case "tooLong":
      return fill(h.tooLong, { over: hint.over, max: hint.max });
    case "character":
      return fill(h.character, { character: hint.character });
    case "adjusted":
      return h.adjusted;
  }
}
