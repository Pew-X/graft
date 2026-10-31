"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { copy } from "../lib/copy.ts";
import { FRAGMENT, fromFragment } from "../lib/sketch/move.ts";
import { ImportQuestion } from "./ImportQuestion.tsx";

/**
 * A sketchbook link arrives in the address fragment (which never reaches a server). On the make page it
 * becomes the question "add these sketches to this browser?"; anywhere else it offers to go to the make
 * page rather than importing out of context. The fragment is removed from the address once the question has
 * been answered, so a reload cannot import twice and Back does not ask again.
 */
export function SketchbookArrival() {
  const path = usePathname();
  const [arrival, setArrival] = useState<{ payload: string | null; n: number }>({
    payload: null,
    n: 0,
  });
  const { payload } = arrival;
  useEffect(() => {
    // every arrival is its own question, even a link identical to the last one
    const look = (): void =>
      setArrival((was) => ({ payload: fromFragment(window.location.hash), n: was.n + 1 }));
    // read after the page is up: the server never sees a fragment
    queueMicrotask(look);
    window.addEventListener("hashchange", look);
    return () => window.removeEventListener("hashchange", look);
  }, [path]);

  const done = useCallback(() => {
    try {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    } catch {
      /* an address that cannot be written is only a link that asks again on reload */
    }
    setArrival((was) => ({ payload: null, n: was.n + 1 }));
  }, []);

  // on a page with the roll, a first visit's narration is not talked over: the offer waits for it to end
  const [narrating, setNarrating] = useState(false);
  useEffect(() => {
    if (payload === null || path === "/make") return undefined;
    const look = (): void => {
      const guide = document.querySelector(".roll")?.getAttribute("data-guide");
      setNarrating(guide === "armed" || guide === "narrating");
    };
    look();
    const timer = window.setInterval(look, 500);
    return () => window.clearInterval(timer);
  }, [payload, path]);

  if (payload === null) return null;
  if (path !== "/make" && narrating) return null;
  if (path === "/make") return <ImportQuestion key={arrival.n} text={payload} onDone={done} />;
  return (
    <div className="sketch-arrival aside" role="status" data-testid="import-elsewhere">
      <p>{copy.sketch.move.elsewhere}</p>
      <div className="actions">
        <a className="pill" href={`/make${FRAGMENT}${payload}`}>
          {copy.sketch.move.goMake}
        </a>
        <button type="button" className="pill" onClick={done}>
          {copy.sketch.move.no}
        </button>
      </div>
    </div>
  );
}
