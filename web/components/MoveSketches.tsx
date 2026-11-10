"use client";

import { useRef, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { LONG_LINK, MOST_FILE_BYTES, entriesOf, linkFor, write } from "../lib/sketch/move.ts";
import { ImportQuestion } from "./ImportQuestion.tsx";
import { useSketchBook } from "./useSketchBook.ts";

/**
 * "move my sketches": to another browser or device with no account and no server, by a link (the address
 * fragment) or a small text file. The link and the file carry the same plain text and never a key.
 * The page never reads the clipboard; it only writes to it, when asked.
 */
export function MoveSketches() {
  const m = copy.sketch.move;
  const book = useSketchBook();
  const [said, setSaid] = useState("");
  const [fileText, setFileText] = useState<string | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  // the file chooser exists only while the panel is open, so the page has one file input unless this one is wanted
  const [open, setOpen] = useState(false);

  const entries = entriesOf(book.sketches);
  const link = (): string => linkFor(window.location.origin, entries);

  return (
    <details
      className="move-sketches"
      data-testid="move-sketches"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{m.summary}</summary>
      {book.sketches.length === 0 ? <p className="hint">{m.nothing}</p> : null}
      <div className="actions">
        <button
          type="button"
          className="pill"
          disabled={book.sketches.length === 0}
          onClick={() => {
            const url = link();
            navigator.clipboard.writeText(url).then(
              () =>
                setSaid(
                  url.length > LONG_LINK
                    ? `${m.linkCopied} ${fill(m.longLink, { n: url.length })}`
                    : m.linkCopied,
                ),
              () => setSaid(m.copyFailed),
            );
          }}
        >
          {m.copyLink}
        </button>
        <button
          type="button"
          className="pill"
          disabled={book.sketches.length === 0}
          onClick={() => {
            const blob = new Blob([`${write(entries)}\n`], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "graft-sketches.txt";
            a.click();
            URL.revokeObjectURL(url);
            setSaid(m.fileSaved);
          }}
        >
          {m.saveFile}
        </button>
        <button type="button" className="pill" onClick={() => pick.current?.click()}>
          {m.addFile}
        </button>
        {open ? (
          <input
            ref={pick}
            type="file"
            accept=".txt,text/plain"
            className="visually-hidden"
            tabIndex={-1}
            aria-label={m.addFile}
            data-testid="sketch-file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              // a size or a type that cannot be a sketchbook file is refused without being read
              const textual = file.type === "" || file.type === "text/plain";
              if (file.size > MOST_FILE_BYTES || !textual) {
                setSaid(m.fileBad);
                return;
              }
              void file.text().then(
                (text) => {
                  setSaid("");
                  setFileText(text);
                },
                () => setSaid(m.fileBad),
              );
            }}
          />
        ) : null}
      </div>
      <p role="status" className="hint">
        {said}
      </p>
      {fileText !== null ? (
        <ImportQuestion
          text={fileText}
          mostBytes={MOST_FILE_BYTES}
          onDone={() => setFileText(null)}
        />
      ) : null}
    </details>
  );
}
