"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import {
  type Outcome,
  type PublishBody,
  type PublishSourceBody,
  type Refusal,
  publishWithRetries,
} from "../lib/publish/client.ts";
import { NAME_MAX, NOTE_MAX, TITLE_MAX, hintFor } from "../lib/publish/hints.ts";
import { forgetKey, keepKey } from "../lib/publish/keep.ts";
import { Trace } from "./Trace.tsx";
import { newRetryKey } from "../lib/publish/retry-key.ts";
import { wireFor } from "../lib/publish/wire.ts";
import { hintText, refusalText } from "../lib/publish/words.ts";

type Phase =
  | { name: "form" }
  | { name: "publishing"; attempt: number; of: number }
  | { name: "refused"; refusal: Refusal }
  | { name: "gaveUp"; outcome: Extract<Outcome, { kind: "gaveUp" }> }
  | { name: "done"; outcome: Extract<Outcome, { kind: "published" }> };

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // storage blocked
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function Field({
  id,
  label,
  gloss,
  value,
  max,
  onChange,
}: {
  id: string;
  label: string;
  gloss: string;
  value: string;
  max: number;
  onChange: (value: string) => void;
}) {
  const hint = value === "" ? null : hintFor(value, max);
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} <span className="gloss">{gloss}</span>
      </label>
      <input
        id={id}
        type="text"
        value={value}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={`${id}-hint`}
        aria-invalid={hint !== null && hint.kind !== "adjusted"}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={`${id}-hint`} className="hint">
        {hint ? hintText(hint) : ""}
      </p>
    </div>
  );
}

/**
 * The last, optional step of making: a title and a name, a plain statement that publishing is
 * public, and the publish. The same retry key goes out on every try of one attempt.
 */
export function PublishStep({
  signature,
  buildBody,
  path = "/v1/publications",
  heading: headingText = copy.publish.heading,
  statement = copy.publish.public,
  gate = true,
  gateWhy = null,
  apiUrl,
  onClose,
  onPublished,
  retryKey: given,
  kind,
  stage = null,
  fromTitle = null,
  folded = false,
  noteEnabled = false,
  initialNote = "",
  children,
}: {
  /** What is being published, as a string: a different thing is a different attempt, with its own key. */
  signature: string;
  buildBody: (fields: {
    title: string;
    author: string;
    /** The note, cleaned of surrounding space; empty when there is none (or notes are off). */
    note: string;
    retryKey: string;
  }) => PublishBody | PublishSourceBody;
  path?: string;
  heading?: string;
  statement?: string;
  /** Anything else that must be true before the button works (a declaration ticked). */
  gate?: boolean;
  /** Why the gate is closed, said beside the button. */
  gateWhy?: string | null;
  apiUrl: string;
  onClose: () => void;
  onPublished?: (id: string, title: string) => void;
  /** A key made earlier for exactly this flip (a sketch's own), used instead of a fresh one for the first attempt. */
  retryKey?: string;
  /** What is being published, so the finished panel can name it ("the source: ...", "stage 2: ..."). */
  kind?: "source" | "flip";
  /** The stage number a flip will have (its parent's plus one), when known. */
  stage?: number | null;
  /** The title of the stage it is made from, when known. */
  fromTitle?: string | null;
  /** A newer stage stands on this one: show one line instead of the whole panel (never while its key is unsafe). */
  folded?: boolean;
  /** The service has notes, so the form offers one. Off for an older service, which would refuse the field. */
  noteEnabled?: boolean;
  /** A note to start from (a sketch's own). */
  initialNote?: string;
  /** Extra fields between the name and the button. */
  children?: ReactNode;
}) {
  const uid = useId();
  const router = useRouter();
  const [warned, setWarned] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [note, setNote] = useState(initialNote);
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const [keyCopied, setKeyCopied] = useState<"no" | "yes" | "failed">("no");
  // the key is kept in this browser as soon as it is shown (so the flip is listed under "your flips"), and
  // unticking the box forgets it again
  const [kept, setKept] = useState<"no" | "yes" | "failed" | "forgotten">("no");
  const heading = useRef<HTMLHeadingElement>(null);
  const message = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLDivElement>(null);
  // One key for one attempt at one flip. A different cut or speed is a different attempt.
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    titleInput.current?.querySelector("input")?.focus();
  }, []);
  const name = phase.name;
  useEffect(() => {
    if (name === "done") heading.current?.focus();
    if (name === "refused" || name === "gaveUp") message.current?.focus();
  }, [name]);

  const empty = (value: string, max: number) => hintFor(value, max)?.kind === "empty";
  const canSubmit = !empty(title, TITLE_MAX) && !empty(author, NAME_MAX) && gate;

  async function submit(fresh = false) {
    if (busy.current) return; // a second tap while one is in flight does nothing
    if (fresh || attempt.current === null || attempt.current.signature !== signature) {
      attempt.current = { signature, key: !fresh && given !== undefined ? given : newRetryKey() };
    }
    busy.current = true;
    setPhase({ name: "publishing", attempt: 1, of: 1 });
    try {
      const outcome = await publishWithRetries(
        wireFor(apiUrl, path),
        buildBody({
          title,
          author,
          note: noteEnabled ? note.trim() : "",
          retryKey: attempt.current.key,
        }),
        {
          sleep,
          onAttempt: (n, of) => setPhase({ name: "publishing", attempt: n, of }),
        },
      );
      if (outcome.kind === "published") {
        if (outcome.manageKey)
          setKept(keepKey(browserStorage(), outcome.id, outcome.manageKey) ? "yes" : "failed");
        setPhase({ name: "done", outcome });
        onPublished?.(outcome.id, title);
      } else if (outcome.kind === "refused")
        setPhase({ name: "refused", refusal: outcome.refusal });
      else if (outcome.kind === "gaveUp") {
        // a service that did not answer may be asleep: ask the site's server to wake it
        if (outcome.why === "network")
          void fetch("/api/wake", { method: "POST" }).catch(() => undefined);
        setPhase({ name: "gaveUp", outcome });
      } else setPhase({ name: "form" });
    } finally {
      busy.current = false;
    }
  }

  if (phase.name === "done") {
    const { outcome } = phase;
    const url = new URL(`/p/${outcome.id}`, window.location.href).href;
    const named =
      kind === "source"
        ? fill(copy.publish.done.namedSource, { title })
        : kind === "flip" && stage !== null
          ? fill(fromTitle ? copy.publish.done.namedFlipFrom : copy.publish.done.namedFlip, {
              n: String(stage),
              title,
              parent: fromTitle ?? "",
            })
          : null;
    const keySafe = outcome.manageKey === null || kept === "yes" || keyCopied === "yes";
    if (folded && keySafe) {
      // an older stage with a newer one standing on it: one line, with the way to its page and its key
      return (
        <section className="publish done folded" aria-label={named ?? copy.publish.done.folded}>
          <p className="folded-line">
            <span className="kicker">{copy.publish.done.folded}</span>{" "}
            <strong>{named ?? title}</strong>{" "}
            <a className="link" href={`/p/${outcome.id}`} data-testid="published-link">
              {url}
            </a>{" "}
            <a className="pill" href={`/manage/${outcome.id}`}>
              {copy.publish.done.manage}
            </a>
          </p>
        </section>
      );
    }
    return (
      <section className="publish done" aria-labelledby={`${uid}-done`}>
        <h3 id={`${uid}-done`} ref={heading} tabIndex={-1} className="kicker">
          {copy.publish.done.heading}
        </h3>
        {named ? <p className="named">{named}</p> : null}
        <p className="kicker">
          {kind === "source" ? copy.publish.done.linkSource : copy.publish.done.link}
        </p>
        <p>
          <a className="link" href={`/p/${outcome.id}`} data-testid="published-link">
            {url}
          </a>
        </p>
        <div className="actions">
          {/* the next stage is made from this one, in this tab. The ticket below is shown once: when it is
              neither kept in this browser nor copied, the first press warns and the second leaves. */}
          <button
            type="button"
            className="primary"
            data-testid="flip-next"
            onClick={() => {
              const safe = outcome.manageKey === null || kept === "yes" || keyCopied === "yes";
              if (!safe && !warned) {
                setWarned(true);
                return;
              }
              router.push(`/make?from=${outcome.id}`);
            }}
          >
            {copy.publish.done.next}
          </button>
          {/* a new tab, so this screen is still here when they come back */}
          <a className="pill" href={`/p/${outcome.id}`} target="_blank" rel="noopener">
            {copy.publish.done.open}
          </a>
          <a className="pill" href={`/manage/${outcome.id}`}>
            {copy.publish.done.manage}
          </a>
          <a className="pill" href="/flips" target="_blank" rel="noopener">
            {copy.publish.done.flips}
          </a>
          <button
            type="button"
            className="pill"
            onClick={() => {
              navigator.clipboard.writeText(url).then(
                () => setCopied("yes"),
                () => setCopied("failed"),
              );
            }}
          >
            {copy.publish.done.copy}
          </button>
          <span role="status" className="refusal">
            {copied === "yes"
              ? copy.publish.done.copied
              : copied === "failed"
                ? copy.publish.done.copyFailed
                : ""}
          </span>
        </div>
        {named ? <p className="hint">{copy.publish.done.nextNote}</p> : null}
        {warned ? (
          <p className="notice" role="alert">
            {copy.publish.done.leaveWarn}
          </p>
        ) : null}
        {outcome.previewMatches === false ? (
          <p className="notice" role="status">
            {copy.publish.done.mismatch}
          </p>
        ) : null}
        {outcome.adjusted.length > 0 ? (
          <p className="notice" role="status">
            {fill(copy.publish.adjusted, {
              fields: outcome.adjusted
                .map((f) =>
                  f === "author"
                    ? copy.publish.fields.author
                    : f === "note"
                      ? copy.publish.fields.note
                      : copy.publish.fields.title,
                )
                .join(" and "),
            })}
          </p>
        ) : null}
        <p className="fixed-note">{copy.publish.done.fixed}</p>
        {outcome.manageKey ? (
          <div
            className="manage-key stub"
            data-testid="key-stub"
            data-torn={keyCopied === "yes" ? "yes" : "no"}
          >
            <div className="stub-screen">
              <Trace id={outcome.id} label={copy.publish.done.traceLabel} />
              <p className="stub-caption">{copy.publish.done.traceCaption}</p>
            </div>
            <div className="stub-body">
              <h4 className="kicker">{copy.publish.done.keyHeading}</h4>
              <p className="stub-hand" aria-hidden="true">
                {copy.publish.done.stubHand}
              </p>
              <p>
                <code data-testid="manage-key">{outcome.manageKey}</code>
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="pill"
                  onClick={() => {
                    navigator.clipboard.writeText(outcome.manageKey ?? "").then(
                      () => setKeyCopied("yes"),
                      () => setKeyCopied("failed"),
                    );
                  }}
                >
                  {copy.publish.done.copyKey}
                </button>
                <span role="status" className="refusal">
                  {keyCopied === "yes"
                    ? copy.publish.done.keyCopied
                    : keyCopied === "failed"
                      ? copy.publish.done.keyCopyFailed
                      : ""}
                </span>
              </div>
              <p>{copy.publish.done.keyWhat}</p>
              <p>{copy.publish.done.keyOnce}</p>
              <p>{copy.publish.done.keyIsNot}</p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={kept === "yes"}
                  onChange={(e) => {
                    if (!e.target.checked) {
                      forgetKey(browserStorage(), outcome.id);
                      setKept("forgotten");
                      return;
                    }
                    setKept(
                      keepKey(browserStorage(), outcome.id, outcome.manageKey ?? "")
                        ? "yes"
                        : "failed",
                    );
                  }}
                />
                <span>
                  {copy.publish.done.keep}{" "}
                  <span className="gloss">{copy.publish.done.keepGloss}</span>
                </span>
              </label>
              <p role="status" className="refusal stub-punch">
                <span className="hole" data-punched={kept === "yes"} aria-hidden="true" />
                {kept === "yes"
                  ? copy.publish.done.kept
                  : kept === "failed"
                    ? copy.publish.done.keepFailed
                    : kept === "forgotten"
                      ? copy.publish.done.forgotten
                      : ""}
              </p>
            </div>
          </div>
        ) : (
          <p className="notice">{copy.publish.done.replay}</p>
        )}
      </section>
    );
  }

  const publishing = phase.name === "publishing";
  return (
    <section className="publish" aria-labelledby={`${uid}-heading`}>
      <h3 id={`${uid}-heading`} className="kicker">
        {headingText}
      </h3>
      <p className="public">{statement}</p>
      <p className="notice">{copy.publish.noAccount}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div ref={titleInput}>
          <Field
            id={`${uid}-title`}
            label={copy.publish.title}
            gloss={copy.publish.titleGloss}
            value={title}
            max={TITLE_MAX}
            onChange={setTitle}
          />
        </div>
        <Field
          id={`${uid}-name`}
          label={copy.publish.name}
          gloss={copy.publish.nameGloss}
          value={author}
          max={NAME_MAX}
          onChange={setAuthor}
        />
        {noteEnabled ? (
          <Field
            id={`${uid}-note`}
            label={copy.publish.note}
            gloss={copy.publish.noteGloss}
            value={note}
            max={NOTE_MAX}
            onChange={setNote}
          />
        ) : null}
        {children}
        <div className="actions">
          <button
            type="submit"
            className="primary"
            disabled={!canSubmit || publishing}
            aria-describedby={`${uid}-why`}
          >
            {copy.publish.submit}
          </button>
          <button type="button" className="pill" onClick={onClose} disabled={publishing}>
            {copy.publish.cancel}
          </button>
        </div>
      </form>
      <p id={`${uid}-why`} className="hint">
        {gate ? "" : gateWhy}
      </p>
      <p role="status" className="progress">
        {phase.name === "publishing"
          ? phase.attempt > 1
            ? fill(copy.publish.trying, { n: phase.attempt, of: phase.of })
            : copy.publish.publishing
          : ""}
      </p>
      <div ref={message} tabIndex={-1} role="alert" className="problem">
        {phase.name === "refused" ? (
          <>
            <p>{refusalText(phase.refusal)}</p>
            {phase.refusal.kind === "conflict" ? (
              <button type="button" className="pill" onClick={() => void submit(true)}>
                {copy.publish.fresh}
              </button>
            ) : phase.refusal.kind === "internal" ||
              phase.refusal.kind === "rateLimited" ||
              phase.refusal.kind === "publishCap" ||
              phase.refusal.kind === "forkCap" ||
              phase.refusal.kind === "publishingOff" ||
              phase.refusal.kind === "storageFull" ? (
              <button type="button" className="pill" onClick={() => void submit()}>
                {copy.publish.retry}
              </button>
            ) : null}
          </>
        ) : phase.name === "gaveUp" ? (
          <>
            <p>
              {fill(copy.publish.gaveUp[phase.outcome.why], { attempts: phase.outcome.attempts })}
            </p>
            <button type="button" className="pill" onClick={() => void submit()}>
              {copy.publish.retry}
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
