import { copy } from "../lib/copy.ts";

export function Footer() {
  return (
    <footer className="footer">
      <p>{copy.footer.disclaimer}</p>
      <a href="/about">{copy.footer.about}</a>
    </footer>
  );
}
