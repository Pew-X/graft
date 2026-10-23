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
    let bad = || SeedError::BadAudio {
        min: limits.min_frames,
        max: limits.max_source_frames,
    };
    if !source.audio.len().is_multiple_of(2) {
        return Err(bad());
    }
    let frames = u32::try_from(source.audio.len() / 2).map_err(|_| bad())?;
    if frames < limits.min_frames || frames > limits.max_source_frames {
        return Err(bad());
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

/// The seeded chain as data: one source and the flips made from it, in order. Swapping the sound
/// after the listening gate means changing this file and the audio, nothing else.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    /// The source sound.
    pub source: ManifestSource,
    /// The flips, each made from the stage before it.
    pub flips: Vec<ManifestFlip>,
}

/// The source of the seeded chain.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestSource {
    /// Deterministic retry key; the public id is derived from it.
    pub key: String,
    /// Title as typed.
    pub title: String,
    /// Maker's name as typed.
    pub author: String,
    /// The audio file, relative to the manifest: canonical 48 kHz mono s16le, headerless.
    pub audio_file: String,
    /// SHA-256 (hex) of that file, so a changed file cannot be seeded by accident.
    pub audio_sha256: String,
    /// Declared licence evidence.
    pub licence: String,
    /// Title of the original work, if any.
    #[serde(default)]
    pub work_title: Option<String>,
    /// Author of the original work, if any.
    #[serde(default)]
    pub work_author: Option<String>,
    /// Where the original can be found.
    #[serde(default)]
    pub url: Option<String>,
}

/// One seeded flip.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestFlip {
    /// Deterministic retry key; the public id is derived from it.
    pub key: String,
    /// Title as typed.
    pub title: String,
    /// Maker's name as typed.
    pub author: String,
    /// The cut of the previous stage, in frames.
    pub cut: crate::publish::CutRequest,
    /// The speed as a fraction.
    pub speed: crate::publish::SpeedRequest,
    /// SHA-256 (hex) of the output, worked out by the independent reference renderer
    /// (`scripts/vectors/reference.py`), not by this code. The publish path cross-checks the
    /// server's render against it and the seed fails if they differ.
    pub expected_output_sha256: String,
}

/// Why the chain could not be seeded.
#[derive(Debug, thiserror::Error)]
pub enum ChainSeedError {
    /// The manifest is not valid JSON of the documented shape.
    #[error("the seed manifest is not valid: {0}")]
    Manifest(String),
    /// The audio file does not match the hash the manifest names.
    #[error("the audio file does not match the manifest's audio_sha256 ({0})")]
    AudioChanged(String),
    /// An audio file the manifest names could not be read.
    #[error("the audio file {file:?} could not be read: {detail}")]
    Unreadable {
        /// The file name in the manifest.
        file: String,
        /// What the operating system said.
        detail: String,
    },
    /// The source could not be seeded.
    #[error(transparent)]
    Source(#[from] SeedError),
    /// A flip was refused by the publish path.
    #[error("flip {key:?} was refused: {detail}")]
    Refused {
        /// The flip's retry key.
        key: String,
        /// What the publish path said.
        detail: String,
    },
    /// The server's render differs from the independent reference's.
    #[error("flip {key:?}: the render differs from the independent reference")]
    RenderDiffers {
        /// The flip's retry key.
        key: String,
    },
}

/// Parse a manifest.
pub fn parse_manifest(text: &str) -> Result<Manifest, ChainSeedError> {
    serde_json::from_str(text).map_err(|e| ChainSeedError::Manifest(e.to_string()))
}

/// Seed the source and then every flip **through the publish pipeline every visitor uses**: the
/// server renders each flip with the canonical renderer, checks the caps and writes the record in
/// the same transaction. The only differences are the identity (a public id derived from the retry
/// key, and no manage key) and that the render is cross-checked against the independent reference.
/// Running it twice yields one chain. Returns the publication ids, source first.
pub async fn seed_chain(
    state: &crate::http::AppState,
    manifest: &Manifest,
    source_audio: Vec<u8>,
) -> Result<Vec<PublicationId>, ChainSeedError> {
    let mut ids = vec![seed_manifest_source(state, &manifest.source, source_audio).await?];
    for flip in &manifest.flips {
        let parent = ids.last().map(ToString::to_string).unwrap_or_default();
        let request = crate::publish::PublishFlipRequest {
            parent_id: parent,
            cut: flip.cut,
            speed: flip.speed,
            title: flip.title.clone(),
            author: flip.author.clone(),
            retry_key: flip.key.clone(),
            preview_hash: Some(flip.expected_output_sha256.clone()),
        };
        let (_, published) =
            crate::publish::publish_flip_as(state, request, crate::publish::Identity::Seeded)
                .await
                .map_err(|p| ChainSeedError::Refused {
                    key: flip.key.clone(),
                    detail: format!("{}: {}", p.kind, p.detail),
                })?;
        if published.preview_matches == Some(false) {
            return Err(ChainSeedError::RenderDiffers {
                key: flip.key.clone(),
            });
        }
        ids.push(PublicationId::seeded(&flip.key));
    }
    Ok(ids)
}

/// Seed one manifest source from its audio, after checking the audio is the file the manifest names.
async fn seed_manifest_source(
    state: &crate::http::AppState,
    source: &ManifestSource,
    audio: Vec<u8>,
) -> Result<PublicationId, ChainSeedError> {
    check_audio(source, &audio)?;
    let identity = state.renderer.identity();
    let renderer = RendererIdentity {
        name: identity.name.to_owned(),
        version: identity.version,
        wasm_sha256: graft_domain::hash::Sha256Hash::parse(&identity.wasm_sha256)
            .map_err(|e| ChainSeedError::Manifest(e.to_string()))?,
    };
    let seeded = seed_source(
        &state.store,
        state.blobs.as_ref(),
        &state.limits,
        SeedSource {
            key: source.key.clone(),
            title: source.title.clone(),
            author: source.author.clone(),
            evidence: SourceEvidence {
                licence: source.licence.clone(),
                work_title: source.work_title.clone(),
                work_author: source.work_author.clone(),
                url: source.url.clone(),
                declaration: None,
            },
            audio,
            renderer,
        },
    )
    .await?;
    let (Outcome::Created(stage) | Outcome::Existing(stage)) = seeded else {
        return Err(SeedError::KeyConflict(source.key.clone()).into());
    };
    Ok(stage.id)
}

fn check_audio(source: &ManifestSource, audio: &[u8]) -> Result<(), ChainSeedError> {
    if graft_domain::hash::Sha256Hash::of(audio).to_hex() == source.audio_sha256 {
        Ok(())
    } else {
        Err(ChainSeedError::AudioChanged(source.key.clone()))
    }
}

/// The curated sources: the sounds a maker can start from, each a root publication with declared
/// evidence. A separate file from the seeded chain, because the chain is one sound and its flips and
/// this is a set of sounds; the chain's source is one of them.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CuratedManifest {
    /// The sources, in the order a maker is shown them.
    pub sources: Vec<ManifestSource>,
}

/// Parse the curated manifest.
pub fn parse_curated(text: &str) -> Result<CuratedManifest, ChainSeedError> {
    let manifest: CuratedManifest =
        serde_json::from_str(text).map_err(|e| ChainSeedError::Manifest(e.to_string()))?;
    let mut keys: Vec<&str> = manifest.sources.iter().map(|s| s.key.as_str()).collect();
    keys.sort_unstable();
    if let Some(pair) = keys.windows(2).find(|w| w[0] == w[1]) {
        return Err(ChainSeedError::Manifest(format!(
            "the retry key {:?} is listed twice",
            pair[0]
        )));
    }
    Ok(manifest)
}

/// Seed every curated source. Every file is read and checked against its recorded hash before any
/// is stored, so a changed file seeds nothing. Running it twice changes nothing the second time.
/// `dir` is where the manifest's audio files are. Returns the ids in the manifest's order.
pub async fn seed_curated(
    state: &crate::http::AppState,
    manifest: &CuratedManifest,
    dir: &std::path::Path,
) -> Result<Vec<PublicationId>, ChainSeedError> {
    let mut files = Vec::with_capacity(manifest.sources.len());
    for source in &manifest.sources {
        let audio = std::fs::read(dir.join(&source.audio_file)).map_err(|e| {
            ChainSeedError::Unreadable {
                file: source.audio_file.clone(),
                detail: e.to_string(),
            }
        })?;
        check_audio(source, &audio)?;
        files.push(audio);
    }
    let mut ids = Vec::with_capacity(files.len());
    for (source, audio) in manifest.sources.iter().zip(files) {
        ids.push(seed_manifest_source(state, source, audio).await?);
    }
    Ok(ids)
}
