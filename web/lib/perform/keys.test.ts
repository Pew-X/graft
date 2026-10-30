import assert from "node:assert/strict";
import { test } from "node:test";
import { MOST_PADS_BY_KEY, keyOfPad, padForKey, padOfCode, type PadKey } from "./keys.ts";

const press = (over: Partial<PadKey> = {}): PadKey => ({
  code: "Digit1",
  repeat: false,
  isComposing: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  target: null,
  ...over,
});

test("the number row is the first twelve stages, by position", () => {
  const row = [
    "Digit1",
    "Digit2",
    "Digit3",
    "Digit4",
    "Digit5",
    "Digit6",
    "Digit7",
    "Digit8",
    "Digit9",
    "Digit0",
    "Minus",
    "Equal",
  ];
  assert.deepEqual(row.map(padOfCode), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(MOST_PADS_BY_KEY, 12);
});

test("the numeric keypad plays stages 1 to 9 and nothing else on it does", () => {
  for (let n = 1; n <= 9; n++) assert.equal(padOfCode(`Numpad${n}`), n - 1);
  for (const code of ["Numpad0", "NumpadAdd", "NumpadEnter", "NumpadSubtract", "NumLock"]) {
    assert.equal(padOfCode(code), null, code);
  }
});

test("other keys are not pads, whatever character a layout prints on them", () => {
  for (const code of [
    "KeyA",
    "Space",
    "Enter",
    "Escape",
    "ArrowLeft",
    "Backquote",
    "BracketLeft",
  ]) {
    assert.equal(padOfCode(code), null, code);
  }
  // a non-US layout: the key is named by where it is, so an AZERTY "&" on the first position is Digit1
  assert.equal(padForKey(press({ code: "Digit1" }), 4), 0);
});

test("a pad that the chain does not have does nothing", () => {
  assert.equal(padForKey(press({ code: "Digit5" }), 4), null);
  assert.equal(padForKey(press({ code: "Digit4" }), 4), 3);
  assert.equal(padForKey(press({ code: "Equal" }), 12), 11);
  assert.equal(padForKey(press({ code: "Equal" }), 11), null);
});

test("auto-repeat, composing text and held modifiers never play a pad", () => {
  assert.equal(padForKey(press({ repeat: true }), 4), null);
  assert.equal(padForKey(press({ isComposing: true }), 4), null);
  for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const) {
    assert.equal(padForKey(press({ [mod]: true }), 4), null, mod);
  }
});

test("a text field, a select or an editable region keeps its digits", () => {
  const field = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable });
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.equal(padForKey(press({ target: field(tag) }), 4), null, tag);
  }
  assert.equal(padForKey(press({ target: field("DIV", true) }), 4), null);
  // a button or the page itself does not
  assert.equal(padForKey(press({ target: field("BUTTON") }), 4), 0);
  assert.equal(padForKey(press({ target: field("BODY") }), 4), 0);
});

test("the printed key of a pad: the number row's own marks, then a plain position", () => {
  assert.equal(keyOfPad(0), "1");
  assert.equal(keyOfPad(8), "9");
  assert.equal(keyOfPad(9), "0");
  assert.equal(keyOfPad(10), "-");
  assert.equal(keyOfPad(11), "=");
  assert.equal(keyOfPad(12), null);
  assert.equal(keyOfPad(-1), null);
});
