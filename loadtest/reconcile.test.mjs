// The counts of a run must agree: what the client saw, what the service counted, what the database holds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcile } from "./reconcile.mjs";

const summary = (c, g = {}) => ({
  metrics: {
    flips_created: { values: { count: c.created } },
    flips_replayed: { values: { count: c.replayed ?? 0 } },
    key_conflicts_expected: { values: { count: c.conflicts ?? 0 } },
    refused_politely: { values: { count: c.refused ?? 0 } },
    true_errors: { values: { count: c.errors ?? 0 } },
    server_created_delta: { values: { value: g.created } },
    server_replayed_delta: { values: { value: g.replayed ?? 0 } },
    server_refused_delta: { values: { value: g.refused ?? 0 } },
    db_flipped_count_delta: { values: { value: g.db } },
  },
});

test("a run whose three views agree passes", () => {
  const r = reconcile(
    summary({ created: 100, replayed: 15, conflicts: 10, refused: 3 }, { created: 100, replayed: 15, refused: 13, db: 100 }),
  );
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("a publish the service made and the client never saw is allowed only as far as errors explain", () => {
  assert.equal(
    reconcile(summary({ created: 100, errors: 2 }, { created: 101, db: 101 })).ok,
    true,
  );
  const lost = reconcile(summary({ created: 100, errors: 0 }, { created: 101, db: 101 }));
  assert.equal(lost.ok, false);
  assert.match(lost.lines.join("\n"), /created/);
});

test("the client counting more than the service did is always a failure", () => {
  assert.equal(reconcile(summary({ created: 100, errors: 5 }, { created: 99, db: 99 })).ok, false);
});

test("the database must hold exactly what the service says it created", () => {
  const r = reconcile(summary({ created: 100 }, { created: 100, db: 98 }));
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /database/);
});

test("replays and refusals must match the service's counters", () => {
  assert.equal(reconcile(summary({ created: 10, replayed: 2 }, { created: 10, replayed: 1, db: 10 })).ok, false);
  assert.equal(reconcile(summary({ created: 10, refused: 4 }, { created: 10, refused: 3, db: 10 })).ok, false);
});

test("without the service's numbers the run says it could not reconcile instead of passing", () => {
  const r = reconcile({ metrics: { flips_created: { values: { count: 5 } } } });
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /not available/);
});
