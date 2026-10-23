//! What a maker can do to their own publication without an account: close or reopen it to new
//! flips, and withdraw it. The only credential is the manage key shown once when the publication
//! was created. It is not an identity: it grants these two actions on that one publication and
//! nothing else, and losing it means only that the flags can no longer be changed.
//!
//! The key travels in the `X-Graft-Manage-Key` header, never in a URL or a body, and is never
//! logged. Only its SHA-256 is stored; the comparison is constant-time, and every way of being
//! refused (no key, a malformed key, a wrong key, another publication's key, a publication that does
//! not exist, one that has no key) gets the identical response.

use crate::http::AppState;
use crate::problem::Problem;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Uri};
use graft_domain::hash::Sha256Hash;
use graft_domain::ids::PublicationId;
use graft_storage::{StageFlags, StoreError};
use serde::{Deserialize, Serialize};
use subtle::{Choice, ConstantTimeEq};
use utoipa::ToSchema;

/// Largest body these routes read.
pub const MAX_BODY_BYTES: usize = 1024;

/// The header that carries the manage key.
pub const MANAGE_KEY_HEADER: &str = "x-graft-manage-key";

/// Close or reopen a stage to new flips.
#[derive(Debug, Clone, Copy, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ForkPermissionRequest {
    /// True to allow new flips of this stage, false to close it. Existing flips are untouched.
    pub permitted: bool,
}

/// The state of a stage after a maker action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub struct MakerState {
    /// Whether new flips of this stage are allowed.
    pub fork_permitted: bool,
    /// Whether the stage is hidden (withdrawn).
    pub withdrawn: bool,
}

impl From<StageFlags> for MakerState {
    fn from(f: StageFlags) -> Self {
        Self {
            fork_permitted: f.fork_permitted,
            withdrawn: f.hidden.is_some(),
        }
    }
}

/// Check the manage key for `id`; the refusal is the same whatever is wrong.
async fn authorize(
    state: &AppState,
    id: &str,
    headers: &HeaderMap,
    uri: &Uri,
) -> Result<PublicationId, Problem> {
    // A key in the address would end up in logs, histories and referrers: refuse it outright.
    if uri.query().is_some_and(|q| {
        let q = q.to_ascii_lowercase();
        q.contains("manage") || q.contains("key")
    }) {
        return Err(Problem::bad_request(
            "send the manage key in the X-Graft-Manage-Key header, never in the address",
        ));
    }
    let provided = headers
        .get(MANAGE_KEY_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|k| k.len() == 64 && k.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(|k| *Sha256Hash::of(k.as_bytes()).as_bytes());
    let parsed = PublicationId::parse(id).ok();
    let stored = match &parsed {
        Some(id) => state.store.manage_key_hash(id).await.map_err(|e| {
            tracing::error!(error = %e, "reading a manage key hash failed");
            Problem::internal()
        })?,
        None => None,
    };
    // Always compare something, so a missing key or publication costs the same as a wrong key.
    let provided_or_dummy = provided.unwrap_or([0u8; 32]);
    let stored_or_dummy = stored.unwrap_or([0u8; 32]);
    let equal = provided_or_dummy.ct_eq(&stored_or_dummy);
    let ok = equal & Choice::from(u8::from(provided.is_some() && stored.is_some()));
    match (bool::from(ok), parsed) {
        (true, Some(id)) => Ok(id),
        _ => Err(Problem::manage_key_refused()),
    }
}

fn store_problem(e: &StoreError) -> Problem {
    match e {
        StoreError::Busy => Problem::retry_later(),
        other => {
            tracing::error!(error = %other, "a maker action failed");
            Problem::internal()
        }
    }
}

/// Close or reopen a stage to new flips. Existing flips and rolls are untouched.
#[utoipa::path(
    put,
    path = "/v1/publications/{id}/fork-permission",
    params(
        ("id" = String, Path, description = "Public id of the publication"),
        ("x-graft-manage-key" = String, Header, description = "The manage key shown once when the publication was created"),
    ),
    request_body = ForkPermissionRequest,
    responses(
        (status = 200, description = "The stage after the change; repeating the request changes nothing", body = MakerState),
        (status = 403, description = "The manage key was not accepted (the same answer for every reason)", body = Problem, content_type = "application/problem+json"),
        (status = 503, description = "Busy; send the same request again", body = Problem, content_type = "application/problem+json"),
    )
)]
pub async fn set_fork_permission(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
    body: axum::body::Body,
) -> Result<Json<MakerState>, Problem> {
    let id = authorize(&state, &id, &headers, &uri).await?;
    // The body is read only after the key is accepted, so a refusal never depends on it (and a
    // body of any size gets the same answer as a body of none), and it is read to a bound.
    let body = axum::body::to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| Problem::too_large())?;
    let request: ForkPermissionRequest = serde_json::from_slice(&body).map_err(|_| {
        Problem::bad_request("the body must be JSON with exactly the documented fields")
    })?;
    let flags = state
        .store
        .set_fork_permission(&id, request.permitted, state.publish.lock_wait)
        .await
        .map_err(|e| store_problem(&e))?;
    Ok(Json(flags.into()))
}

/// Withdraw a publication. It stays in every chain as "no longer here" with its credit; its audio
/// is no longer served; stages built on it stay playable. Only the operator can undo it.
#[utoipa::path(
    post,
    path = "/v1/publications/{id}/withdraw",
    params(
        ("id" = String, Path, description = "Public id of the publication"),
        ("x-graft-manage-key" = String, Header, description = "The manage key shown once when the publication was created"),
    ),
    responses(
        (status = 200, description = "The stage after the change; repeating the request changes nothing", body = MakerState),
        (status = 403, description = "The manage key was not accepted (the same answer for every reason)", body = Problem, content_type = "application/problem+json"),
        (status = 503, description = "Busy; send the same request again", body = Problem, content_type = "application/problem+json"),
    )
)]
pub async fn withdraw(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Json<MakerState>, Problem> {
    let id = authorize(&state, &id, &headers, &uri).await?;
    let flags = state
        .store
        .withdraw(&id, state.publish.lock_wait)
        .await
        .map_err(|e| store_problem(&e))?;
    Ok(Json(flags.into()))
}
