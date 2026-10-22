//! Seeding: create a source, which is a root publication, idempotently.
//!
//! A seeded publication gets a deterministic public id derived from its retry key, so ids, content
//! hashes and the shipped snapshot are the same in every environment. Visitor publications keep
//! random ids; this exception is stated in ARCHITECTURE.md.

use graft_domain::chain::SourceEvidence;
use graft_domain::ids::PublicationId;
use graft_domain::limits::Limits;
use graft_domain::record::{ContentRecord, RecordError, RendererIdentity};
use graft_storage::{BlobError, BlobStore, NewPublication, Outcome, Store, StoreError};

/// Everything needed to seed one source.
#[derive(Debug, Clone)]
pub struct SeedSource {
    /// Deterministic retry key, such as `seed:jazz-rhodes:source`.
    pub key: String,
    /// Title as typed.
    pub title: String,
    /// Maker's name as typed.
    pub author: String,
    /// Declared evidence: licence, original work, where to find it.
    pub evidence: SourceEvidence,
    /// Canonical audio: 48 kHz mono signed 16-bit little-endian, headerless.
    pub audio: Vec<u8>,
    /// The renderer identity recorded on the root.
    pub renderer: RendererIdentity,
}

/// Why a source could not be seeded.
#[derive(Debug, thiserror::Error)]
pub enum SeedError {
    /// The audio is not whole 16-bit samples, or is outside the length limits.
    #[error("the audio must be whole 16-bit samples between {min} and {max} frames")]
    BadAudio {
        /// Shortest allowed.
        min: u32,
        /// Longest allowed.
        max: u32,
    },
    /// The retry key is already used by a different source.
    #[error("the retry key {0:?} already belongs to a different source")]
    KeyConflict(String),
    /// The record could not be formed.
    #[error(transparent)]
    Record(#[from] RecordError),
    /// The blob store failed.
    #[error(transparent)]
    Blob(#[from] BlobError),
    /// The database failed.
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Seed one source. Running it twice with the same input changes nothing the second time.
pub async fn seed_source(
    store: &Store,
    blobs: &dyn BlobStore,
    limits: &Limits,
    source: SeedSource,
) -> Result<Outcome, SeedError> {
    let bad = SeedError::BadAudio {
        min: limits.min_frames,
        max: limits.max_source_frames,
    };
    if !source.audio.len().is_multiple_of(2) {
        return Err(bad);
    }
    let frames = u32::try_from(source.audio.len() / 2).map_err(|_| SeedError::BadAudio {
        min: limits.min_frames,
        max: limits.max_source_frames,
    })?;
    if frames < limits.min_frames || frames > limits.max_source_frames {
        return Err(bad);
    }
    let hash = blobs.put_if_absent(source.audio).await?;
    let record = ContentRecord::source(hash, frames, source.renderer)?;
    let new = NewPublication {
        id: PublicationId::seeded(&source.key),
        record,
        retry_key: source.key.clone(),
        title: source.title,
        author: source.author,
        evidence: Some(source.evidence),
        manage_key_hash: None,
    };
    match store.create_publication(&new).await? {
        Outcome::KeyConflict => Err(SeedError::KeyConflict(source.key)),
        other => Ok(other),
    }
}
