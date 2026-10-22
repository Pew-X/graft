//! The read model: what the API says about a stage and a chain. Names, titles and notes are plain
//! text as typed; every line says whether it is declared, computed or unknown.

use graft_domain::chain::{Chain, HideReason, StoredStage, Truncation, credit_lines};
use graft_domain::honesty::Honesty;
use graft_domain::record::Kind;
use serde::Serialize;
use utoipa::ToSchema;

/// One line of a credit block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct LineView {
    /// Role word: "source", "flip", "flipped by", "cut", "speed", "licence", "renderer", "rights".
    pub role: String,
    /// The value, as text.
    pub value: String,
    /// "declared" (a person said it, as typed), "computed" (the system produced it) or "unknown".
    pub honesty: String,
}

/// A frame range of 48 kHz audio, half-open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct CutView {
    /// First frame included.
    pub start: u32,
    /// First frame not included.
    pub end: u32,
}

/// The exact speed fraction and the method that applied it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct SpeedView {
    /// Numerator.
    pub p: u32,
    /// Denominator.
    pub q: u32,
    /// Interpolation method id (1 is cubic Hermite).
    pub method: u32,
}

/// Which renderer produced the audio.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct RendererView {
    /// Renderer name.
    pub name: String,
    /// Renderer version.
    pub version: u32,
    /// SHA-256 of the `.wasm`, lowercase hex.
    pub wasm_sha256: String,
}

/// The exact facts, one level down from the credit lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct DetailsView {
    /// The content record id: SHA-256 of its canonical bytes. It proves which bytes, nothing more.
    pub record_id: String,
    /// SHA-256 of the audio the cut was taken from.
    pub source_blob: String,
    /// SHA-256 of this stage's audio.
    pub output_blob: String,
    /// The cut, computed.
    pub cut: CutView,
    /// The speed, absent for a source.
    pub speed: Option<SpeedView>,
    /// The renderer.
    pub renderer: RendererView,
}

/// A short-lived URL for a stage's audio: canonical 48 kHz mono signed 16-bit little-endian PCM.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct AudioView {
    /// Where to fetch the audio from. Not stable: ask again after it expires.
    pub url: String,
    /// Seconds the URL stays valid.
    pub expires_in_secs: u64,
}

/// One stage that could be read. Its availability is the `state` of the entry that holds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct StageView {
    /// Public id of the publication.
    pub id: String,
    /// "source" or "flip".
    pub kind: String,
    /// Title as typed.
    pub title: String,
    /// Maker's name as typed. Plain text, never a handle.
    pub author: String,
    /// Creation time, milliseconds since the Unix epoch.
    pub created_at_ms: i64,
    /// How many publications were flipped from this one, counted from publications data.
    pub flipped_count: u32,
    /// Id of the parent publication, absent for a source.
    pub parent_id: Option<String>,
    /// Whether the maker allows new flips of this stage.
    pub fork_permitted: bool,
    /// Credit lines, each with its honesty state.
    pub lines: Vec<LineView>,
    /// The exact facts.
    pub details: DetailsView,
    /// Where to hear it.
    pub audio: AudioView,
}

/// A stage that is hidden: its credit stays, its audio is not served, and the chain around it is
/// not shortened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct RemovedView {
    /// Public id of the publication.
    pub id: String,
    /// "source" or "flip".
    pub kind: String,
    /// Why it is hidden: "withdrawn" or "rights".
    pub reason: String,
    /// Title as typed.
    pub title: String,
    /// Maker's name as typed.
    pub author: String,
    /// Creation time, milliseconds since the Unix epoch.
    pub created_at_ms: i64,
    /// Id of the parent publication, absent for a source.
    pub parent_id: Option<String>,
    /// Credit lines, each with its honesty state.
    pub lines: Vec<LineView>,
}

/// A position in a chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum EntryView {
    /// A stage that was read and may be heard.
    Available(Box<StageView>),
    /// A hidden stage: "no longer here". Its credit stays; its audio is not served.
    NoLongerHere(Box<RemovedView>),
    /// A parent the chain names but could not be read. The chain is never silently shortened.
    Unavailable {
        /// The id the child names as its parent.
        id: String,
    },
}

/// A chain, source first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct ChainView {
    /// The stages, oldest first.
    pub stages: Vec<EntryView>,
    /// Set to "depth_cap" when the walk stopped before reaching a source.
    pub truncated: Option<String>,
}

fn honesty(h: Honesty) -> String {
    h.as_str().to_owned()
}

/// Build the view of one stage with its audio URL.
#[must_use]
pub fn stage_view(stage: &StoredStage, audio: AudioView) -> StageView {
    let r = &stage.record;
    StageView {
        id: stage.id.to_string(),
        kind: match r.kind() {
            Kind::Source => "source",
            Kind::Flip => "flip",
        }
        .to_owned(),
        title: stage.title.clone(),
        author: stage.author.clone(),
        created_at_ms: stage.created_at_ms,
        flipped_count: stage.flipped_count,
        parent_id: r.parent().map(ToString::to_string),
        fork_permitted: stage.fork_permitted,
        lines: credit_lines(stage)
            .into_iter()
            .map(|l| LineView {
                role: l.role.to_owned(),
                value: l.value,
                honesty: honesty(l.honesty),
            })
            .collect(),
        details: DetailsView {
            record_id: r.id().to_hex(),
            source_blob: r.source_blob().to_hex(),
            output_blob: r.output_blob().to_hex(),
            cut: CutView {
                start: r.cut().start,
                end: r.cut().end,
            },
            speed: r.transform().map(|t| SpeedView {
                p: t.p,
                q: t.q,
                method: t.method,
            }),
            renderer: RendererView {
                name: r.renderer().name.clone(),
                version: r.renderer().version,
                wasm_sha256: r.renderer().wasm_sha256.to_hex(),
            },
        },
        audio,
    }
}

/// The view of a hidden stage: credits and identity, no audio and no exact facts.
#[must_use]
pub fn removed_view(stage: &StoredStage, reason: HideReason) -> RemovedView {
    let r = &stage.record;
    RemovedView {
        id: stage.id.to_string(),
        kind: match r.kind() {
            Kind::Source => "source",
            Kind::Flip => "flip",
        }
        .to_owned(),
        reason: reason.as_str().to_owned(),
        title: stage.title.clone(),
        author: stage.author.clone(),
        created_at_ms: stage.created_at_ms,
        parent_id: r.parent().map(ToString::to_string),
        lines: credit_lines(stage)
            .into_iter()
            .map(|l| LineView {
                role: l.role.to_owned(),
                value: l.value,
                honesty: honesty(l.honesty),
            })
            .collect(),
    }
}

/// Assemble the chain response from one view per entry, in order.
#[must_use]
pub fn chain_view(chain: &Chain, stages: Vec<EntryView>) -> ChainView {
    ChainView {
        stages,
        truncated: chain.truncated.map(|t| match t {
            Truncation::DepthCap => "depth_cap".to_owned(),
        }),
    }
}
