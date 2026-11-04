//! Numeric caps and defaults (SPEC-FINAL Appendix F). Every value is configuration in the service;
//! these are the documented defaults.

/// Canonical sample rate in Hz.
pub const SAMPLE_RATE: u32 = 48_000;

/// The most input frames the pinned renderer accepts (its `MAX_INPUT_FRAMES`, 2^21: about 43.7 s).
/// A cut longer than this cannot be rendered, whatever the service is configured to allow.
pub const RENDERER_MAX_INPUT_FRAMES: u32 = 1 << 21;

/// Tunable limits with their documented defaults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// Longest source audio, in frames (30 s).
    pub max_source_frames: u32,
    /// Longest cut, in frames (30 s; the renderer itself accepts up to 2^21 input frames, about 43.7 s).
    pub max_cut_frames: u32,
    /// Longest rendered output, in frames (60 s).
    pub max_output_frames: u32,
    /// Shortest cut and shortest output, in frames (10 ms, so the two 5 ms fades never overlap).
    pub min_frames: u32,
    /// Deepest chain, counting the source as stage 1.
    pub max_chain_depth: u32,
    /// Longest title, in characters.
    pub max_title_chars: usize,
    /// Longest author name as typed, in characters.
    pub max_author_chars: usize,
    /// Longest maker's note, in characters.
    pub max_note_chars: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_source_frames: 30 * SAMPLE_RATE,
            max_cut_frames: 30 * SAMPLE_RATE,
            max_output_frames: 60 * SAMPLE_RATE,
            min_frames: 480,
            max_chain_depth: 12,
            max_title_chars: 60,
            max_author_chars: 32,
            max_note_chars: 140,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_published_appendix_f_values() {
        let l = Limits::default();
        assert_eq!(l.max_source_frames, 1_440_000);
        assert_eq!(l.max_cut_frames, 1_440_000);
        assert_eq!(l.max_output_frames, 2_880_000);
        assert!(l.max_cut_frames <= RENDERER_MAX_INPUT_FRAMES);
        assert_eq!(l.min_frames, 480);
        assert_eq!(l.max_chain_depth, 12);
        assert_eq!((l.max_title_chars, l.max_author_chars), (60, 32));
        assert_eq!(l.max_note_chars, 140);
    }
}
