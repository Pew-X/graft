//! Read routes: a chain, a single publication, and the OpenAPI document.

use crate::http::AppState;
use crate::problem::Problem;
use crate::views::{self, AudioView, ChainView, EntryView};
use axum::Json;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use graft_domain::chain::{Availability, Chain, Entry, HideReason, StoredStage, availability};
use graft_domain::ids::PublicationId;
use graft_storage::StoreError;

fn internal(context: &str, error: &dyn std::fmt::Display) -> Problem {
    tracing::error!(%error, context, "request failed");
    Problem::internal()
}

/// A failed database call: a pool or lock that stayed busy is a retryable 503, anything else is ours.
pub(crate) fn store_problem(context: &str, error: &StoreError) -> Problem {
    match error {
        StoreError::Busy => Problem::retry_later(),
        StoreError::NotFound => Problem::not_found("there is no publication with this id"),
        other => internal(context, other),
    }
}

fn not_found() -> Problem {
    // The same body for an id that is malformed and one that does not exist.
    Problem::not_found("there is no publication with this id")
}

pub(crate) async fn audio_for(state: &AppState, stage: &StoredStage) -> Result<AudioView, Problem> {
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
        .map_err(|e: StoreError| store_problem("reading a chain", &e))?
        .ok_or_else(not_found)?;
    let entries = entry_views(&state, &chain).await?;
    Ok(Json(views::chain_view(&chain, entries)))
}

/// One view per entry of the chain. A hidden stage gets no audio URL: new requests for its audio
/// are refused by never issuing one.
async fn entry_views(state: &AppState, chain: &Chain) -> Result<Vec<EntryView>, Problem> {
    let availability = availability(chain);
    let mut views = Vec::with_capacity(chain.entries.len());
    for index in 0..chain.entries.len() {
        views.push(entry_view_at(state, chain, &availability, index).await?);
    }
    Ok(views)
}

/// The view of the entry at `index`, decided by the one availability rule. Only an available stage
/// gets an audio URL, so only an available stage costs a signing.
async fn entry_view_at(
    state: &AppState,
    chain: &Chain,
    availability: &[Option<Availability>],
    index: usize,
) -> Result<EntryView, Problem> {
    let (Some(entry), Some(available)) = (chain.entries.get(index), availability.get(index)) else {
        return Err(internal(
            "building a view",
            &"an entry index is out of range",
        ));
    };
    Ok(match (entry, available) {
        (Entry::Present(stage), Some(Availability::Available)) => EntryView::Available(Box::new(
            views::stage_view(stage, audio_for(state, stage).await?),
        )),
        (Entry::Present(stage), Some(Availability::NoLongerHere(reason))) => {
            EntryView::NoLongerHere(Box::new(views::removed_view(stage, *reason)))
        }
        (Entry::Present(stage), Some(Availability::Held)) => {
            // Held because of a rights hide above it: the reason shown is that one.
            EntryView::Held(Box::new(views::removed_view(stage, HideReason::Rights)))
        }
        (Entry::Present(stage), None) => EntryView::Unavailable {
            id: stage.id.to_string(),
        },
        (Entry::Unavailable(id), _) => EntryView::Unavailable { id: id.to_string() },
    })
}

/// The view of one publication as every read shows it: its chain is read, the availability rule is
/// applied, and only the requested stage is built.
pub(crate) async fn publication_view(
    state: &AppState,
    id: &PublicationId,
) -> Result<Option<EntryView>, Problem> {
    let Some(chain) = state
        .store
        .chain(id, state.limits.max_chain_depth)
        .await
        .map_err(|e| store_problem("reading a publication", &e))?
    else {
        return Ok(None);
    };
    let availability = availability(&chain);
    let last = chain.entries.len().saturating_sub(1);
    Ok(Some(
        entry_view_at(state, &chain, &availability, last).await?,
    ))
}

/// What the service is open for right now: publishing (the kill switch) and visitors' own sources.
/// Two booleans and nothing else, so a page can say a door is closed before anything is sent
/// through it.
#[utoipa::path(
    get,
    path = "/v1/features",
    responses((status = 200, description = "Whether publishing and uploads are open", body = crate::moderation::SwitchView))
)]
pub async fn get_features(state: State<AppState>) -> axum::Json<crate::moderation::SwitchView> {
    crate::moderation::get_switch(state).await
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
    publication_view(&state, &id)
        .await?
        .map(Json)
        .ok_or_else(not_found)
}

/// The OpenAPI document for the public API.
pub async fn openapi() -> Response {
    Json(crate::openapi::document()).into_response()
}
