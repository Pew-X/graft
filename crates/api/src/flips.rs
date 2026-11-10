//! The flips of a stage: the available flips whose parent is one publication, newest first, a page
//! at a time. It reads the same availability rule as the chain read (a flip is listed exactly when
//! its own chain read would call it available), so a withdrawn or hidden flip is never listed and a
//! rights hide on the stage or above it lists nothing.

use crate::http::AppState;
use crate::problem::Problem;
use crate::routes::store_problem;
use crate::views::{CutView, SpeedView};
use axum::Json;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use graft_domain::chain::{StoredStage, holds_flips};
use graft_domain::ids::PublicationId;
use graft_storage::FlipsAfter;
use serde::Serialize;
use std::collections::HashMap;
use utoipa::ToSchema;

/// A page holds this many flips unless the request asks for fewer.
pub const DEFAULT_PAGE: u32 = 24;
/// A page never holds more than this.
pub const MOST_PER_PAGE: u32 = 50;
/// A cursor is short: anything longer is not one of ours.
const CURSOR_MAX_LEN: usize = 120;
const CURSOR_VERSION: &str = "f1";

/// One flip of a stage, as the list shows it. No audio and nothing private: the flip's own page
/// gives its audio, and no manage key or hash of one is ever part of this shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct FlipItem {
    /// Public id of the flip.
    pub id: String,
    /// Title as typed.
    pub title: String,
    /// Maker's name as typed. Plain text, never a handle.
    pub author: String,
    /// Creation time, milliseconds since the Unix epoch.
    pub created_at_ms: i64,
    /// The cut of the parent, computed.
    pub cut: CutView,
    /// The speed, computed.
    pub speed: SpeedView,
    /// How many frames of 48 kHz audio the flip comes out as, computed.
    pub frames: u32,
}

/// A page of the flips of a stage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct FlipsView {
    /// How many flips of the stage are listed in all (not hidden).
    pub total: u64,
    /// This page, newest first.
    pub flips: Vec<FlipItem>,
    /// Pass this as `cursor` to read the page after this one; absent on the last page.
    pub next: Option<String>,
}

/// The flips of a stage, newest first.
#[utoipa::path(
    get,
    path = "/v1/publications/{id}/flips",
    params(
        ("id" = String, Path, description = "Public id of the stage"),
        ("limit" = Option<u32>, Query, description = "Flips per page: 1 to 50, 24 when absent"),
        ("cursor" = Option<String>, Query, description = "The `next` of the page before; made for this stage only"),
    ),
    responses(
        (status = 200, description = "A page of the stage's flips", body = FlipsView),
        (status = 400, description = "A limit out of range, or a cursor that is not this stage's", body = Problem, content_type = "application/problem+json"),
        (status = 404, description = "No such publication", body = Problem, content_type = "application/problem+json"),
    )
)]
pub async fn get_flips(
    State(state): State<AppState>,
    Path(id): Path<String>,
    query: Result<Query<HashMap<String, String>>, QueryRejection>,
) -> Result<Response, Problem> {
    // The same body for an id that is malformed and one that does not exist.
    let not_found = || Problem::not_found("there is no publication with this id");
    let parent = PublicationId::parse(&id).map_err(|_| not_found())?;
    let Query(params) =
        query.map_err(|_| Problem::bad_request("the query of this request could not be read"))?;
    let limit = parse_limit(params.get("limit").map(String::as_str))?;
    let after = match params.get("cursor") {
        Some(text) => Some(parse_cursor(text, &parent)?),
        None => None,
    };
    // The chain of the parent, to the depth a flip's own chain read would give it, so a rights hide
    // is seen from here exactly where the chain read of a flip would see it.
    let chain = state
        .store
        .chain(
            &parent,
            state.limits.max_chain_depth.saturating_sub(1).max(1),
        )
        .await
        .map_err(|e| store_problem("reading the chain of a stage", &e))?
        .ok_or_else(not_found)?;
    let view = if holds_flips(&chain) {
        // every flip of a held stage is held too: nothing is listed
        FlipsView {
            total: 0,
            flips: Vec::new(),
            next: None,
        }
    } else {
        // one more than the page, to know whether there is a next
        let page = state
            .store
            .flips_of(&parent, after.as_ref(), limit + 1)
            .await
            .map_err(|e| store_problem("reading the flips of a stage", &e))?;
        let more = page.flips.len() > limit as usize;
        let shown: Vec<_> = page.flips.into_iter().take(limit as usize).collect();
        let next = if more {
            shown
                .last()
                .map(|(stage, created_us)| cursor_for(&parent, *created_us, stage))
        } else {
            None
        };
        FlipsView {
            total: page.total,
            flips: shown.iter().filter_map(|(stage, _)| item(stage)).collect(),
            next,
        }
    };
    let mut response = Json(view).into_response();
    // A short hold: a list of flips changes as people publish, and a page that was just published
    // to should not be shown stale for long.
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3"),
    );
    Ok(response)
}

fn parse_limit(text: Option<&str>) -> Result<u32, Problem> {
    let Some(text) = text else {
        return Ok(DEFAULT_PAGE);
    };
    match text.parse::<u32>() {
        Ok(n) if (1..=MOST_PER_PAGE).contains(&n) => Ok(n),
        _ => Err(Problem::bad_request(format!(
            "limit is a whole number from 1 to {MOST_PER_PAGE}"
        ))),
    }
}

/// `f1.<stage>.<creation microseconds>.<last id>`: opaque to a client. It names the stage it was
/// made for, so a cursor of another stage is refused rather than read as a position here.
fn cursor_for(parent: &PublicationId, created_us: i64, last: &StoredStage) -> String {
    format!("{CURSOR_VERSION}.{parent}.{created_us}.{}", last.id)
}

fn parse_cursor(text: &str, parent: &PublicationId) -> Result<FlipsAfter, Problem> {
    let bad = || Problem::bad_request("this cursor is not one this stage gave");
    if text.len() > CURSOR_MAX_LEN || !text.is_ascii() {
        return Err(bad());
    }
    let parts: Vec<&str> = text.split('.').collect();
    let [version, stage, micros, last] = parts.as_slice() else {
        return Err(bad());
    };
    if *version != CURSOR_VERSION || *stage != parent.as_str() {
        return Err(bad());
    }
    if micros.is_empty() || micros.len() > 18 || !micros.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    let created_us: i64 = micros.parse().map_err(|_| bad())?;
    let id = PublicationId::parse(last).map_err(|_| bad())?;
    Ok(FlipsAfter { created_us, id })
}

fn item(stage: &StoredStage) -> Option<FlipItem> {
    let record = &stage.record;
    let transform = record.transform()?;
    let cut = record.cut();
    Some(FlipItem {
        id: stage.id.to_string(),
        title: stage.title.clone(),
        author: stage.author.clone(),
        created_at_ms: stage.created_at_ms,
        cut: CutView {
            start: cut.start,
            end: cut.end,
        },
        speed: SpeedView {
            p: transform.p,
            q: transform.q,
            method: transform.method,
        },
        frames: output_frames(cut.len(), transform.p, transform.q),
    })
}

/// How many frames the renderer makes from a cut of `length` frames at speed p/q:
/// floor((length - 1) * q / p) + 1. The record's limits keep every term far inside 64 bits.
#[must_use]
pub fn output_frames(length: u32, p: u32, q: u32) -> u32 {
    if p == 0 {
        return 0;
    }
    let steps = u64::from(length.saturating_sub(1)) * u64::from(q) / u64::from(p);
    u32::try_from(steps + 1).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parent() -> PublicationId {
        PublicationId::seeded("seed:parent")
    }

    #[test]
    fn output_length_follows_the_renderer_rule() {
        assert_eq!(output_frames(24_000, 3, 2), 16_000);
        assert_eq!(output_frames(24_000, 1, 1), 24_000);
        assert_eq!(output_frames(24_000, 1, 2), 47_999);
        assert_eq!(output_frames(1, 4, 1), 1);
    }

    #[test]
    fn the_limit_is_one_to_fifty_and_defaults_to_a_page() {
        assert_eq!(parse_limit(None).expect("default"), DEFAULT_PAGE);
        assert_eq!(parse_limit(Some("1")).expect("one"), 1);
        assert_eq!(parse_limit(Some("50")).expect("fifty"), 50);
        for bad in ["0", "51", "-1", "abc", "", "1.5", "99999999999999999999"] {
            assert!(parse_limit(Some(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_cursor_round_trips_and_only_for_its_own_stage() {
        let p = parent();
        let last = PublicationId::seeded("seed:last");
        let text = format!("f1.{p}.1700000000123456.{last}");
        let after = parse_cursor(&text, &p).expect("parses");
        assert_eq!(after.created_us, 1_700_000_000_123_456);
        assert_eq!(after.id, last);
        let other = PublicationId::seeded("seed:other");
        assert!(
            parse_cursor(&text, &other).is_err(),
            "a foreign cursor is refused"
        );
    }

    #[test]
    fn a_malformed_cursor_is_refused_never_read_as_a_position() {
        let p = parent();
        let last = PublicationId::seeded("seed:last");
        for bad in [
            String::new(),
            "f1".to_owned(),
            format!("f2.{p}.1.{last}"),
            format!("f1.{p}.-1.{last}"),
            format!("f1.{p}.1e9.{last}"),
            format!("f1.{p}..{last}"),
            format!("f1.{p}.1.{last}.extra"),
            format!("f1.{p}.1.NOTANID"),
            format!("f1.{p}.9999999999999999999.{last}"),
            "é".repeat(80),
            "x".repeat(CURSOR_MAX_LEN + 1),
        ] {
            assert!(parse_cursor(&bad, &p).is_err(), "{bad:?}");
        }
    }
}
