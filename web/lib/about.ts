/**
 * The claims the about page makes about what graft does and does not do, each tied to the test that
 * would fail if it stopped being true. `lib/about.test.ts` checks that every named test exists in
 * the named file, so a claim cannot outlive the evidence for it unnoticed.
 */
import { copy } from "./copy.ts";

export interface Claim {
  text: string;
  /** Files (from the repository root) and the name of a test in each. */
  evidence: ReadonlyArray<{ file: string; test: string }>;
}

const p = copy.about.privacy.claims;
const t = copy.about.takedown.claims;

export const privacyClaims: readonly Claim[] = [
  {
    text: p.session,
    evidence: [
      {
        file: "web/e2e/service/telemetry.spec.ts",
        test: "after a full session the browser holds no session id, no event and no cookie",
      },
    ],
  },
  {
    text: p.signal,
    evidence: [
      {
        file: "web/e2e/service/telemetry.spec.ts",
        test: "no request is made to the events endpoint or a tracker",
      },
      {
        file: "web/lib/telemetry/gate.test.ts",
        test: "Global Privacy Control switches telemetry off",
      },
    ],
  },
  {
    text: p.wake,
    evidence: [
      {
        file: "web/lib/wake/forward.test.ts",
        test: "with its settings it posts once to the function with the secret in a header, and the secret nowhere else",
      },
      {
        file: "web/e2e/wake.spec.ts",
        test: "opening the site asks the site's own server to wake the service, once, and a reload does not ask again",
      },
    ],
  },
  {
    text: p.noIp,
    evidence: [
      {
        file: "crates/api/tests/ip_logs.rs",
        test: "no_address_appears_in_any_stored_row_log_line_or_metric",
      },
    ],
  },
  {
    text: p.tracker,
    evidence: [
      {
        file: "web/lib/telemetry/tracker.test.ts",
        test: "when allowed it starts with no address stored, no replay, no default integrations and a scrubber",
      },
    ],
  },
  {
    text: p.browser,
    evidence: [
      {
        file: "web/e2e/service/publish.spec.ts",
        test: "the key is kept in this browser only when the maker chooses",
      },
      {
        file: "web/e2e/guide.spec.ts",
        test: "the browser keeps one key with one of three words, and nothing else",
      },
    ],
  },
];

export const takedownClaims: readonly Claim[] = [
  {
    text: t.report,
    evidence: [
      { file: "web/e2e/service/manage.spec.ts", test: "a report from the roll is stored" },
    ],
  },
  {
    text: t.hidden,
    evidence: [
      {
        file: "crates/api/tests/maker.rs",
        test: "withdrawing_keeps_the_credit_stops_the_audio_keeps_the_chain_whole_and_lets_descendants_play",
      },
    ],
  },
  {
    text: t.rights,
    evidence: [
      {
        file: "crates/api/tests/moderation.rs",
        test: "hiding_for_rights_holds_every_descendant_and_serves_no_audio_for_them",
      },
    ],
  },
  {
    text: t.expire,
    evidence: [
      {
        file: "crates/api/tests/s3_end_to_end.rs",
        test: "audio_published_through_the_api_is_served_from_a_signed_url_and_equals_the_reference_render",
      },
    ],
  },
  { text: t.copies, evidence: [] },
];
