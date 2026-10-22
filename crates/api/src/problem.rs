//! RFC 9457 problem details: every refusal is a JSON body with a stable `type`, a short `title`
//! and a human-readable `detail`. Nothing in a problem ever carries a secret or a path.

use axum::http::{HeaderName, HeaderValue, StatusCode, header};
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
    /// The request field the problem is about, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<&'static str>,
    /// A stable name for the rule that refused it, such as `too_long` or `inverted`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<&'static str>,
    /// Seconds to wait before trying again, when waiting helps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_secs: Option<u32>,
}

impl Problem {
    fn base(
        kind: &'static str,
        title: &'static str,
        status: u16,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            title,
            status,
            detail: detail.into(),
            field: None,
            rule: None,
            retry_after_secs: None,
        }
    }

    /// 404: no such publication, or no such route.
    #[must_use]
    pub fn not_found(detail: impl Into<String>) -> Self {
        Self::base("urn:graft:problem:not-found", "Not found", 404, detail)
    }

    /// 400: the request could not be understood.
    #[must_use]
    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self::base("urn:graft:problem:bad-request", "Bad request", 400, detail)
    }

    /// 405: the method is not allowed on this route.
    #[must_use]
    pub fn method_not_allowed() -> Self {
        Self::base(
            "urn:graft:problem:method-not-allowed",
            "Method not allowed",
            405,
            "this route does not accept that method",
        )
    }

    /// 413: the request body is larger than this route accepts.
    #[must_use]
    pub fn too_large() -> Self {
        Self::base(
            "urn:graft:problem:too-large",
            "Request too large",
            413,
            "the request body is larger than this route accepts",
        )
    }

    /// 500: something failed on our side. The detail never carries internals.
    #[must_use]
    pub fn internal() -> Self {
        Self::base(
            "urn:graft:problem:internal",
            "Something went wrong",
            500,
            "the service failed to answer; nothing was changed",
        )
    }

    /// 503: the service is up but cannot do this right now.
    #[must_use]
    pub fn unavailable(detail: impl Into<String>) -> Self {
        Self::base("urn:graft:problem:unavailable", "Unavailable", 503, detail)
    }

    /// 422: one field of the request breaks a rule. `rule` names which, so a form can say what to fix.
    #[must_use]
    pub fn invalid(field: &'static str, rule: &'static str, detail: impl Into<String>) -> Self {
        Self {
            field: Some(field),
            rule: Some(rule),
            ..Self::base(
                "urn:graft:problem:invalid-field",
                "A field is not valid",
                422,
                detail,
            )
        }
    }

    /// 403: the maker of the stage has closed it to new flips.
    #[must_use]
    pub fn fork_not_permitted() -> Self {
        Self::base(
            "urn:graft:problem:fork-not-permitted",
            "Flips are closed",
            403,
            "the maker of this stage does not allow new flips of it",
        )
    }

    /// 403: the manage key was not accepted. The same answer for a wrong key, a missing key, a
    /// publication that does not exist and one that has no key, so the refusal says nothing about
    /// which of those it was.
    #[must_use]
    pub fn manage_key_refused() -> Self {
        Self::base(
            "urn:graft:problem:manage-key-refused",
            "Manage key not accepted",
            403,
            "the manage key was not accepted for this publication",
        )
    }

    /// 409: the stage is hidden, so nothing can be built on it.
    #[must_use]
    pub fn parent_unavailable() -> Self {
        Self::base(
            "urn:graft:problem:parent-unavailable",
            "This stage is no longer here",
            409,
            "this stage is hidden, so it cannot be flipped",
        )
    }

    /// 409: the chain is already as deep as it may be.
    #[must_use]
    pub fn depth_cap(max: u32) -> Self {
        Self::base(
            "urn:graft:problem:depth-cap",
            "The chain is as long as it can be",
            409,
            format!("a chain holds at most {max} stages, and this one is already that long"),
        )
    }

    /// 429: this stage was flipped too often in the last hour.
    #[must_use]
    pub fn fork_cap(limit: u32) -> Self {
        Self {
            retry_after_secs: Some(600),
            ..Self::base(
                "urn:graft:problem:fork-cap",
                "Too many flips of this stage",
                429,
                format!(
                    "this stage can be flipped {limit} times an hour, and that many have been; try again later"
                ),
            )
        }
    }

    /// 409: the retry key was already used for different content.
    #[must_use]
    pub fn key_conflict() -> Self {
        Self::base(
            "urn:graft:problem:key-conflict",
            "Retry key already used",
            409,
            "this retry key belongs to a different flip; use a new key for a new flip",
        )
    }

    /// 503: concurrent work kept conflicting. Nothing was written; the same request can be repeated
    /// with the same retry key.
    #[must_use]
    pub fn retry_later() -> Self {
        Self {
            retry_after_secs: Some(1),
            ..Self::base(
                "urn:graft:problem:retry-later",
                "Busy, try again",
                503,
                "the service was too busy to finish this; nothing was changed, so send the same request again",
            )
        }
    }
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let retry_after = self.retry_after_secs;
        let body = serde_json::to_vec(&self).unwrap_or_default();
        let mut response = (status, body).into_response();
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/problem+json"),
        );
        if let Some(Ok(v)) = retry_after.map(|secs| HeaderValue::from_str(&secs.to_string())) {
            headers.insert(HeaderName::from_static("retry-after"), v);
        }
        response
    }
}
