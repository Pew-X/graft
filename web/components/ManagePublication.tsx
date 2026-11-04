"use client";

import { useState, useSyncExternalStore } from "react";
import { copy, fill } from "../lib/copy.ts";
import {
  type NoteResult,
  type Result,
  setForkPermission,
  setNote,
  withdraw,
} from "../lib/manage/client.ts";
import { readFeatures } from "../lib/own/features.ts";
import { NOTE_MAX, hintFor } from "../lib/publish/hints.ts";
import { hintText } from "../lib/publish/words.ts";
import { readPublication } from "../lib/manage/read.ts";
import { forgetKey, keptKeys } from "../lib/publish/keep.ts";
import { useAsync } from "../lib/make/use-async.ts";
import { Trace } from "./Trace.tsx";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const noop = () => () => undefined;

/**
 * The maker's two controls for one publication, reached with the manage key. The key is typed here
 * or taken from the browser if the maker chose to keep it there; it is sent in a header with each
 * action and held in nothing but this component's state.
 */
export function ManagePublication({ id, apiUrl }: { id: string; apiUrl: string }) {
  const read = useAsync(`publication:${id}`, (signal) => readPublication(apiUrl, id, signal));
  const hasKept = useSyncExternalStore(
    noop,
    () => (keptKeys(storage())[id] ? "yes" : "no"),
    () => "no",
  );
  // the note controls show only where the service has notes: an older service would refuse the route
  const features = useAsync(`features:${apiUrl}`, (signal) => readFeatures(apiUrl, signal));
  const notesOn = features.status === "ready" && features.value.notes;
  const [key, setKey] = useState("");
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [noteNow, setNoteNow] = useState<{ value: string | null } | null>(null);
  const [noteMessage, setNoteMessage] = useState("");
  const [override, setOverride] = useState<{ forkPermitted?: boolean; withdrawn?: boolean }>({});
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  if (read.status === "loading" || read.status === "idle") {
    return (
      <p className="notice" role="status">
        {copy.manage.loading}
      </p>
    );
  }
  if (read.status === "failed") {
    return (
      <p className="notice" role="status">
        {copy.manage.unreachable}
      </p>
    );
  }
  const shown = read.value;
  if (shown === null)
    return (
      <p className="notice" role="status">
        {copy.manage.notFound}
      </p>
    );

  const withdrawn = override.withdrawn ?? shown.state !== "available";
  const forkPermitted = override.forkPermitted ?? shown.forkPermitted;

  async function act(run: () => Promise<Result>, done: string) {
    if (working) return;
    setWorking(true);
    setMessage("");
    const result = await run();
    setWorking(false);
    setConfirming(false);
    if (result.kind === "done") {
      setOverride({ forkPermitted: result.forkPermitted, withdrawn: result.withdrawn });
      setMessage(done);
    } else {
      setMessage(
        result.kind === "refused"
          ? copy.manage.refused
          : result.kind === "busy"
            ? copy.manage.busy
            : copy.manage.unreachable,
      );
    }
  }
  const fetcher = (url: string, init?: RequestInit) => fetch(url, init);
  const savedNote = noteNow ? noteNow.value : shown.note;
  const draft = noteDraft ?? savedNote ?? "";
  const draftHint = draft === "" ? null : hintFor(draft, NOTE_MAX);
  const noteBlocked =
    draftHint !== null && (draftHint.kind === "tooLong" || draftHint.kind === "character");
  async function saveNote() {
    if (working) return;
    setWorking(true);
    setNoteMessage("");
    const result: NoteResult = await setNote(fetcher, apiUrl, id, key, draft);
    setWorking(false);
    const n = copy.manage.note;
    switch (result.kind) {
      case "saved":
        setNoteNow({ value: result.note });
        setNoteDraft(null);
        setNoteMessage(
          result.note === null ? n.removed : result.adjusted ? n.savedAdjusted : n.saved,
        );
        break;
      case "refused":
        setNoteMessage(copy.manage.refused);
        break;
      case "locked":
        setNoteMessage(n.locked);
        break;
      case "limited":
        setNoteMessage(n.limited);
        break;
      case "closed":
        setNoteMessage(n.closed);
        break;
      case "invalid":
        setNoteMessage(
          fill(n.invalid, {
            rule: (copy.publish.rules as Record<string, string>)[result.rule ?? ""] ?? "a rule",
          }),
        );
        break;
      case "busy":
        setNoteMessage(copy.manage.busy);
        break;
      default:
        setNoteMessage(copy.manage.unreachable);
    }
  }
  const useKept = () => setKey(keptKeys(storage())[id] ?? "");

  return (
    <div className="manage">
      <p>{copy.manage.intro}</p>
      <section className="panel" aria-labelledby="manage-publication">
        <h3 id="manage-publication" className="kicker">
          {copy.manage.publication}
        </h3>
        <p className="sound-title-plain">{shown.title}</p>
        <Trace id={id} label={copy.publish.done.traceLabel} />
        <p className="hint">{copy.publish.done.fixed}</p>
        <p className="hint">
          {withdrawn
            ? copy.manage.withdrawnNow
            : forkPermitted === false
              ? copy.manage.forksClosed
              : copy.manage.forksOpen}
        </p>
      </section>

      <section className="panel" aria-labelledby="manage-key-label">
        <h3 id="manage-key-label" className="kicker">
          {copy.manage.keyLabel}
        </h3>
        <p className="hint">{copy.manage.keyGloss}</p>
        <input
          type="password"
          aria-labelledby="manage-key-label"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        {hasKept === "yes" ? (
          <div className="actions">
            <button type="button" className="pill" onClick={useKept}>
              {copy.manage.useKept}
            </button>
            <button
              type="button"
              className="pill"
              onClick={() => {
                forgetKey(storage(), id);
                setKey("");
                setMessage(copy.manage.forgotten);
              }}
            >
              {copy.manage.forgetKept}
            </button>
          </div>
        ) : null}
      </section>

      {withdrawn || !notesOn ? null : (
        <section className="panel" aria-labelledby="manage-note">
          <h3 id="manage-note" className="kicker">
            {copy.manage.note.heading}
          </h3>
          <p className="hint">{copy.manage.note.gloss}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (key !== "" && !noteBlocked) void saveNote();
            }}
          >
            <label htmlFor="manage-note-input" className="visually-hidden">
              {copy.manage.note.label}
            </label>
            <input
              id="manage-note-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              aria-describedby="manage-note-hint"
              data-testid="manage-note"
              onChange={(e) => setNoteDraft(e.target.value)}
            />
            <p id="manage-note-hint" className="hint">
              {draftHint ? hintText(draftHint) : savedNote === null ? copy.manage.note.none : ""}
            </p>
            <div className="actions">
              <button
                type="submit"
                className="pill"
                disabled={key === "" || working || noteBlocked || draft === (savedNote ?? "")}
              >
                {draft.trim() === "" ? copy.manage.note.clear : copy.manage.note.save}
              </button>
            </div>
          </form>
          <p role="status" className="refusal" data-testid="manage-note-said">
            {noteMessage}
          </p>
        </section>
      )}

      {withdrawn ? null : (
        <section className="panel" aria-labelledby="manage-actions">
          <h3 id="manage-actions" className="kicker">
            {copy.manage.title}
          </h3>
          <p className="hint">{key === "" ? copy.manage.needKey : ""}</p>
          {forkPermitted === false ? (
            <div className="control">
              <button
                type="button"
                className="pill"
                disabled={key === "" || working}
                onClick={() =>
                  void act(
                    () => setForkPermission(fetcher, apiUrl, id, key, true),
                    copy.manage.reopenedDone,
                  )
                }
              >
                {copy.manage.reopen}
              </button>
              <p className="hint">{copy.manage.reopenEffect}</p>
            </div>
          ) : (
            <div className="control">
              <button
                type="button"
                className="pill"
                disabled={key === "" || working}
                onClick={() =>
                  void act(
                    () => setForkPermission(fetcher, apiUrl, id, key, false),
                    copy.manage.closedDone,
                  )
                }
              >
                {copy.manage.close}
              </button>
              <p className="hint">{copy.manage.closeEffect}</p>
            </div>
          )}
          <div className="control">
            {confirming ? (
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={key === "" || working}
                  onClick={() =>
                    void act(() => withdraw(fetcher, apiUrl, id, key), copy.manage.withdrawnDone)
                  }
                >
                  {copy.manage.confirm}
                </button>
                <button type="button" className="pill" onClick={() => setConfirming(false)}>
                  {copy.manage.back}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="pill"
                disabled={key === "" || working}
                onClick={() => setConfirming(true)}
              >
                {copy.manage.withdraw}
              </button>
            )}
            <p className="hint">{copy.manage.withdrawEffect}</p>
          </div>
        </section>
      )}
      <p role="status" className="refusal">
        {message}
      </p>
    </div>
  );
}
