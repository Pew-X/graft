//! Publishing a source: `POST /v1/sources`. A visitor publishes their own sound as a root
//! publication, under a rights declaration, through the same model, the same idempotency and the
//! same one-time manage key as a flip.
//!
//! **Switched off by default.** The route answers "uploads are switched off" until
//! `GRAFT_UPLOADS=on`, and the kill switch closes it like every other write. Opening the door is a
//! decision at the launch gate, not something this code does.
//!
//! **Validated before anything is stored.** The sound arrives as base64 of canonical PCM (48 kHz,
//! mono, signed 16-bit little-endian, no header), because the browser decodes it first. The route's
//! body limit is derived from the source cap, so an oversized body is cut off before it is read in
//! full. The length, the shape and a few plausibility checks run before a byte reaches the blob
//! store or a row reaches the database.
//!
//! **Honest about what it knows.** The declaration is stored as the visitor accepted it, with the
//! time, and shown as declared. The server computes from what was submitted: it cannot verify
//! that a client decoded honestly, nor that the sound is what the visitor says it is.

use crate::http::AppState;
use crate::problem::Problem;
use crate::publish::{ApiJson, check_retry_key, clean, internal, new_manage_key, random_id};
use crate::views::EntryView;
use axum::Json;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use graft_domain::audio;
use graft_domain::chain::{Declaration, SourceEvidence};
use graft_domain::hash::Sha256Hash;
use graft_domain::limits::Limits;
use graft_domain::record::{ContentRecord, RendererIdentity};
use graft_storage::{NewPublication, Outcome, StoreError};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The statement a visitor accepts to publish a sound. It is stored exactly as accepted, so the
/// request must carry this text, character for character: what is stored is what was shown.
pub const DECLARATION_TEXT: &str = "I made this sound or I have the right to share it. It does not contain anyone's private conversation.";

/// Room for the JSON around the audio.
const ENVELOPE_BYTES: usize = 8 * 1024;

/// The largest body the route reads: the base64 of the longest source the limits allow, plus the
/// envelope. Beyond it the body is refused before it is read in full.
#[must_use]
pub fn max_body_bytes(limits: &Limits) -> usize {
    let audio = limits.max_source_frames as usize * 2;
    audio.div_ceil(3) * 4 + ENVELOPE_BYTES
}

/// What the visitor declares the basis of their right to be.
const BASES: [(&str, &str); 2] = [
    ("own_recording", "own recording"),
    ("right_to_share", "right to share"),
];

/// The declaration the visitor accepted.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DeclarationRequest {
    /// The statement, exactly as shown: it must equal the service's declaration text.
    pub statement: String,
    /// `own_recording` or `right_to_share`.
    pub basis: String,
}

/// A source to publish.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PublishSourceRequest {
    /// Base64 (standard alphabet, no line breaks) of canonical audio: 48 kHz, mono, signed 16-bit
    /// little-endian, no header; at most 30 seconds.
    pub audio: String,
    /// Title as typed; links and handles are removed, and the response says so.
    pub title: String,
    /// The maker's name as typed. Plain text, never a handle.
    pub author: String,
    /// Chosen by the client when the publish step opens: 16 to 128 characters from `A-Z a-z 0-9 . _ : -`.
    pub retry_key: String,
    /// The rights declaration. Required.
    #[serde(default)]
    pub declaration: Option<DeclarationRequest>,
}

/// The result of publishing a source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct PublishedSource {
    /// The new publication, as one entry of a chain.
    pub publication: EntryView,
    /// The key that manages this publication. Shown once, in the response that creates it. Absent
    /// when the request was a replay.
    pub manage_key: Option<String>,
    /// Fields whose text was changed by removing a link or a handle.
    pub adjusted_fields: Vec<String>,
}

/// The guard in front of the source route: the kill switch, then the uploads switch, then the
/// visitor's own limit. All three run before the body is read.
pub async fn upload_guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if let Some(refusal) = crate::http::publishing_closed(&state).await {
        return refusal;
    }
    if !state.uploads_enabled {
        state.metrics.refusal("uploads_off");
        return Problem::uploads_off().into_response();
    }
    let ip = state
        .guards
        .client_ip(request.extensions(), request.headers());
    match state.guards.limiter.try_admit(
        crate::guard::Class::Publish,
        ip,
        state.guards.clock.now_secs(),
    ) {
        Ok(()) => next.run(request).await,
        Err(wait) => {
            state.metrics.refusal("rate_limited_publish");
            Problem::rate_limited(wait).into_response()
        }
    }
}

/// Publish a sound the visitor made.
#[utoipa::path(
    post,
    path = "/v1/sources",
    request_body = PublishSourceRequest,
    responses(
        (status = 201, description = "Published; the manage key is in this response only", body = PublishedSource),
        (status = 200, description = "The same request was already published; nothing changed", body = PublishedSource),
        (status = 409, description = "The retry key belongs to a different sound", body = Problem, content_type = "application/problem+json"),
        (status = 413, description = "The body is larger than any allowed source", body = Problem, content_type = "application/problem+json"),
        (status = 422, description = "A field or the audio breaks a rule; `field` and `rule` say which", body = Problem, content_type = "application/problem+json"),
        (status = 429, description = "This visitor published too often, or everyone together reached the publish cap", body = Problem, content_type = "application/problem+json"),
        (status = 503, description = "Uploads are switched off (`uploads-off`), publishing is switched off (`publishing-off`), there is no room (`storage-full`), or busy (`retry-later`)", body = Problem, content_type = "application/problem+json"),
    )
)]
pub async fn publish_source(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<PublishSourceRequest>,
) -> Result<Response, Problem> {
    use tracing::Instrument;
    let result = publish_source_inner(&state, request)
        .instrument(tracing::info_span!("publish", kind = "source"))
        .await;
    crate::publish::count_outcome(&state, "source", result.as_ref().map(Response::status));
    result
}

async fn publish_source_inner(
    state: &AppState,
    request: PublishSourceRequest,
) -> Result<Response, Problem> {
    let limits = &state.limits;

    // 1. Everything that needs no I/O, cheapest first, before any audio is decoded.
    let title = clean("title", &request.title, limits.max_title_chars, state)?;
    let author = clean("author", &request.author, limits.max_author_chars, state)?;
    check_retry_key(&request.retry_key)?;
    let basis = check_declaration(request.declaration.as_ref())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(request.audio.as_bytes())
        .map_err(|_| {
            Problem::invalid(
                "audio",
                "encoding",
                "the audio must be base64 of the raw sound, with no line breaks",
            )
        })?;
    let frames = audio::check_source(&bytes, limits)
        .map_err(|e| Problem::invalid("audio", e.rule(), e.to_string()))?;

    let hash = Sha256Hash::of(&bytes);
    let identity = state.renderer.identity();
    let record = ContentRecord::source(
        hash,
        frames,
        RendererIdentity {
            name: identity.name.to_owned(),
            version: identity.version,
            wasm_sha256: Sha256Hash::parse(&identity.wasm_sha256)
                .map_err(|e| internal("reading the renderer identity", &e))?,
        },
    )
    .map_err(|e| Problem::invalid("audio", "record", e.to_string()))?;
    // 2. Admission. A replay adds nothing to storage, so it needs neither.
    // A replay is the same key for the same sound. A key reused for another sound is not free: it
    // would write a blob before the conflict showed.
    let is_replay = state
        .store
        .retry_key_matches(&request.retry_key, &record)
        .await
        .map_err(|e| internal("looking up the retry key", &e))?;
    if !is_replay {
        if state.guards.storage.is_full().await {
            state.metrics.refusal("storage_full");
            return Err(Problem::storage_full());
        }
        if let Err(problem) = state.guards.take_global_token(&state.store).await {
            state.metrics.refusal("publish_cap");
            return Err(problem);
        }
    }

    // 3. The audio, then the row. The blob is written first and is safe to repeat.
    let for_repair = bytes.clone();
    let stored = state
        .blobs
        .put_if_absent(bytes)
        .await
        .map_err(|e| internal("storing the audio", &e))?;
    if stored != hash {
        return Err(internal(
            "storing the audio",
            &"the store returned another hash",
        ));
    }
    let manage_key = new_manage_key().map_err(|e| internal("making a manage key", &e))?;
    let key_hash = *Sha256Hash::of(manage_key.as_bytes()).as_bytes();
    let mut outcome = None;
    for _ in 0..4 {
        let new = NewPublication {
            id: random_id().map_err(|e| internal("making an id", &e))?,
            record: record.clone(),
            retry_key: request.retry_key.clone(),
            title: title.value.clone(),
            author: author.value.clone(),
            note: None,
            evidence: Some(SourceEvidence {
                licence: basis.to_owned(),
                work_title: None,
                work_author: None,
                url: None,
                declaration: Some(Declaration {
                    text: DECLARATION_TEXT.to_owned(),
                    at_ms: 0,
                }),
            }),
            manage_key_hash: Some(key_hash),
        };
        match state.store.create_publication(&new).await {
            Err(StoreError::IdCollision) => {}
            Err(StoreError::RetryExhausted | StoreError::Busy) => {
                return Err(Problem::retry_later());
            }
            Err(other) => return Err(internal("creating the source", &other)),
            Ok(done) => {
                outcome = Some(done);
                break;
            }
        }
    }
    let outcome =
        outcome.ok_or_else(|| internal("making an id", &"four ids in a row were taken"))?;
    let (status, stage, key) = match outcome {
        Outcome::Created(stage) => {
            // As for a flip: if cleanup removed the blob between the write and the commit, this
            // restores it.
            if let Err(e) = state.blobs.put_if_absent(for_repair).await {
                tracing::error!(error = %e, "re-checking the audio after commit failed");
            }
            (StatusCode::CREATED, stage, Some(manage_key))
        }
        Outcome::Existing(stage) => (StatusCode::OK, stage, None),
        Outcome::KeyConflict => return Err(Problem::key_conflict()),
    };
    let publication = match crate::routes::publication_view(state, &stage.id).await {
        Ok(Some(view)) => view,
        Ok(None) | Err(_) if status == StatusCode::CREATED => {
            tracing::error!(
                "the new publication's view could not be built; answering with the key only"
            );
            EntryView::Unavailable {
                id: stage.id.to_string(),
            }
        }
        Ok(None) => return Err(Problem::not_found("there is no publication with this id")),
        Err(problem) => return Err(problem),
    };
    let adjusted_fields: Vec<String> = [("title", title.adjusted), ("author", author.adjusted)]
        .into_iter()
        .filter(|(_, adjusted)| *adjusted)
        .map(|(name, _)| name.to_owned())
        .collect();
    Ok((
        status,
        Json(PublishedSource {
            publication,
            manage_key: key,
            adjusted_fields,
        }),
    )
        .into_response())
}

/// The declaration must be present, carry the exact statement and name a basis; returns the basis
/// as it is stored.
fn check_declaration(declaration: Option<&DeclarationRequest>) -> Result<&'static str, Problem> {
    let Some(d) = declaration else {
        return Err(Problem::invalid(
            "declaration",
            "required",
            "a sound can only be published with the rights declaration accepted",
        ));
    };
    if d.statement != DECLARATION_TEXT {
        return Err(Problem::invalid(
            "declaration",
            "statement",
            "the declaration must be the statement exactly as shown",
        ));
    }
    BASES
        .iter()
        .find(|(name, _)| *name == d.basis)
        .map(|(_, stored)| *stored)
        .ok_or_else(|| {
            Problem::invalid(
                "declaration",
                "basis",
                "the basis must be own_recording or right_to_share",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_limit_is_the_base64_of_the_longest_source_plus_an_envelope() {
        let l = Limits::default();
        // 1,440,000 frames are 2,880,000 bytes, which is 3,840,000 base64 characters.
        assert_eq!(max_body_bytes(&l), 3_840_000 + ENVELOPE_BYTES);
    }

    #[test]
    fn a_declaration_must_be_present_exact_and_name_a_basis() {
        let ok = DeclarationRequest {
            statement: DECLARATION_TEXT.to_owned(),
            basis: "own_recording".to_owned(),
        };
        assert_eq!(
            check_declaration(Some(&ok)).expect("valid"),
            "own recording"
        );
        let other = DeclarationRequest {
            basis: "right_to_share".to_owned(),
            ..ok.clone()
        };
        assert_eq!(
            check_declaration(Some(&other)).expect("valid"),
            "right to share"
        );
        let rule = |d: Option<&DeclarationRequest>| check_declaration(d).expect_err("refused").rule;
        assert_eq!(rule(None), Some("required"));
        let altered = DeclarationRequest {
            statement: "I agree".to_owned(),
            ..ok.clone()
        };
        assert_eq!(rule(Some(&altered)), Some("statement"));
        let unknown = DeclarationRequest {
            basis: "found it".to_owned(),
            ..ok
        };
        assert_eq!(rule(Some(&unknown)), Some("basis"));
    }
}
