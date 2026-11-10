"use client";

import Link from "next/link";
import { copy } from "../lib/copy.ts";

// The service did not answer. Nothing was lost, and trying again is one press.
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="make" role="alert">
      <div className="make-bar">
        <Link href="/" className="back">
          {copy.make.home}
        </Link>
      </div>
      <h1 className="slab" data-k="src" data-dye="0">
        <span className="slab-text">{copy.failed.title}</span>
      </h1>
      <p className="local">{copy.failed.line}</p>
      <button type="button" className="quiet-link" onClick={reset}>
        {copy.failed.retry}
      </button>
    </main>
  );
}
