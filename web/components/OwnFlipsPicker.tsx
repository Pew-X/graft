"use client";

import { useEffect, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { LISTED_MAX, flipIds, stateOf } from "../lib/flips/list.ts";
import { keptKeys } from "../lib/publish/keep.ts";
import { usePublicationRead } from "./usePublicationRead.ts";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // storage blocked
  }
}

/** One of the maker's own flips: it can be chosen when it is here and open to new flips, otherwise it says why not. */
function Row({
  id,
  apiUrl,
  onChoose,
}: {
  id: string;
  apiUrl: string;
  onChoose: (id: string) => void;
}) {
  const { read, failed } = usePublicationRead(apiUrl, id);
  const p = copy.make.pick;
  const shown = read.status === "ready" ? read.value : null;
  const state = read.status === "ready" ? stateOf(shown) : null;
  const chooseable = state === "open";
  const title = shown !== null && shown.title !== "" ? shown.title : copy.flips.untitled;
  const standing =
    state === null
      ? failed
        ? copy.flips.states.unreachable
        : copy.flips.states.checking
      : chooseable
        ? ""
        : copy.flips.states[state];
  return (
    <li className="sound own-flip" data-state={state ?? (failed ? "failed" : "checking")}>
      <button
        type="button"
        disabled={!chooseable}
        aria-disabled={!chooseable}
        aria-describedby={`own-${id}-why`}
        onClick={() => onChoose(id)}
        aria-label={`${p.choose}: ${title}`}
      >
        <span className="sound-title">{title}</span>
        <span className="sound-by">
          {shown !== null && shown.author !== "" ? fill(p.by, { author: shown.author }) : ""}
        </span>
        <span id={`own-${id}-why`} className="sound-licence" role="status">
          {standing}
        </span>
      </button>
    </li>
  );
}

/**
 * The flips this browser holds a manage key for, as a second section of the picker: the newest 20, each
 * checked against the public read. Nothing shows when the browser holds none (or storage is blocked).
 */
export function OwnFlipsPicker({
  apiUrl,
  onChoose,
}: {
  apiUrl: string;
  onChoose: (id: string) => void;
}) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    // read after the page is up: the server cannot know what this browser holds
    queueMicrotask(() => setIds(flipIds(keptKeys(storage()))));
  }, []);
  if (ids.length === 0) return null;
  const p = copy.make.pick;
  return (
    <section aria-labelledby="pick-own" data-testid="pick-own">
      <h3 id="pick-own" className="kicker">
        {p.own}
      </h3>
      <ul>
        {ids.slice(0, LISTED_MAX).map((id) => (
          <Row key={id} id={id} apiUrl={apiUrl} onChoose={onChoose} />
        ))}
      </ul>
      {ids.length > LISTED_MAX ? (
        <p className="hint">{fill(p.ownOlder, { n: ids.length - LISTED_MAX })}</p>
      ) : null}
    </section>
  );
}
