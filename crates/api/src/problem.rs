//! RFC 9457 problem details: every refusal is a JSON body with a stable `type`, a short `title`
//! and a human-readable `detail`. Nothing in a problem ever carries a secret or a path.

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use utoipa::ToSchema;

/// A problem-details document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct Problem {
    /// A URI naming the kind of problem; stable, so clients can switch on it.
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// A short summary of the kind.
    pub title: &'static str,
    /// The HTTP status.
    pub status: u16,
    /// What went wrong this time, for a person.
    pub detail: String,
}

impl Problem {
    /// 404: no such publication, or no such route.
    #[must_use]
    pub fn not_found(detail: impl Into<String>) -> Self {
        Self {
            kind: "urn:graft:problem:not-found",
            title: "Not found",
            status: 404,
            detail: detail.into(),
        }
    }

    /// 400: the request could not be understood.
    #[must_use]
    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self {
            kind: "urn:graft:problem:bad-request",
            title: "Bad request",
            status: 400,
            detail: detail.into(),
        }
    }

    /// 405: the method is not allowed on this route.
    #[must_use]
    pub fn method_not_allowed() -> Self {
        Self {
            kind: "urn:graft:problem:method-not-allowed",
            title: "Method not allowed",
            status: 405,
            detail: "this route does not accept that method".to_owned(),
        }
    }

    /// 500: something failed on our side. The detail never carries internals.
    #[must_use]
    pub fn internal() -> Self {
        Self {
            kind: "urn:graft:problem:internal",
            title: "Something went wrong",
            status: 500,
            detail: "the service failed to answer; nothing was changed".to_owned(),
        }
    }

    /// 503: the service is up but cannot do this right now.
    #[must_use]
    pub fn unavailable(detail: impl Into<String>) -> Self {
        Self {
            kind: "urn:graft:problem:unavailable",
            title: "Unavailable",
            status: 503,
            detail: detail.into(),
        }
    }
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let body = serde_json::to_vec(&self).unwrap_or_default();
        let mut response = (status, body).into_response();
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/problem+json"),
        );
        response
    }
}
