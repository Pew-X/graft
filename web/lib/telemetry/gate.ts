/**
 * Whether the browser says it must not be measured. Global Privacy Control and Do Not Track each
 * count, in the spellings browsers have used, and either one switches off all optional client
 * telemetry: the events, and the error tracker's SDK, which is not even loaded. A browser object
 * that cannot be read is treated as signalling: when in doubt, send nothing.
 */
interface NavigatorLike {
  globalPrivacyControl?: boolean | undefined;
  doNotTrack?: string | null | undefined;
  msDoNotTrack?: string | null | undefined;
}

const on = (value: string | null | undefined): boolean => value === "1" || value === "yes";

export function privacySignalled(
  nav: NavigatorLike,
  win: { doNotTrack?: string | null | undefined } = {},
): boolean {
  try {
    return (
      nav.globalPrivacyControl === true ||
      on(nav.doNotTrack) ||
      on(nav.msDoNotTrack) ||
      on(win.doNotTrack)
    );
  } catch {
    return true;
  }
}
