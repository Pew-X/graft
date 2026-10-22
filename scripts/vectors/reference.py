"""Independent reference for the graft renderer contract (ARCHITECTURE.md, "Determinism contract").

Written from the contract text with Python's unbounded integers and exact fractions, not from the Rust
source. The expected values in fixtures/vectors/vectors.json come from here, and the 14 values recorded by
the original spike (SPIKE_HASHES) are checked against it, so the table does not restate the implementation.
"""

import hashlib
import struct
from fractions import Fraction

E_PARAM = -1
E_CAP = -2
MAX_IN = 1 << 21
MAX_PQ = 1 << 20
MAX_FADE = 240
LINEAR, HERMITE = 0, 1


def out_len(in_len, p, q):
    """Output frames for in_len input frames at speed p/q, or a negative code."""
    if in_len == 0 or in_len > MAX_IN:
        return E_PARAM
    if p == 0 or q == 0 or p > MAX_PQ or q > MAX_PQ:
        return E_PARAM
    if p > 4 * q or 4 * p < q:  # speed outside [1/4, 4]
        return E_PARAM
    return (in_len - 1) * q // p + 1


def status(in_len, p, q, method, out_cap):
    """The return code of a render call: frames written, or a negative code.

    Order of checks: parameters and input ceiling, then method id, then output capacity.
    """
    n = out_len(in_len, p, q)
    if n < 0:
        return n
    if method not in (LINEAR, HERMITE):
        return E_PARAM
    if n > out_cap:
        return E_CAP
    return n


def hermite_weights(t_q15):
    """Catmull-Rom weights at fractional position t = t_q15 / 2^15, as Q30 integers.

    The polynomials are evaluated exactly and floored once to Q30.
    """
    t = Fraction(t_q15, 1 << 15)
    t2, t3 = t * t, t * t * t
    exact = (
        (-t3 + 2 * t2 - t) / 2,
        (3 * t3 - 5 * t2 + 2) / 2,
        (-3 * t3 + 4 * t2 + t) / 2,
        (t3 - t2) / 2,
    )
    return tuple((w * (1 << 30)).__floor__() for w in exact)


_WEIGHT_CACHE = {}


def render(src, p, q, method):
    n = out_len(len(src), p, q)
    assert n > 0 and method in (LINEAR, HERMITE)
    size = len(src)

    def at(i):
        return src[i] if 0 <= i < size else 0

    fade = min(MAX_FADE, n // 2)
    out = []
    for k in range(n):
        kp = k * p
        idx, rem = divmod(kp, q)
        t = rem * 32768 // q  # Q15
        if method == LINEAR:
            y = (at(idx) * (32768 - t) + at(idx + 1) * t + 16384) >> 15
        else:
            w = _WEIGHT_CACHE.get(t)
            if w is None:
                w = _WEIGHT_CACHE[t] = hermite_weights(t)
            acc = at(idx - 1) * w[0] + at(idx) * w[1] + at(idx + 1) * w[2] + at(idx + 2) * w[3]
            y = (acc + (1 << 29)) >> 30
        d = min(k, n - 1 - k)
        if d < fade:
            y = (y * (d * 32768 // fade) + 16384) >> 15
        out.append(max(-32768, min(32767, y)))
    return out


def pcm_bytes(samples):
    return struct.pack("<%dh" % len(samples), *samples)


def sha256_pcm(samples):
    return hashlib.sha256(pcm_bytes(samples)).hexdigest()


def gen_input(spec):
    kind = spec["kind"]
    if kind == "literal":
        return list(spec["samples"])
    n = spec["len"]
    if kind == "lcg":
        s, out = spec["seed"], []
        for _ in range(n):
            s = (s * 1664525 + 1013904223) & 0xFFFFFFFF
            v = s >> 16
            out.append(v - 65536 if v >= 32768 else v)
        return out
    if kind == "square":
        half = 1 << spec["half_period_log2"]
        return [32767 if (i // half) & 1 else -32768 for i in range(n)]
    if kind == "constant":
        return [spec["value"]] * n
    raise ValueError(kind)


# Ingest canonicalisation. Rules (also in ARCHITECTURE.md):
#   float to s16: scale by 32768, add one half, floor, clamp to [-32768, 32767]; NaN becomes 0.
#   stereo to mono: (L + R + 1) >> 1 on the s16 values, arithmetic shift.
def f32_from_bits(bits):
    return struct.unpack("<f", struct.pack("<I", bits))[0]


def f32_to_s16(bits):
    x = f32_from_bits(bits)
    if x != x:
        return 0
    if x >= 1.0:
        return 32767
    if x <= -1.0:
        return -32768
    v = Fraction(x) * 32768 + Fraction(1, 2)
    return max(-32768, min(32767, v.__floor__()))


def downmix(left, right):
    return (left + right + 1) >> 1


# Recorded by the original renderer spike (2026-10-20, vault research notes): sha256 of the output for
# each of its 14 vectors, identical on wasmtime, native, Node, Chrome, WebKit and wazero.
SPIKE_HASHES = {
    "id-lin": "7209eda4c9e3368aa83e6c41b5b98493aa1474479e8082ef56f3019d5c22e873",
    "id-cr": "7209eda4c9e3368aa83e6c41b5b98493aa1474479e8082ef56f3019d5c22e873",
    "up3/2-cr": "d00e6d93ef56987fc9a41bcbb5ed7a8b0529bc8fef8b15bee10ab98d6ea93e38",
    "dn2/3-cr": "bebe81bbd2fa65f2428f2cb9ccc4d13ada470a6fe73590d8bcaa9a65b83a8d76",
    "q4-cr": "4b8ea428a3933228a30426b79bcd21eb1effde20d88c0fe7fbc5c24a7112715a",
    "q1/4-cr": "93da4dfbfb5e80db8e2f61359a50fe22fe31995c7d6ba528b9d31d93d5713b6c",
    "odd-cr": "580b37ea9c7693043b2ee87327fb3b1c2ddbffd3224ac6847594f9bae7cc1b05",
    "odd-lin": "08fb106080a86dc373a0f18ce269792e9762392d0ff793c48b4a602d7e57965c",
    "L1-cr": "ca1081b5f19c648fd45553d1d3b0356ae71b97938f28f31d5b6574bdbd305f6d",
    "L2-cr": "55e443c57680b34c7766e5f508fcb8c6af65a9e46fa9b0d4002accd4f4a4558c",
    "L3-lin": "c586bf9f70aafde8e578cb049102b24137ce70006ca24c0e15cb040426d27e2a",
    "sq-cr": "722faa64788655569e206de82a85f8da308b4f69d612e9d482e55edec808a740",
    "max-cr": "f1e507e287e7f6f0876ec8b5452049284ff779fa1328383d7ff71795b9b97538",
    "big-cr": "e9ea9b550f73c79390b3c525d8b9eaaf145f1f109e483e25f1ba159102e9b726",
}
