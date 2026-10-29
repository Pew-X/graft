import { copy } from "../lib/copy.ts";

/** The independence line, the about page, and (on the roll) a way to see how it works again. */
export function Footer({
  onHow,
  flipsHref,
}: {
  onHow?: (() => void) | undefined;
  /** The list of the flips this browser holds a key for, when it holds any. */
  flipsHref?: string | undefined;
} = {}) {
  return (
    <footer className="footer">
      <p>{copy.footer.disclaimer}</p>
      <span className="footer-links">
        <a href="/about">{copy.footer.about}</a>
        {flipsHref ? <a href={flipsHref}>{copy.footer.flips}</a> : null}
        {onHow ? (
          <button type="button" className="how-link" onClick={onHow}>
            <span className="how-mark" aria-hidden="true">
              {copy.footer.howMark}
            </span>
            <span className="how-label">{copy.footer.how}</span>
          </button>
        ) : null}
      </span>
    </footer>
  );
}
