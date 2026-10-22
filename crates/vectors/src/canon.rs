//! Reference form of the ingest canonicalisation rules, for the vector table.
//!
//! The browser applies these rules when it turns decoded audio into canonical PCM; the server never
//! does, and the renderer itself has no floats. This module exists so the rules are fixed, named and
//! covered by vectors in a language other than the one that will run them in production.

/// Float sample to signed 16-bit: scale by 32768, add one half, floor, clamp; NaN becomes 0.
#[must_use]
pub fn f32_to_s16(x: f32) -> i16 {
    if x.is_nan() {
        return 0;
    }
    // Exact in f64: an f32 scaled by a power of two plus one half needs well under 53 bits.
    let v = (f64::from(x) * 32768.0 + 0.5).floor();
    v.clamp(-32768.0, 32767.0) as i16
}

/// Stereo to mono on signed 16-bit values: `(left + right + 1) >> 1`, arithmetic shift.
#[must_use]
pub fn downmix(left: i16, right: i16) -> i16 {
    ((i32::from(left) + i32::from(right) + 1) >> 1) as i16
}
