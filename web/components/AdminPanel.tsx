"use client";

import { useCallback, useRef, useState } from "react";
import {
  AdminClient,
  Refused,
  ageText,
  hourText,
  type Report,
  type Rollups,
  type SwitchView,
} from "../lib/admin/api.ts";
import { copy, fill } from "../lib/copy.ts";

type Phase = "locked" | "checking" | "open";

/**
 * The operator's page: reports, hide and lift, the two switches and the event path. It is a plain
 * page for one person, on a phone if need be. The secret is typed here, held in this component's
 * memory and sent in a header; it is not in the address, not in storage, and is forgotten on lock or
 * when the page is left. Everything printed from the service is printed as text.
 */
export function AdminPanel({ apiUrl }: { apiUrl: string }) {
  const [phase, setPhase] = useState<Phase>("locked");
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState("");
  const [reports, setReports] = useState<Report[]>([]);
  const [switches, setSwitches] = useState<SwitchView | null>(null);
  const [rollups, setRollups] = useState<Rollups | null>(null);
  const client = useRef<AdminClient | null>(null);

  const load = useCallback(async (admin: AdminClient): Promise<void> => {
    const [view, list, events] = await Promise.all([
      admin.switchView(),
      admin.reports(),
      admin.rollups(),
    ]);
    setSwitches(view);
    setReports(list);
    setRollups(events);
  }, []);

  const lock = (): void => {
    client.current = null;
    setSecret("");
    setReports([]);
    setSwitches(null);
    setRollups(null);
    setPhase("locked");
  };

  const fail = (error: unknown): void => {
    if (error instanceof Refused) {
      lock();
      setMessage(copy.admin.refused);
    } else {
      setMessage(copy.admin.unreachable);
    }
  };

  const submit = async (): Promise<void> => {
    setMessage("");
    setPhase("checking");
    const admin = new AdminClient(apiUrl, secret);
    try {
      await load(admin);
      client.current = admin;
      setPhase("open");
    } catch (error) {
      setPhase("locked");
      fail(error);
    }
  };

  const act = async (run: (admin: AdminClient) => Promise<unknown>): Promise<void> => {
    const admin = client.current;
    if (!admin) return;
    setMessage("");
    try {
      await run(admin);
      await load(admin);
    } catch (error) {
      fail(error);
    }
  };

  if (phase !== "open") {
    return (
      <form
        className="admin-gate"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>{copy.admin.title}</h2>
        <label htmlFor="admin-secret">{copy.admin.secret}</label>
        <input
          id="admin-secret"
          type="password"
          name="operator-secret"
          autoComplete="off"
          spellCheck={false}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
        <button type="submit" disabled={phase === "checking" || secret.length === 0}>
          {copy.admin.open}
        </button>
        <p role="status">{message}</p>
      </form>
    );
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h2>{copy.admin.title}</h2>
        <button type="button" onClick={() => void act(async () => undefined)}>
          {copy.admin.refresh}
        </button>
        <button type="button" onClick={lock}>
          {copy.admin.lock}
        </button>
      </div>
      <p role="status">{message}</p>

      <section aria-labelledby="admin-switches">
        <h3 id="admin-switches">{copy.admin.switches}</h3>
        {switches ? (
          <dl className="admin-switches">
            <div>
              <dt>{copy.admin.publishing}</dt>
              <dd data-publishing={switches.publishing}>
                {switches.publishing ? copy.admin.isOpen : copy.admin.isClosed}
              </dd>
            </div>
            <div>
              <dt>{copy.admin.uploads}</dt>
              <dd data-uploads={switches.uploads}>
                {switches.uploads ? copy.admin.on : copy.admin.off}
              </dd>
            </div>
          </dl>
        ) : null}
        <button
          type="button"
          onClick={() => void act((admin) => admin.setPublishing(!(switches?.publishing ?? true)))}
        >
          {switches?.publishing ? copy.admin.closePublishing : copy.admin.openPublishing}
        </button>
        <p className="hint">{copy.admin.uploadsNote}</p>
      </section>

      <section aria-labelledby="admin-reports">
        <h3 id="admin-reports">{copy.admin.reports}</h3>
        {reports.length === 0 ? <p>{copy.admin.noReports}</p> : null}
        <ul className="admin-reports">
          {reports.map((report) => (
            <li key={report.id} data-state={report.state}>
              <p className="admin-title">
                {report.title} <span className="gloss">{report.author}</span>
              </p>
              <p>
                {report.category} ·{" "}
                {fill(copy.admin.filed, { when: hourText(report.created_at_ms) })}
              </p>
              <p className="admin-note">{report.note ?? copy.admin.noNote}</p>
              <p className="admin-state" data-state={report.state}>
                {copy.admin.state[report.state as keyof typeof copy.admin.state] ?? report.state}
              </p>
              <div className="admin-actions">
                {report.state === "visible" ? (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        void act((admin) => admin.hide(report.publication_id, "withdrawn"))
                      }
                    >
                      {copy.admin.hideWithdrawn}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void act((admin) => admin.hide(report.publication_id, "rights"))
                      }
                    >
                      {copy.admin.hideRights}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void act((admin) => admin.lift(report.publication_id))}
                  >
                    {copy.admin.lift}
                  </button>
                )}
                <a href={`/p/${encodeURIComponent(report.publication_id)}`}>
                  {copy.admin.openChain}
                </a>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="admin-events">
        <h3 id="admin-events">{copy.admin.events}</h3>
        <p className="hint">{copy.admin.eventsNote}</p>
        {rollups ? (
          <>
            <p>
              {fill(copy.admin.relay, {
                n: rollups.relay.unsent,
                age: ageText(rollups.relay.oldest_unsent_age_ms),
              })}
            </p>
            <p>
              {fill(copy.admin.lag, {
                n: rollups.consumer.unapplied,
                age: ageText(rollups.consumer.oldest_unapplied_age_ms),
              })}
            </p>
            {rollups.hours.length === 0 ? (
              <p>{copy.admin.noEvents}</p>
            ) : (
              <div
                className="admin-table"
                role="region"
                aria-label={copy.admin.events}
                tabIndex={0}
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{copy.admin.hour}</th>
                      {kinds(rollups).map((kind) => (
                        <th scope="col" key={kind}>
                          {kind}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rollups.hours.map((hour) => (
                      <tr key={hour.hour_ms}>
                        <th scope="row">{hourText(hour.hour_ms)}</th>
                        {kinds(rollups).map((kind) => (
                          <td key={kind}>{hour.counts[kind] ?? 0}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="hint">{rollups.note}</p>
          </>
        ) : null}
      </section>
    </div>
  );
}

function kinds(rollups: Rollups): string[] {
  return [...new Set(rollups.hours.flatMap((h) => Object.keys(h.counts)))].sort();
}
