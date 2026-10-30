/** What the keys sheet lists for a kind of page: all of it, or all but perform when this build holds perform back. */
import { copy } from "./copy.ts";

export interface Section {
  id: string;
  heading: string;
  rows: ReadonlyArray<readonly [string, string]>;
  note: string | null;
}

export function sheetFor(page: "roll" | "make", performOn: boolean): readonly Section[] {
  const sections: readonly Section[] = copy.keys[page];
  return performOn ? sections : sections.filter((s) => s.id !== "perform");
}
