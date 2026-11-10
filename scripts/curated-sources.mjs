// The curated sources, synthesized from code: ten short sounds made for graft, so there is no
// third-party material and nothing to license. The output is canonical audio (48 kHz, mono, signed
// 16-bit little-endian, headerless) in seed/sources/, and seed/sources.json names each file with
// the SHA-256 of its bytes.
//
//   node scripts/curated-sources.mjs            write seed/sources/*.pcm
//   node scripts/curated-sources.mjs --check    fail if the files on disk differ from what this makes
//
// The generator uses only arithmetic and Math functions that every V8 build computes the same way,
// and one seeded random sequence, so the bytes are the same on every machine with the pinned Node.
// The sequence is shared between the sounds, so they must be made in the order of NAMES.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 48000, TAU = Math.PI * 2;
let seed = 7; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const noise = () => rnd() * 2 - 1;
const buf = s => new Float32Array(Math.floor(SR * s));
const saw = ph => 2 * (ph - Math.floor(ph + .5));
const pulse = (ph, d) => (ph - Math.floor(ph)) < d ? 1 : -1;
const mtof = m => 440 * 2 ** ((m - 69) / 12);
const lp = (x, fcFn) => { let y = 0; for (let i = 0; i < x.length; i++) { const a = 1 - Math.exp(-TAU * fcFn(i / SR) / SR); y += a * (x[i] - y); x[i] = y; } return x; };
const addAt = (dst, src, t, g = 1) => { const o = Math.floor(t * SR); for (let i = 0; i < src.length && o + i < dst.length; i++) dst[o + i] += src[i] * g; };

const S = {};
// 808 kick/sub: pitch-dropping sine, saturated, with a click
S['808-sub'] = () => { const x = buf(1.2); let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / SR; ph += (45 + 110 * Math.exp(-t * 35)) / SR; const a = Math.min(1, t / .004) * Math.exp(-t * 2.6); x[i] = Math.tanh(2.4 * Math.sin(TAU * ph)) * a + (t < .003 ? noise() * .4 : 0); } return x; };
// 8-bit arpeggio: 25% pulse, 4-bit quantized
S['chip-arp'] = () => { const x = buf(1.2); const notes = [60, 63, 67, 63, 60, 63, 67, 72]; const step = 1 / 16; let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / SR, n = Math.floor(t / step), nt = t - n * step; ph += mtof(n >= 18 ? 84 : notes[n % notes.length] + 12) / SR; const a = Math.exp(-nt * 14) * .9 + .1; x[i] = Math.round(pulse(ph, .25) * a * 7) / 7 * .8; } return x; };
// 8-bit power-up: rising pentatonic run then a held note
S['powerup'] = () => { const x = buf(1.2); const sc = [0, 2, 4, 7, 9]; let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / SR, n = Math.min(15, Math.floor(t / .05)); const m = 72 + sc[n % 5] + 12 * Math.floor(n / 5); ph += mtof(m) / SR; const hold = t > .8 ? Math.exp(-(t - .8) * 7) : 1; x[i] = Math.round(pulse(ph, .5) * hold * 5) / 5 * .6; } return x; };
// saber-ish hum: detuned saws, slow swing (pitch+amp), ignition sweep
S['saber-hum'] = () => { const x = buf(1.2); let p1 = 0, p2 = 0, p3 = 0; for (let i = 0; i < x.length; i++) { const t = i / SR, sw = Math.sin(TAU * 1.6 * t); const f = 82.4 * (1 + .045 * sw) * (1 + 2.5 * Math.exp(-t * 14)); p1 += f / SR; p2 += f * 1.012 / SR; p3 += f * 2 / SR; const a = Math.min(1, t / .02) * (.75 + .25 * sw) * Math.min(1, (1.2 - t) / .05); x[i] = Math.tanh(1.8 * (saw(p1) + saw(p2) + .5 * Math.sin(TAU * p3))) * a; } return lp(x, t => 1400 + 900 * Math.sin(TAU * 1.6 * t)); };
// laser zap: falling saw sweep
S['laser-zap'] = () => { const x = buf(1.2); let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / SR; ph += (110 + 3200 * Math.exp(-t * 9)) / SR; x[i] = (saw(ph) * .7 + Math.sin(TAU * ph * .5) * .3) * Math.min(1, t / .002) * Math.exp(-t * 4.5); } return x; };
// industrial clang: inharmonic metal partials, noise burst, drive
S['metal-clang'] = () => { const x = buf(1.2); const P = [[1, 6], [2.76, 9], [5.4, 14], [8.93, 20], [11.34, 26], [14.1, 34]]; for (let i = 0; i < x.length; i++) { const t = i / SR; let v = 0; for (const [r, d] of P) v += Math.sin(TAU * 420 * r * t) * Math.exp(-t * d) / (1 + r * .15); v += (t < .008 ? noise() * 1.2 : 0); x[i] = Math.tanh(2.2 * v); } return x; };
// house stab: detuned saw minor-9 chord, closing filter, off-beat double hit
S['house-stab'] = () => { const x = buf(1.2); const chord = [53, 56, 60, 63, 67]; const hit = (t0, g) => { const y = buf(.55); const ph = chord.flatMap(m => [0, 0, 0]); for (let i = 0; i < y.length; i++) { const t = i / SR; let v = 0; chord.forEach((m, k) => { [.994, 1, 1.006].forEach((d, j) => { ph[k * 3 + j] += mtof(m) * d / SR; v += saw(ph[k * 3 + j]); }); }); y[i] = v / 9 * Math.min(1, t / .003) * Math.exp(-t * 6.5); } lp(y, t => 5200 * Math.exp(-t * 7) + 500); addAt(x, y, t0, g); }; hit(0, 1); hit(.45, .7); return x; };
// jazz electric piano: FM Dm9 chord, soft strum, tremolo
S['jazz-rhodes'] = () => { const x = buf(1.2); [50, 53, 57, 60, 64].forEach((m, k) => { const f = mtof(m), t0 = k * .018; for (let i = Math.floor(t0 * SR); i < x.length; i++) { const t = i / SR - t0; const I = 2.2 * Math.exp(-t * 4.5) + .25; x[i] += Math.sin(TAU * f * t + I * Math.sin(TAU * f * t)) * Math.min(1, t / .004) * Math.exp(-t * 1.9) * .22; } }); for (let i = 0; i < x.length; i++) x[i] *= .85 + .15 * Math.sin(TAU * 5 * i / SR); return x; };
// upright bass: Karplus-Strong walking line
S['upright-bass'] = () => { const x = buf(1.2); [43, 45, 47, 40].forEach((m, k) => { const N = Math.round(SR / mtof(m)), d = new Float32Array(N); let pv = 0; for (let i = 0; i < N; i++) { pv = pv * .6 + noise() * .4; d[i] = pv; } const len = Math.floor(.3 * SR), y = new Float32Array(len); let p = 0; for (let i = 0; i < len; i++) { const q = (p + 1) % N; y[i] = d[p]; d[p] = (d[p] + d[q]) * .5 * .9985; p = q; } lp(y, () => 500); addAt(x, y, k * .3, 3.2); }); return x; };
// trap hat roll over a kick: accelerating closed hats
S['trap-hats'] = () => { const x = buf(1.2); const kick = S['808-sub'](); addAt(x, kick.subarray(0, Math.floor(.35 * SR)), 0, .8); const T = [.0, .16, .32, .44, .56, .66, .76, .84, .92, .99, 1.05, 1.1, 1.14, 1.18]; T.forEach((t0, k) => { const y = buf(.06); let a = 0; for (let i = 0; i < y.length; i++) { const n = noise(); y[i] = (n - a) * Math.exp(-i / SR * 70); a = n * .6; } addAt(x, y, t0, .35 + .5 * k / T.length); }); return x; };

const peakNorm = x => { let m = 0, e = 0; for (const v of x) { m = Math.max(m, Math.abs(v)); e += v * v; } const rms = Math.sqrt(e / x.length) || 1; const g = Math.min(.95 / (m || 1), .13 / rms); return Int16Array.from(x, v => Math.round(v * g * 32767)); };

/** The order matters: the random sequence runs on from one sound to the next. */
export const NAMES = ['808-sub', 'chip-arp', 'powerup', 'saber-hum', 'laser-zap', 'metal-clang', 'house-stab', 'jazz-rhodes', 'upright-bass', 'trap-hats'];

/** Every source as canonical bytes, by name. */
export function makeAll() {
  const out = new Map();
  for (const name of NAMES) {
    const pcm = peakNorm(S[name]());
    out.set(name, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2));
  }
  return out;
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed', 'sources');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  fs.mkdirSync(dir, { recursive: true });
  let differs = 0;
  for (const [name, bytes] of makeAll()) {
    const file = path.join(dir, `${name}.pcm`);
    if (check) {
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) {
        console.error(`${name}.pcm differs from what the generator makes`);
        differs += 1;
      }
    } else {
      fs.writeFileSync(file, bytes);
    }
  }
  if (differs) process.exit(1);
}
