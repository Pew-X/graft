/**
 * The audio side of performing: the roll's own decoded stages, played through the performance's mix bus on
 * the roll's own audio context. No second context is made and nothing is fetched on a press.
 */
import type { AudioContextLike, WebAudioGraph } from "../playback/webaudio.ts";
import { MixBus, type BusContext } from "./bus.ts";
import type { PerformGraph } from "./performer.ts";

export interface PerformAudio {
  graph: PerformGraph;
  bus: MixBus;
}

/** The performance's graph over the roll's graph and context. */
export function performAudio(roll: WebAudioGraph, context: AudioContextLike): PerformAudio {
  const bus = new MixBus(context as unknown as BusContext);
  return {
    bus,
    graph: {
      voice: (stage) => roll.voice(stage, bus.input),
      voices: (count) => bus.voices(count),
    },
  };
}
