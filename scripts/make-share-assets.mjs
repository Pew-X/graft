// The paper texture of the share card, made the same way every time: `node scripts/make-share-assets.mjs`
// writes web/assets/share/paper.png, a tile of fine grain and a few paper fibres, in dark brown on
// transparent, to be laid over the card's paper colour. No image library: a PNG is a signature, a few
// chunks and a deflated stream, and the noise is a seeded generator, so the file is reproducible.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "web", "assets", "share", "paper.png");

let seed = 0x1badb002;
function rand() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// alpha only: grey 0..255 where 255 is the darkest speck. Grain first.
const alpha = new Float32Array(SIZE * SIZE);
for (let i = 0; i < alpha.length; i++) alpha[i] = Math.pow(rand(), 2.6) * 14;
// then fibres: short, slightly curved, faint lines (paper is made of them), wrapping at the tile's edge
for (let f = 0; f < 150; f++) {
  let x = rand() * SIZE;
  let y = rand() * SIZE;
  let angle = rand() * Math.PI * 2;
  const length = 6 + rand() * 22;
  const strength = 6 + rand() * 10;
  for (let s = 0; s < length; s++) {
    angle += (rand() - 0.5) * 0.35;
    x += Math.cos(angle);
    y += Math.sin(angle);
    const px = ((Math.round(x) % SIZE) + SIZE) % SIZE;
    const py = ((Math.round(y) % SIZE) + SIZE) % SIZE;
    alpha[py * SIZE + px] = Math.min(34, alpha[py * SIZE + px] + strength);
  }
}

// grey+alpha, 8 bits: the colour is one dark brown for every pixel, the alpha is the texture
const raw = Buffer.alloc((SIZE * 2 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 2 + 1);
  raw[row] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    raw[row + 1 + x * 2] = 58; // the brown, as one grey value: the card tints it
    // a few levels, not a continuous range: the grain looks the same and the card is far smaller to send
    raw[row + 2 + x * 2] = Math.round(alpha[y * SIZE + x] / 5) * 5;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, sum]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 4; // grey with alpha
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out}: ${png.length} bytes`);
