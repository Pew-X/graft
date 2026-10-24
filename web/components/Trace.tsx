import { traceOf, tracePath } from "../lib/trace/trace.ts";

/**
 * A flip's trace: an oscilloscope screen with a phosphor line drawn from the flip's public id. The
 * screen is always dark, as a real one is, in both themes. Decoration that is caused by data: the same
 * id always draws the same line.
 */
export function Trace({ id, label }: { id: string; label: string }) {
  const d = tracePath(traceOf(id), 300, 84);
  return (
    <svg
      className="trace"
      viewBox="0 0 300 84"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      data-testid="trace"
    >
      <rect className="screen" width="300" height="84" rx="6" />
      <g className="grid" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => (
          <line key={`v${i}`} x1={i * 50} y1="0" x2={i * 50} y2="84" />
        ))}
        <line x1="0" y1="42" x2="300" y2="42" />
        <line x1="0" y1="21" x2="300" y2="21" />
        <line x1="0" y1="63" x2="300" y2="63" />
      </g>
      <path className="beam-glow" d={d} />
      <path className="beam" d={d} />
    </svg>
  );
}
