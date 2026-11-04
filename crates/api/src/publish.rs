//! Publishing a flip: `POST /v1/publications`.
//!
//! The order of the steps is the design. Cheap checks that need no I/O come first (text, cut,
//! speed). Then the parent is read (existence, chain depth). Then the slow work: the parent's audio
//! is loaded and rendered with the canonical renderer, outside any database transaction so a long
//! render never holds a lock, and the result is written to the blob store (put-if-absent). Only
//! then does the store's serializable transaction decide the rules that depend on other children:
//! permission, hidden state, the per-stage cap and the retry key. The server's render is the only
//! canonical one; the client's preview hash is a cross-check and never decides what is stored.

use crate::http::AppState;
use crate::problem::Problem;
use crate::views::EntryView;
use axum::Json;
use axum::extract::{FromRequest, Request, State, rejection::JsonRejection};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use graft_domain::hash::Sha256Hash;
use graft_domain::ids::PublicationId;
use graft_domain::limits::Limits;
use graft_domain::record::{
    ContentRecord, Cut, MAX_RATIO_TERM, METHOD_HERMITE, RecordError, RendererIdentity, Transform,
    check_ratio,
};
use graft_domain::text;
use graft_render_host::{Method, Ratio, RenderError};
use graft_storage::{FlipOutcome, NewFlip, NewPublication, Refusal, StoreError};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Largest request body this route reads. A flip is a few hundred bytes of JSON.
pub const MAX_BODY_BYTES: usize = 8 * 1024;

/// A cut of the parent's audio, in frames of 48 kHz mono audio, half-open.
#[derive(Debug, Clone, Copy, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CutRequest {
    /// First frame included.
    pub start: u32,
    /// First frame not included.
    pub end: u32,
}

/// The speed as an exact fraction: `p/q` input frames per output frame, between 1/4 and 4.
#[derive(Debug, Clone, Copy, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SpeedRequest {
    /// Numerator, 1 to 2^20.
    pub p: u32,
    /// Denominator, 1 to 2^20.
    pub q: u32,
}

/// A flip to publish. No audio travels: the server renders it.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PublishFlipRequest {
    /// Public id of the stage being flipped.
    pub parent_id: String,
    /// The cut of the parent's audio.
    pub cut: CutRequest,
    /// The varispeed fraction.
    pub speed: SpeedRequest,
    /// Title as typed; links and handles are removed, and the response says so.
    pub title: String,
    /// The maker's name as typed. Plain text, never a handle.
    pub author: String,
    /// Chosen by the client when the publish step opens: 16 to 128 characters from `A-Z a-z 0-9 . _ : -`.
    /// Repeating a request with the same key and the same content returns the same publication.
    pub retry_key: String,
    /// SHA-256 (hex) of the audio the client's preview rendered. A cross-check only.
    #[serde(default)]
    pub preview_hash: Option<String>,
    /// An optional note from the maker, one short line of plain text under the same rules as a title
    /// (links and handles are removed, and the response says so). The maker can change it later
    /// with the manage key; it is not part of the content record. Empty text means no note.
    #[serde(default)]
    pub note: Option<String>,
}

/// The result of publishing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct PublishedFlip {
    /// The new publication, as one entry of a chain.
    pub publication: EntryView,
    /// The key that manages this publication. Shown once, in the response that creates it, and
    /// never again: only its hash is stored. Absent when the request was a replay.
    pub manage_key: Option<String>,
    /// Whether the client's preview hash matched the server's render; absent when none was sent.
    /// On a mismatch the server's audio is what was stored.
    pub preview_matches: Option<bool>,
    /// Fields whose text was changed by removing a link or a handle.
    pub adjusted_fields: Vec<String>,
}

/// A JSON body extractor whose refusals are problem details.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: serde::de::DeserializeOwned,
{
    type Rejection = Problem;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(match &rejection {
                _ if crate::problem::body_timed_out(&rejection) => Problem::request_timeout(),
                JsonRejection::BytesRejection(_)
                    if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE =>
                {
                    Problem::too_large()
                }
                _ => {
                    Problem::bad_request("the body must be JSON with exactly the documented fields")
                }
            }),
        }
    }
}

/// Publish a flip of an existing stage.
#[utoipa::path(
    post,
    path = "/v1/publications",
    request_body = PublishFlipRequest,
    responses(
        (status = 201, description = "Published; the manage key is in this response only", body = PublishedFlip),
        (status = 200, description = "The same request was already published; nothing changed", body = PublishedFlip),
        (status = 404, description = "No such parent", body = Problem, content_type = "application/problem+json"),
        (status = 409, description = "Key conflict, hidden parent or chain too deep", body = Problem, content_type = "application/problem+json"),
        (status = 403, description = "The maker closed this stage to flips", body = Problem, content_type = "application/problem+json"),
        (status = 422, description = "A field breaks a rule; `field` and `rule` say which", body = Problem, content_type = "application/problem+json"),
        (status = 429, description = "This stage was flipped too often this hour, this visitor published too often (`rate-limited`), or everyone together reached the publish cap (`publish-cap`); `Retry-After` says when to try again", body = Problem, content_type = "application/problem+json"),
        (status = 503, description = "Busy, send the same request again (`retry-later`); publishing is switched off (`publishing-off`); or there is no room for new audio (`storage-full`)", body = Problem, content_type = "application/problem+json"),
    )
)]
pub async fn publish_flip(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<PublishFlipRequest>,
) -> Result<Response, Problem> {
    use tracing::Instrument;
    let result = publish_flip_as(&state, request, Identity::Visitor)
        .instrument(tracing::info_span!("publish", kind = "flip"))
        .await;
    count_outcome(&state, "flip", result.as_ref().map(|(s, _)| *s));
    let (status, body) = result?;
    Ok((status, Json(body)).into_response())
}

/// Count a publish by what became of it: created, replayed, or the stable name of its refusal.
pub(crate) fn count_outcome<E: std::borrow::Borrow<Problem>>(
    state: &AppState,
    kind: &'static str,
    result: Result<StatusCode, E>,
) {
    let outcome = match result {
        Ok(StatusCode::CREATED) => "created",
        Ok(_) => "replay",
        Err(problem) => problem
            .borrow()
            .kind
            .trim_start_matches("urn:graft:problem:"),
    };
    state.metrics.publish_outcome(kind, outcome);
}

/// Who a publication is for, which decides how it is identified.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Identity {
    /// A visitor: a random public id and a manage key shown once.
    Visitor,
    /// The seed script: the public id is derived from the retry key, so it is the same in every
    /// environment, and there is no manage key, so nobody can manage a seeded stage. This is the
    /// only way a deterministic id is ever made, and it is reachable only from the seed path.
    Seeded,
}

/// The whole publish pipeline: the same code serves the route and the seed script, so a seeded
/// stage is rendered, capped and recorded exactly as a visitor's is.
pub(crate) async fn publish_flip_as(
    state: &AppState,
    request: PublishFlipRequest,
    identity_kind: Identity,
) -> Result<(StatusCode, PublishedFlip), Problem> {
    let limits = &state.limits;

    // 1. Everything that needs no I/O.
    let title = clean("title", &request.title, limits.max_title_chars, state)?;
    let author = clean("author", &request.author, limits.max_author_chars, state)?;
    let note = clean_note(request.note.as_deref(), limits.max_note_chars, state)?;
    check_retry_key(&request.retry_key)?;
    let preview = parse_preview(request.preview_hash.as_deref())?;
    check_cut_and_speed(limits, request.cut, request.speed)?;
    let parent_id = PublicationId::parse(&request.parent_id).map_err(|_| parent_not_found())?;

    // 2. The parent: it must exist, and the chain must have room for one more stage.
    let chain = state
        .store
        .chain(&parent_id, limits.max_chain_depth)
        .await
        .map_err(|e| internal("reading the parent chain", &e))?
        .ok_or_else(parent_not_found)?;
    if chain.truncated.is_some() || chain.entries.len() as u32 >= limits.max_chain_depth {
        return Err(Problem::depth_cap(limits.max_chain_depth));
    }
    let Some(graft_domain::chain::Entry::Present(parent)) = chain.entries.last() else {
        return Err(parent_not_found());
    };
    // Whether this retry key is already in use: an idempotent replay returns what was created, so
    // the checks below that would refuse a new flip do not apply to it.
    let is_replay = state
        .store
        .retry_key_exists(&request.retry_key)
        .await
        .map_err(|e| internal("looking up the retry key", &e))?;
    // A stage built on one hidden for rights is held: it cannot be flipped while the hide stands.
    // This is decided from the chain as read; a rights hide that lands a moment after it can still
    // let one fork through, which is harmless because holding is computed whenever a chain is read.
    if !is_replay
        && let Some(Some(graft_domain::chain::Availability::Held)) =
            graft_domain::chain::availability(&chain).last()
    {
        return Err(Problem::parent_held());
    }
    // A closed or hidden parent is refused before any render, so it costs nothing and leaves no
    // audio behind. The transaction decides again, because the flags can change in between.
    if !is_replay {
        match state
            .store
            .fork_flags(&parent_id)
            .await
            .map_err(|e| internal("reading the parent's flags", &e))?
        {
            None => return Err(parent_not_found()),
            Some(flags) if flags.hidden => return Err(Problem::parent_unavailable()),
            Some(flags) if !flags.fork_permitted => return Err(Problem::fork_not_permitted()),
            Some(_) => {}
        }
    }

    // 3. Render, outside any transaction.
    let parent_audio = state
        .blobs
        .get(parent.record.output_blob())
        .await
        .map_err(|e| internal("reading the parent audio", &e))?
        .ok_or_else(|| internal("reading the parent audio", &"the blob is missing"))?;
    let frames = u32::try_from(parent_audio.len() / 2).unwrap_or(u32::MAX);
    if request.cut.end > frames {
        return Err(Problem::invalid(
            "cut",
            "beyond_parent",
            format!(
                "the cut ends at frame {} but the stage has only {frames} frames",
                request.cut.end
            ),
        ));
    }
    let samples: Vec<i16> = parent_audio
        [request.cut.start as usize * 2..request.cut.end as usize * 2]
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    let ratio = Ratio {
        p: request.speed.p,
        q: request.speed.q,
    };
    let output_frames = state
        .renderer
        .output_frames(request.cut.end - request.cut.start, ratio)
        .map_err(|_| {
            Problem::invalid(
                "speed",
                "rejected",
                "the renderer does not accept this cut and speed",
            )
        })?;
    if output_frames < limits.min_frames {
        return Err(Problem::invalid(
            "speed",
            "output_too_short",
            format!(
                "this cut at this speed would be {output_frames} frames; the shortest allowed is {}",
                limits.min_frames
            ),
        ));
    }
    if output_frames > limits.max_output_frames {
        return Err(Problem::invalid(
            "speed",
            "output_too_long",
            format!(
                "this cut at this speed would be {output_frames} frames; the longest allowed is {}",
                limits.max_output_frames
            ),
        ));
    }
    // Admission, after every check that needs no render (so a request that was never going to publish
    // cannot spend the shared budget) and before the slow work: room to store the audio, and a token from the
    // global budget. A replay adds nothing to storage, so it takes neither.
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

    // At most a few renders at once: each holds the parent audio, the samples and the output in
    // memory and a thread, so an unbounded burst could starve everything else. Waiting too long for
    // a turn is a polite "busy, send it again".
    let _permit = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        state.renders.clone().acquire_owned(),
    )
    .await
    .map_err(|_| Problem::retry_later())?
    .map_err(|e| internal("waiting to render", &e))?;
    let renderer = state.renderer.clone();
    // The render runs on a blocking thread, which does not carry the request's span: the span is
    // made here, with the size of the input and no audio, and the future is instrumented, not the
    // closure.
    let render_span = tracing::info_span!(
        "render",
        input_frames = samples.len(),
        duration_us = tracing::field::Empty
    );
    let render_started = std::time::Instant::now();
    let render_result = {
        use tracing::Instrument;
        tokio::task::spawn_blocking(move || renderer.render(&samples, ratio, Method::Hermite))
            .instrument(render_span.clone())
            .await
    };
    let render_elapsed = render_started.elapsed();
    render_span.record("duration_us", render_elapsed.as_micros() as u64);
    state.metrics.observe_render(
        render_elapsed.as_secs_f64(),
        matches!(render_result, Ok(Ok(_))),
    );
    let rendered = render_result
        .map_err(|e| internal("rendering", &e))?
        .map_err(|e| match e {
            RenderError::InvalidParameters => Problem::invalid(
                "speed",
                "rejected",
                "the renderer does not accept this cut and speed",
            ),
            other => internal("rendering", &other),
        })?;
    let output_bytes: Vec<u8> = rendered.iter().flat_map(|s| s.to_le_bytes()).collect();
    let output_hash = Sha256Hash::of(&output_bytes);
    let preview_matches = preview.map(|p| p == output_hash);
    // The seed path cross-checks against the independent reference and must refuse before anything
    // is stored: a mismatch is a bug to see, not a chain to keep.
    if identity_kind == Identity::Seeded && preview_matches == Some(false) {
        return Err(Problem::invalid(
            "preview_hash",
            "differs",
            "the render differs from the independent reference",
        ));
    }
    if preview_matches == Some(false) {
        state.metrics.preview_mismatch();
        tracing::warn!(
            "the client's preview hash differed from the server render; the server's audio is stored"
        );
    }
    // Kept to write the blob once more after the commit (see below).
    let output_for_repair = output_bytes.clone();
    let stored = {
        use tracing::Instrument;
        state
            .blobs
            .put_if_absent(output_bytes)
            .instrument(tracing::info_span!("blob.put"))
            .await
            .map_err(|e| internal("storing the audio", &e))?
    };
    if stored != output_hash {
        return Err(internal(
            "storing the audio",
            &"the store returned another hash",
        ));
    }

    // 4. The record and the transaction.
    let identity = state.renderer.identity();
    let record = ContentRecord::flip(
        parent_id,
        parent.record.output_blob(),
        Cut {
            start: request.cut.start,
            end: request.cut.end,
        },
        Transform {
            p: request.speed.p,
            q: request.speed.q,
            method: METHOD_HERMITE,
        },
        RendererIdentity {
            name: identity.name.to_owned(),
            version: identity.version,
            wasm_sha256: Sha256Hash::parse(&identity.wasm_sha256)
                .map_err(|e| internal("reading the renderer identity", &e))?,
        },
        output_hash,
    )
    .map_err(|e| Problem::invalid("speed", "record", e.to_string()))?;

    let (manage_key, key_hash) = match identity_kind {
        Identity::Visitor => {
            let key = new_manage_key().map_err(|e| internal("making a manage key", &e))?;
            let hash = *Sha256Hash::of(key.as_bytes()).as_bytes();
            (Some(key), Some(hash))
        }
        Identity::Seeded => (None, None),
    };
    let outcome = create_with_fresh_id(
        state,
        record,
        &request.retry_key,
        FlipText {
            title: &title.value,
            author: &author.value,
            note: note.as_ref().map(|n| n.value.as_str()),
        },
        key_hash,
        identity_kind,
    )
    .await?;

    let adjusted_fields: Vec<String> = [
        ("title", title.adjusted),
        ("author", author.adjusted),
        ("note", note.as_ref().is_some_and(|n| n.adjusted)),
    ]
    .into_iter()
    .filter(|(_, adjusted)| *adjusted)
    .map(|(name, _)| name.to_owned())
    .collect();
    let (status, stage, key) = match outcome {
        FlipOutcome::Created(stage) => {
            // The orphan cleanup cannot be made atomic with this transaction, so the last line of
            // defence is here: write the audio again now that the record that names it is
            // committed. If the blob was removed in the instant between the first write and the
            // commit, this restores it; if it is present (nearly always) this is one cheap check.
            if let Err(e) = state.blobs.put_if_absent(output_for_repair).await {
                tracing::error!(error = %e, "re-checking the audio after commit failed");
            }
            (StatusCode::CREATED, stage, manage_key)
        }
        FlipOutcome::Existing(stage) => (StatusCode::OK, stage, None),
        FlipOutcome::KeyConflict => return Err(Problem::key_conflict()),
        FlipOutcome::Refused(why) => return Err(refusal(why)),
    };
    // Answer as every read does, through the availability rule, so a replay of a flip that has since
    // been withdrawn or held gets no audio URL. If the view cannot be built after the flip was
    // committed (a signing failure, say), the one-time manage key must still reach the maker:
    // answer with the key and an entry that says to read the publication again.
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
        Ok(None) => return Err(parent_not_found()),
        Err(problem) => return Err(problem),
    };
    let body = PublishedFlip {
        publication,
        manage_key: key,
        preview_matches,
        adjusted_fields,
    };
    Ok((status, body))
}

/// The cleaned public text of a flip, as it is stored.
struct FlipText<'a> {
    title: &'a str,
    author: &'a str,
    note: Option<&'a str>,
}

/// Create the flip under a fresh random id (or the seeded one), choosing another random id if one happens to be taken.
async fn create_with_fresh_id(
    state: &AppState,
    record: ContentRecord,
    retry_key: &str,
    text: FlipText<'_>,
    manage_key_hash: Option<[u8; 32]>,
    identity_kind: Identity,
) -> Result<FlipOutcome, Problem> {
    let FlipText {
        title,
        author,
        note,
    } = text;
    for _ in 0..4 {
        let id = match identity_kind {
            Identity::Visitor => random_id().map_err(|e| internal("making an id", &e))?,
            Identity::Seeded => PublicationId::seeded(retry_key),
        };
        let flip = NewFlip {
            publication: NewPublication {
                id,
                record: record.clone(),
                retry_key: retry_key.to_owned(),
                title: title.to_owned(),
                author: author.to_owned(),
                note: note.map(str::to_owned),
                evidence: None,
                manage_key_hash,
            },
            max_forks_per_stage_per_hour: state.publish.max_forks_per_stage_per_hour,
            serialization_retries: state.publish.serialization_retries,
            lock_wait: state.publish.lock_wait,
        };
        match state.store.create_flip(&flip).await {
            Err(StoreError::IdCollision) => {}
            // Conflicts that persisted, or a lock that stayed busy: nothing was written, and the
            // same request with the same retry key can simply be sent again.
            Err(StoreError::RetryExhausted | StoreError::Busy) => {
                return Err(Problem::retry_later());
            }
            Err(other) => return Err(internal("creating the flip", &other)),
            Ok(outcome) => return Ok(outcome),
        }
    }
    Err(internal("making an id", &"four ids in a row were taken"))
}

fn refusal(why: Refusal) -> Problem {
    match why {
        Refusal::ParentMissing => parent_not_found(),
        Refusal::ForkNotPermitted => Problem::fork_not_permitted(),
        Refusal::ParentHidden => Problem::parent_unavailable(),
        Refusal::ForkCapReached { limit } => Problem::fork_cap(limit),
    }
}

fn parent_not_found() -> Problem {
    Problem::not_found("there is no stage with this id to flip")
}

pub(crate) fn internal(context: &str, error: &dyn std::fmt::Display) -> Problem {
    tracing::error!(%error, context, "publish failed");
    Problem::internal()
}

pub(crate) fn clean(
    field: &'static str,
    input: &str,
    max: usize,
    state: &AppState,
) -> Result<text::Cleaned, Problem> {
    text::clean(input, max, &state.publish.extra_deny_words)
        .map_err(|e| Problem::invalid(field, e.rule(), format!("the {field} is not valid: {e}")))
}

/// Clean the optional note: absent or blank is no note; anything else follows the title rules at the
/// note's own length. Shared by publishing and by editing a note.
pub(crate) fn clean_note(
    input: Option<&str>,
    max: usize,
    state: &AppState,
) -> Result<Option<text::Cleaned>, Problem> {
    match input {
        None => Ok(None),
        Some(text) if text.trim().is_empty() => Ok(None),
        Some(text) => clean("note", text, max, state).map(Some),
    }
}

pub(crate) fn check_retry_key(key: &str) -> Result<(), Problem> {
    let ok = (16..=128).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b));
    if ok {
        Ok(())
    } else {
        Err(Problem::invalid(
            "retry_key",
            "format",
            "the retry key must be 16 to 128 characters from A-Z a-z 0-9 . _ : -",
        ))
    }
}

fn parse_preview(hash: Option<&str>) -> Result<Option<Sha256Hash>, Problem> {
    hash.map(|h| {
        Sha256Hash::parse(h).map_err(|_| {
            Problem::invalid(
                "preview_hash",
                "format",
                "the preview hash must be 64 lowercase hex characters",
            )
        })
    })
    .transpose()
}

/// The checks on a cut and a speed that need only the request and the limits.
fn check_cut_and_speed(
    limits: &Limits,
    cut: CutRequest,
    speed: SpeedRequest,
) -> Result<(), Problem> {
    if cut.end <= cut.start {
        return Err(Problem::invalid(
            "cut",
            "inverted",
            "the cut must end after it starts",
        ));
    }
    let len = cut.end - cut.start;
    if len < limits.min_frames {
        return Err(Problem::invalid(
            "cut",
            "too_short",
            format!(
                "the cut is {len} frames; the shortest allowed is {}",
                limits.min_frames
            ),
        ));
    }
    if len > limits.max_cut_frames {
        return Err(Problem::invalid(
            "cut",
            "too_long",
            format!(
                "the cut is {len} frames; the longest allowed is {}",
                limits.max_cut_frames
            ),
        ));
    }
    // One rule for the ratio, shared with the record that will hold it.
    check_ratio(speed.p, speed.q).map_err(|e| match e {
        RecordError::RatioTermOutOfRange => Problem::invalid(
            "speed",
            "term_out_of_range",
            format!("p and q must each be between 1 and {MAX_RATIO_TERM}"),
        ),
        _ => Problem::invalid(
            "speed",
            "out_of_range",
            "the speed must be between 1/4 and 4",
        ),
    })
}

/// 32 random bytes as 64 hex characters. Only the SHA-256 of this text is ever stored.
pub(crate) fn new_manage_key() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub(crate) fn random_id() -> Result<PublicationId, getrandom::Error> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes)?;
    Ok(PublicationId::from_bits(u64::from_be_bytes(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cut(start: u32, end: u32) -> CutRequest {
        CutRequest { start, end }
    }

    fn speed(p: u32, q: u32) -> SpeedRequest {
        SpeedRequest { p, q }
    }

    fn rule(r: Result<(), Problem>) -> Option<&'static str> {
        r.err().and_then(|p| p.rule)
    }

    #[test]
    fn cut_limits_are_exact_at_the_minimum_and_the_maximum() {
        let l = Limits::default();
        assert_eq!(
            rule(check_cut_and_speed(&l, cut(10, 10), speed(1, 1))),
            Some("inverted")
        );
        assert_eq!(
            rule(check_cut_and_speed(&l, cut(11, 10), speed(1, 1))),
            Some("inverted")
        );
        assert_eq!(
            rule(check_cut_and_speed(&l, cut(0, 479), speed(1, 1))),
            Some("too_short")
        );
        assert_eq!(
            rule(check_cut_and_speed(&l, cut(0, 480), speed(1, 1))),
            None
        );
        assert_eq!(
            rule(check_cut_and_speed(&l, cut(0, 1_440_000), speed(1, 1))),
            None
        );
        assert_eq!(
            rule(check_cut_and_speed(&l, cut(0, 1_440_001), speed(1, 1))),
            Some("too_long")
        );
    }

    #[test]
    fn speed_limits_are_exact_at_a_quarter_and_four_and_at_two_to_the_twenty() {
        let l = Limits::default();
        let c = cut(0, 1000);
        assert_eq!(rule(check_cut_and_speed(&l, c, speed(1, 4))), None);
        assert_eq!(rule(check_cut_and_speed(&l, c, speed(4, 1))), None);
        assert_eq!(
            rule(check_cut_and_speed(&l, c, speed(1, 5))),
            Some("out_of_range")
        );
        assert_eq!(
            rule(check_cut_and_speed(&l, c, speed(5, 1))),
            Some("out_of_range")
        );
        assert_eq!(
            rule(check_cut_and_speed(&l, c, speed(0, 1))),
            Some("term_out_of_range")
        );
        assert_eq!(
            rule(check_cut_and_speed(&l, c, speed(1, 0))),
            Some("term_out_of_range")
        );
        assert_eq!(
            rule(check_cut_and_speed(&l, c, speed(1 << 20, 1 << 20))),
            None
        );
        assert_eq!(
            rule(check_cut_and_speed(&l, c, speed((1 << 20) + 1, 1 << 20))),
            Some("term_out_of_range")
        );
    }

    #[test]
    fn retry_keys_are_16_to_128_url_safe_characters() {
        assert!(check_retry_key(&"a".repeat(16)).is_ok());
        assert!(check_retry_key(&"a".repeat(128)).is_ok());
        assert!(check_retry_key("abc-123_def.456:789").is_ok());
        for bad in [
            String::new(),
            "a".repeat(15),
            "a".repeat(129),
            "has space in it okay".to_owned(),
            "é".repeat(16),
        ] {
            assert!(check_retry_key(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_manage_key_is_64_hex_characters_and_never_repeats() {
        let a = new_manage_key().expect("random");
        let b = new_manage_key().expect("random");
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
