import { copy } from "../lib/copy.ts";

/** The independence line, the about page, and (on the roll) a way to see how it works again. */
export function Footer({ onHow }: { onHow?: (() => void) | undefined } = {}) {
  return (
    <footer className="footer">
      <p>{copy.footer.disclaimer}</p>
      <span className="footer-links">
        <a href="/about">{copy.footer.about}</a>
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
