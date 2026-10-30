"use client";

import { useRef } from "react";
import { copy } from "../lib/copy.ts";

/**
 * Every keyboard control of this kind of page, in words. A visible button (not a character shortcut: a
 * "?" key would itself have to be switchable off) opens a native modal dialog built like the report
 * dialog: focus moves in and stays in, Escape closes it, and focus goes back to the button.
 */
export function KeysSheet({ page, className }: { page: "roll" | "make"; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const sections = copy.keys[page];
  const close = (): void => {
    dialog.current?.close();
    opener.current?.focus();
  };
  return (
    <>
      <button
        ref={opener}
        type="button"
        className={className ?? "keys-link"}
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
      >
        <span className="keys-label">{copy.keys.button}</span>
        {/* a keyboard, for a narrow screen where the word would crowd the note beside it */}
        <svg className="keys-icon" viewBox="0 0 24 16" width="22" height="15" aria-hidden="true">
          <rect
            x="1"
            y="1"
            width="22"
            height="14"
            rx="2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M5 5.5h1.5M9.5 5.5H11M14 5.5h1.5M18 5.5h1.5M5 8.5h1.5M9.5 8.5H11M14 8.5h1.5M18 8.5h1.5M7 11.5h10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <dialog
        ref={dialog}
        className="report-dialog keys-dialog"
        aria-labelledby={`keys-heading-${page}`}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <header>
          <h2 id={`keys-heading-${page}`} className="kicker">
            {copy.keys.heading}
          </h2>
          <button type="button" className="pill" onClick={close}>
            {copy.keys.close}
          </button>
        </header>
        {sections.map((section) => (
          <section key={section.heading}>
            <h3>{section.heading}</h3>
            <dl>
              {section.rows.map(([keys, does]) => (
                <div key={`${keys}-${does}`}>
                  <dt>{keys}</dt>
                  <dd>{does}</dd>
                </div>
              ))}
            </dl>
            {section.note ? <p className="hint">{section.note}</p> : null}
          </section>
        ))}
      </dialog>
    </>
  );
}
