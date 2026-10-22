import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "./engine.ts";
import { attachContextLifecycle, attachLifecycle } from "./lifecycle.ts";
import { FakeClock, FakeGraph } from "./testing.ts";

class FakeTarget {
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  count(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

function setup() {
  const clock = new FakeClock();
  const graph = new FakeGraph(clock, [1.2, 0.6]);
  const engine = new Engine({ graph, clock, lengths: [1.2, 0.6] });
  const document = Object.assign(new FakeTarget(), { visibilityState: "visible" });
  const window = new FakeTarget();
  const mediaDevices = new FakeTarget();
  const audioContext = Object.assign(new FakeTarget(), { state: "running" });
  const detach = attachLifecycle(engine, { document, window, mediaDevices, audioContext });
  return { clock, graph, engine, document, window, mediaDevices, audioContext, detach };
}

test("hiding the tab while playing pauses cleanly and leaves nothing running", () => {
  const s = setup();
  s.engine.play();
  s.clock.advance(0.5);
  s.document.visibilityState = "hidden";
  s.document.emit("visibilitychange");
  assert.equal(s.engine.state.kind, "paused");
  assert.deepEqual([s.engine.voices, s.engine.timers, s.graph.sounding.length], [0, 0, 0]);
  s.document.visibilityState = "visible";
  s.document.emit("visibilitychange");
  assert.equal(s.engine.state.kind, "paused", "coming back never restarts the sound by itself");
});

test("an event that finds nothing playing changes nothing", () => {
  const s = setup();
  s.document.visibilityState = "hidden";
  s.document.emit("visibilitychange");
  s.window.emit("pagehide");
  s.mediaDevices.emit("devicechange");
  assert.equal(s.engine.state.kind, "idle");
});

test("leaving the page, a device change, and the system taking the audio each pause playback", () => {
  for (const trigger of [
    (s: ReturnType<typeof setup>) => s.window.emit("pagehide"),
    (s: ReturnType<typeof setup>) => s.mediaDevices.emit("devicechange"),
    (s: ReturnType<typeof setup>) => {
      s.audioContext.state = "interrupted";
      s.audioContext.emit("statechange");
    },
    (s: ReturnType<typeof setup>) => {
      s.audioContext.state = "suspended";
      s.audioContext.emit("statechange");
    },
  ]) {
    const s = setup();
    s.engine.tapStage(1);
    s.clock.advance(0.2);
    trigger(s);
    assert.equal(s.engine.state.kind, "paused");
    assert.equal(s.graph.sounding.length, 0);
  }
});

test("a context that is running again does not pause anything", () => {
  const s = setup();
  s.engine.play();
  s.audioContext.state = "running";
  s.audioContext.emit("statechange");
  assert.equal(s.engine.state.kind, "rolling");
});

test("detaching removes every listener, and later events do nothing", () => {
  const s = setup();
  assert.ok(
    s.document.count() + s.window.count() + s.mediaDevices.count() + s.audioContext.count() >= 4,
  );
  s.detach();
  assert.equal(
    s.document.count() + s.window.count() + s.mediaDevices.count() + s.audioContext.count(),
    0,
  );
  s.engine.play();
  s.window.emit("pagehide");
  assert.equal(s.engine.state.kind, "rolling");
});

test("a context created after the first gesture can still pause playback when the system takes the audio", () => {
  // attachLifecycle ran at mount, when no context existed; the context is attached once it does.
  const clock = new FakeClock();
  const graph = new FakeGraph(clock, [1.2, 0.6]);
  const engine = new Engine({ graph, clock, lengths: [1.2, 0.6] });
  const context = Object.assign(new FakeTarget(), { state: "running" });
  const detach = attachContextLifecycle(engine, context);
  engine.tapStage(1);
  clock.advance(0.1);
  context.state = "interrupted";
  context.emit("statechange");
  assert.equal(engine.state.kind, "paused");
  assert.equal(graph.sounding.length, 0);
  detach();
  assert.equal(context.count(), 0);
});
