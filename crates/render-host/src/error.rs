//! Typed errors. A caller can tell "your request was wrong" from "the renderer failed".

use thiserror::Error;

/// Why a render did not produce audio.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RenderError {
    /// The parameters are outside the contract (speed, lengths, method id).
    #[error("render parameters are outside the contract")]
    InvalidParameters,
    /// The output buffer offered is smaller than the output.
    #[error("output buffer is too small for this render")]
    OutputTooSmall,
    /// The render used its whole fuel budget and was stopped.
    #[error("render was interrupted after using its fuel budget")]
    Interrupted,
    /// The render needed more memory than the host allows.
    #[error("render needed more memory than the host allows")]
    MemoryLimit,
    /// The module trapped. The instance is discarded; the host stays usable.
    #[error("renderer trapped: {0}")]
    Trapped(String),
    /// The host or module misbehaved in a way that is not the caller's fault.
    #[error("render host failure: {0}")]
    Internal(String),
}

/// Why an artefact was not accepted at load time.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ArtefactError {
    /// The bytes are not a valid module.
    #[error("not a valid module: {0}")]
    Invalid(String),
    /// The module imports something; the canonical artefact imports nothing.
    #[error("module has {0} import(s); the canonical artefact has none")]
    HasImports(usize),
    /// A required export is missing or has the wrong type.
    #[error("module lacks the export `{0}`")]
    MissingExport(&'static str),
    /// The version the module reports has no pin.
    #[error("renderer version {0} has no pin")]
    UnpinnedVersion(u32),
    /// The bytes do not hash to the pinned value for their version.
    #[error("renderer version {version} hashes to {actual} but the pin is {expected}")]
    PinMismatch {
        /// Version reported by the module.
        version: u32,
        /// Pinned SHA-256.
        expected: String,
        /// SHA-256 of the loaded bytes.
        actual: String,
    },
    /// The pin file could not be read.
    #[error("malformed pin file: {0}")]
    BadPins(String),
}
