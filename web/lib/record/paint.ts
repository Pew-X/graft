/**
 * The record, drawn: the locked look (vault/prototypes/t11-roll, variant E) as production code.
 * A black disc, large enough to bleed off the screen, with a band of fine grooves for each stage in
 * that stage's dye. The grooves wobble with the stage's real waveform, the ones already played are
 * brighter, the part the next stage kept is brighter, the groove at the playhead glows phosphor green,
 * and the groove under the stylus gives way to it. The disc turns at 33 rpm while playing. The label
 * shows the stage's dye and a phosphor trace of its waveform, lit up to the playhead. A tonearm runs
 * from its pivot to the stylus, which is the cursor while the pointer is over the record.
 *
 * Two layers, so the expensive one can be kept: `paintGrooves` (the disc, the grooves, the empty slot
 * and the label) and `paintOverlay` (lacquer sheen, rim, tonearm, stylus, hover). Hairlines are stroked
 * in a handful of grouped paths by brightness, not one stroke each. In `cached` mode the grooves do not
 * turn and are not pushed, so the layer only changes when the playhead passes a groove and can be
 * drawn once and reused.
 */
import { bandOuter, layout, needleAt, hit, type DiscLayout } from "./disc.ts";
import type { Mark } from "./mark.ts";

export interface StageLook {
  /** The stage's dye, `#rrggbb`. */
  dye: string;
  /** The loudest sample in each slice of the stage's audio, 0 to 1. */
  peaks: readonly number[];
  /** The part of this stage's groove the next stage kept, as fractions of it; null when none. */
  cut: readonly [number, number] | null;
}

export interface Scene {
  width: number;
  height: number;
  theme: "light" | "dark";
  stages: readonly StageLook[];
  /** The stage the playhead is in, and how far through it (0 to 1). */
  active: number;
  u: number;
  /** The disc's turn in radians, and a running clock in seconds that drives the stylus's push. */
  rotation: number;
  clock: number;
  /** The pointer over the record, when there is one, and the stage name to show beside it. */
  pointer: { x: number; y: number } | null;
  hover: { band: number; name: string } | null;
  reduced: boolean;
  /** Draw the plain version: no turning, no push. */
  cached?: boolean;
  /** A part of a stage being marked for a flip, with the words to show beside it. */
  mark?: (Mark & { label?: string }) | null;
}

const TAU = Math.PI * 2;
const PHOSPHOR = "#a8ffb8";
const POINTS = 96;
const THEME = {
  light: { disc: "#0a0b0a", rim: "#34322d", text: "#f4efe4", pencil: "#8c877d" },
  dark: { disc: "#111110", rim: "#3a3833", text: "#ece6d8", pencil: "#8a857a" },
} as const;

/** How many grooves a slot holds: about one every 2.6 pixels. */
export const groovesIn = (l: DiscLayout): number => Math.max(8, Math.round(l.slotW / 2.6));

function tipOf(l: DiscLayout, s: Scene): { x: number; y: number; over: boolean } {
  const auto = needleAt(l, Math.min(s.active, l.slots - 1), s.u);
  const over = s.pointer !== null && hit(l, s.pointer.x, s.pointer.y, null) !== null;
  return over && s.pointer ? { ...s.pointer, over } : { ...auto, over: false };
}

/** The disc, the grooves of every stage, the empty slot and the label. */
export function paintGrooves(ctx: CanvasRenderingContext2D, s: Scene): void {
  const l = layout(s.width, s.height, s.stages.length);
  const th = THEME[s.theme];
  const { cx, cy } = l;
  const still = s.reduced || s.cached === true;
  const rot = still ? 0 : s.rotation;
  const tip = tipOf(l, s);
  const push = still ? 0 : tip.over ? 6 : 3;

  ctx.fillStyle = th.disc;
  ctx.beginPath();
  ctx.arc(cx, cy, l.R, 0, TAU);
  ctx.fill();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.lineWidth = 1;
  const G = groovesIn(l);
  for (let k = 0; k < s.stages.length; k++) {
    const look = s.stages[k]!;
    const w = look.peaks.length > 0 ? look.peaks : [0.4];
    const active = k === s.active;
    // Group the hairlines by how bright they are: one path and one stroke for each group.
    const groups = new Map<string, number[]>();
    for (let g = 0; g < G; g++) {
      const q = g / (G - 1);
      const inCut = look.cut !== null && q >= look.cut[0] && q <= look.cut[1];
      const played = k < s.active || (active && q <= s.u);
      const near = active && Math.abs(q - s.u) < 0.045;
      const alpha = near ? 0.95 : Math.min(1, (inCut ? 0.52 : 0.2) * (played ? 1.3 : 1));
      const key = `${near ? "p" : "d"}${alpha.toFixed(2)}`;
      const list = groups.get(key);
      if (list) list.push(g);
      else groups.set(key, [g]);
    }
    for (const [key, members] of groups) {
      ctx.strokeStyle = key.startsWith("p") ? PHOSPHOR : look.dye;
      ctx.globalAlpha = Number(key.slice(1));
      ctx.beginPath();
      for (const g of members) {
        const r0 = bandOuter(l, k) - (g / (G - 1)) * l.slotW;
        for (let i = 0; i <= POINTS; i++) {
          const a = (i / POINTS) * TAU;
          const wi = (Math.floor((i / POINTS) * w.length) + g * 3) % w.length;
          let r = r0 + (active ? 1.8 : 0.8) * ((w[wi] ?? 0.4) - 0.4);
          if (push > 0) {
            // The groove gives way under the stylus; far from it nothing is computed.
            const sx = cx + r * Math.cos(a + rot);
            const sy = cy + r * Math.sin(a + rot);
            const dx = sx - tip.x;
            const dy = sy - tip.y;
            if (dx * dx + dy * dy < 110 * 110) {
              r +=
                push *
                Math.exp(-((Math.hypot(dx, dy) / 48) ** 2)) *
                Math.sin(g * 1.9 + s.clock * 9);
            }
          }
          const x = r * Math.cos(a);
          const y = r * Math.sin(a);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
  }

  // The empty slot, where you go: dashed, no grooves.
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = th.pencil;
  ctx.setLineDash([3, 5]);
  const empty = s.stages.length;
  for (const r of [bandOuter(l, empty), bandOuter(l, empty) - l.slotW]) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // The label, in the stage's dye.
  ctx.fillStyle = s.stages[Math.min(s.active, empty - 1)]?.dye ?? th.pencil;
  ctx.beginPath();
  ctx.arc(0, 0, l.Ri * 0.78, 0, TAU);
  ctx.fill();
  ctx.restore();

  paintBeam(ctx, l, s, th.disc);
}

/** The beam: the current stage as a phosphor trace across the label, lit up to the playhead. */
function paintBeam(ctx: CanvasRenderingContext2D, l: DiscLayout, s: Scene, disc: string): void {
  const look = s.stages[Math.min(s.active, s.stages.length - 1)];
  if (!look || look.peaks.length < 2) return;
  const w = look.peaks;
  const { cx, cy } = l;
  const half = l.Ri * 0.62;
  const n = w.length;
  const trace = (sign: number): void => {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = cx - half + (i / (n - 1)) * 2 * half;
      const y = cy + sign * (w[i] ?? 0) * l.Ri * 0.3;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  };
  ctx.save();
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0,0,0,.55)";
  ctx.beginPath();
  ctx.moveTo(cx - half, cy);
  ctx.lineTo(cx + half, cy);
  ctx.stroke();
  for (const sign of [1, -1]) {
    trace(sign);
    ctx.strokeStyle = "rgba(168,255,184,.28)";
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - half, cy - l.Ri, 2 * half * s.u, 2 * l.Ri);
    ctx.clip();
    ctx.shadowColor = PHOSPHOR;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = PHOSPHOR;
    trace(sign);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, TAU);
  ctx.fill();
}

/** The lacquer sheen, the rim, the tonearm and stylus, and the hover: what is drawn over the grooves. */
/**
 * Where a marked part lies on the record: the two radii it spans (the outer one is where it starts, as
 * time runs inward) and the angle it is drawn around, which is where the needle sits: to the left of the
 * centre in landscape, above it in portrait.
 */
export function markSector(
  l: DiscLayout,
  m: Mark,
): { rOuter: number; rInner: number; centre: number; spread: number } {
  const top = bandOuter(l, m.stage);
  return {
    rOuter: top - m.from * l.slotW,
    rInner: top - m.to * l.slotW,
    centre: l.portrait ? -Math.PI / 2 : Math.PI,
    spread: 0.32,
  };
}

/** The marked part, drawn as a viewfinder: the part lit, and a bracket in each corner. */
function paintMark(
  ctx: CanvasRenderingContext2D,
  l: DiscLayout,
  m: Mark & { label?: string },
): void {
  const { rOuter, rInner, centre, spread } = markSector(l, m);
  const a0 = centre - spread;
  const a1 = centre + spread;
  ctx.fillStyle = "rgba(168,255,184,0.2)";
  ctx.beginPath();
  ctx.arc(l.cx, l.cy, rOuter, a0, a1);
  ctx.arc(l.cx, l.cy, rInner, a1, a0, true);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = PHOSPHOR;
  ctx.lineWidth = 3;
  ctx.lineCap = "square";
  const arm = Math.max(4, Math.min(14, rOuter - rInner));
  for (const [r, toward] of [
    [rOuter, -1],
    [rInner, 1],
  ] as const) {
    for (const [a, along] of [
      [a0, 0.07],
      [a1, -0.07],
    ] as const) {
      ctx.beginPath();
      ctx.arc(l.cx, l.cy, r, a, a + along, along < 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(l.cx + r * Math.cos(a), l.cy + r * Math.sin(a));
      ctx.lineTo(l.cx + (r + toward * arm) * Math.cos(a), l.cy + (r + toward * arm) * Math.sin(a));
      ctx.stroke();
    }
  }
  if (m.label) {
    ctx.font = "500 12px ui-monospace, monospace";
    ctx.fillStyle = PHOSPHOR;
    ctx.shadowColor = "rgba(0,0,0,.9)";
    ctx.shadowBlur = 4;
    ctx.textAlign = l.portrait ? "center" : "right";
    ctx.fillText(
      m.label,
      l.portrait ? l.cx : l.cx - rOuter - 12,
      l.portrait ? l.cy - rOuter - 12 : l.cy + 4,
    );
    ctx.shadowBlur = 0;
  }
}

export function paintOverlay(ctx: CanvasRenderingContext2D, s: Scene): void {
  const l = layout(s.width, s.height, s.stages.length);
  const th = THEME[s.theme];
  const { cx, cy } = l;
  const tip = tipOf(l, s);
  const auto = needleAt(l, Math.min(s.active, l.slots - 1), s.u);

  if ("createConicGradient" in ctx) {
    // Lighting: it does not turn with the disc.
    const cg = ctx.createConicGradient(0.7, cx, cy);
    for (const [stop, a] of [
      [0, 0],
      [0.07, 0.08],
      [0.14, 0],
      [0.5, 0],
      [0.57, 0.06],
      [0.64, 0],
      [1, 0],
    ] as const) {
      cg.addColorStop(stop, `rgba(255,255,255,${a})`);
    }
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(cx, cy, l.R, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = th.rim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, l.R, 0, TAU);
  ctx.stroke();

  if (s.mark) paintMark(ctx, l, s.mark);

  // The tonearm, from its pivot to the stylus.
  const P = l.pivot;
  const dx = tip.x - P.x;
  const dy = tip.y - P.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const mx = (P.x + tip.x) / 2 - uy * len * 0.07;
  const my = (P.y + tip.y) / 2 + ux * len * 0.07;
  ctx.lineCap = "round";
  for (const [colour, width] of [
    ["rgba(0,0,0,.4)", 5],
    [th.text, 2.2],
  ] as const) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(P.x, P.y);
    ctx.quadraticCurveTo(mx, my, tip.x - ux * 20, tip.y - uy * 20);
    ctx.stroke();
  }
  ctx.strokeStyle = th.text;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(tip.x - ux * 20, tip.y - uy * 20);
  ctx.lineTo(tip.x - ux * 5, tip.y - uy * 5);
  ctx.stroke();
  ctx.fillStyle = th.text;
  ctx.beginPath();
  ctx.arc(P.x, P.y, 9, 0, TAU);
  ctx.fill();
  ctx.fillStyle = th.disc;
  ctx.beginPath();
  ctx.arc(P.x, P.y, 3.5, 0, TAU);
  ctx.fill();
  ctx.shadowColor = PHOSPHOR;
  ctx.shadowBlur = 14;
  ctx.fillStyle = PHOSPHOR;
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 3, 0, TAU);
  ctx.fill();
  ctx.shadowBlur = 0;

  if (s.hover && tip.over) {
    // A ghost ring where the music really is, and the name of the stage under the stylus.
    ctx.strokeStyle = PHOSPHOR;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(auto.x, auto.y, 6, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = '600 13px ui-monospace, "JetBrains Mono", monospace';
    ctx.fillStyle = th.text;
    ctx.shadowColor = "rgba(0,0,0,.7)";
    ctx.shadowBlur = 4;
    ctx.textAlign = l.portrait ? "center" : "right";
    ctx.fillText(s.hover.name, l.portrait ? tip.x : tip.x - 18, tip.y - 18);
    ctx.shadowBlur = 0;
  }
}
