import { copy } from "../lib/copy.ts";

/** Where the maker is in the three steps, so nobody has to guess what comes next. */
export function Steps({ current }: { current: 1 | 2 | 3 }) {
  const items = [copy.make.steps.pick, copy.make.steps.cut, copy.make.steps.publish];
  return (
    <ol className="steps" data-testid="steps" aria-label={copy.make.steps.label}>
      {items.map((text, i) => (
        <li
          key={text}
          aria-current={current === i + 1 ? "step" : undefined}
          data-state={current > i + 1 ? "done" : current === i + 1 ? "now" : "next"}
        >
          <span className="n" aria-hidden="true">
            {i + 1}
          </span>
          {text}
        </li>
      ))}
    </ol>
  );
}
