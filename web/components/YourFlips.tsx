"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { ID_SHAPE, LISTED_MAX, flipIds, stateOf } from "../lib/flips/list.ts";
import { forgetKey, keptKeys } from "../lib/publish/keep.ts";
import { createApi, fetchChain } from "../lib/api/chain.ts";
import type { FlipItem } from "../lib/flips/read.ts";
import { MOST_BANK_PADS } from "../lib/perform/bank-link.ts";
import type { AudioContextLike } from "../lib/playback/webaudio.ts";
import { FlipsBank, type FlipsAudio } from "./FlipsBank.tsx";
import { usePublicationRead } from "./usePublicationRead.ts";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** One flip: what it is called and how it stands, read from the service, with the ways to act on it. */
export interface Place {
  /** The stage number of this flip in its own lineage (1 is a source). */
  n: number;
  /** The title of the stage it was made from, when it has one. */
  parent: string | null;
  /** The source that lineage begins with. */
  root: string;
  rootTitle: string;
}

function Row({
  id,
  apiUrl,
  place,
  onForget,
  onFailing,
}: {
  id: string;
  apiUrl: string;
  /** Where it sits, once the lineages have been read. */
  place: Place | null;
  onForget: (id: string) => void;
  /** Said when this flip's read starts or stops failing, so the page knows whether to offer "try again". */
  onFailing: (id: string, failing: boolean) => void;
}) {
  // a service that did not answer is often one that was asleep (the site has already asked it to wake):
  // the read asks again by itself for a few minutes
  const { read, failed } = usePublicationRead(apiUrl, id);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    onFailing(id, failed);
    return () => onFailing(id, false);
  }, [id, failed, onFailing]);

  const f = copy.flips;
  const title =
    read.status === "ready" && read.value !== null && read.value.title !== ""
      ? read.value.title
      : f.untitled;
  const standing =
    read.status === "ready"
      ? f.states[stateOf(read.value)]
      : failed
        ? f.states.unreachable
        : f.states.checking;
  return (
    <li
      className="your-flip"
      data-state={read.status === "ready" ? stateOf(read.value) : read.status}
    >
      <p className="flip-title">{title}</p>
      {place ? (
        <p className="hint flip-place">
          {place.n === 1
            ? copy.flips.kindSource
            : [
                fill(copy.flips.stageOf, { n: String(place.n) }),
                place.parent ? fill(copy.flips.madeFrom, { parent: place.parent }) : "",
              ]
                .filter((s) => s !== "")
                .join(", ")}
        </p>
      ) : null}
      <p className="hint" role="status">
        {standing}
      </p>
      <div className="actions">
        {read.status === "ready" && read.value !== null && read.value.state === "available" ? (
          <a className="pill" href={`/p/${id}`}>
            {f.open}
          </a>
        ) : null}
        <Link className="pill" href={`/manage/${id}`}>
          {f.manage}
        </Link>
        {asking ? (
          <span className="forget-ask" role="group" aria-label={f.forgetAsk}>
            <span className="hint">{f.forgetAsk}</span>
            <button type="button" className="pill" onClick={() => onForget(id)}>
              {f.forgetYes}
            </button>
            <button type="button" className="pill" onClick={() => setAsking(false)}>
              {f.forgetNo}
            </button>
          </span>
        ) : (
          <button type="button" className="pill" onClick={() => setAsking(true)}>
            {f.forget}
          </button>
        )}
      </div>
    </li>
  );
}

/** The maker's own flips as pads, over an audio context of its own made on the first press. */
function YourPads({ apiUrl, ids }: { apiUrl: string; ids: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const context = useRef<AudioContextLike | null>(null);
  const audio = useMemo<FlipsAudio>(
    () => ({
      context: async () => {
        if (context.current === null)
          context.current = new window.AudioContext() as unknown as AudioContextLike;
        await (context.current as unknown as AudioContext).resume();
        return context.current;
      },
      beforeSound: () => undefined,
      stageIds: new Set<string>(),
      ready: true,
    }),
    [],
  );
  const padKey = ids.slice(0, MOST_BANK_PADS).join(",");
  const flips = useMemo(
    () =>
      padKey === ""
        ? []
        : padKey.split(",").map((id) => ({ id, title: "" }) as unknown as FlipItem),
    [padKey],
  );
  const c = copy.flips.pads;
  if (flips.length === 0) return null;
  if (!open)
    return (
      <p className="actions">
        <button type="button" className="pill" onClick={() => setOpen(true)}>
          {c.open}
        </button>
      </p>
    );
  return (
    <FlipsBank
      stage={flips[0]?.id ?? ""}
      apiUrl={apiUrl}
      flips={flips}
      total={flips.length}
      audio={audio}
      arrived={null}
      onClose={() => setOpen(false)}
      heading={c.heading}
      honesty={c.honesty}
      linkable={false}
    />
  );
}

/**
 * The flips this browser holds a manage key for. The list is the browser's own kept keys; each flip's
 * title and standing are asked of the service, and if it does not answer (it may have been asleep) the
 * page asks the site to wake it and offers to try again. Forgetting a key asks twice: the key was shown
 * once and cannot be shown again.
 */
export function YourFlips({ apiUrl }: { apiUrl: string }) {
  const [ids, setIds] = useState<string[] | null>(null);
  const [round, setRound] = useState(0);
  const [message, setMessage] = useState("");
  const [failing, setFailing] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    // read after the page is up: the server cannot know what this browser holds
    queueMicrotask(() => setIds(flipIds(keptKeys(storage()))));
  }, []);

  const forget = useCallback((id: string) => {
    if (!ID_SHAPE.test(id)) return;
    forgetKey(storage(), id);
    setIds(flipIds(keptKeys(storage())));
    setMessage(copy.flips.forgottenOne);
  }, []);

  const onFailing = useCallback((id: string, now: boolean) => {
    setFailing((was) => {
      if (was.has(id) === now) return was;
      const next = new Set(was);
      if (now) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // where each listed flip sits, read once for the whole list (a chain read each), so the list can be grouped by source
  const [places, setPlaces] = useState<Readonly<Record<string, Place | null>>>({});
  const listed = ids === null ? "" : ids.slice(0, LISTED_MAX).join(",");
  useEffect(() => {
    if (listed === "") return undefined;
    const controller = new AbortController();
    const api = createApi(apiUrl);
    for (const id of listed.split(",")) {
      fetchChain(api, id)
        .then((chain) => {
          if (controller.signal.aborted) return;
          let place: Place | null = null;
          if (chain !== null && chain.stages.length > 0) {
            const n = chain.stages.length;
            const first = chain.stages[0];
            const before = n > 1 ? chain.stages[n - 2] : undefined;
            place = {
              n,
              parent: before && "title" in before ? before.title : null,
              root: first && "id" in first ? first.id : id,
              rootTitle: first && "title" in first ? first.title : "",
            };
          }
          setPlaces((was) => ({ ...was, [id]: place }));
        })
        .catch(() => {
          if (!controller.signal.aborted) setPlaces((was) => ({ ...was, [id]: null }));
        });
    }
    return () => controller.abort();
  }, [listed, apiUrl, round]);

  const f = copy.flips;
  if (ids === null)
    return (
      <p className="notice" role="status">
        {f.loading}
      </p>
    );
  if (ids.length === 0)
    return (
      <div className="your-flips">
        <p className="notice" role="status">
          {f.empty}
        </p>
        <p>
          <Link className="pill" href="/make">
            {f.make}
          </Link>
        </p>
      </div>
    );
  const shown = ids.slice(0, LISTED_MAX);
  // group by the source each lineage begins with, once every row's place is known; until then the list is as kept
  const settled = shown.every((id) => id in places);
  const order = (() => {
    if (!settled) return shown.map((id) => ({ id, heading: null as string | null }));
    const groups = new Map<string, string[]>();
    for (const id of shown) {
      const root = places[id]?.root ?? id;
      groups.set(root, [...(groups.get(root) ?? []), id]);
    }
    const out: Array<{ id: string; heading: string | null }> = [];
    for (const [root, members] of groups) {
      members.sort((a, b) => (places[a]?.n ?? 0) - (places[b]?.n ?? 0));
      const title = places[members[0] ?? root]?.rootTitle ?? "";
      members.forEach((id, i) =>
        out.push({
          id,
          heading: i === 0 && groups.size > 1 && title !== "" ? fill(f.lineageOf, { title }) : null,
        }),
      );
    }
    return out;
  })();
  return (
    <div className="your-flips">
      <p>{f.intro}</p>
      <ul className="flip-list">
        {order.map(({ id, heading }) => (
          <Fragment key={`${id}:${round}`}>
            {heading ? (
              <li className="flip-group">
                <p className="kicker">{heading}</p>
              </li>
            ) : null}
            <Row
              id={id}
              apiUrl={apiUrl}
              place={places[id] ?? null}
              onForget={forget}
              onFailing={onFailing}
            />
          </Fragment>
        ))}
      </ul>
      {ids.length > shown.length ? (
        <p className="hint">{fill(f.older, { n: ids.length - shown.length })}</p>
      ) : null}
      <YourPads apiUrl={apiUrl} ids={order.map((o) => o.id)} />
      <p className="hint">{f.here}</p>
      <p className="actions">
        {failing.size > 0 ? (
          <button type="button" className="pill" onClick={() => setRound((n) => n + 1)}>
            {f.retry}
          </button>
        ) : null}
        <Link className="pill" href="/make">
          {f.make}
        </Link>
      </p>
      <p role="status" className="hint">
        {message}
      </p>
    </div>
  );
}
