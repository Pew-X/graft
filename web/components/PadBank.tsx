"use client";

import { memo, type PointerEvent as ReactPointerEvent } from "react";
import { copy, fill } from "../lib/copy.ts";
import { keyOfPad } from "../lib/perform/keys.ts";
import { positionHint } from "../lib/perform/layout.ts";
import type { Rule } from "../lib/perform/performer.ts";
import type { Block } from "../lib/roll/view.ts";

interface Props {
  blocks: readonly Block[];
  /** Whether each stage can be heard now. */
  playable: readonly boolean[];
  /** For a stage that cannot be heard, why, in words. */
  reasons: readonly string[];
  /** What is printed on each key where the browser can say; the US marks where it cannot. */
  marks: Record<number, string> | null;
  /** The stage last played: the one the page shows large. */
  shown: number | null;
  mode: Rule;
  onMode: (rule: Rule) => void;
  onPress: (stage: number) => void;
  onStop: () => void;
}

/**
 * One pad for every stage, numbered like its ring and lit in its dye. A pad does what its number key does:
 * it sounds on the press itself (not on its release), so a finger and a key feel the same, and every finger
 * is its own pointer, so two fingers play two pads. The lit state is written by the performer straight onto
 * the pads (`data-sounding`), so a press does not wait for the page to render. Pads are real buttons: a
 * screen reader's own digit keys are taken by its browse mode, so Tab, Enter and Space are its way in.
 */
export const PadBank = memo(function PadBank({
  blocks,
  playable,
  reasons,
  marks,
  shown,
  mode,
  onMode,
  onPress,
  onStop,
}: Props) {
  return (
    <div className="bank" data-count={blocks.length}>
      <div className="pads" role="group" aria-label={copy.perform.bank}>
        {blocks.map((block, i) => {
          const ok = playable[i] === true;
          const key = marks?.[i] ?? keyOfPad(i);
          return (
            <button
              key={block.id}
              type="button"
              className="pad"
              data-pad={i}
              data-dye={block.dye}
              data-sounding="false"
              aria-current={shown === i ? "true" : undefined}
              aria-disabled={ok ? undefined : "true"}
              aria-keyshortcuts={key ?? undefined}
              title={positionHint(i) ?? undefined}
              aria-label={fill(copy.perform.pad, { n: i + 1, title: block.title })}
              // the sound starts on the press itself; a key's Enter or Space arrives as a click with no detail
              onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
                if (e.pointerType === "mouse" && e.button !== 0) return;
                onPress(i);
              }}
              // a held Enter repeats keydown, and each repeat would be a click that restarts the stage: only
              // the first press of a key plays (the number keys ignore repeats the same way)
              onKeyDown={(e) => {
                if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault();
              }}
              onClick={(e) => {
                if (e.detail === 0) onPress(i);
              }}
            >
              <span className="pad-n" aria-hidden="true">
                {i + 1}
              </span>
              {i >= 9 && key ? (
                <span className="pad-key" aria-hidden="true">
                  {key}
                </span>
              ) : null}
              <span className="pad-t" aria-hidden="true">
                {ok ? block.title : (reasons[i] ?? "")}
              </span>
            </button>
          );
        })}
      </div>
      <div className="bank-side">
        <div role="group" aria-label={copy.perform.rule} className="rule">
          {(["cut", "layer"] as const).map((rule) => (
            <button
              key={rule}
              type="button"
              aria-pressed={mode === rule}
              onClick={() => onMode(rule)}
            >
              {copy.perform[rule]}
            </button>
          ))}
        </div>
        <button type="button" className="stop" onClick={onStop}>
          {copy.perform.stop}
        </button>
      </div>
    </div>
  );
});
