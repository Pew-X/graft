import type { Ref } from "react";
import { copy, fill } from "../lib/copy.ts";
import type { Block, DetailRow, FaceLine } from "../lib/roll/view.ts";

/** A value with its honesty state in words; colour is never the only carrier of the state. */
function Stated({ state, asTyped }: { state: string; asTyped: boolean }) {
  return (
    <span className="state" data-state={state}>
      {state}
      {asTyped ? ` · ${copy.state.asTyped}` : ""}
    </span>
  );
}

function Line({ line }: { line: FaceLine }) {
  return (
    <div className="line" data-honesty={line.honesty}>
      <dt>
        <span className="role">{line.word}</span>
        <span className="gloss">{line.gloss}</span>
      </dt>
      <dd>
        <span className="value">{line.value}</span>{" "}
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
        <code>{row.value}</code> <Stated state={row.state} asTyped={row.asTyped} />
      </dd>
    </div>
  );
}

export function CreditBlock({
  block,
  total,
  current,
  playing,
  disabled,
  onPlay,
  onFlip,
  nodeRef,
}: {
  block: Block;
  total: number;
  current: boolean;
  playing: boolean;
  disabled: boolean;
  onPlay: () => void;
  onFlip: () => void;
  nodeRef: Ref<HTMLLIElement>;
}) {
  const heading = `stage-${block.id}`;
  return (
    <li
      ref={nodeRef}
      className="block"
      data-dye={block.dye}
      data-current={current}
      aria-current={current ? "step" : undefined}
    >
      <article aria-labelledby={heading}>
        <h2 id={heading} className="slab">
          <button type="button" disabled={disabled} onClick={onPlay} aria-pressed={playing}>
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
        <dl className="face">
          {block.face.map((line) => (
            <Line key={`${line.role}-${line.value}`} line={line} />
          ))}
        </dl>
        <details className="details">
          <summary>{copy.details.summary}</summary>
          <dl>
            {block.details.map((row) => (
              <Detail key={row.label} row={row} />
            ))}
          </dl>
        </details>
        <button type="button" className="flip" onClick={onFlip}>
          {copy.flip.label}
        </button>
      </article>
    </li>
  );
}

/** The last label: empty, and the place the next flip goes. */
export function EndBlock({ onFlip }: { onFlip: () => void }) {
  return (
    <li className="block end">
      <article aria-label={copy.end.role}>
        <dl className="face">
          <div className="line" data-honesty="unknown">
            <dt>
              <span className="role">{copy.end.role}</span>
              <span className="gloss">{copy.end.gloss}</span>
            </dt>
            <dd>
              <span className="cursor" aria-hidden="true" />
              <span className="value">{copy.end.value}</span>{" "}
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
}
