"use client";

import { useEffect, useState } from "react";
import { browserRenderer } from "../lib/make/browser-renderer.ts";
import { outputFrames } from "../lib/make/cut.ts";
import { checkFlip, renderFlip } from "../lib/make/flip.ts";
import { Previewer } from "../lib/make/preview.ts";
import { copy, fill } from "../lib/copy.ts";
import { EDIT_SPEEDS, semitoneLabel } from "../lib/record/edit.ts";
import { describeSpeed } from "../lib/roll/speed.ts";

type Speed = { p: number; q: number };

const RATE = 48_000;

/**
 * What is done to a marked part, on the record where it was marked: pick how fast it plays, hear the
 * real rendering of it on a loop (the renderer that makes the stored audio, not an approximation), and
 * carry it to the make page, which has every speed and the publishing. Nothing here publishes.
 */
export function EditPart({
  samples,
  cut,
  label,
  onFlip,
  onClear,
  onBeforeHear,
}: {
  /** The whole stage's audio the part was marked in; null when it could not be heard. */
  samples: Int16Array | null;
  cut: { start: number; end: number };
  /** "0.50 s", the part's length, for the button. */
  label: string;
  onFlip: (speed: Speed | null) => void;
  onClear: () => void;
  /** Called as hearing starts, so the roll's own sound can stop. */
  onBeforeHear: () => void;
}) {
  const [speed, setSpeed] = useState<Speed | null>(null);
  const [hearing, setHearing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [previewer] = useState(
    () =>
      new Previewer(
        () =>
          (window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext) as
            (new (options?: { sampleRate?: number }) => never) | undefined,
      ),
  );

  // The loop follows the part and the speed: a new choice is rendered and replaces the old one. The part
  // is read as two numbers, not as the object the page makes afresh on every render.
  const { start, end } = cut;
  useEffect(() => {
    if (!hearing || speed === null || samples === null) {
      previewer.stop();
      return undefined;
    }
    let current = true;
    browserRenderer()
      .then((engine) =>
        renderFlip(engine, samples, { cut: { start, end }, p: speed.p, q: speed.q }),
      )
      .then(async (made) => {
        if (!current) return;
        if (!made.ok) throw new Error("refused");
        setFailed(false);
        await previewer.play(made.samples);
      })
      .catch(() => {
        if (current) {
          setFailed(true);
          setHearing(false);
        }
      });
    return () => {
      current = false;
    };
  }, [hearing, speed, samples, start, end, previewer]);
  useEffect(() => () => previewer.close(), [previewer]);

  const note =
    speed === null
      ? null
      : fill(copy.mark.edit.note, {
          from: ((cut.end - cut.start) / RATE).toFixed(2),
          to: (outputFrames(cut.end - cut.start, speed.p, speed.q) / RATE).toFixed(2),
        });

  return (
    <div className="mark-bar" role="group" aria-label={copy.mark.toggle}>
      <div className="speeds" role="group" aria-label={copy.mark.edit.speed}>
        {EDIT_SPEEDS.map(([p, q]) => {
          const chosen = speed?.p === p && speed.q === q;
          const refused = samples === null || checkFlip(samples, { cut, p, q }) !== null;
          const words = describeSpeed(p, q).interval;
          return (
            <button
              key={`${p}/${q}`}
              type="button"
              className="speed-chip"
              aria-pressed={chosen}
              disabled={refused}
              aria-label={fill(copy.mark.edit.chip, {
                semitones: semitoneLabel(p, q),
                interval: words,
              })}
              onClick={() => setSpeed(chosen ? null : { p, q })}
            >
              {semitoneLabel(p, q)}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="hear"
        aria-pressed={hearing}
        disabled={speed === null || samples === null}
        onClick={() => {
          if (hearing) {
            setHearing(false);
            return;
          }
          // inside the press, so the browser lets the audio start
          void previewer.unlock().catch(() => undefined);
          onBeforeHear();
          setFailed(false);
          setHearing(true);
        }}
      >
        {hearing ? copy.mark.edit.stop : copy.mark.edit.hear}
      </button>
      <button type="button" className="primary" onClick={() => onFlip(speed)}>
        {copy.mark.flipPart}
        <span className="part-length"> · {label}</span>
      </button>
      <button type="button" onClick={onClear}>
        {copy.mark.clear}
      </button>
      {note || failed ? (
        <p className="edit-note" role="status">
          <span>{failed ? copy.mark.edit.failed : note}</span>
        </p>
      ) : null}
    </div>
  );
}
