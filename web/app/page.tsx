import { Footer } from "../components/Footer.tsx";
import { HomeRoll } from "../components/HomeRoll.tsx";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { copy } from "../lib/copy.ts";
import { buildBlocks, type StageInput } from "../lib/roll/view.ts";
import snapshot from "../snapshot/chain.json";

// The home page is the seeded chain, read from the snapshot that ships with the build: no request to
// the API is made to open it, so it stays usable when the API is down.
const blocks = buildBlocks(snapshot.stages as StageInput[]);

export default function Home() {
  return (
    <>
      <header className="masthead">
        <h1>{copy.site.name}</h1>
        <p>{copy.site.line}</p>
        <ThemeToggle />
      </header>
      <main>
        <HomeRoll blocks={blocks} />
      </main>
      <Footer />
    </>
  );
}
