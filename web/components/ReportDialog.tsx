"use client";

import { useEffect, useRef, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import {
  CATEGORIES,
  NOTE_MAX,
  sendReport,
  type Category,
  type Result,
} from "../lib/report/client.ts";
import { waitText } from "../lib/publish/words.ts";

type Phase =
  | { name: "form" }
  | { name: "sending" }
  | { name: "sent" }
  | { name: "refused"; result: Exclude<Result, { kind: "sent" }> };

function refusalText(result: Exclude<Result, { kind: "sent" }>): string {
  switch (result.kind) {
    case "rateLimited":
      return fill(copy.report.rateLimited, { when: waitText(result.retryAfterSecs) });
    case "gone":
      return copy.report.gone;
    case "invalid":
      return fill(copy.report.invalid, { rule: (result.rule ?? "a rule").replace(/_/g, " ") });
    case "unreachable":
      return copy.report.unreachable;
  }
}

/**
 * Report one sound. A native modal dialog: focus moves into it, stays in it, Escape closes it, and
 * focus goes back to the control that opened it. No account, no name, no contact details.
 */
export function ReportDialog({
  target,
  apiUrl,
  onClose,
}: {
  target: { id: string; title: string } | null;
  apiUrl: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const [category, setCategory] = useState<Category>("rights");
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const open = target !== null;

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      opener.current = document.activeElement;
      node.showModal();
    }
    if (!open && node.open) node.close();
  }, [open]);

  const close = () => {
    onClose();
    setPhase({ name: "form" });
    setNote("");
    const back = opener.current;
    if (back instanceof HTMLElement) back.focus();
  };

  async function submit() {
    if (!target || phase.name === "sending") return;
    setPhase({ name: "sending" });
    const result = await sendReport((url, init) => fetch(url, init), apiUrl, {
      id: target.id,
      category,
      note,
    });
    setPhase(result.kind === "sent" ? { name: "sent" } : { name: "refused", result });
  }

  return (
    <dialog
      ref={dialog}
      className="report-dialog"
      aria-labelledby="report-heading"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {target ? (
        <>
          <h2 id="report-heading" className="kicker">
            {copy.report.heading}
          </h2>
          <p>{fill(copy.report.about, { title: target.title })}</p>
          {phase.name === "sent" ? (
            <>
              <p role="status" className="sent">
                {copy.report.sent}
              </p>
              <p>{copy.report.next}</p>
              <button type="button" className="pill" onClick={close} autoFocus>
                {copy.report.done}
              </button>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <fieldset>
                <legend>{copy.report.categoryLabel}</legend>
                {CATEGORIES.map((c) => (
                  <label key={c} className="choice">
                    <input
                      type="radio"
                      name="category"
                      value={c}
                      checked={category === c}
                      onChange={() => setCategory(c)}
                    />
                    <span>{copy.report.categories[c]}</span>
                  </label>
                ))}
              </fieldset>
              <label htmlFor="report-note">
                {copy.report.noteLabel} <span className="gloss">{copy.report.noteGloss}</span>
              </label>
              <textarea
                id="report-note"
                value={note}
                maxLength={NOTE_MAX}
                rows={3}
                onChange={(e) => setNote(e.target.value)}
              />
              <p className="hint">{copy.report.noContact}</p>
              <div className="actions">
                <button type="submit" className="primary" disabled={phase.name === "sending"}>
                  {copy.report.send}
                </button>
                <button type="button" className="pill" onClick={close}>
                  {copy.report.cancel}
                </button>
              </div>
              <p role="status" className="progress">
                {phase.name === "sending" ? copy.report.sending : ""}
              </p>
              {phase.name === "refused" ? (
                <p role="alert" className="problem-line">
                  {refusalText(phase.result)}
                </p>
              ) : null}
            </form>
          )}
        </>
      ) : null}
    </dialog>
  );
}
