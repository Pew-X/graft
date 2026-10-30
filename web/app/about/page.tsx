import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "../../components/Footer.tsx";
import { copy, fill } from "../../lib/copy.ts";
import { PERFORM_ON } from "../../lib/perform/enabled.ts";
import sources from "../../snapshot/sources.json";

export const metadata: Metadata = { title: copy.about.title, description: copy.site.description };

const list = (claims: Record<string, string>) => (
  <ul>
    {Object.entries(claims).map(([key, text]) => (
      <li key={key}>{text}</li>
    ))}
  </ul>
);

/**
 * One of the three honesty states, its word drawn the way the roll draws it: declared prints crisp, computed
 * is misregistered red and cyan, unknown is pencil. The words are the first of the sentence, up to its colon.
 */
function State({ state, text }: { state: "declared" | "computed" | "unknown"; text: string }) {
  const at = text.indexOf(":");
  return (
    <p className="state-line" data-honesty={state}>
      <span className="state-word">{text.slice(0, at)}</span>
      {text.slice(at)}
    </p>
  );
}

export default function About() {
  const a = copy.about;
  return (
    <>
      <main className="make about">
        <p className="kicker">{a.title}</p>
        <h1 className="picker-title">{a.what.heading}</h1>
        {/* the four dyes of the record, as a rule under the title: the same colours that mark the stages */}
        <div className="dye-rule" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
        <p className="about-sentence">{copy.site.sentence}</p>
        <p>{a.what.body}</p>
        <section>
          <h2 className="kicker">{a.tour.heading}</h2>
          <p>{a.tour.body}</p>
          <p>
            <Link href="/#how" className="tour-link">
              {a.tour.link}
            </Link>
          </p>
        </section>
        {PERFORM_ON ? (
          <section>
            <h2 className="kicker">{a.perform.heading}</h2>
            <p>{a.perform.body}</p>
            <p>{a.perform.keys}</p>
          </section>
        ) : null}
        <section>
          <h2 className="kicker">{a.isNot.heading}</h2>
          <p>{PERFORM_ON ? a.isNot.body : a.isNot.bodyWithoutPerform}</p>
        </section>
        <section>
          <h2 className="kicker">{a.states.heading}</h2>
          <State state="declared" text={a.states.declared} />
          <State state="computed" text={a.states.computed} />
          <State state="unknown" text={a.states.unknown} />
        </section>
        <section>
          <h2 className="kicker">{a.privacy.heading}</h2>
          {list(a.privacy.claims)}
        </section>
        <section>
          <h2 className="kicker">{a.takedown.heading}</h2>
          {list(a.takedown.claims)}
        </section>
        <section>
          <h2 className="kicker">{a.licences.heading}</h2>
          <p>{fill(a.licences.body, { licence: "own work, synthesized for graft" })}</p>
          <ul className="sounds">
            {sources.stages.map((s) => (
              <li key={s.id}>{s.title}</li>
            ))}
          </ul>
        </section>
        <p className="local">{a.footerNote}</p>
      </main>
      <Footer />
    </>
  );
}
