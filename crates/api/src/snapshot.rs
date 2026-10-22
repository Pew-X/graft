//! The static snapshot of the seeded chain: what the UI ships with so that the first open needs no
//! API call and never waits on a sleeping database.
//!
//! It holds only what a freshly seeded database says for certain: public ids, the credit lines with
//! their honesty states, the computed facts (cut, speed, renderer, hashes) and where each stage's
//! audio lives. It holds nothing that varies between environments (no creation times, no flip
//! counts, no signed URLs) and nothing secret. The audio is written beside it as files named by the
//! SHA-256 of their bytes, so they can be cached for ever.

use crate::http::AppState;
use graft_domain::chain::{Availability, Entry, availability, credit_lines};
use graft_domain::ids::PublicationId;
use serde::{Deserialize, Serialize};

/// The snapshot format version.
pub const VERSION: u32 = 1;

/// Where the audio files are served from, below the web root.
pub const AUDIO_DIR: &str = "public/seed";
/// Where the snapshot data is written, below the web root.
pub const DATA_FILE: &str = "snapshot/chain.json";

/// One credit line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Line {
    /// Role word.
    pub role: String,
    /// The text.
    pub value: String,
    /// `declared`, `computed` or `unknown`.
    pub honesty: String,
}

/// One stage of the seeded chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stage {
    /// Public publication id.
    pub id: String,
    /// `source` or `flip`.
    pub kind: String,
    /// Title as typed.
    pub title: String,
    /// Maker's name as typed.
    pub author: String,
    /// Parent publication id; absent for the source.
    pub parent_id: Option<String>,
    /// Credit lines in display order.
    pub lines: Vec<Line>,
    /// SHA-256 of the content record's canonical bytes.
    pub record_id: String,
    /// SHA-256 of the audio the cut was taken from.
    pub source_blob: String,
    /// SHA-256 of this stage's audio.
    pub output_blob: String,
    /// First frame of the cut.
    pub cut_start: u32,
    /// First frame after the cut.
    pub cut_end: u32,
    /// Speed numerator; absent for the source.
    pub speed_p: Option<u32>,
    /// Speed denominator; absent for the source.
    pub speed_q: Option<u32>,
    /// Renderer name and version.
    pub renderer: String,
    /// SHA-256 of the renderer `.wasm`.
    pub renderer_wasm_sha256: String,
    /// Frames of audio.
    pub frames: u32,
    /// Where the audio is served from: `/seed/<output_blob>.pcm`.
    pub audio_path: String,
}

/// The whole snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    /// The format version.
    pub version: u32,
    /// The stages, source first.
    pub stages: Vec<Stage>,
}

/// A stage's audio, to be written as `<hash>.pcm`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioFile {
    /// The file name: the SHA-256 (hex) of the bytes, then `.pcm`.
    pub name: String,
    /// The bytes.
    pub bytes: Vec<u8>,
}

/// Why a snapshot could not be built.
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    /// The chain is not whole and available: a snapshot of a hidden or missing stage would be wrong.
    #[error("the chain ending at {0} is not whole and available")]
    NotWhole(String),
    /// The database or the blob store failed.
    #[error("{0}")]
    Read(String),
}

/// Build the snapshot of the chain ending at `leaf`, and the audio files it points at, from what
/// the service holds for those publications.
pub async fn build(
    state: &AppState,
    leaf: &PublicationId,
) -> Result<(Snapshot, Vec<AudioFile>), SnapshotError> {
    let not_whole = || SnapshotError::NotWhole(leaf.to_string());
    let chain = state
        .store
        .chain(leaf, state.limits.max_chain_depth)
        .await
        .map_err(|e| SnapshotError::Read(e.to_string()))?
        .ok_or_else(not_whole)?;
    let available = availability(&chain);
    let mut stages = Vec::new();
    let mut files = Vec::new();
    for (entry, how) in chain.entries.iter().zip(&available) {
        let (Entry::Present(stage), Some(Availability::Available)) = (entry, how) else {
            return Err(not_whole());
        };
        let r = &stage.record;
        let bytes = state
            .blobs
            .get(r.output_blob())
            .await
            .map_err(|e| SnapshotError::Read(e.to_string()))?
            .ok_or_else(|| SnapshotError::Read("a stage's audio is missing".to_owned()))?;
        let name = format!("{}.pcm", r.output_blob().to_hex());
        stages.push(Stage {
            id: stage.id.to_string(),
            kind: match r.kind() {
                graft_domain::record::Kind::Source => "source",
                graft_domain::record::Kind::Flip => "flip",
            }
            .to_owned(),
            title: stage.title.clone(),
            author: stage.author.clone(),
            parent_id: r.parent().map(ToString::to_string),
            lines: credit_lines(stage)
                .into_iter()
                .map(|l| Line {
                    role: l.role.to_owned(),
                    value: l.value,
                    honesty: l.honesty.as_str().to_owned(),
                })
                .collect(),
            record_id: r.id().to_hex(),
            source_blob: r.source_blob().to_hex(),
            output_blob: r.output_blob().to_hex(),
            cut_start: r.cut().start,
            cut_end: r.cut().end,
            speed_p: r.transform().map(|t| t.p),
            speed_q: r.transform().map(|t| t.q),
            renderer: format!("{} {}", r.renderer().name, r.renderer().version),
            renderer_wasm_sha256: r.renderer().wasm_sha256.to_hex(),
            frames: u32::try_from(bytes.len() / 2).unwrap_or(u32::MAX),
            audio_path: format!("/seed/{name}"),
        });
        if !files.iter().any(|f: &AudioFile| f.name == name) {
            files.push(AudioFile { name, bytes });
        }
    }
    Ok((
        Snapshot {
            version: VERSION,
            stages,
        },
        files,
    ))
}

/// The snapshot as it is committed: pretty JSON, a trailing newline, fields in a fixed order.
#[must_use]
pub fn to_text(snapshot: &Snapshot) -> String {
    let mut text = serde_json::to_string_pretty(snapshot).unwrap_or_default();
    text.push('\n');
    text
}

/// How the committed snapshot differs from a fresh one, one line per difference, naming the stage.
/// Empty when they are the same.
#[must_use]
pub fn differences(committed: &Snapshot, fresh: &Snapshot) -> Vec<String> {
    let mut out = Vec::new();
    if committed.version != fresh.version {
        out.push(format!(
            "the snapshot version is {} and a fresh one is {}",
            committed.version, fresh.version
        ));
    }
    if committed.stages.len() != fresh.stages.len() {
        out.push(format!(
            "the committed snapshot has {} stages and a freshly seeded database has {}",
            committed.stages.len(),
            fresh.stages.len()
        ));
    }
    for (i, (a, b)) in committed.stages.iter().zip(&fresh.stages).enumerate() {
        if a == b {
            continue;
        }
        let what = |name: &str, x: &dyn std::fmt::Debug, y: &dyn std::fmt::Debug| {
            format!(
                "stage {} ({:?}, id {}): {name} is {x:?} in the committed snapshot and {y:?} when freshly seeded",
                i + 1,
                a.title,
                a.id
            )
        };
        if a.id != b.id {
            out.push(what("id", &a.id, &b.id));
        }
        if a.title != b.title {
            out.push(what("title", &a.title, &b.title));
        }
        if (a.cut_start, a.cut_end) != (b.cut_start, b.cut_end) {
            out.push(what(
                "cut",
                &(a.cut_start, a.cut_end),
                &(b.cut_start, b.cut_end),
            ));
        }
        if (a.speed_p, a.speed_q) != (b.speed_p, b.speed_q) {
            out.push(what(
                "speed",
                &(a.speed_p, a.speed_q),
                &(b.speed_p, b.speed_q),
            ));
        }
        if a.output_blob != b.output_blob {
            out.push(what("audio", &a.output_blob, &b.output_blob));
        }
        if a.record_id != b.record_id {
            out.push(what("record id", &a.record_id, &b.record_id));
        }
        if a.lines != b.lines {
            out.push(what("credit lines", &a.lines, &b.lines));
        }
        if out.is_empty()
            || !out
                .last()
                .is_some_and(|l| l.starts_with(&format!("stage {}", i + 1)))
        {
            out.push(format!(
                "stage {} ({:?}, id {}) differs",
                i + 1,
                a.title,
                a.id
            ));
        }
    }
    out
}
