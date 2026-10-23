// Reads a k6 summary and says whether the run's counts agree: what the client saw, what the service's
// own counters say, and what the database holds (the parents' flipped counts). Run it after the test:
//   node loadtest/reconcile.mjs summary.json
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @param {{ metrics: Record<string, { values?: Record<string, number> }> }} summary */
export function reconcile(summary) {
  const m = summary.metrics ?? {};
  const count = (name) => m[name]?.values?.count ?? 0;
  const gauge = (name) => m[name]?.values?.value;
  const server = {
    created: gauge("server_created_delta"),
    replayed: gauge("server_replayed_delta"),
    refused: gauge("server_refused_delta"),
    db: gauge("db_flipped_count_delta"),
  };
  if (Object.values(server).some((v) => v === undefined)) {
    return {
      ok: false,
      lines: ["not available: the service's own counters or the database's counts are missing from the summary"],
    };
  }
  const client = {
    created: count("flips_created"),
    replayed: count("flips_replayed"),
    refused: count("refused_politely") + count("key_conflicts_expected"),
    errors: count("true_errors"),
  };
  const lines = [];
  let ok = true;
  const judge = (good, text) => {
    lines.push(`${good ? "ok  " : "FAIL"} ${text}`);
    if (!good) ok = false;
  };
  // A response can be lost after the service acted, so the service may have created more than the
  // client saw, but never more than the failures the client counted can explain, and never fewer.
  const extra = server.created - client.created;
  judge(
    extra >= 0 && extra <= client.errors,
    `created: client ${client.created}, service ${server.created} (${extra} unseen, ${client.errors} failures could explain them)`,
  );
  judge(server.db === server.created, `database: flipped counts rose by ${server.db}, the service created ${server.created}`);
  judge(server.replayed === client.replayed, `replays: client ${client.replayed}, service ${server.replayed}`);
  const unseen = server.refused - client.refused;
  judge(
    unseen >= 0 && unseen <= client.errors,
    `refusals and conflicts: client ${client.refused}, service ${server.refused}`,
  );
  return { ok, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = reconcile(JSON.parse(readFileSync(process.argv[2] ?? "summary.json", "utf8")));
  console.log(result.lines.join("\n"));
  console.log(result.ok ? "the counts reconcile" : "THE COUNTS DO NOT RECONCILE");
  process.exit(result.ok ? 0 : 1);
}
