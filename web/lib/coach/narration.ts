/**
 * The first play narrates itself: one short caption for each moment of the roll (the finished sound,
 * the source, each flip, the rest), worked out from the chain's own data. The caption for a moment is
 * a pure function of the chain and the moment, so it can never run ahead of the sound: the page asks
 * for the caption of the step the engine says it is on. No caption names a maker; the credit stays on
 * the stage's own label, so the text never reads as the app doing it.
 */
import { copy, fill } from "../copy.ts";
import type { State } from "../playback/machine.ts";
import { buildSteps, type Step } from "../playback/steps.ts";
import type { StageState } from "../roll/view.ts";

/** What a caption needs to know of a stage; a roll block has all of it. */
export interface Narrated {
  kind: string;
  title: string;
  state: StageState;
  /** The frames of the stage before it that a flip kept; null for a source. */
  cutFrames: readonly [number, number] | null;
  /** The speed as a fraction; null when it is not known. */
  speed: { p: number; q: number } | null;
}

/** Which moment of the roll the sound is at. */
export type Moment = Pick<Step, "kind" | "stage">;

/** The longest a name may be in a caption before it is cut short with an ellipsis. */
const LONGEST_NAME = 32;

export function shorten(name: string): string {
  const chars = [...name];
  return chars.length <= LONGEST_NAME ? name : `${chars.slice(0, LONGEST_NAME - 1).join("")}…`;
}

/**
 * The caption for `step` of a roll over `stages`. `frames` is each stage's output length in frames
 * (null where it is not known yet); it only decides whether a cut kept the whole of the sound before it.
 */
export function captions(
  step: Moment,
  stages: readonly Narrated[],
  frames: ReadonlyArray<number | null>,
): string {
  const n = copy.narration;
  const last = stages.length - 1;
  if (step.kind === "teaser") return last === 0 ? n.teaserOne : n.teaser;
  if (step.kind === "rest") return last === 0 ? n.restOne : n.rest;

  const stage = stages[step.stage];
  if (!stage || stage.state !== "available") return n.missing;
  if (stage.kind === "source" || step.stage === 0)
    return fill(n.began, { name: shorten(stage.title) });

  const parentFrames = frames[step.stage - 1] ?? null;
  const [start, end] = stage.cutFrames ?? [0, 0];
  const whole =
    stage.cutFrames !== null && start === 0 && parentFrames !== null && end >= parentFrames;
  const speed = stage.speed;
  const direction =
    speed === null ? "none" : speed.p > speed.q ? "up" : speed.p < speed.q ? "down" : "same";
  if (whole)
    return direction === "up" ? n.wholeUp : direction === "down" ? n.wholeDown : n.wholeSame;
  return direction === "up"
    ? n.cutUp
    : direction === "down"
      ? n.cutDown
      : direction === "same"
        ? n.cutSame
        : n.cutOnly;
}

/** The moment the engine is at, or null when no roll is sounding or paused (an audition has no caption). */
export function momentAt(state: State, stages: number): Moment | null {
  const roll = state.kind === "paused" ? state.from : state;
  if (roll.kind !== "rolling") return null;
  const step = buildSteps(stages)[roll.step];
  return step ? { kind: step.kind, stage: step.stage } : null;
}
