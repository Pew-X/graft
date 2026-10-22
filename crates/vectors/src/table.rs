//! The vector table as data.

use serde::Deserialize;
use std::path::Path;

/// How an input is produced; generators are specified, not stored as bytes.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Input {
    /// A linear congruential noise generator.
    Lcg {
        /// Number of frames.
        len: u32,
        /// Initial state.
        seed: u32,
    },
    /// A full-scale square wave.
    Square {
        /// Number of frames.
        len: u32,
        /// Half period is `1 << half_period_log2` frames.
        half_period_log2: u32,
    },
    /// Every frame equal to `value`.
    Constant {
        /// Number of frames.
        len: u32,
        /// The sample value.
        value: i16,
    },
    /// The listed samples.
    Literal {
        /// The samples.
        samples: Vec<i16>,
    },
}

/// What a vector must produce.
#[derive(Debug, Clone, Deserialize)]
pub struct Expect {
    /// Frames written, or a negative status.
    pub status: i32,
    /// SHA-256 of the output as little-endian bytes, when the status is a success.
    pub sha256: Option<String>,
    /// The full output, for the tiny vectors worked out by hand.
    pub samples: Option<Vec<i16>>,
}

/// One render call and its expected result.
#[derive(Debug, Clone, Deserialize)]
pub struct Vector {
    /// Unique name.
    pub name: String,
    /// One line on what the vector pins.
    pub doc: String,
    /// The input.
    pub input: Input,
    /// Speed numerator.
    pub p: u32,
    /// Speed denominator.
    pub q: u32,
    /// Method id.
    pub method: u32,
    /// Output buffer capacity in frames.
    pub out_cap: u32,
    /// Expected result.
    pub expect: Expect,
}

/// A direct `out_len` query.
#[derive(Debug, Clone, Deserialize)]
pub struct OutLen {
    /// Input frames.
    pub in_len: u32,
    /// Speed numerator.
    pub p: u32,
    /// Speed denominator.
    pub q: u32,
    /// Expected frames or negative status.
    pub expect: i32,
}

/// One float-to-s16 case, given as raw f32 bits.
#[derive(Debug, Clone, Deserialize)]
pub struct F32Case {
    /// Case name.
    pub name: String,
    /// The f32 bit pattern.
    pub bits: u32,
    /// Expected sample.
    pub expect: i16,
}

/// One stereo downmix case.
#[derive(Debug, Clone, Deserialize)]
pub struct DownmixCase {
    /// Left sample.
    pub left: i16,
    /// Right sample.
    pub right: i16,
    /// Expected mono sample.
    pub expect: i16,
}

/// A group of canonicalisation cases.
#[derive(Debug, Clone, Deserialize)]
pub struct Cases<T> {
    /// The rule in words.
    pub rule: String,
    /// The cases.
    pub cases: Vec<T>,
}

/// Ingest canonicalisation vectors.
#[derive(Debug, Clone, Deserialize)]
pub struct Canonicalisation {
    /// Float to signed 16-bit.
    pub f32_to_s16: Cases<F32Case>,
    /// Stereo to mono.
    pub downmix: Cases<DownmixCase>,
}

/// A multi-call scenario in one instance.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Scenario {
    /// Repeat one vector many times.
    Repeat {
        /// Scenario name.
        name: String,
        /// Vector to repeat.
        vector: String,
        /// How many times.
        times: u32,
    },
    /// Render a large vector repeatedly, then a small one again.
    Growth {
        /// Scenario name.
        name: String,
        /// The large vector.
        big: String,
        /// Repetitions.
        times: u32,
        /// The small vector rendered again afterwards.
        then: String,
    },
    /// Hand the renderer an output pointer outside memory.
    Trap {
        /// Scenario name.
        name: String,
        /// Input frames.
        in_len: u32,
        /// Speed numerator.
        p: u32,
        /// Speed denominator.
        q: u32,
        /// Method id.
        method: u32,
    },
}

impl Scenario {
    /// The scenario's name.
    #[must_use]
    pub fn name(&self) -> &str {
        match self {
            Self::Repeat { name, .. } | Self::Growth { name, .. } | Self::Trap { name, .. } => name,
        }
    }
}

/// Renderer identity the table was written for.
#[derive(Debug, Clone, Deserialize)]
pub struct RendererRef {
    /// Renderer name.
    pub name: String,
    /// Renderer version.
    pub version: u32,
}

/// The whole table.
#[derive(Debug, Clone, Deserialize)]
pub struct Table {
    /// Schema version of this file.
    pub schema: u32,
    /// The renderer these vectors belong to.
    pub renderer: RendererRef,
    /// Render vectors, including error vectors.
    pub vectors: Vec<Vector>,
    /// Direct `out_len` queries.
    pub out_len: Vec<OutLen>,
    /// Ingest canonicalisation.
    pub canonicalisation: Canonicalisation,
    /// Multi-call scenarios.
    pub scenarios: Vec<Scenario>,
}

/// Why a table could not be loaded.
#[derive(Debug)]
pub enum LoadError {
    /// The file could not be read.
    Io(std::io::Error),
    /// The file is not a valid table.
    Parse(serde_json::Error),
    /// The schema version is not one this build understands.
    Schema(u32),
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "cannot read the vector table: {e}"),
            Self::Parse(e) => write!(f, "the vector table is not valid: {e}"),
            Self::Schema(v) => write!(f, "unsupported vector table schema {v}"),
        }
    }
}

impl std::error::Error for LoadError {}

impl Table {
    /// Highest schema this build reads.
    pub const SCHEMA: u32 = 1;

    /// Parses a table from JSON text.
    ///
    /// # Errors
    /// Returns [`LoadError::Parse`] for malformed JSON and [`LoadError::Schema`] for an unknown schema.
    pub fn parse(text: &str) -> Result<Self, LoadError> {
        let table: Self = serde_json::from_str(text).map_err(LoadError::Parse)?;
        if table.schema != Self::SCHEMA {
            return Err(LoadError::Schema(table.schema));
        }
        Ok(table)
    }

    /// Reads and parses a table file.
    ///
    /// # Errors
    /// See [`Table::parse`]; also [`LoadError::Io`] when the file cannot be read.
    pub fn load(path: &Path) -> Result<Self, LoadError> {
        Self::parse(&std::fs::read_to_string(path).map_err(LoadError::Io)?)
    }

    /// Finds a vector by name.
    #[must_use]
    pub fn vector(&self, name: &str) -> Option<&Vector> {
        self.vectors.iter().find(|v| v.name == name)
    }
}
