/**
 * Editing a marked part where it is marked: the few speeds offered on the record itself, named the way
 * the roll's header names them (whole semitones), and the address the make page opens at with the part
 * and its speed already chosen. The full control, with every stop of the table, stays on the make page.
 * Every offered speed is a stop of the committed table, so the renderer and the service accept it.
 */

/** Down an octave, a fifth and a fourth, then up a fourth, a fifth and an octave. */
export const EDIT_SPEEDS: ReadonlyArray<readonly [p: number, q: number]> = [
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 3],
  [3, 2],
  [2, 1],
];

/** The speed as whole semitones with a sign, as the header shows it: "−12", "+7". */
export function semitoneLabel(p: number, q: number): string {
  const n = Math.round(12 * Math.log2(p / q));
  return n === 0 ? "0" : `${n < 0 ? "−" : "+"}${Math.abs(n)}`;
}

/** How a speed is written in the make page's address: "3/2", encoded. */
export function speedParam(p: number, q: number): string {
  return encodeURIComponent(`${p}/${q}`);
}
