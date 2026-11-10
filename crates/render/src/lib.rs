//! Integer-only varispeed renderer, compiled to the canonical `.wasm` artefact.
//!
//! The renderer is a pure function: canonical PCM (48 kHz, mono, signed 16-bit) plus an exact speed
//! fraction `p/q` and a method id go in; the same output frames come out on every host, for a named
//! renderer version. There are no floats, no libm, no allocation and no global state in the render
//! call. The contract, with its worked limits, lives in `ARCHITECTURE.md` ("Determinism contract") and
//! is pinned by the vector table in `fixtures/vectors`.

#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)] // justified in the module documentation
mod ffi;

/// Renderer name recorded in every content record.
pub const NAME: &str = "graft-render";
/// Renderer version. Changing any output byte requires a new version and new vectors.
pub const VERSION: u32 = 1;

/// Most input frames the renderer accepts (2^21).
pub const MAX_INPUT_FRAMES: u32 = 1 << 21;
/// Largest `p` or `q` (2^20).
pub const MAX_RATIO_TERM: u32 = 1 << 20;
/// Length of the linear fade at each end of the output, in frames (5 ms at 48 kHz).
pub const MAX_FADE_FRAMES: u32 = 240;

/// Status returned for bad parameters, an unknown method, or input over the ceiling.
pub const STATUS_PARAM: i32 = -1;
/// Status returned when the output buffer is too small.
pub const STATUS_CAPACITY: i32 = -2;

/// Interpolation method ids. Any new method gets a new id and new vectors.
pub mod method {
    /// Two-point linear interpolation (baseline).
    pub const LINEAR: u32 = 0;
    /// Cubic Hermite (Catmull-Rom) with Q30 integer weights.
    pub const HERMITE: u32 = 1;
}

/// Output frames for `in_len` input frames at speed `p/q`, or a negative status.
///
/// The speed `p/q` must lie in `[1/4, 4]` with `p` and `q` in `1..=2^20`, and the input must hold
/// `1..=2^21` frames.
#[must_use]
pub fn out_len(in_len: u32, p: u32, q: u32) -> i32 {
    let ratio_ok = (1..=MAX_RATIO_TERM).contains(&p) && (1..=MAX_RATIO_TERM).contains(&q);
    let (p, q) = (u64::from(p), u64::from(q));
    let speed_ok = p <= 4 * q && 4 * p >= q;
    if !(1..=MAX_INPUT_FRAMES).contains(&in_len) || !ratio_ok || !speed_ok {
        return STATUS_PARAM;
    }
    // At most 2^21 * 4 frames, so the value always fits an i32.
    i32::try_from((u64::from(in_len) - 1) * q / p + 1).unwrap_or(STATUS_PARAM)
}

/// Validates a render call and returns the number of output frames it will write.
///
/// Checks run in this order: parameters and input ceiling, method id, output capacity. On failure the
/// error is the negative status the C-ABI returns.
///
/// # Errors
/// [`STATUS_PARAM`] for bad parameters, input over the ceiling or an unknown method;
/// [`STATUS_CAPACITY`] when `out_cap` frames cannot hold the output.
pub fn plan(in_len: u32, p: u32, q: u32, method: u32, out_cap: u32) -> Result<usize, i32> {
    let frames = out_len(in_len, p, q);
    if frames < 0 {
        return Err(frames);
    }
    if method != method::LINEAR && method != method::HERMITE {
        return Err(STATUS_PARAM);
    }
    match u32::try_from(frames) {
        Ok(n) if n <= out_cap => Ok(n as usize),
        _ => Err(STATUS_CAPACITY),
    }
}

/// Renders `src` at speed `p/q` into `dst` and returns the frames written or a negative status.
///
/// `dst.len()` is the output capacity (see [`plan`] for the order of checks). Output frame `k` reads
/// input position `k * p / q` exactly; input outside `src` is zero, so the result depends only on the
/// slice.
#[must_use]
pub fn render_into(src: &[i16], p: u32, q: u32, method: u32, dst: &mut [i16]) -> i32 {
    let (Ok(in_len), Ok(out_cap)) = (u32::try_from(src.len()), u32::try_from(dst.len())) else {
        return STATUS_PARAM;
    };
    let frames = match plan(in_len, p, q, method, out_cap) {
        Ok(n) => n,
        Err(status) => return status,
    };
    let out = &mut dst[..frames];
    let fade = u64::min(u64::from(MAX_FADE_FRAMES), out.len() as u64 / 2);
    let last = out.len() as u64 - 1;
    for (k, slot) in (0u64..).zip(out.iter_mut()) {
        let position = k * u64::from(p);
        let index = (position / u64::from(q)) as i64;
        let remainder = position % u64::from(q);
        let t = (remainder * 32768 / u64::from(q)) as i64; // Q15 fraction, 0..=32767
        let sample = if method == method::LINEAR {
            linear(src, index, t)
        } else {
            hermite(src, index, t)
        };
        let distance = u64::min(k, last - k);
        let faded = if distance < fade {
            let gain = (distance * 32768 / fade) as i64;
            (sample * gain + 16384) >> 15
        } else {
            sample
        };
        *slot = faded.clamp(i64::from(i16::MIN), i64::from(i16::MAX)) as i16;
    }
    i32::try_from(frames).unwrap_or(STATUS_PARAM)
}

/// Input frame `i`, or zero outside the slice.
fn at(src: &[i16], i: i64) -> i64 {
    usize::try_from(i)
        .ok()
        .and_then(|i| src.get(i))
        .map_or(0, |v| i64::from(*v))
}

/// Two-point interpolation with a Q15 weight.
fn linear(src: &[i16], index: i64, t: i64) -> i64 {
    (at(src, index) * (32768 - t) + at(src, index + 1) * t + 16384) >> 15
}

/// Catmull-Rom interpolation. Weights are the exact cubic polynomials in `t` floored once to Q30
/// (computed in Q45 and shifted by 16, which includes the factor of one half); the sum of four
/// products is rounded half toward positive infinity.
fn hermite(src: &[i16], index: i64, t: i64) -> i64 {
    let t2 = t * t; // Q30
    let t3 = t2 * t; // Q45
    let a = t2 << 15; // t^2 in Q45
    let b = t << 30; // t in Q45
    let one = 1i64 << 45;
    let w_prev = (-t3 + 2 * a - b) >> 16;
    let w_here = (3 * t3 - 5 * a + 2 * one) >> 16;
    let w_next = (-3 * t3 + 4 * a + b) >> 16;
    let w_after = (t3 - a) >> 16;
    let acc = at(src, index - 1) * w_prev
        + at(src, index) * w_here
        + at(src, index + 1) * w_next
        + at(src, index + 2) * w_after;
    (acc + (1 << 29)) >> 30
}
