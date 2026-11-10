/**
 * The page the browser test drives: the real engine over real Web Audio, with an analyser tapped on
 * the output so the test can measure whether sound is actually coming out.
 */
import {
  Engine,
  LazyAudio,
  attachContextLifecycle,
  attachLifecycle,
  type AudioContextConstructor,
  type Clock,
} from "../lib/playback/index.ts";

const SAMPLE_RATE = 48_000;

/** A sine tone as canonical 16-bit audio, `seconds` long. */
function tone(hz: number, seconds: number): Int16Array {
  const out = new Int16Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++)
    out[i] = Math.round(12_000 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE));
  return out;
}

const LENGTHS = [0.6, 0.5, 0.8];
const stages = [tone(220, LENGTHS[0] ?? 0), tone(330, LENGTHS[1] ?? 0), tone(440, LENGTHS[2] ?? 0)];

/** An AudioContext whose output passes through an analyser first. */
class TapContext extends AudioContext {
  readonly tap: AnalyserNode;
  constructor(options?: AudioContextOptions) {
    super(options);
    this.tap = this.createAnalyser();
    this.tap.fftSize = 2048;
    this.tap.connect(super.destination);
  }
  override get destination(): AudioDestinationNode {
    return this.tap as unknown as AudioDestinationNode;
  }
}

const clock: Clock = {
  now: () => performance.now() / 1000,
  setTimeout: (fn, seconds) => window.setTimeout(fn, seconds * 1000),
  clearTimeout: (id) => window.clearTimeout(id),
};

const audio = new LazyAudio(() => TapContext as unknown as AudioContextConstructor, stages);
let engine: Engine | null = null;

async function start(): Promise<void> {
  const graph = await audio.unlock();
  engine = new Engine({ graph, clock, lengths: LENGTHS });
  const context = audio.context as unknown as TapContext;
  attachLifecycle(engine, { document, window });
  // The context exists only now, after the gesture, so its lifecycle is attached here.
  attachContextLifecycle(engine, context);
}

/** The loudest sample the analyser sees right now, 0 to 1. */
function level(): number {
  const context = audio.context as unknown as TapContext | null;
  if (context === null) return 0;
  const data = new Float32Array(context.tap.fftSize);
  context.tap.getFloatTimeDomainData(data);
  return data.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
}

Object.assign(window, {
  player: {
    audioCreated: () => audio.created,
    contextState: () => audio.context?.state ?? "none",
    sampleRate: () => audio.context?.sampleRate ?? 0,
    resampled: () => audio.resampled,
    state: () => engine?.state ?? { kind: "none" },
    voices: () => engine?.voices ?? 0,
    timers: () => engine?.timers ?? 0,
    level,
  },
});

document.querySelector("#start")?.addEventListener("click", () => void start());
document.querySelector("#tap1")?.addEventListener("click", () => engine?.tapStage(1));
document.querySelector("#tap2")?.addEventListener("click", () => engine?.tapStage(2));
document.querySelector("#play")?.addEventListener("click", () => engine?.play());
document.querySelector("#pause")?.addEventListener("click", () => engine?.pause());
