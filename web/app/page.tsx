import { HomeRoll } from "../components/HomeRoll.tsx";
import { buildBlocks, type StageInput } from "../lib/roll/view.ts";
import snapshot from "../snapshot/chain.json";

// The home page is the seeded chain, read from the snapshot that ships with the build: no request to
// the API is made to open it, so it stays usable when the API is down.
const blocks = buildBlocks(snapshot.stages as StageInput[]);

// Best-effort counts go to the service only if an address was given when the site was built. With
// none, opening the home page makes no request to the service at all.
const publicApi = process.env["GRAFT_PUBLIC_API_URL"]?.replace(/\/+$/, "");
const reportTo = publicApi ? `${publicApi}/v1/events` : undefined;

export default function Home() {
  return (
    <main>
      <HomeRoll blocks={blocks} reportTo={reportTo} apiUrl={publicApi} />
    </main>
  );
}
