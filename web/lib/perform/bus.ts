/**
 * The mix bus every performed voice passes through before the speakers: room for the voices that sound
 * (a gain that falls as their number grows), then a soft clip that is exactly the identity below its
 * knee and bounded inside full scale above it.
 *
 * It is deliberately not a dynamics compressor. Browsers' compressors differ (Chromium applies an automatic
 * make-up gain and looks ahead), so one pad through one could sound louder than the same stage on the roll.
 * This bus leaves a single voice exactly as the roll plays it, and what it does to several is a fixed,
 * checkable curve. The context is an argument, so the same code runs on an offline context in the
 * loudness check.
 */

/** The minimal shapes of the Web Audio nodes it uses, so it can be tested with a fake. */
interface ParamLike {
  readonly value: number;
  setValueAtTime(value: number, time: number): unknown;
  setTargetAtTime(value: number, time: number, timeConstant: number): unknown;
  cancelScheduledValues(time: number): unknown;
}
interface GainNodeLike {
  gain: ParamLike;
  connect(destination: unknown): unknown;
}
interface ShaperLike {
  curve: Float32Array | null;
  oversample: string;
  connect(destination: unknown): unknown;
}
export interface BusContext {
  readonly currentTime: number;
  readonly destination: unknown;
  createGain(): GainNodeLike;
  createWaveShaper(): ShaperLike;
}

/** Below this the soft clip changes nothing: a stage at 0.92 of full scale passes exactly. */
export const KNEE = 0.92;
/** Seconds: the room is taken back fast when a voice joins, so it never clips, and returned slowly. */
const MAKE_ROOM = 0.004;
const GIVE_ROOM = 0.15;

/** The gain that leaves room for `voices` sounding at once: all of it for one, 1/sqrt(n) for n. */
export function headroom(voices: number): number {
  return voices <= 1 ? 1 : 1 / Math.sqrt(voices);
}

/**
 * The soft clip's curve over the input range -1 to 1: the identity up to `knee`, then bending toward (and
 * staying below) full scale, odd-symmetric. An input beyond the range is held at the curve's ends.
 */
export function softClip(knee: number, points = 4097): Float32Array {
  const curve = new Float32Array(points);
  const room = 1 - knee;
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

export class MixBus {
  /** Where the performed voices connect. */
  readonly input: GainNodeLike;
  readonly #context: BusContext;

  constructor(context: BusContext) {
    this.#context = context;
    this.input = context.createGain();
    const shaper = context.createWaveShaper();
    shaper.curve = softClip(KNEE);
    // the curve is the identity where it matters; oversampling would only add latency
    shaper.oversample = "none";
    this.input.connect(shaper);
    shaper.connect(context.destination);
  }

  /** Tell the bus how many voices sound now. */
  voices(count: number): void {
    const param = this.input.gain;
    const target = headroom(count);
    const now = this.#context.currentTime;
    // Cancelling a move in flight sends the gain back to its last scheduled value, which is a jump:
    // read where it is, pin it there, then move on from that level.
    const here = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(here, now);
    param.setTargetAtTime(target, now, target < here ? MAKE_ROOM : GIVE_ROOM);
  }

  /** Let go of the nodes' connections. */
  disconnect(): void {
    (this.input as unknown as { disconnect?: () => void }).disconnect?.();
  }
}
