// The operator's rehearsal (launch gate steps 1 to 3), as commands against a running service. It is
// what ARCHITECTURE.md's runbook does by hand, written down so it can be run again: after a release,
// on staging, or here. Run it through scripts/operator-rehearsal.sh, which starts a private service.
//
//   node scripts/operator-rehearsal.mjs <step> --api <url> --secret <operator secret>
//   steps: hide        publish a source, flip it twice, report it, hide it for `rights`, release it,
//                      then hide it as `withdrawn` (descendants held, then playing)
//          switch      close the kill switch: every write refuses, reads and reports do not; reopen it
//          storage-low against a service whose storage limit leaves almost no room (the service refuses to start with a limit at or below its overshoot bound, 61,440,000 bytes by default): a publish is refused politely
//          storage-ok  the same service with the limit restored: a publish is accepted
//
// It writes only what a visitor could write, through the public interface, and prints each step.
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { api: { type: "string" }, secret: { type: "string" } },
});
const [step] = positionals;
const api = values.api?.replace(/\/+$/, "");
const secret = values.secret;
if (!step || !api || !secret) {
  console.error("usage: operator-rehearsal.mjs <hide|switch|storage-low|storage-ok> --api <url> --secret <s>");
  process.exit(2);
}

const DECLARATION =
  "I made this sound or I have the right to share it. It does not contain anyone's private conversation.";

let failed = 0;
const say = (ok, text) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) failed += 1;
};

async function call(method, path, body, operator = false) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(operator ? { "x-graft-admin-secret": secret } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}
const problem = (r) => String(r.json?.type ?? "").replace("urn:graft:problem:", "");

// One second of a quiet tone, as the canonical bytes the service stores (48 kHz, mono, 16-bit LE).
function tone(hz) {
  const bytes = Buffer.alloc(48_000 * 2);
  for (let i = 0; i < 48_000; i++) {
    bytes.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / 48_000) * 12_000), i * 2);
  }
  return bytes.toString("base64");
}
const key = (label) => `rehearsal-${label.replace(/[^A-Za-z0-9]+/g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const source = (label, hz) =>
  call("POST", "/v1/sources", {
    audio: tone(hz),
    title: `rehearsal ${label}`,
    author: "operator",
    retry_key: key(label),
    declaration: { statement: DECLARATION, basis: "own_recording" },
  });
const flip = (parent, label, p = 3, q = 2) =>
  call("POST", "/v1/publications", {
    parent_id: parent,
    title: `rehearsal ${label}`,
    author: "operator",
    retry_key: key(label),
    cut: { start: 0, end: 24_000 },
    speed: { p, q },
  });
const states = async (leaf) =>
  ((await call("GET", `/v1/chains/${leaf}`)).json?.stages ?? []).map((s) => s.state);
const idOf = (r) => r.json?.id ?? r.json?.publication?.id;

if (step === "hide") {
  const root = await source("root", 220);
  say(root.status === 201, `published a test source (${root.status} ${problem(root)})`);
  const rootId = idOf(root);
  const a = await flip(rootId, "flip a");
  const b = await flip(rootId, "flip b", 2, 1);
  say(a.status === 201 && b.status === 201, "flipped it twice");
  const leaf = idOf(a);

  const report = await call("POST", "/v1/reports", { publication_id: rootId, category: "rights" });
  say(report.status === 201, "filed a report on the source");
  const list = await call("GET", "/admin/reports", undefined, true);
  say(
    list.status === 200 && JSON.stringify(list.json).includes(rootId),
    "the operator's list shows it",
  );

  const hidden = await call("POST", `/admin/publications/${rootId}/hide`, { reason: "rights" }, true);
  say(hidden.status === 200, "hid it with reason rights");
  say(
    (await states(leaf)).join() === "no_longer_here,held",
    `descendants are held while it is hidden for rights (${(await states(leaf)).join()})`,
  );
  const cleared = await call("DELETE", `/admin/publications/${rootId}/hide`, undefined, true);
  say(cleared.status === 200, "cleared the hide");
  say(
    (await states(leaf)).join() === "available,available",
    `released: everything plays again (${(await states(leaf)).join()})`,
  );

  const withdrawn = await call("POST", `/admin/publications/${rootId}/hide`, { reason: "withdrawn" }, true);
  say(withdrawn.status === 200, "hid it with reason withdrawn");
  say(
    (await states(leaf)).join() === "no_longer_here,available",
    `descendants keep playing after a withdrawal (${(await states(leaf)).join()})`,
  );
  await call("DELETE", `/admin/publications/${rootId}/hide`, undefined, true);
} else if (step === "switch") {
  const root = await source("switch root", 330);
  const rootId = idOf(root);
  const closed = await call("PUT", "/admin/switch", { publishing: false }, true);
  say(closed.status === 200, "closed the kill switch");
  const writes = [
    ["publish a flip", await flip(rootId, "closed flip")],
    ["publish a source", await source("closed source", 440)],
    [
      "send a client event",
      await call("POST", "/v1/events", { session: "rehearsal-session-0001", events: [] }),
    ],
  ];
  for (const [name, r] of writes) {
    say(r.status === 503 && problem(r) === "publishing-off", `${name}: refused, publishing-off (${r.status})`);
  }
  say((await call("GET", `/v1/chains/${rootId}`)).status === 200, "reads continue");
  const rep = await call("POST", "/v1/reports", { publication_id: rootId, category: "other" });
  say(rep.status === 201, "a report can still be filed");
  const features = await call("GET", "/v1/features");
  say(features.json?.publishing === false, "/v1/features says publishing is closed");
  say((await call("PUT", "/admin/switch", { publishing: true }, true)).status === 200, "reopened it, no restart");
  say((await flip(rootId, "reopened flip")).status === 201, "a flip is accepted again");
} else if (step === "storage-low") {
  const r = await source("over the threshold", 550);
  say(r.status === 507 || r.status === 503, `refused politely (${r.status} ${problem(r)})`);
  say(problem(r) === "storage-full", `the refusal names the reason (${problem(r)})`);
} else if (step === "storage-ok") {
  const r = await source("under the threshold", 660);
  say(r.status === 201, `accepted once the limit is restored (${r.status} ${problem(r)})`);
} else {
  console.error(`unknown step ${step}`);
  process.exit(2);
}

console.log(failed === 0 ? `${step}: all steps passed` : `${step}: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
