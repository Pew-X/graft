"use client";

import { useRef, useState } from "react";
import { copy } from "../lib/copy.ts";
import { type Decoded, decodeToCanonical } from "../lib/own/decode.ts";
import { type Recording, startRecording } from "../lib/own/mic.ts";
import { MAX_FRAMES } from "../lib/own/source.ts";

type Status =
  | { name: "idle" }
  | { name: "asking" }
  | { name: "recording" }
  | { name: "reading" }
  | { name: "problem"; text: string };

const problemText = (reason: Extract<Decoded, { ok: false }>["reason"]): string => copy.own[reason];

/**
 * Start from the maker's own sound: the microphone, or a picked file. It is read and made canonical
 * here, in memory. A recording of more than 15 seconds is handed on to be trimmed; nothing is sent
 * anywhere.
 */
export function OwnSound({
  onSound,
}: {
  /** The canonical sound, and whether it is longer than a source may be. */
  onSound: (samples: Int16Array, needsTrim: boolean) => void;
}) {
  const [status, setStatus] = useState<Status>({ name: "idle" });
  const recording = useRef<Recording | null>(null);

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
    setStatus({ name: "recording" });
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
              void file.arrayBuffer().then(finish);
            }}
          />
        </label>
      </div>
      <p className="hint" role="status">
        {status.name === "recording"
          ? copy.own.recording
          : status.name === "reading"
            ? copy.own.working
            : status.name === "problem"
              ? status.text
              : ""}
      </p>
      <p className="hint">{copy.own.honesty}</p>
    </section>
  );
}
