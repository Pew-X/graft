/**
 * The playback state machine: a pure, total function from a state and an event to the next state
 * and the effects to carry out. It knows nothing about audio or time; the engine feeds it events and
 * performs its effects. Every state handles every event (a stale or irrelevant one leaves the state
 * alone), so there is no undefined behaviour to find later.
 *
 * Two modes. *Roll* plays the chain as a sequence of steps (teaser, source forward, rest). *Audition*
 * plays one stage's whole output once. Scrubbing is always an audition; the roll's own progress is
 * automatic. One position is always (stage, offset): in roll mode the stage of the current step.
 */
import { buildSteps, restStep, stepAfterAudition } from "./steps.ts";

/** Roll mode: at `step`, `elapsed` seconds into it. */
export interface Rolling {
  kind: "rolling";
  step: number;
  elapsed: number;
}

/** Audition: one stage, `offset` seconds into its full output; `ended` once it has played to the end. */
export interface Auditioning {
  kind: "auditioning";
  stage: number;
  offset: number;
  ended: boolean;
}

export type State =
  { kind: "idle" } | Rolling | Auditioning | { kind: "paused"; from: Rolling | Auditioning };

export type Event =
  | { type: "play" }
  | { type: "pause"; position: number }
  | { type: "tapStage"; stage: number; position: number }
  | { type: "scrubStart"; stage: number; offset: number }
  | { type: "scrubMove"; stage: number; offset: number }
  | { type: "scrubEnd" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "dwellEnded" }
  | { type: "auditionEnded" }
  | { type: "tabHidden"; position: number }
  | { type: "routeChange" }
  | { type: "reducedMotion"; enabled: boolean };

export type Effect =
  /** Release whatever is sounding. Always comes first, so two sources never overlap. */
  | { type: "stop" }
  /** Begin sounding `stage` from `offset` seconds; in roll mode it repeats, in audition it plays once. */
  | { type: "start"; stage: number; offset: number; mode: "roll" | "audition" }
  /** Arm the end-of-step timer for this many seconds, replacing any earlier one. */
  | { type: "dwell"; seconds: number }
  | { type: "cancelDwell" };

export interface Result {
  state: State;
  effects: Effect[];
}

export const idle: State = { kind: "idle" };

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function same(a: State, b: State): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The effects of entering a playing state. */
function enter(state: State, stages: number): Effect[] {
  switch (state.kind) {
    case "rolling": {
      const step = buildSteps(stages)[state.step];
      if (!step) return [{ type: "stop" }, { type: "cancelDwell" }];
      const effects: Effect[] = [
        { type: "stop" },
        { type: "start", stage: step.stage, offset: state.elapsed, mode: "roll" },
      ];
      effects.push(
        step.dwell === null
          ? { type: "cancelDwell" }
          : { type: "dwell", seconds: Math.max(0, step.dwell - state.elapsed) },
      );
      return effects;
    }
    case "auditioning":
      // An audition that has played to its end enters silence: nothing is started again.
      if (state.ended) return [{ type: "stop" }, { type: "cancelDwell" }];
      return [
        { type: "stop" },
        { type: "cancelDwell" },
        { type: "start", stage: state.stage, offset: state.offset, mode: "audition" },
      ];
    case "idle":
    case "paused":
      return [{ type: "stop" }, { type: "cancelDwell" }];
  }
}

function go(prev: State, next: State, stages: number): Result {
  return { state: next, effects: same(prev, next) ? [] : enter(next, stages) };
}

const audition = (stage: number, offset: number): Auditioning => ({
  kind: "auditioning",
  stage,
  offset,
  ended: false,
});

/** Advance the machine. `stages` is the number of stages in the chain being played (at least 1). */
export function transition(state: State, event: Event, stages: number): Result {
  const last = stages - 1;
  const rest = restStep(stages);
  const stageIn = (n: number): number => clamp(Math.trunc(n), 0, last);

  // Events that mean the same thing in every state.
  switch (event.type) {
    case "routeChange":
      return go(state, idle, stages);
    case "reducedMotion":
      return { state, effects: [] }; // a presentation setting: it changes no playback state
    case "scrubStart":
    case "scrubMove":
      return go(state, audition(stageIn(event.stage), Math.max(0, event.offset)), stages);
    case "scrubEnd":
      return { state, effects: [] }; // the audition simply continues from where it was released
    case "tapStage":
      break; // depends on the state, below
    default:
      break;
  }

  switch (state.kind) {
    case "idle":
      switch (event.type) {
        case "play":
          return go(state, { kind: "rolling", step: 0, elapsed: 0 }, stages); // first tap: the teaser
        case "tapStage":
          return go(state, audition(stageIn(event.stage), 0), stages);
        default:
          return { state, effects: [] }; // pause, next, previous and the timers' events mean nothing here
      }

    case "rolling":
      switch (event.type) {
        case "play":
          return { state, effects: [] }; // already rolling
        case "pause":
        case "tabHidden":
          return go(
            state,
            {
              kind: "paused",
              from: { kind: "rolling", step: state.step, elapsed: Math.max(0, event.position) },
            },
            stages,
          );
        case "tapStage":
          return go(state, audition(stageIn(event.stage), 0), stages);
        case "next":
          return go(
            state,
            { kind: "rolling", step: Math.min(state.step + 1, rest), elapsed: 0 },
            stages,
          );
        case "previous":
          return go(
            state,
            { kind: "rolling", step: Math.max(state.step - 1, 0), elapsed: 0 },
            stages,
          );
        case "dwellEnded":
          // Rest has no dwell, so a late timer there is ignored.
          return state.step >= rest
            ? { state, effects: [] }
            : go(state, { kind: "rolling", step: state.step + 1, elapsed: 0 }, stages);
        default:
          return { state, effects: [] }; // auditionEnded is stale in roll mode
      }

    case "auditioning":
      switch (event.type) {
        case "play":
          // The main control after an audition continues roll mode from that stage's step.
          return go(
            state,
            { kind: "rolling", step: stepAfterAudition(stages, state.stage), elapsed: 0 },
            stages,
          );
        case "pause":
        case "tabHidden":
          return state.ended
            ? { state, effects: [] } // nothing is sounding, so nothing to pause
            : go(
                state,
                {
                  kind: "paused",
                  from: {
                    kind: "auditioning",
                    stage: state.stage,
                    offset: Math.max(0, event.position),
                    ended: false,
                  },
                },
                stages,
              );
        case "tapStage": {
          const stage = stageIn(event.stage);
          if (stage !== state.stage) return go(state, audition(stage, 0), stages);
          // The same stage: a second tap pauses it while it plays, and replays it once it has ended.
          return state.ended
            ? go(state, audition(stage, 0), stages)
            : go(
                state,
                {
                  kind: "paused",
                  from: {
                    kind: "auditioning",
                    stage,
                    offset: Math.max(0, event.position),
                    ended: false,
                  },
                },
                stages,
              );
        }
        case "next":
          return go(state, audition(Math.min(state.stage + 1, last), 0), stages);
        case "previous":
          return go(state, audition(Math.max(state.stage - 1, 0), 0), stages);
        case "auditionEnded":
          return go(state, { ...state, ended: true }, stages);
        default:
          return { state, effects: [] }; // dwellEnded is stale in an audition
      }

    case "paused": {
      const from = state.from;
      switch (event.type) {
        case "play":
          // Pause and resume are exact and stay in the same mode.
          return go(
            state,
            from.kind === "rolling" ? { ...from } : { ...from, ended: false },
            stages,
          );
        case "tapStage":
          return go(state, audition(stageIn(event.stage), 0), stages);
        case "next":
        case "previous": {
          const delta = event.type === "next" ? 1 : -1;
          const moved: Rolling | Auditioning =
            from.kind === "rolling"
              ? { kind: "rolling", step: clamp(from.step + delta, 0, rest), elapsed: 0 }
              : audition(clamp(from.stage + delta, 0, last), 0);
          return go(state, { kind: "paused", from: moved }, stages);
        }
        default:
          return { state, effects: [] }; // pause, tabHidden and the timers' events: nothing is sounding
      }
    }
  }
}

/** The stage the machine says is current, or null when nothing has started. Roll and audio must agree on it. */
export function currentStage(state: State, stages: number): number | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "rolling":
      return buildSteps(stages)[state.step]?.stage ?? null;
    case "auditioning":
      return state.stage;
    case "paused":
      return currentStage(state.from, stages);
  }
}

/** True when the machine intends sound right now. */
export function isSounding(state: State): boolean {
  return state.kind === "rolling" || (state.kind === "auditioning" && !state.ended);
}
