// The load test for the service: reads of chains at several depths, publishes of flips (one stage and
// many stages, duplicate retry keys, same key with different content), a mixed run, and a ramp that
// meets the configured limits. It is run by k6 against a staging service (or a local one), never
// against production: the guard below refuses to start otherwise.
//
//   k6 run -e BASE_URL=https://staging.example.com -e SEED_LEAF=<id of the seeded chain's last stage> loadtest/graft.js
//
// What it measures and what it does not is in ARCHITECTURE.md, "Measured numbers". It asserts
// correctness, not speed: every accepted publish is readable, a repeated retry key returns the same
// publication, a retry key reused for other content is a named conflict, and the client's counts
// reconcile with the service's own counters and with the database's `flipped_count`.
import http from "k6/http";
import { check } from "k6";
import { Counter, Gauge, Trend } from "k6/metrics";
import { checkTarget } from "./guard.mjs";

const BASE = (__ENV.BASE_URL || "").replace(/\/+$/, "");
const verdict = checkTarget(BASE, {
  allowedHosts: __ENV.ALLOWED_HOSTS,
  productionHosts: __ENV.PRODUCTION_HOSTS,
});
if (!verdict.ok) throw new Error(`refusing to run: ${verdict.reason}`);
const SEED_LEAF = __ENV.SEED_LEAF || "";
if (SEED_LEAF === "") throw new Error("SEED_LEAF is required: the id of the seeded chain's last stage");

// A short run for checking the script, or the full one. The rates are per second.
const PROFILE = __ENV.PROFILE === "full" ? "full" : "smoke";
const SECS = PROFILE === "full" ? 60 : 8;
const READ_RATE = Number(__ENV.READ_RATE || (PROFILE === "full" ? 60 : 15));
const WRITE_RATE = Number(__ENV.WRITE_RATE || (PROFILE === "full" ? 6 : 3));
const RAMP_TO = Number(__ENV.RAMP_TO || (PROFILE === "full" ? 12 : 6));
// A short cut of every parent (0.1 s). At half speed it makes a stage of 9,600 frames whatever the parent, so
// a chain of any depth can be built and every parent is long enough.
const CUT = 4800;
const DUPLICATE_SHARE = 0.15; // of accepted publishes, the share repeated with the same key and content
const CONFLICT_SHARE = 0.1; // of accepted publishes, the share repeated with the same key and other content

// What is counted, by what became of each request.
const created = new Counter("flips_created");
const replayed = new Counter("flips_replayed");
const conflicts = new Counter("key_conflicts_expected");
const refused = new Counter("refused_politely"); // rate limits, caps, retry-later: named, never errors
const trueErrors = new Counter("true_errors"); // network failures and 5xx (not a polite 503), or an unexpected answer
const unreadable = new Counter("accepted_but_unreadable");
const replayDiffers = new Counter("replay_returned_other_publication");
const conflictMissed = new Counter("conflict_not_named");
const readsOk = new Counter("chain_reads_ok");
const publishMs = new Trend("publish_ms", true);
const chainReadMs = new Trend("chain_read_ms", true);
// Set once, at the end, from the service's own numbers.
const serverCreated = new Gauge("server_created_delta");
const serverReplayed = new Gauge("server_replayed_delta");
const serverRefusedTotal = new Gauge("server_refused_delta");
const dbFlipped = new Gauge("db_flipped_count_delta");

// 2xx are answers, 409 and 429 and 503 are polite refusals we count ourselves; anything else is a failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409, 429, 503));

const POLITE = new Set([
  "rate-limited",
  "publish-cap",
  "fork-cap",
  "storage-full",
  "publishing-off",
  "retry-later",
  "depth-cap",
]);
const SPEEDS = [
  [1, 2],
  [3, 2],
  [2, 1],
];
const RUN = Date.now().toString(36);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const problemType = (res) => {
  try {
    return String(res.json("type")).replace("urn:graft:problem:", "");
  } catch (_) {
    return "";
  }
};
let counter = 0;
const newKey = () => `lt-${RUN}-${__VU}-${__ITER}-${counter++}`;

const JSON_HEADERS = { headers: { "content-type": "application/json" } };
function postFlip(parent, key, speed, end) {
  const body = {
    parent_id: parent,
    title: "loadtest flip",
    author: "k6-loadtest",
    retry_key: key,
    cut: { start: 0, end },
    speed: { p: speed[0], q: speed[1] },
  };
  const res = http.post(`${BASE}/v1/publications`, JSON.stringify(body), {
    ...JSON_HEADERS,
    tags: { name: "POST /v1/publications" },
  });
  return res;
}

/** Sort an answer into one of the counters; returns "created", "replay", "conflict", "refused" or "error". */
function tally(res) {
  if (res.status === 201) {
    created.add(1);
    publishMs.add(res.timings.duration);
    return "created";
  }
  if (res.status === 200) {
    replayed.add(1);
    return "replay";
  }
  const type = problemType(res);
  if (res.status === 409 && type === "key-conflict") return "conflict";
  if (POLITE.has(type)) {
    refused.add(1, { reason: type });
    return "refused";
  }
  trueErrors.add(1, { status: String(res.status), type });
  return "error";
}

const idOf = (res) => {
  try {
    return res.json("publication.id");
  } catch (_) {
    return null;
  }
};

/** An accepted publish must be readable at once, as the last stage of its own chain. */
function readBack(id) {
  const res = http.get(`${BASE}/v1/chains/${id}`, { tags: { name: "GET /v1/chains/{id}" } });
  let last = null;
  try {
    last = res.json("stages").at(-1).id;
  } catch (_) {
    /* not a chain */
  }
  if (res.status === 200 && last === id) readsOk.add(1);
  else unreadable.add(1);
}

function write(pool) {
  const parent = pick(pool);
  const key = newKey();
  const speed = pick(SPEEDS);
  const res = postFlip(parent, key, speed, CUT);
  if (tally(res) !== "created") return;
  const id = idOf(res);
  readBack(id);
  const roll = Math.random();
  if (roll < DUPLICATE_SHARE) {
    const again = postFlip(parent, key, speed, CUT);
    if (tally(again) === "replay" && idOf(again) === id) return;
    replayDiffers.add(1);
  } else if (roll < DUPLICATE_SHARE + CONFLICT_SHARE) {
    const other = postFlip(parent, key, speed, CUT - 100); // the same key, a different cut
    if (tally(other) === "conflict") conflicts.add(1);
    else conflictMissed.add(1);
  }
}

function read(data) {
  const depth = pick(data.depths);
  const res = http.get(`${BASE}/v1/chains/${data.leaves[depth]}`, {
    tags: { name: "GET /v1/chains/{id}", depth: String(depth) },
  });
  chainReadMs.add(res.timings.duration, { depth: String(depth) });
  const ok = check(res, {
    "the chain is read": (r) => r.status === 200,
    "it has the depth that was asked for": (r) => {
      try {
        return r.json("stages").length === depth;
      } catch (_) {
        return false;
      }
    },
  });
  if (ok) readsOk.add(1);
  else trueErrors.add(1, { status: String(res.status), type: "chain-read" });
  const one = http.get(`${BASE}/v1/publications/${pick(data.pool)}`, {
    tags: { name: "GET /v1/publications/{id}" },
  });
  if (one.status !== 200) trueErrors.add(1, { status: String(one.status), type: "publication-read" });
}

export const options = {
  scenarios: {
    read: {
      executor: "constant-arrival-rate",
      exec: "readScenario",
      rate: READ_RATE,
      timeUnit: "1s",
      duration: `${SECS}s`,
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
    write_one_stage: {
      executor: "constant-arrival-rate",
      exec: "writeOneStage",
      startTime: `${SECS + 2}s`,
      rate: WRITE_RATE,
      timeUnit: "1s",
      duration: `${SECS}s`,
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
    write_many_stages: {
      executor: "constant-arrival-rate",
      exec: "writeManyStages",
      startTime: `${(SECS + 2) * 2}s`,
      rate: WRITE_RATE,
      timeUnit: "1s",
      duration: `${SECS}s`,
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
    mixed: {
      executor: "constant-arrival-rate",
      exec: "mixedScenario",
      startTime: `${(SECS + 2) * 3}s`,
      rate: READ_RATE,
      timeUnit: "1s",
      duration: `${SECS}s`,
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
    // Up to the configured limits: the refusals it meets are the limits working, counted apart from errors.
    ramp_to_the_limits: {
      executor: "ramping-arrival-rate",
      exec: "writeManyStages",
      startTime: `${(SECS + 2) * 4}s`,
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: 20,
      maxVUs: 100,
      stages: [{ target: RAMP_TO, duration: `${SECS}s` }],
    },
  },
  // Correctness gates only. Latency is reported, never gated: there is no claim to defend with a number.
  thresholds: {
    true_errors: ["count==0"],
    accepted_but_unreadable: ["count==0"],
    replay_returned_other_publication: ["count==0"],
    conflict_not_named: ["count==0"],
  },
  summaryTrendStats: ["min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const outcomes = (text) => {
  const found = {};
  const re = /^graft_publish_outcomes_total\{kind="flip",outcome="([^"]+)"\} (\d+)/gm;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) found[m[1]] = Number(m[2]);
  return found;
};
const serverView = (pool) => {
  const metrics = http.get(`${BASE}/metrics`, { tags: { name: "GET /metrics" } });
  const counts = pool.map((id) => {
    const r = http.get(`${BASE}/v1/publications/${id}`, { tags: { name: "GET /v1/publications/{id}" } });
    // One entry, not wrapped (only a publish answer wraps it).
    const n = r.status === 200 ? r.json("flipped_count") : null;
    if (typeof n !== "number") throw new Error(`could not read the flipped count of ${id} (${r.status})`);
    return n;
  });
  return { metrics: metrics.status === 200 ? metrics.body : null, flipped: counts };
};

// Build chains at stated depths from the seeded chain's last stage (a chain of four), by publishing
// flips one after another. The depth cap is 12, so the deepest chain is the cap itself.
export function setup() {
  const ready = http.get(`${BASE}/ready`);
  if (ready.status !== 200) throw new Error(`the service is not ready (${ready.status})`);
  const seeded = http.get(`${BASE}/v1/chains/${SEED_LEAF}`).json("stages").map((s) => s.id);
  const leaves = { [seeded.length]: SEED_LEAF };
  const pool = [...seeded];
  // The baseline is taken before anything this run publishes, so the build below is counted too.
  const before = serverView(pool);
  let parent = SEED_LEAF;
  for (let depth = seeded.length + 1; depth <= 12; depth++) {
    const res = postFlip(parent, `lt-${RUN}-build-${depth}`, [1, 2], CUT);
    if (tally(res) !== "created") throw new Error(`could not build a chain of depth ${depth}: ${res.status} ${res.body}`);
    parent = idOf(res);
    pool.push(parent);
    if (depth === 8 || depth === 12) leaves[depth] = parent;
  }
  // Past the cap, a flip is refused by name and writes nothing.
  const past = postFlip(parent, `lt-${RUN}-past-cap`, [1, 2], CUT);
  check(past, { "a flip past the depth cap is refused by name": (r) => problemType(r) === "depth-cap" });
  tally(past);
  const depths = Object.keys(leaves).map(Number);
  return { leaves, depths, pool, before, one: pool[0] };
}

export function readScenario(data) {
  read(data);
}
export function writeOneStage(data) {
  write([data.one]);
}
export function writeManyStages(data) {
  // The deepest stage is left out: a flip of it is refused by the depth cap, which setup already shows.
  write(data.pool.filter((id) => id !== data.leaves[12]));
}
export function mixedScenario(data) {
  if (Math.random() < 0.8) read(data);
  else writeManyStages(data);
}

// At the end, the service's own numbers (counters and the database's flipped counts) go into the summary.
export function teardown(data) {
  const after = serverView(data.pool);
  if (data.before.metrics !== null && after.metrics !== null) {
    const b = outcomes(data.before.metrics);
    const a = outcomes(after.metrics);
    const delta = (name) => (a[name] ?? 0) - (b[name] ?? 0);
    serverCreated.add(delta("created"));
    serverReplayed.add(delta("replay"));
    serverRefusedTotal.add(
      Object.keys(a)
        .filter((name) => name !== "created" && name !== "replay")
        .reduce((sum, name) => sum + delta(name), 0),
    );
  }
  dbFlipped.add(after.flipped.reduce((s, n, i) => s + n - (data.before.flipped[i] ?? 0), 0));
}

export function handleSummary(data) {
  const v = (name, field = "count") => data.metrics[name]?.values?.[field] ?? 0;
  const lines = [
    `profile ${PROFILE}; target ${verdict.host}`,
    `created ${v("flips_created")}  replayed ${v("flips_replayed")}  conflicts ${v("key_conflicts_expected")}  polite refusals ${v("refused_politely")}  true errors ${v("true_errors")}`,
    `accepted but unreadable ${v("accepted_but_unreadable")}  replay returned another publication ${v("replay_returned_other_publication")}  conflict not named ${v("conflict_not_named")}`,
    `publish ms: med ${v("publish_ms", "med").toFixed(1)}  p95 ${v("publish_ms", "p(95)").toFixed(1)}  p99 ${v("publish_ms", "p(99)").toFixed(1)}`,
    `chain read ms: med ${v("chain_read_ms", "med").toFixed(1)}  p95 ${v("chain_read_ms", "p(95)").toFixed(1)}  p99 ${v("chain_read_ms", "p(99)").toFixed(1)}`,
    `server counted: created ${v("server_created_delta", "value")}  replayed ${v("server_replayed_delta", "value")}  refused ${v("server_refused_delta", "value")}; database flipped_count +${v("db_flipped_count_delta", "value")}`,
  ];
  return {
    stdout: `${lines.join("\n")}\n`,
    [__ENV.SUMMARY_OUT || "summary.json"]: JSON.stringify(data, null, 2),
  };
}
