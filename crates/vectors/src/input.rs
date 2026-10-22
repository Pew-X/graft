//! Input generators named by the table.

use crate::table::Input;

impl Input {
    /// Number of frames this input produces.
    #[must_use]
    pub fn len(&self) -> usize {
        match self {
            Self::Lcg { len, .. } | Self::Square { len, .. } | Self::Constant { len, .. } => {
                *len as usize
            }
            Self::Literal { samples } => samples.len(),
        }
    }

    /// True when the input has no frames.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Produces the frames.
    #[must_use]
    pub fn generate(&self) -> Vec<i16> {
        match self {
            Self::Lcg { len, seed } => {
                let mut state = *seed;
                (0..*len)
                    .map(|_| {
                        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                        (state >> 16) as u16 as i16
                    })
                    .collect()
            }
            Self::Square {
                len,
                half_period_log2,
            } => (0..*len)
                .map(|i| {
                    if (i >> half_period_log2) & 1 == 1 {
                        i16::MAX
                    } else {
                        i16::MIN
                    }
                })
                .collect(),
            Self::Constant { len, value } => vec![*value; *len as usize],
            Self::Literal { samples } => samples.clone(),
        }
    }
}
