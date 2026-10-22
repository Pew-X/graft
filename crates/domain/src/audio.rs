//! Checks a visitor's source audio must pass before anything is stored.
//!
//! The audio arrives as canonical PCM: 48 kHz, mono, signed 16-bit little-endian, no header. The
//! browser decoded it; the server cannot verify that it decoded honestly, and these checks do not
//! pretend to. They refuse what is plainly not a sound worth keeping, kindly and specifically:
//!
//! - the wrong shape: an odd number of bytes, too short or too long;
//! - silence: the loudest sample is within 32 of zero (about -60 dBFS);
//! - a constant signal: the whole recording stays within 64 of one level (a flat line or a DC
//!   offset, which has no sound in it);
//! - clipping noise: more than half the samples sit on the rails.
//!
//! A pure steady tone is not detected: it is a sound, if a dull one. That is a stated limit, not an
//! oversight.

use crate::limits::Limits;

/// The loudest sample, in absolute value, at or below which a recording counts as silent.
pub const SILENCE_PEAK: i32 = 32;
/// The spread (highest minus lowest sample) at or below which a recording counts as constant.
pub const CONSTANT_SPREAD: i32 = 64;
/// Samples at or beyond this magnitude count as sitting on a rail.
pub const RAIL: i32 = 32_700;

/// Why a recording is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AudioError {
    /// A 16-bit sample is two bytes.
    #[error("the audio has an odd number of bytes, so it is not whole 16-bit samples")]
    OddLength,
    /// Shorter than the minimum.
    #[error("the sound is {frames} frames and the shortest allowed is {min}")]
    TooShort {
        /// What was sent.
        frames: u32,
        /// The minimum.
        min: u32,
    },
    /// Longer than the cap.
    #[error("the sound is {frames} frames and the longest allowed is {max}")]
    TooLong {
        /// What was sent, saturated.
        frames: u32,
        /// The cap.
        max: u32,
    },
    /// Nothing audible.
    #[error("the sound is silent")]
    Silent,
    /// A flat line.
    #[error("the sound is a flat line with nothing moving in it")]
    Constant,
    /// Mostly noise at full scale.
    #[error("the sound is mostly clipped noise at full scale")]
    Clipped,
}

impl AudioError {
    /// A stable name for the rule, for a form to switch on.
    #[must_use]
    pub fn rule(&self) -> &'static str {
        match self {
            Self::OddLength => "odd_length",
            Self::TooShort { .. } => "too_short",
            Self::TooLong { .. } => "too_long",
            Self::Silent => "silent",
            Self::Constant => "constant",
            Self::Clipped => "clipped",
        }
    }
}

/// Check canonical PCM bytes and return the number of frames.
pub fn check_source(bytes: &[u8], limits: &Limits) -> Result<u32, AudioError> {
    if !bytes.len().is_multiple_of(2) {
        return Err(AudioError::OddLength);
    }
    let frames = u32::try_from(bytes.len() / 2).unwrap_or(u32::MAX);
    if frames < limits.min_frames {
        return Err(AudioError::TooShort {
            frames,
            min: limits.min_frames,
        });
    }
    if frames > limits.max_source_frames {
        return Err(AudioError::TooLong {
            frames,
            max: limits.max_source_frames,
        });
    }
    let (mut lo, mut hi, mut rails) = (i32::MAX, i32::MIN, 0u64);
    for pair in bytes.chunks_exact(2) {
        let s = i32::from(i16::from_le_bytes([pair[0], pair[1]]));
        lo = lo.min(s);
        hi = hi.max(s);
        if s.abs() >= RAIL {
            rails += 1;
        }
    }
    if hi.abs().max(lo.abs()) <= SILENCE_PEAK {
        return Err(AudioError::Silent);
    }
    if hi - lo <= CONSTANT_SPREAD {
        return Err(AudioError::Constant);
    }
    if rails * 2 > u64::from(frames) {
        return Err(AudioError::Clipped);
    }
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(samples: impl IntoIterator<Item = i16>) -> Vec<u8> {
        samples.into_iter().flat_map(i16::to_le_bytes).collect()
    }

    fn tone(frames: usize) -> Vec<u8> {
        pcm((0..frames).map(|i| (((i % 200) as i16) - 100) * 100))
    }

    #[test]
    fn a_sound_with_movement_passes_and_reports_its_frames() {
        assert_eq!(check_source(&tone(48_000), &Limits::default()), Ok(48_000));
    }

    #[test]
    fn the_length_limits_are_exact_at_the_minimum_and_the_maximum() {
        let l = Limits::default();
        assert!(check_source(&tone(l.min_frames as usize), &l).is_ok());
        assert_eq!(
            check_source(&tone(l.min_frames as usize - 1), &l),
            Err(AudioError::TooShort {
                frames: l.min_frames - 1,
                min: l.min_frames
            })
        );
        assert!(check_source(&tone(l.max_source_frames as usize), &l).is_ok());
        assert!(matches!(
            check_source(&tone(l.max_source_frames as usize + 1), &l),
            Err(AudioError::TooLong { .. })
        ));
    }

    #[test]
    fn an_odd_byte_count_is_refused_before_anything_else() {
        let mut bytes = tone(1000);
        bytes.push(0);
        assert_eq!(
            check_source(&bytes, &Limits::default()),
            Err(AudioError::OddLength)
        );
    }

    #[test]
    fn silence_is_exactly_a_peak_of_32_or_less() {
        let l = Limits::default();
        let quiet = |peak: i16| pcm((0..1000).map(|i| if i % 2 == 0 { peak } else { -peak }));
        assert_eq!(check_source(&quiet(0), &l), Err(AudioError::Silent));
        assert_eq!(check_source(&quiet(32), &l), Err(AudioError::Silent));
        // One step louder is a faint sound, not silence (its spread of 66 is also over the
        // constant threshold).
        assert!(check_source(&quiet(33), &l).is_ok());
    }

    #[test]
    fn a_flat_line_at_any_level_is_constant_and_a_small_wobble_around_it_is_too() {
        let l = Limits::default();
        assert_eq!(
            check_source(&pcm(vec![9000; 1000]), &l),
            Err(AudioError::Constant)
        );
        let wobble = |amp: i16| pcm((0..1000).map(|i| 9000 + if i % 2 == 0 { amp } else { -amp }));
        assert_eq!(check_source(&wobble(32), &l), Err(AudioError::Constant));
        assert!(check_source(&wobble(33), &l).is_ok());
    }

    #[test]
    fn more_than_half_the_samples_on_the_rails_is_clipping_noise_and_exactly_half_is_not() {
        let l = Limits::default();
        let mix = |rail_samples: usize| {
            pcm((0..1000).map(|i| {
                if i < rail_samples {
                    if i % 2 == 0 { 32_767 } else { -32_768 }
                } else {
                    ((i % 50) as i16 - 25) * 100
                }
            }))
        };
        assert!(check_source(&mix(500), &l).is_ok());
        assert_eq!(check_source(&mix(501), &l), Err(AudioError::Clipped));
    }

    #[test]
    fn every_error_names_its_rule() {
        let rules: Vec<_> = [
            AudioError::OddLength,
            AudioError::TooShort { frames: 1, min: 2 },
            AudioError::TooLong { frames: 3, max: 2 },
            AudioError::Silent,
            AudioError::Constant,
            AudioError::Clipped,
        ]
        .iter()
        .map(AudioError::rule)
        .collect();
        assert_eq!(
            rules,
            [
                "odd_length",
                "too_short",
                "too_long",
                "silent",
                "constant",
                "clipped"
            ]
        );
    }
}
