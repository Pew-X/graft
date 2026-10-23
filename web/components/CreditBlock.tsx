import { memo } from "react";
import { copy, fill } from "../lib/copy.ts";
import type { Block, DetailRow, FaceLine } from "../lib/roll/view.ts";

/** The honesty state in words (colour is never the only carrier of it). */
function Stated({ state, asTyped }: { state: string; asTyped: boolean }) {
  return (
    <u className="state" data-state={state}>
      {state}
      {asTyped ? ` · ${copy.state.asTyped}` : ""}
    </u>
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
        <code>{row.value}</code>
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
        <p className="kicker">
          {fill(copy.roll.kicker, { n: String(block.numeral).padStart(2, "0"), kind: block.kind })}
        </p>
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
        <button type="button" className="flip" onClick={() => onFlip(block.index)}>
          {copy.flip.label}
        </button>
        {onReport && block.state === "available" ? (
          <button type="button" className="flip report" onClick={() => onReport(block.index)}>
            {copy.report.open}
          </button>
        ) : null}
      </article>
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
    </li>
  );
});
