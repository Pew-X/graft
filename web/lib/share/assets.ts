import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** What the share card needs from disk, read once: three fonts (as TrueType) and the paper grain (as a data address). */
export interface CardAssets {
  fonts: Array<{ name: string; data: ArrayBuffer; weight: 400 | 800; style: "normal" }>;
  paper: string;
}

let loaded: Promise<CardAssets> | null = null;

async function bytes(...path: string[]): Promise<Buffer> {
  return readFile(join(process.cwd(), "assets", ...path));
}

const arrayBuffer = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export function cardAssets(): Promise<CardAssets> {
  loaded ??= (async () => {
    const [brush, black, cond, paper] = await Promise.all([
      bytes("fonts", "CaveatBrush-Regular.ttf"),
      bytes("fonts", "ArchivoBlack-Regular.ttf"),
      bytes("fonts", "BarlowCondensed-ExtraBold.ttf"),
      bytes("share", "paper.png"),
    ]);
    return {
      fonts: [
        { name: "Brush", data: arrayBuffer(brush), weight: 400, style: "normal" },
        { name: "Black", data: arrayBuffer(black), weight: 400, style: "normal" },
        { name: "Cond", data: arrayBuffer(cond), weight: 800, style: "normal" },
      ],
      paper: `data:image/png;base64,${paper.toString("base64")}`,
    };
  })();
  return loaded;
}
