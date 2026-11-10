/**
 * The loudness and click checks for performing, run on an offline context so they are exact: the same bus
 * code the page uses, rendered to samples. The spec in perform-audio.spec.ts drives it.
 */
import { ATTACK } from "../lib/playback/config.ts";
import { WebAudioGraph, type AudioContextLike } from "../lib/playback/webaudio.ts";
import { performAudio } from "../lib/perform/graph.ts";
import { Performer } from "../lib/perform/performer.ts";

const RATE = 48_000;

/** Signed 16-bit stages, as the page holds them. */
type Stages = number[][];

function offline(seconds: number): OfflineAudioContext {
  return new OfflineAudioContext(1, Math.ceil(seconds * RATE), RATE);
}
function graphOf(context: OfflineAudioContext, stages: Stages): WebAudioGraph {
  return new WebAudioGraph(
    context as unknown as AudioContextLike,
    stages.map((s) => Int16Array.from(s)),
  );
}
const peakOf = (data: Float32Array): number => data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rmsOf = (data: Float32Array): number =>
  Math.sqrt(data.reduce((s, v) => s + v * v, 0) / Math.max(1, data.length));

/** One stage through the roll's own path: voice to the speakers. */
async function viaRoll(stages: Stages, stage: number, seconds: number) {
  const ctx = offline(seconds);
  graphOf(ctx, stages).voice(stage).start(0, ATTACK);
  const out = (await ctx.startRendering()).getChannelData(0);
  return { peak: peakOf(out), rms: rmsOf(out) };
}

/** The same stage as a pad: through the performance's bus. */
async function viaPad(stages: Stages, stage: number, seconds: number) {
  const ctx = offline(seconds);
  const { graph } = performAudio(graphOf(ctx, stages), ctx as unknown as AudioContextLike);
  const performer = new Performer({ graph, stages: stages.length, now: () => 0 });
  performer.press(stage);
  const out = (await ctx.startRendering()).getChannelData(0);
  return { peak: peakOf(out), rms: rmsOf(out) };
}

/** Every stage at once, under the overlap rule as far as it goes, and the loudest sample of the mix. */
async function allAtOnce(stages: Stages, seconds: number) {
  const ctx = offline(seconds);
  const { graph, bus } = performAudio(graphOf(ctx, stages), ctx as unknown as AudioContextLike);
  // six voices are the performer's cap; the bus is also shown twelve, which a bare graph can reach
  bus.voices(stages.length);
  stages.forEach((_, stage) => graph.voice(stage).start(0, ATTACK));
  const out = (await ctx.startRendering()).getChannelData(0);
  return { peak: peakOf(out) };
}

/**
 * Press one stage, then another at `at` seconds, one at a time, and report the largest step between
 * neighbouring samples near the cut and over the whole render (a click is a step far beyond the tone's).
 */
async function cutClick(
  stages: Stages,
  first: number,
  second: number,
  at: number,
  seconds: number,
) {
  const ctx = offline(seconds);
  const { graph } = performAudio(graphOf(ctx, stages), ctx as unknown as AudioContextLike);
  const performer = new Performer({ graph, stages: stages.length, now: () => ctx.currentTime });
  performer.press(first);
  void ctx.suspend(at).then(() => {
    performer.press(second);
    return ctx.resume();
  });
  const out = (await ctx.startRendering()).getChannelData(0);
  let near = 0;
  let overall = 0;
  const from = Math.floor(at * RATE) - 200;
  for (let i = 1; i < out.length; i++) {
    const step = Math.abs((out[i] ?? 0) - (out[i - 1] ?? 0));
    overall = Math.max(overall, step);
    if (i >= from && i <= from + 1800) near = Math.max(near, step);
  }
  return { near, overall, first: out[0] ?? 0 };
}

Object.assign(window, { measure: { viaRoll, viaPad, allAtOnce, cutClick } });
