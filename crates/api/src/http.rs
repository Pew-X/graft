//! The HTTP surface: routing, request ids, security headers, CORS, health, readiness and metrics.

use crate::config::Config;
use crate::metrics::Metrics;
use crate::problem::Problem;
use axum::extract::{MatchedPath, Request, State};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::Instrument;

/// A boxed future, so the readiness check can be a trait object without an extra crate.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Whether the service can do its job right now: the database answers.
pub trait Readiness: Send + Sync {
    /// Ok when ready; Err carries a short reason that is safe to log, never a connection string.
    fn check(&self) -> BoxFuture<'_, Result<(), String>>;
}

/// Shared state for every handler.
#[derive(Clone)]
pub struct AppState {
    /// Readiness probe.
    pub readiness: Arc<dyn Readiness>,
    /// Request metrics.
    pub metrics: Arc<Metrics>,
}

/// Build the router with all middleware.
pub fn router(state: AppState, config: &Config) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/metrics", get(metrics))
        .fallback(|| async { Problem::not_found("there is nothing at this address") })
        .method_not_allowed_fallback(|| async { Problem::method_not_allowed() })
        .layer(middleware::from_fn_with_state(state.clone(), observe))
        .layer(cors(config))
        .with_state(state)
}

fn cors(config: &Config) -> CorsLayer {
    let origins: Vec<HeaderValue> = config
        .cors_origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();
    // No configured origin means no cross-origin access: the layer allows nothing.
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([
            header::CONTENT_TYPE,
            HeaderName::from_static("x-graft-manage-key"),
        ])
        .max_age(std::time::Duration::from_secs(600))
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}

async fn ready(State(state): State<AppState>) -> Response {
    match state.readiness.check().await {
        Ok(()) => Json(json!({ "status": "ready" })).into_response(),
        Err(reason) => {
            tracing::warn!(%reason, "readiness check failed");
            Problem::unavailable("the service cannot reach its database right now").into_response()
        }
    }
}

async fn metrics(State(state): State<AppState>) -> Response {
    let mut response = state.metrics.render().into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
    );
    response
}

/// Request id, tracing span, metrics and security headers for every response.
async fn observe(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let request_id = new_request_id();
    let method = request.method().to_string();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| "unmatched".to_owned(), |p| p.as_str().to_owned());
    let span = tracing::info_span!("request", %request_id, %method, route = %route);
    let started = Instant::now();
    let mut response = next.run(request).instrument(span.clone()).await;
    let status = response.status();
    let elapsed = started.elapsed().as_secs_f64();
    state
        .metrics
        .observe(&method, &route, status.as_u16(), elapsed);
    span.in_scope(|| {
        tracing::info!(
            status = status.as_u16(),
            elapsed_ms = elapsed * 1000.0,
            "request finished"
        )
    });
    let headers = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&request_id) {
        headers.insert(HeaderName::from_static("x-request-id"), v);
    }
    // The API serves JSON and signed-URL redirects only: nothing may be framed, sniffed or cached.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    response
}

fn new_request_id() -> String {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return "unknown".to_owned();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The status code a handler error maps to, for tests and logging.
#[must_use]
pub fn status_of(problem: &Problem) -> StatusCode {
    StatusCode::from_u16(problem.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    struct Ok_;
    impl Readiness for Ok_ {
        fn check(&self) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
    }

    struct Down;
    impl Readiness for Down {
        fn check(&self) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async {
                Err("connection refused to postgres://user:secret@db/graft".to_owned())
            })
        }
    }

    fn config() -> Config {
        Config::from_lookup(|n| (n == "GRAFT_DATABASE_URL").then(|| "postgres://x".to_owned()))
            .expect("valid config")
    }

    fn app(readiness: Arc<dyn Readiness>) -> (Router, Arc<Metrics>) {
        let metrics = Arc::new(Metrics::default());
        (
            router(
                AppState {
                    readiness,
                    metrics: metrics.clone(),
                },
                &config(),
            ),
            metrics,
        )
    }

    async fn call(
        app: &Router,
        method: &str,
        uri: &str,
    ) -> (StatusCode, axum::http::HeaderMap, String) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .expect("request");
        let response = app.clone().oneshot(request).await.expect("response");
        let (parts, body) = response.into_parts();
        let bytes = body.collect().await.expect("body").to_bytes();
        (
            parts.status,
            parts.headers,
            String::from_utf8_lossy(&bytes).into_owned(),
        )
    }

    #[tokio::test]
    async fn health_answers_without_touching_the_database() {
        let (app, _) = app(Arc::new(Down));
        let (status, _, body) = call(&app, "GET", "/health").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("ok"));
    }

    #[tokio::test]
    async fn readiness_is_503_when_the_database_is_unreachable_and_leaks_nothing() {
        let (app, _) = app(Arc::new(Down));
        let (status, headers, body) = call(&app, "GET", "/ready").await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(headers[header::CONTENT_TYPE], "application/problem+json");
        assert!(
            !body.contains("secret") && !body.contains("postgres://"),
            "body was {body}"
        );
    }

    #[tokio::test]
    async fn readiness_is_200_when_the_database_answers() {
        let (app, _) = app(Arc::new(Ok_));
        assert_eq!(call(&app, "GET", "/ready").await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn every_response_carries_a_request_id_and_the_security_headers() {
        let (app, _) = app(Arc::new(Ok_));
        let (_, headers, _) = call(&app, "GET", "/health").await;
        assert_eq!(headers["x-request-id"].len(), 16);
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
        assert!(
            headers[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .expect("ascii")
                .contains("frame-ancestors 'none'")
        );
        let (_, other, _) = call(&app, "GET", "/health").await;
        assert_ne!(
            headers["x-request-id"], other["x-request-id"],
            "ids are not reused"
        );
    }

    #[tokio::test]
    async fn unknown_routes_and_wrong_methods_are_problem_details() {
        let (app, _) = app(Arc::new(Ok_));
        let (status, headers, body) = call(&app, "GET", "/nope").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(headers[header::CONTENT_TYPE], "application/problem+json");
        assert!(body.contains("urn:graft:problem:not-found"));
        let (status, _, body) = call(&app, "POST", "/health").await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert!(body.contains("urn:graft:problem:method-not-allowed"));
    }

    #[tokio::test]
    async fn the_metrics_endpoint_exposes_request_count_and_latency_by_route() {
        let (app, _) = app(Arc::new(Ok_));
        call(&app, "GET", "/health").await;
        call(&app, "GET", "/health").await;
        let (status, headers, body) = call(&app, "GET", "/metrics").await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            headers[header::CONTENT_TYPE]
                .to_str()
                .expect("ascii")
                .starts_with("text/plain")
        );
        assert!(body.contains(
            "graft_http_requests_total{method=\"GET\",route=\"/health\",status=\"200\"} 2"
        ));
        assert!(body.contains("graft_http_request_duration_seconds_count{route=\"/health\"} 2"));
    }

    #[tokio::test]
    async fn no_cross_origin_access_unless_an_origin_is_configured() {
        let (app, _) = app(Arc::new(Ok_));
        let request = Request::builder()
            .method("GET")
            .uri("/health")
            .header(header::ORIGIN, "https://evil.example")
            .body(Body::empty())
            .expect("request");
        let response = app.clone().oneshot(request).await.expect("response");
        assert!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_none()
        );
    }
}
