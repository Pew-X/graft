import { RENDERER_PATH, loadRenderer, type Renderer } from "./renderer.ts";

let once: Promise<Renderer> | null = null;

/** The pinned renderer artefact, fetched and instantiated once, on first need; a failed fetch may be tried again. */
export function browserRenderer(): Promise<Renderer> {
  once ??= fetch(RENDERER_PATH)
    .then((r) => {
      if (!r.ok) throw new Error(`the renderer was answered with ${r.status}`);
      return r.arrayBuffer();
    })
    .then(loadRenderer)
    .catch((error: unknown) => {
      once = null;
      throw error;
    });
  return once;
}
