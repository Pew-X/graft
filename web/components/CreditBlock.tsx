import { memo } from "react";
import { copy, fill } from "../lib/copy.ts";
import type { Block, DetailRow, FaceLine } from "../lib/roll/view.ts";
import type { FlipsAudio } from "./FlipsBank.tsx";
import { FlipsOfStage } from "./FlipsOfStage.tsx";
import { Trace } from "./Trace.tsx";

/** The honesty state in words (colour is never the only carrier of it). */
function Stated({ state, asTyped }: { state: string; asTyped: boolean }) {
  return (
    <u className="state" data-state={state}>
      {state}
      {asTyped ? ` · ${copy.state.asTyped}` : ""}
    </u>
  );
}

/**
 * "more ↓" under a stage that has more than fits. The page's styles show it only while there is more
 * (it is a button, so a press scrolls the stage, instead of a word that looks pressable and is not).
 */
function MoreCue() {
  return (
    <button
      type="button"
      className="more-cue"
      aria-label={copy.roll.moreLabel}
      onClick={(event) => {
        const article = event.currentTarget.parentElement?.querySelector(":scope > article");
        if (!article) return;
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        article.scrollBy({ top: article.clientHeight * 0.8, behavior: still ? "auto" : "smooth" });
      }}
    >
      {copy.roll.more}
      <span aria-hidden="true"> {"\u2193"}</span>
    </button>
  );
}

function Line({ line }: { line: FaceLine }) {
  return (
    <div className="line" data-honesty={line.honesty}>
      <dt>{line.word}</dt>
      <dd>
        <span className="value">{line.value}</span>
        {line.gloss ? <em>{line.gloss}</em> : null}
        <Stated state={line.state} asTyped={line.asTyped} />
      </dd>
    </div>
  );
}

function Detail({ row }: { row: DetailRow }) {
  return (
    <div className="line" data-honesty={row.honesty}>
      <dt>{row.label}</dt>
      <dd>
        {row.print === undefined ? (
          <code>{row.value}</code>
        ) : (
          // A code is drawn first and written out only on request: the same sound draws the same line.
          <>
            <span className="print">
              <Trace id={row.print} label={copy.details.printLabel} />
            </span>
            <em className="print-note">{copy.details.printNote}</em>
            <details className="code">
              <summary>{copy.details.showCode}</summary>
              <code>{row.value}</code>
            </details>
          </>
        )}
        <Stated state={row.state} asTyped={row.asTyped} />
      </dd>
    </div>
  );
}

interface Props {
  block: Block;
  total: number;
  /** The stage the engine says is current. */
  current: boolean;
  /** The stage the page is showing as the hero (the current one, or the one the visitor moved to). */
  hero: boolean;
  playing: boolean;
  disabled: boolean;
  onPlay: (index: number) => void;
  onFlip: (index: number) => void;
  /** Absent where reports cannot be sent (no service to send them to). */
  onReport?: ((index: number) => void) | undefined;
  /** Mark a part of this stage on the record to flip; absent where the roll has no way to make. */
  onMark?: (() => void) | undefined;
  marking?: boolean;
  /** Where the service is, to list this stage's flips under it; absent where the roll has no service (the home page). */
  flipsFrom?: string | undefined;
  /** What the roll lends a bank of this stage's flips (its audio context, a pause, the page's stages). */
  flipsAudio?: FlipsAudio | undefined;
  register: (index: number, node: HTMLLIElement | null) => void;
  onFocusBlock: (index: number) => void;
}

/**
 * One stage as a wall label: a kicker, a cut-paper title slab in the stage's dye (lettered after what
 * was done to the sound), and the credit lines. The page shows one stage large and the others dimmed;
 * every stage is always real text in reading order.
 */
export const CreditBlock = memo(function CreditBlock({
  block,
  total,
  current,
  hero,
  playing,
  disabled,
  onPlay,
  onFlip,
  register,
  onFocusBlock,
  onReport,
  onMark,
  marking = false,
  flipsFrom,
  flipsAudio,
}: Props) {
  const heading = `stage-${block.id}`;
  return (
    <li
      ref={(node) => register(block.index, node)}
      className="block"
      data-dye={block.dye}
      data-state={block.state}
      data-current={current}
      data-hero={hero}
      aria-current={current ? "step" : undefined}
      onFocus={() => onFocusBlock(block.index)}
    >
      <article aria-labelledby={heading}>
        <div className="kicker-row">
          <p className="kicker">
            {fill(copy.roll.kicker, {
              n: String(block.numeral).padStart(2, "0"),
              kind: block.kind,
            })}
          </p>
          {block.state === "available" ? (
            // The stage's face: its trace, drawn from its public id. A tap plays it; the title below is
            // the control a keyboard or a screen reader uses, so this one is only drawn.
            <div
              className="trace-face"
              aria-hidden="true"
              data-stage={block.id}
              onClick={() => (disabled ? undefined : onPlay(block.index))}
            >
              <Trace id={block.id} label="" decorative />
            </div>
          ) : null}
        </div>
        <h2 id={heading} className="slab" data-k={block.lettering}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onPlay(block.index)}
            aria-pressed={playing}
          >
            <span className="numeral" aria-hidden="true">
              {block.numeral}
            </span>
            <span className="title">{block.title}</span>
            <span className="play-word">
              {playing ? copy.controls.pauseStage : copy.controls.playStage}
            </span>
            <span className="visually-hidden">
              {fill(copy.roll.stage, { n: block.index + 1, total, title: block.title })}
            </span>
          </button>
        </h2>
        {block.state === "available" ? null : (
          <div className="stage-note" data-state={block.state}>
            <p>{copy.states[block.state]}</p>
            {block.state === "unavailable" ? null : <p>{copy.states.takedown}</p>}
          </div>
        )}
        {/* The action comes straight after the title, where it is on the first screen; the facts follow. */}
        <div className="flip-row">
          <button type="button" className="flip primary" onClick={() => onFlip(block.index)}>
            {copy.flip.label}
          </button>
          {onMark && hero && block.state === "available" && !disabled ? (
            <button type="button" className="mark-toggle" aria-pressed={marking} onClick={onMark}>
              {marking ? copy.mark.stop : copy.mark.toggle}
            </button>
          ) : null}
        </div>
        {/* the flips made from this stage come straight after the action: that is the lineage going on */}
        {flipsFrom && hero && block.state === "available" ? (
          <FlipsOfStage key={block.id} id={block.id} apiUrl={flipsFrom} audio={flipsAudio} />
        ) : null}
        <dl className="face">
          {block.face.map((line) => (
            <Line key={`${line.role}-${line.value}`} line={line} />
          ))}
        </dl>
        {block.flipped ? <p className="flipped">{block.flipped}</p> : null}
        {block.details.length === 0 ? null : (
          <details className="details">
            <summary>{copy.details.summary}</summary>
            <dl>
              {block.details.map((row) => (
                <Detail key={row.label} row={row} />
              ))}
            </dl>
          </details>
        )}
        {onReport && block.state === "available" ? (
          <button type="button" className="flip report" onClick={() => onReport(block.index)}>
            {copy.report.open}
          </button>
        ) : null}
      </article>
      {hero ? <MoreCue /> : null}
    </li>
  );
});

/** The last label: empty, and the place the next flip goes. */
export const EndBlock = memo(function EndBlock({
  index,
  hero,
  onFlip,
  register,
  onFocusBlock,
}: {
  index: number;
  hero: boolean;
  onFlip: () => void;
  register: (index: number, node: HTMLLIElement | null) => void;
  onFocusBlock: (index: number) => void;
}) {
  return (
    <li
      ref={(node) => register(index, node)}
      className="block end"
      data-hero={hero}
      onFocus={() => onFocusBlock(index)}
    >
      <article aria-label={copy.end.role}>
        <p className="kicker">
          {fill(copy.roll.kickerYours, { n: String(index + 1).padStart(2, "0") })}
        </p>
        <h2 className="slab" data-k="src">
          <span className="empty-slab">
            <span className="cursor" aria-hidden="true" />
            <span className="value">{copy.end.value}</span>
          </span>
        </h2>
        <dl className="face">
          <div className="line" data-honesty="unknown">
            <dt>{copy.end.role}</dt>
            <dd>
              <em>{copy.end.gloss}</em>
              <Stated state="unknown" asTyped={false} />
            </dd>
          </div>
        </dl>
        <button type="button" className="flip" onClick={onFlip}>
          {copy.flip.label}
        </button>
      </article>
      {hero ? <MoreCue /> : null}
    </li>
  );
});
