// Replays the vector table against a host and reports every check. Runs unchanged in Node and in the
// browsers; the page and the Node test both call it.

import type { Host, Outcome, PointerCase } from "./host.ts";
import { downmix, f32BitsToS16, generate, type Table, type Vector } from "./table.ts";

export interface Check {
  host: string;
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
}

async function sha256(frames: Int16Array): Promise<string> {
  const bytes = new Uint8Array(frames.buffer, frames.byteOffset, frames.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function describe(o: Outcome): Promise<string> {
  if (o.kind === "trap") return `trap (${o.message})`;
  if (o.kind === "harness") return `harness error (${o.message})`;
  return o.code > 0 ? `status ${o.code} sha256 ${await sha256(o.out)}` : `status ${o.code}`;
}

function expectedOf(v: Vector): string {
  return v.expect.sha256
    ? `status ${v.expect.status} sha256 ${v.expect.sha256}`
    : `status ${v.expect.status}`;
}

export async function runTable(table: Table, host: Host): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, expected: string, actual: string) =>
    checks.push({ host: host.name, name, passed: expected === actual, expected, actual });
  const vector = (name: string): Vector => {
    const v = table.vectors.find((x) => x.name === name);
    if (!v) throw new Error(`no vector ${name}`);
    return v;
  };
  const call = (v: Vector, input: Int16Array) => host.render(input, v.p, v.q, v.method, v.out_cap);

  for (const v of table.vectors) {
    const outcome = call(v, generate(v.input));
    add(`vector ${v.name}`, expectedOf(v), await describe(outcome));
    if (v.expect.samples && outcome.kind === "status") {
      add(
        `vector ${v.name} (hand-worked samples)`,
        JSON.stringify(v.expect.samples),
        JSON.stringify([...outcome.out]),
      );
    }
  }
  for (const c of table.out_len) {
    add(
      `out_len(${c.in_len}, ${c.p}, ${c.q})`,
      String(c.expect),
      String(host.outLen(c.in_len, c.p, c.q)),
    );
  }
  for (const c of table.canonicalisation.f32_to_s16.cases) {
    add(`f32_to_s16 ${c.name}`, String(c.expect), String(f32BitsToS16(c.bits)));
  }
  for (const c of table.canonicalisation.downmix.cases) {
    add(`downmix(${c.left}, ${c.right})`, String(c.expect), String(downmix(c.left, c.right)));
  }
  for (const s of table.scenarios) {
    const name = `scenario ${s.name}`;
    if (s.kind === "repeat") {
      const v = vector(s.vector);
      const input = generate(v.input);
      const first = await describe(call(v, input));
      let drift = -1;
      for (let i = 1; i < s.times && drift < 0; i++)
        if ((await describe(call(v, input))) !== first) drift = i;
      add(
        name,
        "every repeat identical",
        drift < 0 ? "every repeat identical" : `repeat ${drift} differed`,
      );
    } else if (s.kind === "growth") {
      const big = vector(s.big);
      const small = vector(s.then);
      const bigInput = generate(big.input);
      const smallInput = generate(small.input);
      const before = await describe(call(small, smallInput));
      let bigOk = true;
      for (let i = 0; i < s.times; i++)
        bigOk &&= (await describe(call(big, bigInput))) === expectedOf(big);
      const after = await describe(call(small, smallInput));
      const ok = bigOk && before === after && after === expectedOf(small);
      add(
        name,
        "large renders match, small vector unchanged",
        ok
          ? "large renders match, small vector unchanged"
          : `large ok: ${bigOk}, small before/after: ${before} / ${after}`,
      );
    } else if (!host.rawPointers || !host.pointerCase) {
      // Only hosts declared without raw pointers are exempt.
      add(
        name,
        "declared without raw pointers",
        host.rawPointers ? "pointer cases missing" : "declared without raw pointers",
      );
    } else {
      const wrong: string[] = [];
      for (const c of s.cases) {
        const o = host.pointerCase(c.case as PointerCase, s.in_len, s.p, s.q, s.method);
        const got =
          o.kind === "trap"
            ? "trap"
            : o.kind === "status"
              ? `status ${o.code}`
              : `harness error (${o.message})`;
        if (got !== c.expect) wrong.push(`${c.case}: expected ${c.expect}, got ${got}`);
      }
      add(
        name,
        "every pointer case as expected",
        wrong.length === 0 ? "every pointer case as expected" : wrong.join("; "),
      );
    }
  }
  return checks;
}

export function failures(checks: Check[]): string[] {
  return checks
    .filter((c) => !c.passed)
    .map((c) => `${c.host}: ${c.name}\n    expected ${c.expected}\n    actual   ${c.actual}`);
}
