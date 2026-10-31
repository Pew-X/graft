"use client";

import { copy, fill } from "../lib/copy.ts";
import { moveInBank, removeFromBank } from "../lib/sketch/book.ts";
import { MOST_ON_BANK } from "../lib/sketch/sketch.ts";
import { PadBank } from "./PadBank.tsx";
import type { useSketchBank } from "./useBank.ts";
import { announceSketchChange, sketchStorage } from "./useSketchBook.ts";

type Bank = ReturnType<typeof useSketchBank>;

/**
 * The sketch bank on the make page: up to twelve sketches on pads, played with the touch of a pad or, when
 * turned on, the number keys, with the roll's rules (one at a time or overlap, stop, rec, play, loop). Each
 * pad is a real button; the order is changed with buttons too (move earlier, move later), so the bank can
 * be arranged from the keyboard. A pad that cannot play says why on itself.
 */
export function SketchBankPanel({ bank, status }: { bank: Bank; status: string }) {
  const c = copy.sketch.bank;
  const act = (fn: () => unknown): void => {
    fn();
    announceSketchChange();
  };
  return (
    <section aria-labelledby="sketch-bank" className="sketch-bank-panel" data-testid="sketch-bank">
      <h3 id="sketch-bank" className="kicker">
        {c.heading}
      </h3>
      <p className="hint">{c.intro}</p>
      {bank.pads.length === 0 ? (
        <p className="hint">{c.empty}</p>
      ) : (
        <>
          <div className="sketch-bank">
            <PadBank
              pads={bank.pads}
              playable={bank.playable}
              reasons={bank.reasons}
              marks={null}
              shown={bank.shown}
              mode={bank.mode}
              onMode={bank.setMode}
              onPress={bank.press}
              onStop={bank.stop}
              phrase={bank.phrase}
              padLabel={c.pad}
            />
          </div>
          <div className="actions">
            <button
              type="button"
              className="pill"
              aria-pressed={bank.keysOn}
              aria-describedby="bank-keys-why"
              onClick={() => bank.setKeysOn(!bank.keysOn)}
            >
              {bank.keysOn ? c.keysOn : c.keysOff}
            </button>
          </div>
          <p id="bank-keys-why" className="hint">
            {c.keysWhy}
          </p>
          {bank.pads.length === 1 ? <p className="hint">{c.once}</p> : null}
          <ol className="bank-order" aria-label={c.pads}>
            {bank.pads.map((pad, i) => (
              <li key={pad.id}>
                <span className="bank-n">{i + 1}</span>
                <span className="bank-title">{pad.title}</span>
                <button
                  type="button"
                  className="pill"
                  disabled={i === 0}
                  aria-label={`${c.earlier}: ${pad.title}`}
                  onClick={() => act(() => moveInBank(sketchStorage(), pad.id, -1))}
                >
                  {c.earlier}
                </button>
                <button
                  type="button"
                  className="pill"
                  disabled={i === bank.pads.length - 1}
                  aria-label={`${c.later}: ${pad.title}`}
                  onClick={() => act(() => moveInBank(sketchStorage(), pad.id, 1))}
                >
                  {c.later}
                </button>
                <button
                  type="button"
                  className="pill"
                  aria-label={`${c.remove}: ${pad.title}`}
                  onClick={() => act(() => removeFromBank(sketchStorage(), pad.id))}
                >
                  {c.remove}
                </button>
              </li>
            ))}
          </ol>
          <p className="hint">{fill(c.full, { max: MOST_ON_BANK })}</p>
          <p className="hint">{c.phraseLocal}</p>
        </>
      )}
      <p role="status" className="hint" data-testid="bank-status">
        {status}
      </p>
    </section>
  );
}
