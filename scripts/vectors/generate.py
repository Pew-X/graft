#!/usr/bin/env python3
"""Writes fixtures/vectors/vectors.json from the independent reference (reference.py).

    python3 scripts/vectors/generate.py           rewrite the table
    python3 scripts/vectors/generate.py --check   fail if the committed table differs

Before writing, the reference is checked against the 14 hashes recorded by the original spike and
against outputs worked out by hand, so a wrong reference cannot silently define the table.
"""

import json
import sys
from pathlib import Path

import reference as ref

ROOT = Path(__file__).resolve().parents[2]
TABLE = ROOT / "fixtures" / "vectors" / "vectors.json"

NOISE = lambda n: {"kind": "lcg", "len": n, "seed": 12345}  # noqa: E731
SQUARE = lambda n: {"kind": "square", "len": n, "half_period_log2": 5}  # noqa: E731
CONST = lambda n, v: {"kind": "constant", "len": n, "value": v}  # noqa: E731
LIT = lambda s: {"kind": "literal", "samples": s}  # noqa: E731

# name, doc, input, p, q, method
RENDERS = [
    # The spike's 14 vectors, names unchanged so their recorded hashes stay comparable.
    ("id-lin", "speed 1, linear", NOISE(1000), 1, 1, 0),
    ("id-cr", "speed 1, Hermite: equals linear at t = 0", NOISE(1000), 1, 1, 1),
    ("up3/2-cr", "speed 3/2", NOISE(48000), 3, 2, 1),
    ("dn2/3-cr", "speed 2/3", NOISE(48000), 2, 3, 1),
    ("q4-cr", "speed 4 exactly", NOISE(30011), 4, 1, 1),
    ("q1/4-cr", "speed 1/4 exactly", NOISE(30011), 1, 4, 1),
    ("odd-cr", "awkward prime fraction", NOISE(48000), 7919, 5003, 1),
    ("odd-lin", "awkward prime fraction, linear", NOISE(48000), 7919, 5003, 0),
    ("L1-cr", "one input frame at speed 3/2 gives one output frame", NOISE(1), 3, 2, 1),
    ("L2-cr", "two input frames at speed 2/3", NOISE(2), 1, 3, 1),
    ("L3-lin", "three input frames at speed 1/3, linear", NOISE(3), 1, 3, 0),
    ("sq-cr", "full-scale square wave: Hermite overshoot saturates", SQUARE(9000), 5, 7, 1),
    ("max-cr", "480,000 frames at p/q just under 1 with p and q near 2^20", NOISE(480000), 1048575, 1048576, 1),
    ("big-cr", "renderer input ceiling 2^21 frames at speed 4", NOISE(2097152), 4, 1, 1),
    # Tiny cases checked by hand (see HAND below).
    ("hand-one-frame", "one-frame output: no fade ramp, value passes through", LIT([12345]), 1, 1, 1),
    ("hand-one-frame-neg", "one-frame output at the negative extreme, linear", LIT([-32768]), 1, 1, 0),
    ("hand-two-frames", "two-frame output: both frames are fade end points, so both are zero", LIT([1000, -1000]), 1, 1, 1),
    ("hand-three-frames", "three-frame output: fade length 1, only the middle frame survives", LIT([100, 200, 300]), 1, 1, 1),
    # Exact limits of the speed range and of p and q.
    ("pq-max-identity", "p = q = 2^20", NOISE(1000), 1 << 20, 1 << 20, 1),
    ("pq-max-speed4", "p = 2^20, q = 2^18: speed 4 at the largest p", NOISE(48000), 1 << 20, 1 << 18, 1),
    ("pq-max-speed-quarter", "p = 2^18, q = 2^20: speed 1/4 at the largest q", NOISE(48000), 1 << 18, 1 << 20, 1),
    ("speed4-unreduced", "4000/1000 equals 4/1 and gives the same bytes", NOISE(30011), 4000, 1000, 1),
    # Lengths at the product caps (the core itself is not limited to them).
    ("cut-cap-identity", "cut of exactly 480,000 frames at speed 1", NOISE(480000), 1, 1, 1),
    ("out-cap-exact", "480,000 frame cut giving exactly 960,000 output frames", NOISE(480000), 479999, 959999, 1),
    ("cut-cap-quarter", "480,000 frame cut at 1/4 speed: 1,919,997 frames, past the product output cap", NOISE(480000), 1, 4, 1),
    ("dc-max", "constant full-scale input stays inside the 16-bit range", CONST(48000, 32767), 3, 2, 1),
    ("dc-min", "constant negative full-scale input", CONST(48000, -32768), 2, 3, 1),
]

# Output samples worked out by hand from the contract; the reference must reproduce them exactly.
HAND = {
    "hand-one-frame": [12345],
    "hand-one-frame-neg": [-32768],
    "hand-two-frames": [0, 0],
    "hand-three-frames": [0, 200, 0],
}

# name, doc, in_len spec, p, q, method, out_cap ("exact" = the output length, else a number)
ERRORS = [
    ("err-zero-length", "no input frames", LIT([]), 1, 1, 1, 100),
    ("err-p-zero", "p = 0", NOISE(10), 0, 1, 1, 100),
    ("err-q-zero", "q = 0", NOISE(10), 1, 0, 1, 100),
    ("err-speed-above-4", "speed 5", NOISE(10), 5, 1, 1, 100),
    ("err-speed-above-4-barely", "speed 4001/1000", NOISE(10), 4001, 1000, 1, 100),
    ("err-speed-below-quarter", "speed 1/5", NOISE(10), 1, 5, 1, 100),
    ("err-speed-below-quarter-barely", "speed 999/4000", NOISE(10), 999, 4000, 1, 100),
    ("err-p-over-2^20", "p = 2^20 + 1", NOISE(10), (1 << 20) + 1, 1 << 20, 1, 100),
    ("err-q-over-2^20", "q = 2^20 + 1", NOISE(10), (1 << 20) + 1, (1 << 20) + 1, 1, 100),
    ("err-input-over-ceiling", "2^21 + 1 input frames", CONST((1 << 21) + 1, 0), 1, 1, 1, 1 << 22),
    ("err-bad-method", "method 2", NOISE(100), 1, 1, 2, 100),
    ("err-bad-method-max", "method 2^32 - 1", NOISE(100), 1, 1, 0xFFFFFFFF, 100),
    ("err-output-too-small", "output buffer one frame short", NOISE(100), 1, 1, 1, 99),
    ("err-output-zero-cap", "output buffer of zero frames", NOISE(100), 1, 1, 1, 0),
    ("err-order-params-before-method", "bad parameters and bad method: parameters win", NOISE(100), 0, 1, 7, 0),
    ("err-order-method-before-capacity", "bad method and a short buffer: method wins", NOISE(100), 1, 1, 7, 0),
    ("ok-output-exact-capacity", "output buffer exactly the output length", NOISE(100), 1, 1, 1, 100),
]

OUT_LEN = [  # in_len, p, q
    (1, 1, 1), (1000, 1, 1), (1000, 3, 2), (1000, 2, 3), (48000, 4, 1), (48000, 1, 4),
    (2, 1, 3), (3, 1, 3), (1, 4, 1), (480000, 479999, 959999), (480000, 1, 4), (1 << 21, 4, 1),
    (1 << 21, 1, 4), (0, 1, 1), ((1 << 21) + 1, 1, 1), (10, 5, 1), (10, 1, 5), (10, (1 << 20) + 1, 1 << 20),
]

# Raw f32 bit patterns and the s16 each must become.
F32_CASES = [
    ("zero", 0x00000000, 0), ("negative-zero", 0x80000000, 0),
    ("full-scale-positive-clamps", 0x3F800000, 32767), ("full-scale-negative", 0xBF800000, -32768),
    ("half", 0x3F000000, 16384), ("minus-half", 0xBF000000, -16384),
    ("one-lsb", 0x38000000, 1), ("minus-one-lsb", 0xB8000000, -1),
    ("half-lsb-rounds-up", 0x37800000, 1), ("minus-half-lsb-rounds-toward-positive", 0xB7800000, 0),
    ("just-below-half-lsb", 0x377FFFFF, 0), ("just-below-minus-half-lsb", 0xB77FFFFF, 0),
    ("just-past-minus-half-lsb", 0xB7800001, -1),
    ("above-full-scale", 0x40000000, 32767), ("below-minus-full-scale", 0xC0000000, -32768),
    ("huge", 0x7F7FFFFF, 32767), ("huge-negative", 0xFF7FFFFF, -32768),
    ("positive-infinity", 0x7F800000, 32767), ("negative-infinity", 0xFF800000, -32768),
    ("quiet-nan", 0x7FC00000, 0), ("negative-nan", 0xFFC00001, 0),
    ("denormal", 0x00000001, 0), ("negative-denormal", 0x80000001, 0),
    ("just-under-one", 0x3F7FFFFF, 32767), ("just-over-minus-one", 0xBF7FFFFF, -32768),
]
DOWNMIX_CASES = [  # left, right
    (0, 0), (1, 0), (0, 1), (-1, 0), (0, -1), (-1, -1), (1, 1), (1, 2), (-1, -2), (-2, -1),
    (32767, 32767), (-32768, -32768), (32767, -32768), (-32768, 32767), (32767, 32766), (-32768, -32767),
]

# One instance, many calls (memory growth, state leakage), and the trap path.
SCENARIOS = [
    {"name": "repeat-200", "doc": "200 renders of one vector in one instance give identical bytes",
     "kind": "repeat", "vector": "up3/2-cr", "times": 200},
    {"name": "growth-then-repeat", "doc": "eight 2^21-frame renders in one instance, then a small vector still matches",
     "kind": "growth", "big": "big-cr", "times": 8, "then": "up3/2-cr"},
    {"name": "trap-output-out-of-bounds", "doc": "an output pointer past the end of memory traps; the host must report failure, not a wrong result. WebAssembly hosts only: the same call natively would be undefined",
     "kind": "trap", "wasm_only": True, "in_len": 1000, "p": 1, "q": 1, "method": 1},
]


def build():
    vectors = []
    by_name = {}
    for name, doc, spec, p, q, method in RENDERS:
        samples = ref.gen_input(spec)
        out = ref.render(samples, p, q, method)
        assert ref.status(len(samples), p, q, method, len(out)) == len(out), name
        if name in ref.SPIKE_HASHES:
            assert ref.sha256_pcm(out) == ref.SPIKE_HASHES[name], f"{name}: reference disagrees with the spike"
        if name in HAND:
            assert out == HAND[name], f"{name}: reference disagrees with the hand-worked output"
        entry = {"name": name, "doc": doc, "input": spec, "p": p, "q": q, "method": method,
                 "out_cap": len(out), "expect": {"status": len(out), "sha256": ref.sha256_pcm(out)}}
        if name in HAND:
            entry["expect"]["samples"] = HAND[name]
        if name in ref.SPIKE_HASHES:
            entry["spike"] = True
        vectors.append(entry)
        by_name[name] = entry
    # The spike recorded these two as equal because Hermite equals linear at t = 0.
    assert by_name["id-lin"]["expect"]["sha256"] == by_name["id-cr"]["expect"]["sha256"]
    assert by_name["speed4-unreduced"]["expect"]["sha256"] == by_name["q4-cr"]["expect"]["sha256"]  # 4000/1000 is 4/1

    for name, doc, spec, p, q, method, cap in ERRORS:
        samples = ref.gen_input(spec)
        want = ref.status(len(samples), p, q, method, cap)
        vectors.append({"name": name, "doc": doc, "input": spec, "p": p, "q": q, "method": method,
                        "out_cap": cap, "expect": {"status": want}})
    ok = next(v for v in vectors if v["name"] == "ok-output-exact-capacity")
    ok["expect"]["sha256"] = ref.sha256_pcm(ref.render(ref.gen_input(ok["input"]), 1, 1, 1))

    return {
        "schema": 1,
        "renderer": {"name": "graft-render", "version": 1},
        "format": {"sample_rate": 48000, "channels": 1, "encoding": "s16le", "hash": "sha256 of the raw bytes"},
        "generators": {
            "lcg": "s = (s * 1664525 + 1013904223) mod 2^32 per frame starting from seed; sample = s >> 16 as signed 16-bit",
            "square": "frame i is 32767 when (i >> half_period_log2) is odd, otherwise -32768",
            "constant": "every frame equals value",
            "literal": "the listed samples",
        },
        "vectors": vectors,
        "out_len": [{"in_len": a, "p": b, "q": c, "expect": ref.out_len(a, b, c)} for a, b, c in OUT_LEN],
        "canonicalisation": {
            "f32_to_s16": {
                "rule": "scale by 32768, add one half, floor, clamp to [-32768, 32767]; NaN becomes 0",
                "cases": [{"name": n, "bits": b, "expect": e} for n, b, e in F32_CASES],
            },
            "downmix": {
                "rule": "(left + right + 1) >> 1 on the s16 values, arithmetic shift",
                "cases": [{"left": l, "right": r, "expect": ref.downmix(l, r)} for l, r in DOWNMIX_CASES],
            },
        },
        "scenarios": SCENARIOS,
    }


def check_canonicalisation():
    for name, bits, want in F32_CASES:
        got = ref.f32_to_s16(bits)
        assert got == want, f"f32 case {name}: reference {got}, hand-worked {want}"


def main():
    check_canonicalisation()
    table = build()
    text = json.dumps(table, indent=1, sort_keys=False) + "\n"
    if "--check" in sys.argv:
        if not TABLE.exists() or TABLE.read_text() != text:
            print("vectors.json is out of date: run python3 scripts/vectors/generate.py", file=sys.stderr)
            sys.exit(1)
        print(f"vectors.json is up to date ({len(table['vectors'])} vectors)")
        return
    TABLE.parent.mkdir(parents=True, exist_ok=True)
    TABLE.write_text(text)
    print(f"wrote {TABLE.relative_to(ROOT)}: {len(table['vectors'])} vectors")


if __name__ == "__main__":
    main()
