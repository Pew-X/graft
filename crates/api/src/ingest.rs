//! Client event ingest: `POST /v1/events`, the guarded batch endpoint for the three events the
//! browser reports (`roll_opened`, `stage_played`, `flip_started`).
//!
//! It is an anonymous, public, write-capable route, so every guard matters: the kill switch and a
//! per-address rate limit run before the body is read; the batch and body sizes are capped; each
//! event id is a dedupe key; a session id is capped in how many events it may send; events naming
//! a publication that does not exist are dropped; and a browser that signals Global Privacy
//! Control or Do Not Track has its batch ignored, as defence in depth (the client does not send at
//! all). The response says only how many events were newly stored. Nothing from the request other
//! than the event fields is stored: no address, no user agent.
//!
//! Client events are best-effort counts. They never feed a public fact.

use crate::http::AppState;
use crate::problem::Problem;
use axum::Json;
use axum::body::Bytes;
use axum::extract::{FromRequest, Request, State};
use axum::http::{HeaderMap, StatusCode};
use graft_storage::{EventKind, NewEvent, Origin};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use utoipa::ToSchema;

/// Largest body this route reads. A full batch of 20 events is about 4 KB.
pub const MAX_BODY_BYTES: usize = 16 * 1024;

/// The events body as JSON, whatever its content type says. The browser's way to send a batch that
/// must outlive the page (a beacon) is a `text/plain` body, because that is the one type a
/// cross-origin request may use without a preflight, and a preflight cannot finish while a page is
/// unloading. The body is held to the same rules as any other: it must be exactly the documented
/// JSON, within the size cap. Accepting it makes the route postable from any site, which costs
/// nothing here: it is anonymous, stores no address, is limited per address and per session, and
/// its counts never become a public fact.
pub struct EventsBody(pub IngestRequest);

impl<S: Send + Sync> FromRequest<S> for EventsBody {
    type Rejection = Problem;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = Bytes::from_request(req, state).await.map_err(|rejection| {
            if crate::problem::body_timed_out(&rejection) {
                Problem::request_timeout()
            } else if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                Problem::too_large()
            } else {
                Problem::bad_request("the body could not be read")
            }
        })?;
        serde_json::from_slice(&bytes).map(Self).map_err(|_| {
            Problem::bad_request("the body must be JSON with exactly the documented fields")
        })
    }
}

/// An event time more than this far ahead of the server's clock is clamped to the server's now.
const FUTURE_SKEW_MS: i64 = 5 * 60 * 1000;
/// An event time older than this is clamped to this age: a batch is sent within minutes.
const PAST_SKEW_MS: i64 = 24 * 60 * 60 * 1000;

/// One event as the browser reports it.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ClientEvent {
    /// Chosen by the browser, 16 to 64 characters from `A-Z a-z 0-9 _ -`. The dedupe key: an id
    /// already stored is not stored again.
    pub event_id: String,
    /// The page load's session id, 8 to 64 characters from `A-Z a-z 0-9 _ -`.
    pub session_id: String,
    /// One of `roll_opened`, `stage_played`, `flip_started`.
    pub kind: String,
    /// When it happened by the browser's clock, milliseconds since the Unix epoch. A time far from
    /// the server's is replaced by the nearest acceptable one.
    pub occurred_at_ms: i64,
    /// The public id of the stage (for a roll, its last stage). Events naming a publication that
    /// does not exist are dropped.
    pub publication_id: String,
}

/// A batch of events.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct IngestRequest {
    /// The events, at most the configured batch size (20 by default).
    pub events: Vec<ClientEvent>,
}

/// The receipt: deliberately all there is to learn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub struct IngestReceipt {
    /// Events newly stored. Fewer than sent when some were repeats, named a publication that does
    /// not exist, or the browser signalled that it must not be measured.
    pub accepted: u32,
}

fn id_ok(text: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Whether the request carries a Global Privacy Control or Do Not Track signal.
fn opted_out(headers: &HeaderMap) -> bool {
    let on = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.trim() == "1")
    };
    on("sec-gpc") || on("dnt")
}

/// Report a batch of client events.
#[utoipa::path(
    post,
    path = "/v1/events",
    request_body = IngestRequest,
    responses(
        (status = 200, description = "How many events were newly stored", body = IngestReceipt),
        (status = 422, description = "A field breaks a rule, or the batch is too large; `field` and `rule` say which", body = Problem, content_type = "application/problem+json"),
        (status = 429, description = "This visitor or session sent too much; `Retry-After` says when to try again", body = Problem, content_type = "application/problem+json"),
        (status = 503, description = "Publishing, which includes event reporting, is switched off", body = Problem, content_type = "application/problem+json"),
    )
)]
pub async fn ingest_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    EventsBody(request): EventsBody,
) -> Result<Json<IngestReceipt>, Problem> {
    // A browser that signals Global Privacy Control or Do Not Track must not be measured: whatever
    // arrives with the signal is ignored, not stored and not examined.
    if opted_out(&headers) || request.events.is_empty() {
        return Ok(Json(IngestReceipt { accepted: 0 }));
    }
    if request.events.len() > state.ingest_max_batch {
        return Err(Problem::invalid(
            "events",
            "too_many",
            format!(
                "send at most {} events in one batch",
                state.ingest_max_batch
            ),
        ));
    }
    let now_ms = (state.guards.clock.now_secs() * 1000.0) as i64;
    let mut events = Vec::with_capacity(request.events.len());
    let mut per_session: BTreeMap<&str, usize> = BTreeMap::new();
    for e in &request.events {
        if !id_ok(&e.event_id, 16, 64) {
            return Err(Problem::invalid(
                "event_id",
                "format",
                "an event id is 16 to 64 letters, digits, underscores or hyphens",
            ));
        }
        if !id_ok(&e.session_id, 8, 64) {
            return Err(Problem::invalid(
                "session_id",
                "format",
                "a session id is 8 to 64 letters, digits, underscores or hyphens",
            ));
        }
        let kind = EventKind::parse(&e.kind)
            .filter(|k| k.origin() == Origin::Client)
            .ok_or_else(|| {
                Problem::invalid(
                    "kind",
                    "unknown",
                    "the kind must be one of roll_opened, stage_played, flip_started",
                )
            })?;
        // A time too far ahead is replaced by now; one too far back by the oldest time allowed.
        let occurred = if e.occurred_at_ms > now_ms + FUTURE_SKEW_MS {
            now_ms
        } else {
            e.occurred_at_ms.max(now_ms - PAST_SKEW_MS)
        };
        *per_session.entry(e.session_id.as_str()).or_default() += 1;
        events.push(NewEvent {
            event_id: Some(e.event_id.clone()),
            kind,
            session_id: Some(e.session_id.clone()),
            occurred_at_ms: Some(occurred),
            publication_id: Some(e.publication_id.clone()),
            detail: None,
        });
    }
    let now = state.guards.clock.now_secs();
    let counts: Vec<(&str, usize)> = per_session.iter().map(|(s, n)| (*s, *n)).collect();
    if let Err(wait) = state.guards.sessions.try_add_all(&counts, now) {
        state.metrics.refusal("rate_limited_session");
        return Err(Problem::rate_limited(wait));
    }
    // Events about nothing that exists are dropped; the receipt does not say which.
    let ids: Vec<String> = events
        .iter()
        .filter_map(|e| e.publication_id.clone())
        .collect();
    let existing = state
        .store
        .existing_publication_ids(&ids)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "checking the events' publications failed");
            Problem::internal()
        })?;
    events.retain(|e| {
        e.publication_id
            .as_ref()
            .is_some_and(|id| existing.contains(id))
    });
    let accepted = state.store.append_events(&events).await.map_err(|e| {
        tracing::error!(error = %e, "storing client events failed");
        Problem::internal()
    })?;
    Ok(Json(IngestReceipt {
        accepted: u32::try_from(accepted).unwrap_or(u32::MAX),
    }))
}
