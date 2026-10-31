import { copy } from "../lib/copy.ts";

/**
 * What graft is, in five plain steps, for someone who has never seen a lineage of sounds. One source of words
 * (`copy.how`) for the make page and the about page. A native disclosure, so it works without a script, folds
 * away once it has been read, and is a real control for a keyboard and a screen reader.
 */
export function HowItWorks({ open, id = "how" }: { open: boolean; id?: string }) {
  const h = copy.how;
  return (
    <details className="how-card" open={open} data-testid="how-card" id={id}>
      <summary>
        <span className="how-title">{h.heading}</span>
      </summary>
      <p className="how-lead">{h.lead}</p>
      <ol className="how-steps">
        {h.steps.map((s) => (
          <li key={s.name}>
            <span className="how-name">{s.name}</span>
            <span className="how-body">{s.body}</span>
          </li>
        ))}
      </ol>
      <p className="how-own">{h.own}</p>
    </details>
  );
}
