"use client";

import { useEffect, useRef, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import type { Cut } from "../lib/make/cut.ts";
import { type Outcome, type Refusal, publishWithRetries } from "../lib/publish/client.ts";
import { NAME_MAX, TITLE_MAX, hintFor } from "../lib/publish/hints.ts";
import { keepKey } from "../lib/publish/keep.ts";
import { newRetryKey } from "../lib/publish/retry-key.ts";
import { wireFor } from "../lib/publish/wire.ts";
import { hintText, refusalText } from "../lib/publish/words.ts";

type Phase =
  | { name: "form" }
  | { name: "publishing"; attempt: number; of: number }
  | { name: "refused"; refusal: Refusal }
  | { name: "gaveUp"; outcome: Extract<Outcome, { kind: "gaveUp" }> }
  | { name: "done"; outcome: Extract<Outcome, { kind: "published" }> };

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
  parentId,
  cut,
  p,
  q,
  previewHash,
  apiUrl,
  onClose,
}: {
  parentId: string;
  cut: Cut;
  p: number;
  q: number;
  previewHash: string | null;
  apiUrl: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const [kept, setKept] = useState<"no" | "yes" | "failed">("no");
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
  const canSubmit = !empty(title, TITLE_MAX) && !empty(author, NAME_MAX);

  async function submit(fresh = false) {
    if (busy.current) return; // a second tap while one is in flight does nothing
    const signature = `${parentId}:${cut.start}-${cut.end}:${p}/${q}`;
    if (fresh || attempt.current === null || attempt.current.signature !== signature) {
      attempt.current = { signature, key: newRetryKey() };
    }
    busy.current = true;
    setPhase({ name: "publishing", attempt: 1, of: 1 });
    try {
      const outcome = await publishWithRetries(
        wireFor(apiUrl),
        {
          parent_id: parentId,
          cut: { start: cut.start, end: cut.end },
          speed: { p, q },
          title,
          author,
          retry_key: attempt.current.key,
          ...(previewHash ? { preview_hash: previewHash } : {}),
        },
        {
          sleep,
          onAttempt: (n, of) => setPhase({ name: "publishing", attempt: n, of }),
        },
      );
      if (outcome.kind === "published") setPhase({ name: "done", outcome });
      else if (outcome.kind === "refused") setPhase({ name: "refused", refusal: outcome.refusal });
      else if (outcome.kind === "gaveUp") setPhase({ name: "gaveUp", outcome });
      else setPhase({ name: "form" });
    } finally {
      busy.current = false;
    }
  }

  if (phase.name === "done") {
    const { outcome } = phase;
    const url = new URL(`/p/${outcome.id}`, window.location.href).href;
    return (
      <section className="publish done" aria-labelledby="done-heading">
        <h3 id="done-heading" ref={heading} tabIndex={-1} className="kicker">
          {copy.publish.done.heading}
        </h3>
        <p className="kicker">{copy.publish.done.link}</p>
        <p>
          <a className="link" href={`/p/${outcome.id}`} data-testid="published-link">
            {url}
          </a>
        </p>
        <div className="actions">
          <a className="pill" href={`/p/${outcome.id}`}>
            {copy.publish.done.open}
          </a>
          <a className="pill" href={`/manage/${outcome.id}`}>
            {copy.publish.done.manage}
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
                  f === "author" ? copy.publish.fields.author : copy.publish.fields.title,
                )
                .join(" and "),
            })}
          </p>
        ) : null}
        {outcome.manageKey ? (
          <div className="manage-key">
            <h4 className="kicker">{copy.publish.done.keyHeading}</h4>
            <p>
              <code data-testid="manage-key">{outcome.manageKey}</code>
            </p>
            <p>{copy.publish.done.keyOnce}</p>
            <p>{copy.publish.done.keyIsNot}</p>
            <label className="check">
              <input
                type="checkbox"
                checked={kept === "yes"}
                onChange={(e) => {
                  if (!e.target.checked) return;
                  let storage: Storage | null = null;
                  try {
                    storage = window.localStorage;
                  } catch {
                    /* storage blocked */
                  }
                  setKept(keepKey(storage, outcome.id, outcome.manageKey ?? "") ? "yes" : "failed");
                }}
              />
              <span>
                {copy.publish.done.keep}{" "}
                <span className="gloss">{copy.publish.done.keepGloss}</span>
              </span>
            </label>
            <p role="status" className="refusal">
              {kept === "yes"
                ? copy.publish.done.kept
                : kept === "failed"
                  ? copy.publish.done.keepFailed
                  : ""}
            </p>
          </div>
        ) : (
          <p className="notice">{copy.publish.done.replay}</p>
        )}
      </section>
    );
  }

  const publishing = phase.name === "publishing";
  return (
    <section className="publish" aria-labelledby="publish-heading">
      <h3 id="publish-heading" className="kicker">
        {copy.publish.heading}
      </h3>
      <p className="public">{copy.publish.public}</p>
      <p className="notice">{copy.publish.noAccount}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div ref={titleInput}>
          <Field
            id="publish-title"
            label={copy.publish.title}
            gloss={copy.publish.titleGloss}
            value={title}
            max={TITLE_MAX}
            onChange={setTitle}
          />
        </div>
        <Field
          id="publish-name"
          label={copy.publish.name}
          gloss={copy.publish.nameGloss}
          value={author}
          max={NAME_MAX}
          onChange={setAuthor}
        />
        <div className="actions">
          <button type="submit" className="primary" disabled={!canSubmit || publishing}>
            {copy.publish.submit}
          </button>
          <button type="button" className="pill" onClick={onClose} disabled={publishing}>
            {copy.publish.cancel}
          </button>
        </div>
      </form>
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
