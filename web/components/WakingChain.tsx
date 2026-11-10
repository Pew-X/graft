"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy.ts";

/** How often the service is asked whether it is ready, and how long to keep asking before saying so. */
const ASK_EVERY_MS = 5_000;
const ASK_FOR_MS = 4 * 60_000;

type Mood = "waking" | "offline" | "slow";

/**
 * What a chain page shows when the service did not answer because it was asleep: say so, kindly, ask the
 * service every few seconds, and when it answers show the roll without a reload. It tells waking apart from
 * the visitor being offline, and after a few minutes admits it is taking long. The words change only when
 * the situation does, so a screen reader hears each state once, not at every attempt.
 */
export function WakingChain({ apiUrl }: { apiUrl: string }) {
  const router = useRouter();
  const [mood, setMood] = useState<Mood>("waking");
  const [asking, setAsking] = useState(false);
  const started = useRef(0);
  const alive = useRef(true);

  const ask = useCallback(async (): Promise<void> => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setMood("offline");
      return;
    }
    setAsking(true);
    try {
      const response = await fetch(`${apiUrl}/ready`, {
        cache: "no-store",
        signal: AbortSignal.timeout(4_000),
      });
      if (response.ok && alive.current) {
        router.refresh();
        return;
      }
    } catch {
      /* not up yet */
    } finally {
      if (alive.current) setAsking(false);
    }
    if (alive.current) setMood(Date.now() - started.current > ASK_FOR_MS ? "slow" : "waking");
  }, [apiUrl, router]);

  useEffect(() => {
    alive.current = true;
    started.current = Date.now();
    void fetch("/api/wake", { method: "POST", keepalive: true }).catch(() => undefined);
    const first = window.setTimeout(() => void ask(), 1_500);
    const every = window.setInterval(() => void ask(), ASK_EVERY_MS);
    const back = (): void => void ask();
    window.addEventListener("online", back);
    return () => {
      alive.current = false;
      window.clearTimeout(first);
      window.clearInterval(every);
      window.removeEventListener("online", back);
    };
  }, [ask]);

  const w = copy.waking;
  return (
    <main className="make waking" data-testid="waking" data-mood={mood}>
      <div className="make-bar">
        <Link href="/" className="back">
          {copy.make.home}
        </Link>
      </div>
      <h1 className="slab" data-k="up" data-dye="1">
        <span className="slab-text">{w.title}</span>
      </h1>
      <p className="lede">{w.line}</p>
      <p className="waking-status" role="status" aria-live="polite">
        {mood === "offline" ? w.offline : mood === "slow" ? w.slow : w.checking}
      </p>
      <div className="waking-bar" data-asking={asking} aria-hidden="true">
        <span />
      </div>
      <div className="actions">
        <button type="button" className="pill" onClick={() => void ask()}>
          {w.tryNow}
        </button>
        <Link href="/" className="quiet-link">
          {w.home}
        </Link>
      </div>
    </main>
  );
}
