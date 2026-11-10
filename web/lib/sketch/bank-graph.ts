/**
 * The audio side of a sketch bank: a voice for each pad, through the performance's mix bus, on the page's
 * one audio context. A pad's sound is held as 16-bit samples (2 bytes a frame) and turned into the context's
 * float buffer only on the pad's first press, so a bank of twelve of the longest flips (60 seconds each)
 * costs about 69 MB until pads are played, and about 138 MB of float buffers once all of them have been (a bank of twelve 20 second flips was a third of that). The
 * pad that is not ready has no voice and the press says why: it is never a silent dead press.
 */
import type { Voice } from "../playback/engine.ts";
import { type AudioContextLike, WebAudioGraph } from "../playback/webaudio.ts";
import type { PerformGraph } from "../perform/performer.ts";
import type { MixBus } from "../perform/bus.ts";

export class BankGraph implements PerformGraph {
  readonly #context: AudioContextLike;
  readonly #bus: MixBus;
  /** Pad order: the sketch id on each pad, and its samples when they are ready. */
  #pads: Array<{ id: string; samples: Int16Array | null }> = [];
  /** One tiny graph per sketch, made on the first press. */
  readonly #graphs = new Map<string, WebAudioGraph>();
  /** How many float buffers have been made (for the memory note and for tests). */
  made = 0;

  constructor(context: AudioContextLike, bus: MixBus) {
    this.#context = context;
    this.#bus = bus;
  }

  /** The pads as they are now. A sketch that left the bank gives its buffer back. */
  setPads(pads: ReadonlyArray<{ id: string; samples: Int16Array | null }>): void {
    this.#pads = pads.map((p) => ({ ...p }));
    const keep = new Set(pads.map((p) => p.id));
    for (const id of [...this.#graphs.keys()]) if (!keep.has(id)) this.#graphs.delete(id);
  }

  voice(index: number): Voice {
    const pad = this.#pads[index];
    if (!pad || pad.samples === null) throw new Error("this pad has no sound yet");
    let graph = this.#graphs.get(pad.id);
    if (!graph) {
      graph = new WebAudioGraph(this.#context, [pad.samples]);
      this.#graphs.set(pad.id, graph);
      this.made += 1;
    }
    return graph.voice(0, this.#bus.input);
  }

  voices(count: number): void {
    this.#bus.voices(count);
  }
}
