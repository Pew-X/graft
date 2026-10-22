//! Numeric caps and defaults (SPEC-FINAL Appendix F). Every value is configuration in the service;
//! these are the documented defaults.

/// Canonical sample rate in Hz.
pub const SAMPLE_RATE: u32 = 48_000;

/// Tunable limits with their documented defaults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// Longest source audio, in frames (15 s).
    pub max_source_frames: u32,
    /// Longest cut, in frames (10 s).
    pub max_cut_frames: u32,
    /// Longest rendered output, in frames (20 s).
    pub max_output_frames: u32,
    /// Shortest cut and shortest output, in frames (10 ms, so the two 5 ms fades never overlap).
    pub min_frames: u32,
    /// Deepest chain, counting the source as stage 1.
    pub max_chain_depth: u32,
    /// Longest title, in characters.
    pub max_title_chars: usize,
    /// Longest author name as typed, in characters.
    pub max_author_chars: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_source_frames: 15 * SAMPLE_RATE,
            max_cut_frames: 10 * SAMPLE_RATE,
            max_output_frames: 20 * SAMPLE_RATE,
            min_frames: 480,
            max_chain_depth: 12,
            max_title_chars: 60,
            max_author_chars: 32,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_published_appendix_f_values() {
        let l = Limits::default();
        assert_eq!(l.max_source_frames, 720_000);
        assert_eq!(l.max_cut_frames, 480_000);
        assert_eq!(l.max_output_frames, 960_000);
        assert_eq!(l.min_frames, 480);
        assert_eq!(l.max_chain_depth, 12);
        assert_eq!((l.max_title_chars, l.max_author_chars), (60, 32));
    }
}
