// Seam 2 in Node (V8): the artefact and the TypeScript port against the committed table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PortHost, WasmHost } from "../src/host.ts";
import { failures, runTable } from "../src/run.ts";
import type { Table } from "../src/table.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const table: Table = JSON.parse(readFileSync(`${root}fixtures/vectors/vectors.json`, "utf8"));

function artefact(): Uint8Array {
  execFileSync("sh", [`${root}scripts/build-wasm.sh`], { cwd: root, stdio: "ignore" });
  return readFileSync(`${root}target/wasm32-unknown-unknown/wasm/graft_render.wasm`);
}

test("the artefact, instantiated with an empty import object, reproduces every vector in Node", async () => {
  const host = await WasmHost.load("wasm-in-node", artefact());
  assert.deepEqual(failures(await runTable(table, host)), []);
});

test("the TypeScript port reproduces every vector, and is exempt only from the pointer scenario", async () => {
  const checks = await runTable(table, new PortHost());
  assert.deepEqual(failures(checks), []);
  const exempt = checks.find((c) => c.name === "scenario bad-pointers");
  assert.equal(exempt?.actual, "declared without raw pointers");
});

test("a host that claims raw pointers but cannot run the cases does not pass vacuously", async () => {
  const lying = { ...new PortHost(), name: "lying", rawPointers: true };
  const checks = await runTable(table, Object.assign(Object.create(PortHost.prototype), lying));
  assert.ok(failures(checks).some((f) => f.includes("scenario bad-pointers")));
});

test("a wrong expected hash in the table fails and names the vector and the host", async () => {
  const bad: Table = structuredClone(table);
  const v = bad.vectors.find((x) => x.name === "up3/2-cr");
  assert.ok(v?.expect.sha256);
  v.expect.sha256 = "0".repeat(64);
  const found = failures(await runTable(bad, new PortHost()));
  // The vector itself and the growth scenario that re-checks it both fail; each line names the host.
  assert.equal(found.length, 2);
  assert.match(found[0] ?? "", /typescript-port: vector up3\/2-cr/);
  assert.ok(found.every((f) => f.startsWith("typescript-port: ")));
});

test("the artefact and the port give identical bytes, not only identical hashes", async () => {
  const host = await WasmHost.load("wasm-in-node", artefact());
  const port = new PortHost();
  for (const name of ["up3/2-cr", "dn2/3-cr", "sq-cr", "odd-lin"]) {
    const v = table.vectors.find((x) => x.name === name);
    assert.ok(v);
    const { generate } = await import("../src/table.ts");
    const input = generate(v.input);
    const a = host.render(input, v.p, v.q, v.method, v.out_cap);
    const b = port.render(input, v.p, v.q, v.method, v.out_cap);
    assert.ok(a.kind === "status" && b.kind === "status");
    assert.deepEqual([...a.out], [...b.out], name);
  }
});
