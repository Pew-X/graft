"use client";

import type { ReactNode } from "react";
import { copy, fill } from "../lib/copy.ts";
import type { Sound } from "../lib/make/sounds.ts";

function Row({ sound, onChoose }: { sound: Sound; onChoose: (sound: Sound) => void }) {
  return (
    <li className="sound">
      <button
        type="button"
        onClick={() => onChoose(sound)}
        aria-label={`${copy.make.pick.choose}: ${sound.title}`}
      >
        <span className="sound-title">{sound.title}</span>
        <span className="sound-by">{fill(copy.make.pick.by, { author: sound.author })}</span>
        {sound.licence ? (
          <span className="sound-licence" data-honesty={sound.licence.honesty}>
            {sound.licence.value}
            <span className="stated">{sound.licence.honesty}</span>
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** The sounds to start from, with each source's declared licence line shown as typed. */
export function SoundPicker({
  curated,
  flips,
  onChoose,
  children,
  after,
}: {
  curated: readonly Sound[];
  flips: readonly Sound[];
  onChoose: (sound: Sound) => void;
  /** Further ways to start, shown first: below thirteen rows a visitor never scrolls to them. */
  children?: ReactNode;
  /** Sections that come after the shipped ones (the maker's own flips). */
  after?: ReactNode;
}) {
  return (
    <div className="picker">
      <h2 className="picker-title">{copy.make.pick.heading}</h2>
      {children}
      <section aria-labelledby="pick-curated">
        <h3 id="pick-curated" className="kicker">
          {copy.make.pick.curated}
        </h3>
        <ul>
          {curated.map((s) => (
            <Row key={s.id} sound={s} onChoose={onChoose} />
          ))}
        </ul>
      </section>
      {flips.length === 0 ? null : (
        <section aria-labelledby="pick-flips">
          <h3 id="pick-flips" className="kicker">
            {copy.make.pick.flips}
          </h3>
          <ul>
            {flips.map((s) => (
              <Row key={s.id} sound={s} onChoose={onChoose} />
            ))}
          </ul>
        </section>
      )}
      {after}
    </div>
  );
}
