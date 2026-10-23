import Link from "next/link";
import { Footer } from "../components/Footer.tsx";
import { copy } from "../lib/copy.ts";

// A link to a chain that does not exist: a quiet empty state with the right status code, not an error wall.
export default function NotFound() {
  return (
    <>
      <header className="masthead">
        <h1>{copy.site.name}</h1>
      </header>
      <main className="quiet">
        <h2>{copy.notFound.title}</h2>
        <p>{copy.notFound.line}</p>
        <Link href="/">{copy.notFound.home}</Link>
      </main>
      <Footer />
    </>
  );
}
