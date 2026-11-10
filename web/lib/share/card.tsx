import { dyes } from "../theme/tokens.ts";
import { traceOf, tracePath } from "../trace/trace.ts";
import { LEADING, fitTitle, tornPoints, type Lettering } from "./torn.ts";

/** What a share card says, all of it taken from what the page itself says. */
export interface CardInput {
  /** The flip's public id: it draws the oscilloscope line and tears the paper, so the same flip has the same card. */
  id: string;
  title: string;
  /** "no. 04 · flip", as the credits print it; empty for a card that is not about one stage. */
  kicker: string;
  lettering: Lettering;
  /** 0 to 3: which of the four dyes the stage has. */
  dye: 0 | 1 | 2 | 3;
}

export const SIZE = { width: 1200, height: 630 } as const;

const PAPER = "#efebe3";
const INK = "#14110e";
const MUTED = "#6a645a";
const SCREEN = "#070908";
const BEAM = "#5dff9c";
const SENTENCE = "a sound has a past. hear how this one was made, then make the next step.";
const FONT: Record<Lettering, string> = { src: "Brush", up: "Cond", down: "Black" };
const TILT: Record<Lettering, number> = { src: -2, up: -3.5, down: 2 };

function seeded(seed: string): () => number {
  let a = 0x2545f491;
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rgba = (hex: string, a: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

const CENTRE = { x: 1040, y: 318 };

/** The record, cropped by the right edge as on the site: black vinyl, the four dyes in bands of fine grooves, the stage's label. */
function Record({ id, dye }: { id: string; dye: number }) {
  const rand = seeded(id);
  const rings: Array<{ r: number; colour: string; alpha: number }> = [];
  const OUTER = 392;
  const BAND = 62;
  for (let band = 0; band < 4; band++) {
    const colour = dyes[(band + dye + 1) % 4]!.fill;
    for (let k = 0; k < 10; k++) {
      rings.push({
        r: OUTER - band * BAND - k * 6,
        colour,
        alpha: 0.14 + rand() * 0.42,
      });
    }
  }
  const active = OUTER - 2 * BAND - 28;
  const label = dyes[dye]!.fill;
  const wave = tracePath(traceOf(id, 60), 120, 40);
  return (
    <div
      style={{ position: "absolute", left: 0, top: 0, width: 1200, height: 630, display: "flex" }}
    >
      <Circle r={OUTER + 14} fill="#2b2924" />
      <Circle r={OUTER + 8} fill="#0c0b0a" />
      {rings.map((ring, i) => (
        <Circle key={i} r={ring.r} border={`1.4px solid ${rgba(ring.colour, ring.alpha)}`} />
      ))}
      <Circle r={active} border={`2.5px solid ${BEAM}`} glow />
      <Circle r={86} fill={label} />
      <div
        style={{
          position: "absolute",
          left: CENTRE.x - 60,
          top: CENTRE.y - 20,
          width: 120,
          height: 40,
          display: "flex",
        }}
      >
        <svg width="120" height="40" viewBox="0 0 120 40">
          <path d={wave} fill="none" stroke="rgba(12,11,10,0.55)" strokeWidth="2" />
        </svg>
      </div>
      <Circle r={7} fill="#0c0b0a" />
      <Tonearm tipX={CENTRE.x - active * 0.97} tipY={CENTRE.y + active * 0.2} />
    </div>
  );
}

function Circle({
  r,
  fill,
  border,
  glow,
}: {
  r: number;
  fill?: string;
  border?: string;
  glow?: boolean;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: CENTRE.x - r,
        top: CENTRE.y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: 9999,
        display: "flex",
        ...(fill ? { backgroundColor: fill } : {}),
        ...(border ? { border } : {}),
        ...(glow ? { boxShadow: `0 0 14px ${rgba(BEAM, 0.7)}` } : {}),
      }}
    />
  );
}

/** A light arm with a dark shadow under it, so it reads on the paper and on the vinyl, ending in a green point. */
function Tonearm({ tipX, tipY }: { tipX: number; tipY: number }) {
  const pivot = { x: 1128, y: 64 };
  // a slight bow in the arm, as the site draws it, and the arm stops short of the stylus
  const mx = (pivot.x + tipX) / 2 + (tipY - pivot.y) * 0.06;
  const my = (pivot.y + tipY) / 2 - (tipX - pivot.x) * 0.06;
  const d = `M${pivot.x} ${pivot.y} Q${mx.toFixed(1)} ${my.toFixed(1)} ${tipX.toFixed(1)} ${tipY.toFixed(1)}`;
  return (
    <div
      style={{ position: "absolute", left: 0, top: 0, width: 1200, height: 630, display: "flex" }}
    >
      <svg width="1200" height="630" viewBox="0 0 1200 630">
        <path
          d={d}
          fill="none"
          stroke="rgba(0, 0, 0, 0.35)"
          strokeWidth={7}
          strokeLinecap="round"
          transform="translate(3 4)"
        />
        <path d={d} fill="none" stroke="#f4efe4" strokeWidth={3.4} strokeLinecap="round" />
        <circle cx={pivot.x} cy={pivot.y} r={17} fill="#f4efe4" stroke="#14110e" strokeWidth={3} />
        <circle cx={pivot.x} cy={pivot.y} r={5} fill="#14110e" />
        <circle cx={tipX} cy={tipY} r={9} fill={rgba(BEAM, 0.25)} />
        <circle cx={tipX} cy={tipY} r={4.5} fill={BEAM} />
      </svg>
    </div>
  );
}

/** The flip's own oscilloscope line on a dark screen, with the beam's glow, as the credits draw it. */
function Scope({ id, width, height }: { id: string; width: number; height: number }) {
  const d = tracePath(traceOf(id), width, height);
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 8,
        backgroundColor: SCREEN,
        display: "flex",
        border: `1px solid ${rgba(BEAM, 0.25)}`,
      }}
    >
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {[1, 2, 3, 4, 5].map((i) => (
          <line
            key={i}
            x1={(width * i) / 6}
            y1={0}
            x2={(width * i) / 6}
            y2={height}
            stroke={rgba(BEAM, 0.12)}
            strokeWidth={1}
          />
        ))}
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke={rgba(BEAM, 0.18)}
          strokeWidth={1}
        />
        <path d={d} fill="none" stroke={rgba(BEAM, 0.22)} strokeWidth={7} strokeLinecap="round" />
        <path
          d={d}
          fill="none"
          stroke={BEAM}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/** The cut-paper title slab in the stage's dye, torn along every edge, lettered as the credits letter it. */
function Slab({ input }: { input: CardInput }) {
  const WIDTH = 590;
  const inner = WIDTH - 64;
  const fit = fitTitle(input.title, input.lettering, inner, 214);
  const lineHeight = fit.size * LEADING[input.lettering];
  const height = Math.round(fit.lines * lineHeight + 62);
  const dye = dyes[input.dye]!;
  const points = tornPoints(`${input.id}:${input.lettering}`, WIDTH, height)
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  return {
    height,
    node: (
      <div
        style={{
          position: "relative",
          width: WIDTH,
          height,
          display: "flex",
          transform: `rotate(${TILT[input.lettering]}deg)`,
        }}
      >
        <div style={{ position: "absolute", left: 5, top: 7, display: "flex" }}>
          <svg width={WIDTH} height={height} viewBox={`0 0 ${WIDTH} ${height}`}>
            <polygon points={points} fill="rgba(20, 17, 14, 0.22)" />
          </svg>
        </div>
        <div style={{ position: "absolute", left: 0, top: 0, display: "flex" }}>
          <svg width={WIDTH} height={height} viewBox={`0 0 ${WIDTH} ${height}`}>
            <polygon points={points} fill={dye.fill} />
          </svg>
        </div>
        <div
          style={{
            position: "absolute",
            left: 32,
            top: 28,
            width: inner,
            height: height - 56,
            display: "flex",
            alignItems: "center",
            color: dye.text,
            fontFamily: FONT[input.lettering],
            fontSize: fit.size,
            lineHeight: `${LEADING[input.lettering]}`,
            letterSpacing: input.lettering === "down" ? -2 : input.lettering === "up" ? -1 : 0,
            overflow: "hidden",
          }}
        >
          {fit.text}
        </div>
      </div>
    ),
  };
}

/** The whole card, 1200 by 630: paper, the record cropped on the right, and the stage's slab, line and trace on the left. */
export function Card({ input, paper }: { input: CardInput; paper: string }) {
  const slab = Slab({ input });
  return (
    <div
      style={{
        position: "relative",
        width: SIZE.width,
        height: SIZE.height,
        display: "flex",
        backgroundColor: PAPER,
        overflow: "hidden",
      }}
    >
      <Record id={input.id} dye={input.dye} />
      <div
        style={{
          position: "absolute",
          left: 56,
          top: 40,
          width: 640,
          height: 560,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: 600,
          }}
        >
          <div
            style={{
              fontFamily: "Cond",
              fontWeight: 800,
              fontSize: 40,
              letterSpacing: 3,
              color: INK,
              display: "flex",
            }}
          >
            graft
          </div>
          <Scope id={input.id} width={230} height={62} />
        </div>
        {input.kicker ? (
          <div
            style={{
              marginTop: 22,
              fontFamily: "Cond",
              fontWeight: 800,
              fontSize: 27,
              letterSpacing: 6,
              textTransform: "uppercase",
              color: MUTED,
              display: "flex",
            }}
          >
            {input.kicker}
          </div>
        ) : null}
        <div style={{ marginTop: input.kicker ? 34 : 56, display: "flex" }}>{slab.node}</div>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 486,
            width: 540,
            fontFamily: "Brush",
            fontSize: 38,
            lineHeight: 1.06,
            color: INK,
            display: "flex",
          }}
        >
          {SENTENCE}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: SIZE.width,
          height: SIZE.height,
          display: "flex",
          backgroundImage:
            "radial-gradient(circle at 38% 46%, rgba(255,255,255,0) 45%, rgba(70,52,30,0.2) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 680,
          height: SIZE.height,
          display: "flex",
          backgroundImage: `url(${paper})`,
          backgroundSize: "256px 256px",
          backgroundRepeat: "repeat",
          opacity: 0.85,
        }}
      />
    </div>
  );
}
