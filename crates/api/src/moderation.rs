//! Moderation: anyone can report a sound, and the operator reviews reports and makes one decision,
//! hiding a publication with a reason, reversibly.
//!
//! - **Reporting** needs no account and collects no identity: a category, an optional short note and
//!   a time. The note is cleaned like other public text (links and handles removed), is for the
//!   operator only and is never shown publicly.
//! - **The admin routes** are guarded by a secret from configuration, presented in the
//!   `X-Graft-Admin-Secret` header. Only its SHA-256 is kept in memory, the comparison is
//!   constant-time, and a wrong secret, a missing one and an unconfigured one all get the same
//!   refusal. The routes are deliberately absent from the public OpenAPI document: they are
//!   internal, and ticket 33 (the admin page) will describe them in its own contract.
//! - **Hiding** with the reason `rights` holds every stage built on the hidden one (credit shown,
//!   audio not served); `withdrawn` leaves them playable. Both are computed when a chain is read, so
//!   clearing a hide restores everything with no job.

use crate::http::AppState;
use crate::problem::Problem;
use crate::publish::ApiJson;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use graft_domain::chain::HideReason;
use graft_domain::hash::Sha256Hash;
use graft_domain::ids::PublicationId;
use graft_domain::text;
use graft_storage::{ReportCategory, StageFlags, StoreError};
use serde::{Deserialize, Serialize};
use subtle::{Choice, ConstantTimeEq};
use utoipa::ToSchema;

/// Largest body these routes read.
pub const MAX_BODY_BYTES: usize = 2 * 1024;
/// Longest report note, in characters.
const MAX_NOTE_CHARS: usize = 500;
/// The header that carries the operator secret.
pub const ADMIN_HEADER: &str = "x-graft-admin-secret";
/// Shortest operator secret the service accepts at start-up.
pub const MIN_ADMIN_SECRET_LEN: usize = 24;

/// A request that a publication be looked at.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ReportRequest {
    /// Public id of the publication.
    pub publication_id: String,
    /// One of `rights`, `private_conversation`, `harmful`, `spam`, `other`.
    pub category: String,
    /// An optional short note for the operator, at most 500 characters. Never shown publicly.
    #[serde(default)]
    pub note: Option<String>,
}

/// The plain confirmation of a report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub struct ReportReceived {
    /// Always true: the report was stored.
    pub received: bool,
}

/// File a report about a publication. No account; no identity is collected.
#[utoipa::path(
    post,
    path = "/v1/reports",
    request_body = ReportRequest,
    responses(
        (status = 201, description = "The report was stored", body = ReportReceived),
        (status = 404, description = "No such publication", body = Problem, content_type = "application/problem+json"),
        (status = 422, description = "A field breaks a rule; `field` and `rule` say which", body = Problem, content_type = "application/problem+json"),
    )
)]
pub async fn file_report(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<ReportRequest>,
) -> Result<(axum::http::StatusCode, Json<ReportReceived>), Problem> {
    let category = ReportCategory::parse(&request.category).ok_or_else(|| {
        Problem::invalid(
            "category",
            "unknown",
            "the category must be one of rights, private_conversation, harmful, spam, other",
        )
    })?;
    let note = match request
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        None => None,
        Some(raw) => Some(
            text::clean(raw, MAX_NOTE_CHARS, &state.publish.extra_deny_words)
                .map_err(|e| {
                    Problem::invalid("note", e.rule(), format!("the note is not valid: {e}"))
                })?
                .value,
        ),
    };
    let id = PublicationId::parse(&request.publication_id)
        .map_err(|_| Problem::not_found("there is no publication with this id"))?;
    let stored = state
        .store
        .create_report(&id, category, note.as_deref())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "filing a report failed");
            Problem::internal()
        })?;
    if !stored {
        return Err(Problem::not_found("there is no publication with this id"));
    }
    Ok((
        axum::http::StatusCode::CREATED,
        Json(ReportReceived { received: true }),
    ))
}

/// Check the operator secret; the refusal is the same whatever is wrong.
fn authorize_admin(state: &AppState, headers: &HeaderMap) -> Result<(), Problem> {
    let provided = headers
        .get(ADMIN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| *Sha256Hash::of(v.as_bytes()).as_bytes());
    let configured = state.admin_secret_hash;
    // Always compare something, so an unconfigured service and a missing header cost the same as a
    // wrong secret.
    let a = provided.unwrap_or([0u8; 32]);
    let b = configured.unwrap_or([1u8; 32]);
    let ok = a.ct_eq(&b) & Choice::from(u8::from(provided.is_some() && configured.is_some()));
    if bool::from(ok) {
        Ok(())
    } else {
        Err(Problem::admin_refused())
    }
}

/// One report as the operator sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AdminReport {
    /// Report number.
    pub id: i64,
    /// The publication reported.
    pub publication_id: String,
    /// Why it was reported.
    pub category: String,
    /// The reporter's note, if any.
    pub note: Option<String>,
    /// When it was filed, milliseconds since the Unix epoch.
    pub created_at_ms: i64,
    /// The publication's title as typed.
    pub title: String,
    /// The maker's name as typed.
    pub author: String,
    /// The publication's state now: `visible`, `withdrawn` or `rights`.
    pub state: String,
}

/// The reports list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AdminReports {
    /// Newest first.
    pub reports: Vec<AdminReport>,
}

/// Query of the reports list.
#[derive(Debug, Deserialize)]
pub struct ReportsQuery {
    limit: Option<u32>,
}

/// List reports, newest first, each with its publication's current state.
pub async fn list_reports(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReportsQuery>,
) -> Result<Json<AdminReports>, Problem> {
    authorize_admin(&state, &headers)?;
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let rows = state.store.list_reports(limit).await.map_err(|e| {
        tracing::error!(error = %e, "listing reports failed");
        Problem::internal()
    })?;
    Ok(Json(AdminReports {
        reports: rows
            .into_iter()
            .map(|r| AdminReport {
                id: r.id,
                publication_id: r.publication_id.to_string(),
                category: r.category.as_str().to_owned(),
                note: r.note,
                created_at_ms: r.created_at_ms,
                title: r.title,
                author: r.author,
                state: r.hidden.map_or("visible", HideReason::as_str).to_owned(),
            })
            .collect(),
    }))
}

/// The decision to hide a publication.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HideRequest {
    /// `withdrawn` (descendants stay playable) or `rights` (descendants are held).
    pub reason: String,
}

/// A publication's state after an operator decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AdminState {
    /// The publication.
    pub id: String,
    /// `withdrawn`, `rights`, or null when it is visible.
    pub hidden: Option<String>,
    /// Whether new flips are allowed.
    pub fork_permitted: bool,
}

async fn decide(
    state: &AppState,
    id: &str,
    reason: Option<HideReason>,
) -> Result<Json<AdminState>, Problem> {
    let id = PublicationId::parse(id)
        .map_err(|_| Problem::not_found("there is no publication with this id"))?;
    if state
        .store
        .fork_flags(&id)
        .await
        .map_err(internal)?
        .is_none()
    {
        return Err(Problem::not_found("there is no publication with this id"));
    }
    let StageFlags {
        fork_permitted,
        hidden,
    } = state
        .store
        .set_hidden(&id, reason, state.publish.lock_wait)
        .await
        .map_err(internal)?;
    Ok(Json(AdminState {
        id: id.to_string(),
        hidden: hidden.map(|h| h.as_str().to_owned()),
        fork_permitted,
    }))
}

fn internal(e: StoreError) -> Problem {
    match e {
        StoreError::Busy => Problem::retry_later(),
        other => {
            tracing::error!(error = %other, "an operator decision failed");
            Problem::internal()
        }
    }
}

/// Hide a publication with a reason. Idempotent; replaces any earlier hide.
pub async fn hide(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<HideRequest>,
) -> Result<Json<AdminState>, Problem> {
    authorize_admin(&state, &headers)?;
    let reason = HideReason::parse(&request.reason).ok_or_else(|| {
        Problem::invalid(
            "reason",
            "unknown",
            "the reason must be withdrawn or rights",
        )
    })?;
    decide(&state, &id, Some(reason)).await
}

/// Clear a publication's hide, whoever made it. Idempotent.
pub async fn clear_hide(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<AdminState>, Problem> {
    authorize_admin(&state, &headers)?;
    decide(&state, &id, None).await
}

/// Middleware for the admin routes: the secret is checked before any query or body is looked at, so
/// every unauthorised request gets the identical refusal, whatever else is wrong with it.
pub async fn require_admin(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    match authorize_admin(&state, request.headers()) {
        Ok(()) => next.run(request).await,
        Err(problem) => problem.into_response(),
    }
}
