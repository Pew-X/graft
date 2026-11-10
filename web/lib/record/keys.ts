/** Where the stylus rests when the person moves it by keyboard: a stage and seconds into it. */
export interface Cursor {
  stage: number;
  offset: number;
}

/** One press of left or right moves this many seconds. */
const STEP = 0.1;

/**
 * What a key does to the stylus, or null for a key the record does not use. Left and right move
 * within a stage; up goes outwards towards the source, down inwards, keeping the same share of the
 * stage; home and end go to its ends. Playing from the cursor is the caller's (Enter and Space).
 */
export function moveCursor(cursor: Cursor, key: string, lengths: readonly number[]): Cursor | null {
  const length = lengths[cursor.stage] ?? 0;
  const within = (offset: number): Cursor => ({
    stage: cursor.stage,
    // To the millisecond: the arithmetic of tenths should not show as 0.19999999999999998.
    offset: Math.round(Math.min(length, Math.max(0, offset)) * 1000) / 1000,
  });
  const toStage = (stage: number): Cursor => {
    const clamped = Math.min(lengths.length - 1, Math.max(0, stage));
    if (clamped === cursor.stage) return cursor;
    const share = length > 0 ? cursor.offset / length : 0;
    return { stage: clamped, offset: share * (lengths[clamped] ?? 0) };
  };
  switch (key) {
    case "ArrowRight":
      return within(cursor.offset + STEP);
    case "ArrowLeft":
      return within(cursor.offset - STEP);
    case "ArrowUp":
      return toStage(cursor.stage - 1);
    case "ArrowDown":
      return toStage(cursor.stage + 1);
    case "Home":
      return within(0);
    case "End":
      return within(length);
    default:
      return null;
  }
}
