"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { ID_SHAPE, LISTED_MAX, flipIds, stateOf } from "../lib/flips/list.ts";
import { forgetKey, keptKeys } from "../lib/publish/keep.ts";
import { usePublicationRead } from "./usePublicationRead.ts";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** One flip: what it is called and how it stands, read from the service, with the ways to act on it. */
function Row({
  id,
  apiUrl,
  onForget,
  onFailing,
}: {
  id: string;
  apiUrl: string;
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
  return (
    <div className="your-flips">
      <p>{f.intro}</p>
      <ul className="flip-list">
        {shown.map((id) => (
          <Row
            key={`${id}:${round}`}
            id={id}
            apiUrl={apiUrl}
            onForget={forget}
            onFailing={onFailing}
          />
        ))}
      </ul>
      {ids.length > shown.length ? (
        <p className="hint">{fill(f.older, { n: ids.length - shown.length })}</p>
      ) : null}
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
