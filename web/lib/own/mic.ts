/** The microphone, held only while recording, and never longer than the longest source. */
export const MAX_SECONDS = 15;

export type MicProblem = "denied" | "unavailable";

export interface Recording {
  /** The open microphone, so a picture of what it hears can be drawn while it is held (the recording indicator stays the browser's). */
  stream: MediaStream;
  /** Stop and hand back what was recorded. */
  stop(): Promise<Blob>;
  /** Stop and throw away what was recorded, and let the microphone go. */
  cancel(): void;
}

/**
 * Ask for the microphone and start recording. A refusal or a missing device comes back as a
 * problem to tell the maker about; every track is stopped when recording ends, so the browser's
 * recording indicator goes out.
 */
export async function startRecording(
  onLimit: () => void,
): Promise<{ ok: true; recording: Recording } | { ok: false; problem: MicProblem }> {
  const devices = navigator.mediaDevices;
  if (!devices || typeof MediaRecorder === "undefined")
    return { ok: false, problem: "unavailable" };
  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia({ audio: true });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    return {
      ok: false,
      problem: name === "NotFoundError" || name === "NotReadableError" ? "unavailable" : "denied",
    };
  }
  const release = () => stream.getTracks().forEach((t) => t.stop());
  let recorder: MediaRecorder;
  const chunks: Blob[] = [];
  try {
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.start();
  } catch {
    // The microphone was allowed but cannot be recorded from: let it go, so its indicator goes out.
    release();
    return { ok: false, problem: "unavailable" };
  }
  const timer = setTimeout(onLimit, MAX_SECONDS * 1000);
  return {
    ok: true,
    recording: {
      stream,
      cancel: () => {
        clearTimeout(timer);
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
        release();
      },
      stop: () =>
        new Promise<Blob>((resolve) => {
          clearTimeout(timer);
          recorder.onstop = () => {
            release();
            resolve(new Blob(chunks, { type: recorder.mimeType }));
          };
          if (recorder.state !== "inactive") recorder.stop();
          else recorder.onstop?.(new Event("stop"));
        }),
    },
  };
}
