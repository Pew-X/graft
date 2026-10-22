//! The OpenAPI 3.1 document, generated from the handlers' annotations. The typed TypeScript client
//! is generated from the committed copy, and CI fails when the two drift.

use crate::problem::Problem;
use crate::routes;
use crate::views::{
    AudioView, ChainView, CutView, DetailsView, EntryView, LineView, RendererView, SpeedView,
    StageView,
};
use crate::{maker, publish};
use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "graft API",
        description = "Read a chain of stages, source first. Errors are RFC 9457 problem details.",
        version = "0.0.0"
    ),
    paths(
        routes::get_chain,
        routes::get_publication,
        publish::publish_flip,
        maker::set_fork_permission,
        maker::withdraw
    ),
    components(schemas(
        Problem,
        ChainView,
        EntryView,
        StageView,
        LineView,
        CutView,
        SpeedView,
        RendererView,
        DetailsView,
        AudioView
    ))
)]
struct ApiDoc;

/// The document as a JSON value.
#[must_use]
pub fn document() -> serde_json::Value {
    serde_json::to_value(ApiDoc::openapi()).unwrap_or_default()
}

/// The document as pretty-printed JSON with a trailing newline, as committed.
#[must_use]
pub fn pretty() -> String {
    let mut text = serde_json::to_string_pretty(&document()).unwrap_or_default();
    text.push('\n');
    text
}
