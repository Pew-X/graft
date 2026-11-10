"use client";

import { useId, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { typedSpeed } from "../lib/make/percent.ts";

/**
 * A speed typed as a percentage. The editor walks a table of stops, so a number that is not exactly a
 * stop moves to the nearest one, and the line under the field says so ("snapped to 148%").
 */
export function TypedSpeed({ onSet }: { onSet: (stop: number) => void }) {
  const uid = useId();
  const c = copy.make.speed.typed;
  const [text, setText] = useState("");
  const [said, setSaid] = useState("");

  const submit = (): void => {
    const r = typedSpeed(text);
    if (!r.ok) {
      setSaid(c[r.why]);
      return;
    }
    onSet(r.stop);
    setSaid(fill(r.snapped ? c.snapped : c.exact, { percent: r.percent }));
    setText("");
  };

  return (
    <form
      className="typed-speed"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor={`${uid}-pct`} className="gloss">
        {c.label}
      </label>
      <div className="typed-row">
        <input
          id={`${uid}-pct`}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          size={6}
          value={text}
          aria-describedby={`${uid}-said`}
          data-testid="typed-speed"
          onChange={(e) => setText(e.target.value)}
        />
        <span aria-hidden="true">%</span>
        <button type="submit" className="pill">
          {c.set}
        </button>
      </div>
      <p id={`${uid}-said`} role="status" className="hint" data-testid="typed-speed-said">
        {said}
      </p>
    </form>
  );
}
