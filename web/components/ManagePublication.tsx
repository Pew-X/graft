"use client";

import { useState, useSyncExternalStore } from "react";
import { copy } from "../lib/copy.ts";
import { type Result, setForkPermission, withdraw } from "../lib/manage/client.ts";
import { forgetKey, keptKeys } from "../lib/publish/keep.ts";
import { useAsync } from "../lib/make/use-async.ts";

interface Shown {
  state: string;
  title: string;
  author: string;
  forkPermitted: boolean | null;
}

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
  const read = useAsync(`publication:${id}`, async (signal): Promise<Shown | null> => {
    const response = await fetch(`${apiUrl}/v1/publications/${encodeURIComponent(id)}`, { signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(String(response.status));
    const entry = (await response.json()) as Record<string, unknown>;
    return {
      state: String(entry["state"]),
      title: String(entry["title"] ?? ""),
      author: String(entry["author"] ?? ""),
      forkPermitted: typeof entry["fork_permitted"] === "boolean" ? entry["fork_permitted"] : null,
    };
  });
  const hasKept = useSyncExternalStore(
    noop,
    () => (keptKeys(storage())[id] ? "yes" : "no"),
    () => "no",
  );
  const [key, setKey] = useState("");
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
  const useKept = () => setKey(keptKeys(storage())[id] ?? "");

  return (
    <div className="manage">
      <p>{copy.manage.intro}</p>
      <section className="panel" aria-labelledby="manage-publication">
        <h3 id="manage-publication" className="kicker">
          {copy.manage.publication}
        </h3>
        <p className="sound-title-plain">{shown.title}</p>
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
