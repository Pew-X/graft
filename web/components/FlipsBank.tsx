"use client";

import { useCallback, useMemo, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { type BankLink, MOST_BANK_PADS, encodeBank } from "../lib/perform/bank-link.ts";
import type { AudioContextLike } from "../lib/playback/webaudio.ts";
import type { FlipItem } from "../lib/flips/read.ts";
import { fetchPcm } from "../lib/roll/pcm.ts";
import { PadBank } from "./PadBank.tsx";
import { useBank } from "./useBank.ts";

/** What the roll lends a bank of flips: its one audio context, a way to go quiet, and which stages the page shows. */
export interface FlipsAudio {
  context: () => Promise<AudioContextLike>;
  /** Something is about to sound: the roll pauses. */
  beforeSound: () => void;
  /** The ids of the stages this page shows, so a link naming any other stage is no bank here. */
  stageIds: ReadonlySet<string>;
  /** The page has finished its first-visit narration and shows its tools: an invitation waits for this. */
  ready: boolean;
}

type Made = { ok: true; samples: Int16Array } | { ok: false; why: string };

/** Put a phrase into this page's own address, or remove it. False when another fragment is in use. */
function writeBank(link: BankLink | null): boolean {
  try {
    const here = window.location;
    if (here.hash !== "" && !here.hash.startsWith("#bank=")) return false;
    if (link === null) {
      if (here.hash === "") return true;
      window.history.replaceState(window.history.state, "", `${here.pathname}${here.search}`);
      return true;
    }
    const fragment = encodeBank(link);
    if (fragment === null) return false;
    window.history.replaceState(
      window.history.state,
      "",
      `${here.pathname}${here.search}${fragment}`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * A stage's flips as pads: up to the newest twelve (or exactly the ones a link pinned), each pad fetching
 * its own sound with its own loading state and its own try-again, over the roll's one audio context. A phrase
 * recorded here goes in the address with the ids of the flips it was played on; a link that carries one only
 * offers it, and plays when the visitor presses play.
 */
export function FlipsBank({
  stage,
  apiUrl,
  flips,
  total,
  audio,
  arrived,
  onClose,
  heading,
  honesty,
  linkable = true,
}: {
  stage: string;
  apiUrl: string;
  flips: readonly FlipItem[];
  total: number;
  audio: FlipsAudio;
  arrived: BankLink | null;
  onClose: () => void;
  /** Another heading and another line about whose flips these are (the maker's own, on the your-flips page). */
  heading?: string;
  honesty?: string;
  /** Whether a phrase may be written into the page's address as a link; false where there is no stage to name. */
  linkable?: boolean;
}) {
  const c = copy.stageFlips.bank;
  const [titles, setTitles] = useState<Record<string, string>>(() =>
    Object.fromEntries(flips.map((f) => [f.id, f.title])),
  );
  const [status, setStatus] = useState("");
  const ids = useMemo(
    () => arrived?.pads ?? flips.slice(0, MOST_BANK_PADS).map((f) => f.id),
    [arrived, flips],
  );

  const samplesOf = useCallback(
    async (id: string): Promise<Made> => {
      try {
        const response = await fetch(`${apiUrl}/v1/publications/${encodeURIComponent(id)}`);
        if (response.status === 404) return { ok: false, why: c.goneHere };
        if (!response.ok) return { ok: false, why: c.unreadable };
        const entry = (await response.json()) as {
          state?: string;
          title?: string;
          audio?: { url?: string };
        };
        if (typeof entry.title === "string") setTitles((t) => ({ ...t, [id]: entry.title ?? "" }));
        if (entry.state === "held") return { ok: false, why: c.held };
        if (entry.state !== "available" || typeof entry.audio?.url !== "string")
          return { ok: false, why: c.goneHere };
        return { ok: true, samples: await fetchPcm(entry.audio.url) };
      } catch {
        return { ok: false, why: c.unreadable };
      }
    },
    [apiUrl, c.goneHere, c.held, c.unreadable],
  );
  const titleOf = useCallback((id: string): string => titles[id] ?? "", [titles]);
  const words = useMemo(
    () => ({
      preparing: c.preparing,
      recording: c.recording,
      phraseKept: (n: number, linked: boolean) =>
        fill(linked ? c.phraseKeptLinked : c.phraseKept, { n }),
      padRemoved: c.padRemoved,
    }),
    [c],
  );
  const onPhrase = useCallback(
    (entry: { presses: BankLink["phrase"]; ids: string[] } | null): boolean =>
      linkable
        ? writeBank(entry === null ? null : { stage, pads: entry.ids, phrase: entry.presses })
        : false,
    [stage, linkable],
  );
  const copyLink = useCallback((): void => {
    try {
      navigator.clipboard.writeText(window.location.href).then(
        () => setStatus(c.linkCopied),
        () => setStatus(c.linkFailed),
      );
    } catch {
      setStatus(c.linkFailed);
    }
  }, [c]);

  const bank = useBank({
    ids,
    titleOf,
    samplesOf,
    getContext: audio.context,
    beforeSound: audio.beforeSound,
    say: setStatus,
    words,
    arrived: arrived ? { presses: arrived.phrase, ids: arrived.pads } : null,
    onPhrase,
    copyLink,
  });

  const failed = bank.pads.filter((_, i) => !bank.playable[i] && bank.reasons[i] !== c.preparing);
  return (
    <div className="flips-bank" data-testid="flips-bank">
      <h4 className="kicker">{heading ?? c.heading}</h4>
      <p className="hint">{honesty ?? c.honesty}</p>
      {total > ids.length && !arrived ? (
        <p className="hint">{fill(c.newest, { n: ids.length, total })}</p>
      ) : null}
      {ids.length === 1 ? <p className="hint">{c.once}</p> : null}
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
      {bank.phrase.invited && audio.ready ? (
        <div className="phrase-invite" role="group" aria-label={copy.phrase.group}>
          <p>{c.invite}</p>
          <button type="button" onClick={() => void bank.phrase.play()}>
            {copy.phrase.inviteButton}
          </button>
          <button type="button" onClick={bank.phrase.dismiss}>
            {copy.phrase.dismiss}
          </button>
        </div>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="pill"
          aria-pressed={bank.keysOn}
          aria-describedby="flips-bank-keys-why"
          onClick={() => bank.setKeysOn(!bank.keysOn)}
        >
          {bank.keysOn ? c.keysOn : c.keysOff}
        </button>
        {failed.map((pad) => (
          <button key={pad.id} type="button" className="pill" onClick={() => bank.retry(pad.id)}>
            {fill(c.retry, { title: pad.title || pad.id })}
          </button>
        ))}
        <button type="button" className="pill" onClick={onClose}>
          {c.close}
        </button>
      </div>
      <p id="flips-bank-keys-why" className="hint">
        {c.keysWhy}
      </p>
      <p role="status" className="hint" data-testid="flips-bank-status">
        {status}
      </p>
    </div>
  );
}
