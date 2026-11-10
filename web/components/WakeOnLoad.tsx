"use client";

import { useEffect } from "react";

/**
 * When any page of the site opens, quietly ask the site's own server to wake the service. It never blocks
 * or shows anything, and a failure is invisible. A reload does not ask again (so reloading a page five
 * times asks once), which needs no storage: the browser says how the page was reached.
 */
export function WakeOnLoad() {
  useEffect(() => {
    const entry = performance.getEntriesByType?.("navigation")[0] as
      PerformanceNavigationTiming | undefined;
    if (entry?.type === "reload") return;
    void fetch("/api/wake", { method: "POST", keepalive: true }).catch(() => undefined);
  }, []);
  return null;
}
