// The record's geometry on the screen, worked by hand from the rule and not from the code. Landscape,
// 1000 x 600, four stages (five slots, the last empty): R = min(0.68 H, 0.46 W) = 408, the centre is just
// past the right edge (1016.32, 300), the grooves run from 0.95 R = 387.6 in to 0.26 R = 106.08, a gap of
// 0.014 R = 5.712 between slots, so each slot is (387.6 - 106.08 - 4 * 5.712) / 5 = 51.7344 wide.
// Portrait, 390 x 844: R = min(0.9 W, 0.42 H) = 351, centre (195, 879.1), slots 44.5068 wide.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bandOuter, hit, layout, needleAt, outsideBand, peaksOf } from "./disc.ts";

const near = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) < eps;
const land = layout(1000, 600, 4);
const port = layout(390, 844, 4);

test("landscape: the record is the right of the screen and bleeds off its edge", () => {
  assert.equal(land.portrait, false);
  assert.ok(near(land.R, 408) && near(land.cx, 1016.32) && near(land.cy, 300));
  assert.ok(near(land.Ro, 387.6) && near(land.Ri, 106.08) && near(land.slotW, 51.7344));
  assert.ok(
    land.cx - land.R < 1000,
    "the left edge of the disc is on the screen, the right is not",
  );
  assert.ok(land.cx + land.R > 1000);
});

test("portrait: the record is the bottom of the screen and bleeds off below", () => {
  assert.equal(port.portrait, true);
  assert.ok(
    near(port.R, 351) && near(port.cx, 195) && near(port.cy, 879.1) && near(port.slotW, 44.5068),
  );
  assert.ok(port.cy - port.R < 844 && port.cy > 844);
});

test("one slot per stage plus the empty one; the source is outermost", () => {
  assert.equal(land.slots, 5);
  assert.ok(near(bandOuter(land, 0), 387.6));
  assert.ok(near(bandOuter(land, 1), 387.6 - 51.7344 - 5.712));
  // the empty slot is the last, and it is still outside the label
  assert.ok(bandOuter(land, 4) - land.slotW > land.Ri - 1e-6);
});

test("time runs inward inside a slot: the needle sits on the horizontal in landscape, the vertical in portrait", () => {
  // the start of a stage is its outer edge, the end is its inner edge
  const a = needleAt(land, 0, 0);
  assert.ok(near(a.x, land.cx - 387.6) && near(a.y, 300));
  const b = needleAt(land, 0, 1);
  assert.ok(near(b.x, land.cx - (387.6 - 51.7344)) && near(b.y, 300));
  const c = needleAt(port, 2, 0.5);
  assert.ok(near(c.x, 195) && near(c.y, port.cy - (bandOuter(port, 2) - 0.5 * port.slotW)));
});

test("a point's slot and place in it come from its distance from the centre", () => {
  const at = (k: number, u: number) => needleAt(land, k, u);
  for (const [k, u] of [
    [0, 0.1],
    [1, 0.5],
    [2, 0.9],
    [3, 0.25],
  ] as const) {
    const p = at(k, u);
    const h = hit(land, p.x, p.y, null)!;
    assert.equal(h.band, k);
    assert.ok(near(h.u, u, 1e-6), `slot ${k}: ${h.u} vs ${u}`);
  }
});

test("outside the disc and inside the label are no slot", () => {
  assert.equal(hit(land, land.cx - land.R - 5, 300, null), null);
  assert.equal(hit(land, land.cx - 20, 300, null), null);
});

test("while dragging, a pointer that leaves the disc keeps the slot it was in", () => {
  assert.equal(hit(land, 5, 5, 1)!.band, 1);
});

test("a slot is only left once the pointer is a quarter of a slot past its edge", () => {
  const pitch = land.slotW + land.gap;
  const edge = bandOuter(land, 1) + land.gap / 2; // the middle of the gap between slots 0 and 1, from the centre
  const x = (r: number) => land.cx - r;
  // from slot 1, going outward: still 1 within a quarter pitch of the slot, 0 beyond it
  assert.equal(hit(land, x(bandOuter(land, 1) + 0.2 * pitch), 300, 1)!.band, 1);
  assert.equal(hit(land, x(bandOuter(land, 1) + 0.3 * pitch), 300, 1)!.band, 0);
  assert.ok(edge > 0);
});

test("a pointer shaking on a slot's outer edge changes slot once, when it really leaves", () => {
  const pitch = land.slotW + land.gap;
  const edge = bandOuter(land, 1); // slot 1's outer edge, from the centre
  // shaking within a fifth of a pitch either side, then walking out into slot 0
  const path = [0.1, -0.15, 0.2, -0.1, 0.05, -0.2, 0.15, 0.4, 0.6, 0.9].map(
    (d) => edge + d * pitch,
  );
  let band: number | null = 1;
  const seen: Array<number | null> = [band];
  for (const r of path) {
    band = hit(land, land.cx - r, 300, band)!.band;
    seen.push(band);
  }
  const changes = seen.filter((b, i) => i > 0 && b !== seen[i - 1]).length;
  assert.equal(changes, 1, `slots seen: ${seen.join(" ")}`);
  assert.equal(seen.at(-1), 0);
});

test("twelve stages still fit: thirteen slots, each narrower, none negative", () => {
  const long = layout(390, 844, 12);
  assert.equal(long.slots, 13);
  assert.ok(near(long.slotW, 14.094));
  assert.ok(long.slotW > 0);
});

test("peaks are the loudest sample in each slice, as a fraction of full scale", () => {
  const pcm = Int16Array.from([0, 16384, -32768, 0, 8192, -8192, 0, 0]);
  assert.deepEqual(peaksOf(pcm, 4), [0.5, 1, 0.25, 0]);
  assert.deepEqual(peaksOf(new Int16Array(0), 3), [0, 0, 0]);
});

test("a label just outside a band sits on the needle's line, a set gap beyond the band's outer edge", () => {
  for (const [w, h] of [
    [1280, 720],
    [390, 844],
  ] as const) {
    const l = layout(w, h, 4);
    for (const slot of [0, 2, 3]) {
      const p = outsideBand(l, slot, 15);
      assert.ok(Math.abs(Math.hypot(p.x - l.cx, p.y - l.cy) - (bandOuter(l, slot) + 15)) < 1e-9);
      if (l.portrait) assert.equal(p.x, l.cx, "portrait: straight above the centre");
      else assert.equal(p.y, l.cy, "landscape: straight left of the centre");
    }
  }
});
