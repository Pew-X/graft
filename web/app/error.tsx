"use client";

import { copy } from "../lib/copy.ts";

// The service did not answer. Nothing was lost, and trying again is one press.
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="quiet" role="alert">
      <h2>{copy.failed.title}</h2>
      <p>{copy.failed.line}</p>
      <button type="button" onClick={reset}>
        {copy.failed.retry}
      </button>
    </main>
  );
}
