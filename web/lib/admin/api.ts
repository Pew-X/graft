/**
 * The operator's calls to the service. The secret is given to the client and sent in one header
 * (`x-graft-admin-secret`); it is never put in an address, a body, a log or storage. Every kind of
 * refusal of it (wrong, missing, too many tries) is the same `Refused`, so the page can only ever say
 * one thing about it.
 */

export class Refused extends Error {
  constructor() {
    super("not accepted");
    this.name = "Refused";
  }
}

export interface Report {
  id: number;
  publication_id: string;
  category: string;
  note: string | null;
  created_at_ms: number;
  title: string;
  author: string;
  /** "visible", "withdrawn" or "rights". */
  state: string;
  /** The maker's note on the publication now (absent from an older service). */
  maker_note?: string | null;
  /** When the maker last changed it after publishing; a time after `created_at_ms` means it is not the note that was reported. */
  maker_note_updated_at_ms?: number | null;
}
export interface SwitchView {
  publishing: boolean;
  uploads: boolean;
}
export interface Rollups {
  generated_at_ms: number;
  hours: Array<{ hour_ms: number; counts: Record<string, number> }>;
  relay: { unsent: number; oldest_unsent_age_ms: number };
  consumer: {
    unapplied: number;
    oldest_unapplied_age_ms: number;
    applied_since_start: number;
    duplicates_since_start: number;
  };
  note: string;
}

export class AdminClient {
  readonly #base: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;

  constructor(base: string, secret: string, fetcher: typeof fetch = fetch.bind(globalThis)) {
    this.#base = base.replace(/\/+$/, "");
    this.#secret = secret;
    this.#fetch = fetcher;
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "x-graft-admin-secret": this.#secret };
    if (body !== undefined) headers["content-type"] = "application/json";
    const init: RequestInit = {
      method,
      headers,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.#fetch(`${this.#base}${path}`, init);
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw new Refused();
    }
    if (!response.ok) throw new Error(`the service answered ${response.status}`);
    return (await response.json()) as T;
  }

  switchView(): Promise<SwitchView> {
    return this.#call("GET", "/admin/switch");
  }
  setPublishing(open: boolean): Promise<SwitchView> {
    return this.#call("PUT", "/admin/switch", { publishing: open });
  }
  async reports(): Promise<Report[]> {
    return (await this.#call<{ reports: Report[] }>("GET", "/admin/reports")).reports;
  }
  rollups(hours = 24): Promise<Rollups> {
    return this.#call("GET", `/admin/rollups?hours=${hours}`);
  }
  hide(id: string, reason: "withdrawn" | "rights"): Promise<unknown> {
    return this.#call("POST", `/admin/publications/${encodeURIComponent(id)}/hide`, { reason });
  }
  lift(id: string): Promise<unknown> {
    return this.#call("DELETE", `/admin/publications/${encodeURIComponent(id)}/hide`);
  }
}

/** "none waiting", "under a second", "42 seconds", "2 minutes", "2 hours". */
export function ageText(ms: number): string {
  if (ms <= 0) return "none waiting";
  if (ms < 1_000) return "under a second";
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** An hour as "2026-10-23 14:00 utc". */
export function hourText(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} utc`;
}
