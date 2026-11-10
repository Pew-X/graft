/**
 * The browser error tracker, behind the same privacy gate as the events. Its code is loaded only when
 * no privacy signal is on and a tracker is configured, so a visitor who sends a signal never downloads
 * or runs it. It is started without a stored address, without session replay, without default
 * integrations or breadcrumbs, and with a scrubber for what remains. The SDK itself is passed in as
 * `load`; none is installed until the operator has a tracker project (ticket 16).
 */
export interface TrackerOptions {
  dsn: string;
  sendDefaultPii: false;
  replaysSessionSampleRate: 0;
  replaysOnErrorSampleRate: 0;
  defaultIntegrations: false;
  maxBreadcrumbs: 0;
  beforeSend: (event: Record<string, unknown>) => Record<string, unknown>;
}
export interface TrackerModule {
  init(options: TrackerOptions): void;
}

/** Keep the message and the page address; remove who and what sent it. */
function scrub(event: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...event };
  delete clean["user"];
  delete clean["contexts"];
  const request = event["request"] as { url?: string } | undefined;
  if (request?.url !== undefined) clean["request"] = { url: request.url };
  else delete clean["request"];
  return clean;
}

export async function startErrorTracking(options: {
  gated: boolean;
  dsn: string | undefined;
  load?: () => Promise<TrackerModule>;
}): Promise<boolean> {
  if (options.gated || !options.dsn || !options.load) return false;
  try {
    const tracker = await options.load();
    tracker.init({
      dsn: options.dsn,
      sendDefaultPii: false,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      defaultIntegrations: false,
      maxBreadcrumbs: 0,
      beforeSend: scrub,
    });
    return true;
  } catch {
    return false;
  }
}
