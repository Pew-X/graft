import Link from "next/link";
import { Footer } from "../components/Footer.tsx";
import { copy } from "../lib/copy.ts";

// A link to a chain that does not exist: a quiet empty state with the right status code, not an error wall.
// It wears the make flow's frame (the way back, a torn slab) so a mistyped link still looks like graft.
export default function NotFound() {
  return (
    <>
      <main className="make">
        <div className="make-bar">
          <Link href="/" className="back">
            {copy.make.home}
          </Link>
        </div>
        <h1 className="slab" data-k="src" data-dye="0">
          <span className="slab-text">{copy.notFound.title}</span>
        </h1>
        <p className="local">{copy.notFound.line}</p>
        <Link href="/" className="quiet-link">
          {copy.notFound.home}
        </Link>
      </main>
      <Footer />
    </>
  );
}
