//! Read routes: a chain, a single publication, and the OpenAPI document.

use crate::http::AppState;
use crate::problem::Problem;
use crate::views::{self, AudioView, ChainView, EntryView};
use axum::Json;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use graft_domain::chain::{Entry, StoredStage};
use graft_domain::ids::PublicationId;
use graft_storage::StoreError;

fn internal(context: &str, error: &dyn std::fmt::Display) -> Problem {
    tracing::error!(%error, context, "request failed");
    Problem::internal()
}

fn not_found() -> Problem {
    // The same body for an id that is malformed and one that does not exist.
    Problem::not_found("there is no publication with this id")
}

async fn audio_for(state: &AppState, stage: &StoredStage) -> Result<AudioView, Problem> {
    let url = state
        .blobs
        .signed_url(stage.record.output_blob(), state.blob_url_ttl)
        .await
        .map_err(|e| internal("signing a blob url", &e))?;
    Ok(AudioView {
        url,
        expires_in_secs: state.blob_url_ttl.as_secs(),
    })
}

/// The chain ending at a publication, source first.
#[utoipa::path(
    get,
    path = "/v1/chains/{id}",
    params(("id" = String, Path, description = "Public id of the last stage of the chain")),
    responses(
        (status = 200, description = "The chain, source first", body = ChainView),
        (status = 404, description = "No such publication", body = Problem, content_type = "application/problem+json"),
    )
)]
pub async fn get_chain(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ChainView>, Problem> {
    let id = PublicationId::parse(&id).map_err(|_| not_found())?;
    let chain = state
        .store
        .chain(&id, state.limits.max_chain_depth)
        .await
        .map_err(|e: StoreError| internal("reading a chain", &e))?
        .ok_or_else(not_found)?;
    let mut views = Vec::with_capacity(chain.entries.len());
    for entry in &chain.entries {
        views.push(match entry {
            Entry::Present(stage) => {
                Some(views::stage_view(stage, audio_for(&state, stage).await?))
            }
            Entry::Unavailable(_) => None,
        });
    }
    Ok(Json(views::chain_view(&chain, views)))
}

/// One publication.
#[utoipa::path(
    get,
    path = "/v1/publications/{id}",
    params(("id" = String, Path, description = "Public id of the publication")),
    responses(
        (status = 200, description = "The publication, as one entry of a chain", body = EntryView),
        (status = 404, description = "No such publication", body = Problem, content_type = "application/problem+json"),
    )
)]
pub async fn get_publication(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<EntryView>, Problem> {
    let id = PublicationId::parse(&id).map_err(|_| not_found())?;
    let stage = state
        .store
        .publication(&id)
        .await
        .map_err(|e| internal("reading a publication", &e))?
        .ok_or_else(not_found)?;
    let view = views::stage_view(&stage, audio_for(&state, &stage).await?);
    Ok(Json(EntryView::Available(Box::new(view))))
}

/// The OpenAPI document for the public API.
pub async fn openapi() -> Response {
    Json(crate::openapi::document()).into_response()
}
