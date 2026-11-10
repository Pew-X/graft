import { DWELL_MAX, DWELL_MIN, ROLL_TARGET_SECONDS } from "./config.ts";

/** One step of roll mode. */
export interface Step {
  /** "teaser" is the finished flip first; "stage" walks the chain forward; "rest" is the finished flip again, looping. */
  kind: "teaser" | "stage" | "rest";
  /** Which stage plays: 0 is the source, `stages - 1` is the finished flip. */
  stage: number;
  /** How long the step lasts in seconds; null for rest, which has no end. */
  dwell: number | null;
}

/** How long each step of a roll over `stages` stages lasts, in seconds. */
export function dwellFor(stages: number): number {
  const wanted = ROLL_TARGET_SECONDS / stages;
  return Math.min(DWELL_MAX, Math.max(DWELL_MIN, wanted));
}

function assertStages(stages: number): void {
  if (!Number.isInteger(stages) || stages < 1) {
    throw new RangeError(`a chain has at least one stage, got ${stages}`);
  }
}

/** The ordered steps of roll mode: teaser, then each stage from the source forward, then rest. */
export function buildSteps(stages: number): Step[] {
  assertStages(stages);
  const dwell = dwellFor(stages);
  const final = stages - 1;
  return [
    { kind: "teaser", stage: final, dwell },
    ...Array.from({ length: stages }, (_, stage): Step => ({ kind: "stage", stage, dwell })),
    { kind: "rest", stage: final, dwell: null },
  ];
}

/** Index of the rest step. */
export function restStep(stages: number): number {
  assertStages(stages);
  return stages + 1;
}

/**
 * The step roll mode resumes at after an audition of `stage`: the start of that stage's step, and
 * for the finished flip, the first stage: nothing is left after it to continue to, and resting on a
 * sound that has just been heard felt like a loop that would not let go (found in the first live audit).
 */
export function stepAfterAudition(stages: number, stage: number): number {
  assertStages(stages);
  return stage >= stages - 1 ? 1 : stage + 1;
}
