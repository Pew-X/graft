import type { Metadata } from "next";
import { Footer } from "../../components/Footer.tsx";
import { copy, fill } from "../../lib/copy.ts";
import sources from "../../snapshot/sources.json";

export const metadata: Metadata = { title: copy.about.title, description: copy.site.description };

const list = (claims: Record<string, string>) => (
  <ul>
    {Object.entries(claims).map(([key, text]) => (
      <li key={key}>{text}</li>
    ))}
  </ul>
);

export default function About() {
  const a = copy.about;
  return (
    <>
      <main className="make about">
        <p className="kicker">{a.title}</p>
        <h1 className="picker-title">{a.what.heading}</h1>
        <p>{a.what.body}</p>
        <h2 className="kicker">{a.isNot.heading}</h2>
        <p>{a.isNot.body}</p>
        <h2 className="kicker">{a.states.heading}</h2>
        <p>{a.states.declared}</p>
        <p>{a.states.computed}</p>
        <p>{a.states.unknown}</p>
        <h2 className="kicker">{a.privacy.heading}</h2>
        {list(a.privacy.claims)}
        <h2 className="kicker">{a.takedown.heading}</h2>
        {list(a.takedown.claims)}
        <h2 className="kicker">{a.licences.heading}</h2>
        <p>{fill(a.licences.body, { licence: "own work, synthesized for graft" })}</p>
        <ul>
          {sources.stages.map((s) => (
            <li key={s.id}>{s.title}</li>
          ))}
        </ul>
        <p className="local">{a.footerNote}</p>
      </main>
      <Footer />
    </>
  );
}
