import type { Engine } from "./engine.ts";
import { isSounding } from "./machine.ts";

interface Target {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface LifecycleSources {
  /** The document: `visibilitychange` fires when the tab goes to the background. */
  document: Target & { readonly visibilityState: string };
  /** The window: `pagehide` fires when the page is being left. */
  window: Target;
  /** `navigator.mediaDevices`: `devicechange` fires when headphones are plugged or unplugged. */
  mediaDevices?: Target;
  /** The audio context, if it exists: its state becomes suspended or interrupted when the system claims the audio. */
  audioContext?: Target & { readonly state: string };
}

/**
 * Pause cleanly when the tab is hidden, the page is left, the output device changes, or the system
 * claims the audio away; resume is always the person's choice. Returns a function that removes the
 * listeners.
 */
export function attachLifecycle(engine: Engine, sources: LifecycleSources): () => void {
  const pause = (): void => {
    if (isSounding(engine.state)) engine.tabHidden();
  };
  const onVisibility = (): void => {
    if (sources.document.visibilityState === "hidden") pause();
  };
  const onContextState = (): void => {
    const state = sources.audioContext?.state;
    if (state === "suspended" || state === "interrupted" || state === "closed") pause();
  };
  sources.document.addEventListener("visibilitychange", onVisibility);
  sources.window.addEventListener("pagehide", pause);
  sources.mediaDevices?.addEventListener("devicechange", pause);
  sources.audioContext?.addEventListener("statechange", onContextState);
  return () => {
    sources.document.removeEventListener("visibilitychange", onVisibility);
    sources.window.removeEventListener("pagehide", pause);
    sources.mediaDevices?.removeEventListener("devicechange", pause);
    sources.audioContext?.removeEventListener("statechange", onContextState);
  };
}
