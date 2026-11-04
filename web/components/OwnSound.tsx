"use client";

import { useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy.ts";
import { type Decoded, decodeToCanonical, tooBigToRead } from "../lib/own/decode.ts";
import { type Recording, startRecording } from "../lib/own/mic.ts";
import { RecordScope } from "./RecordScope.tsx";
import { MAX_FRAMES } from "../lib/own/source.ts";

type Status =
  | { name: "idle" }
  | { name: "asking" }
  | { name: "recording"; stream: MediaStream }
  | { name: "reading" }
  | { name: "problem"; text: string };

const problemText = (reason: Extract<Decoded, { ok: false }>["reason"]): string => copy.own[reason];

/**
 * Start from the maker's own sound: the microphone, or a picked file. It is read and made canonical
 * here, in memory. A recording of more than 30 seconds is handed on to be trimmed; nothing is sent
 * anywhere.
 */
export function OwnSound({
  onSound,
  uploads = null,
}: {
  /** Whether publishing a sound of one's own is open: false says so up front; null (not known) says nothing. */
  uploads?: boolean | null;
  /** The canonical sound, and whether it is longer than a source may be. */
  onSound: (samples: Int16Array, needsTrim: boolean) => void;
}) {
  const [status, setStatus] = useState<Status>({ name: "idle" });
  const recording = useRef<Recording | null>(null);
  // Leaving the screen while recording lets the microphone go and discards what was recorded.
  useEffect(
    () => () => {
      recording.current?.cancel();
      recording.current = null;
    },
    [],
  );

  async function finish(data: ArrayBuffer) {
    setStatus({ name: "reading" });
    const result = await decodeToCanonical(data);
    if (!result.ok) {
      setStatus({ name: "problem", text: problemText(result.reason) });
      return;
    }
    setStatus({ name: "idle" });
    onSound(result.samples, result.samples.length > MAX_FRAMES);
  }

  async function stop() {
    const active = recording.current;
    recording.current = null;
    if (!active) return;
    setStatus({ name: "reading" });
    const blob = await active.stop();
    await finish(await blob.arrayBuffer());
  }

  async function record() {
    setStatus({ name: "asking" });
    const started = await startRecording(() => void stop());
    if (!started.ok) {
      setStatus({ name: "problem", text: copy.own[started.problem] });
      return;
    }
    recording.current = started.recording;
    setStatus({ name: "recording", stream: started.recording.stream });
  }

  return (
    <section className="own" aria-labelledby="own-heading">
      <h3 id="own-heading" className="kicker">
        {copy.own.heading} <span className="gloss">{copy.own.gloss}</span>
      </h3>
      <div className="actions">
        {status.name === "recording" ? (
          <button type="button" className="primary" onClick={() => void stop()}>
            {copy.own.stop}
          </button>
        ) : (
          <button
            type="button"
            className="pill"
            disabled={status.name === "asking" || status.name === "reading"}
            onClick={() => void record()}
          >
            {copy.own.record}
          </button>
        )}
        <label className="pill file">
          {copy.own.pick}
          <input
            type="file"
            accept="audio/*"
            disabled={status.name === "recording" || status.name === "reading"}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              // Judged by its size before a byte is read: a huge file is never pulled into memory.
              if (tooBigToRead(file)) {
                setStatus({ name: "problem", text: copy.own.tooBig });
                return;
              }
              setStatus({ name: "reading" });
              file.arrayBuffer().then(finish, () => {
                setStatus({ name: "problem", text: copy.own.unreadable });
              });
            }}
          />
        </label>
      </div>
      {status.name === "recording" ? <RecordScope stream={status.stream} /> : null}
      {uploads === true ? (
        <p className="notice own-rights" data-testid="rights-note">
          {copy.own.rightsNote}
        </p>
      ) : null}
      {uploads === false ? (
        <p className="notice own-off" data-testid="uploads-off">
          {copy.own.offUpFront}
        </p>
      ) : null}
      <p className="hint" role="status">
        {status.name === "recording"
          ? copy.own.recording
          : status.name === "reading"
            ? copy.own.working
            : status.name === "problem"
              ? status.text
              : ""}
      </p>
      <details className="own-more">
        <summary>{copy.own.moreSummary}</summary>
        {uploads === true ? <p className="hint">{copy.own.reportNote}</p> : null}
        <p className="hint">{copy.own.honesty}</p>
      </details>
    </section>
  );
}
