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

/// The error a request body ends with when it did not finish arriving in time. Extractors look for
/// it in what a failed read reports, so that a stalled client is answered with a timeout.
#[derive(Debug)]
pub struct BodyTimedOut;

impl std::fmt::Display for BodyTimedOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the request body did not arrive in time")
    }
}

impl std::error::Error for BodyTimedOut {}

/// Whether a failed read of a request body failed because it timed out, looking through the
/// causes the extractors wrap it in.
#[must_use]
pub fn body_timed_out(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(e) = current {
        if e.is::<BodyTimedOut>() {
            return true;
        }
        current = e.source();
    }
    false
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

    /// 408: the request took too long to arrive or to answer.
    #[must_use]
    pub fn request_timeout() -> Self {
        Self::base(
            "urn:graft:problem:request-timeout",
            "Request timeout",
            408,
            "the request took too long; send it again",
        )
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

    /// 403: the operator secret was not accepted, or admin access is not configured. The same
    /// answer for both, so the refusal does not reveal whether admin access exists.
    #[must_use]
    pub fn admin_refused() -> Self {
        Self::base(
            "urn:graft:problem:admin-refused",
            "Not accepted",
            403,
            "this request was not accepted",
        )
    }

    /// 409: the stage is held while a rights concern about one of its ancestors stands.
    #[must_use]
    pub fn parent_held() -> Self {
        Self::base(
            "urn:graft:problem:parent-held",
            "This stage is held",
            409,
            "this stage is held while a rights concern about one of its ancestors is open, so it cannot be flipped",
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

    /// 503: the operator has closed publishing. Reads and plays are unaffected.
    #[must_use]
    pub fn publishing_off() -> Self {
        Self::base(
            "urn:graft:problem:publishing-off",
            "Publishing is switched off",
            503,
            "publishing is switched off for now; everything already published still plays, and you can try again later",
        )
    }

    /// 503: visitor uploads are not open yet.
    #[must_use]
    pub fn uploads_off() -> Self {
        Self::base(
            "urn:graft:problem:uploads-off",
            "Uploads are switched off",
            503,
            "uploads are switched off for now; you can still flip the sounds that are already here",
        )
    }

    /// 429: this visitor has done this too often within the window.
    #[must_use]
    pub fn rate_limited(retry_after_secs: u32) -> Self {
        Self {
            retry_after_secs: Some(retry_after_secs),
            ..Self::base(
                "urn:graft:problem:rate-limited",
                "Slow down a little",
                429,
                format!("you have done this a lot lately; try again in {retry_after_secs} seconds"),
            )
        }
    }

    /// 429: everyone together have published as much as is admitted for now.
    #[must_use]
    pub fn publish_cap(retry_after_secs: u64) -> Self {
        let wait = u32::try_from(retry_after_secs).unwrap_or(u32::MAX);
        Self {
            retry_after_secs: Some(wait),
            ..Self::base(
                "urn:graft:problem:publish-cap",
                "Publishing is at its limit for now",
                429,
                format!(
                    "a lot has been published in a short time and new publishes are paused briefly; try again in {wait} seconds"
                ),
            )
        }
    }

    /// 503: the audio store has reached its admission threshold.
    #[must_use]
    pub fn storage_full() -> Self {
        Self::base(
            "urn:graft:problem:storage-full",
            "No room for new sounds right now",
            503,
            "there is no room for new publications right now; everything already published still plays",
        )
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
