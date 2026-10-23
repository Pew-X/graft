//! The HTTP surface: routing, request ids, security headers, CORS, health, readiness and metrics.

use crate::config::Config;
use crate::guard::{Class, Clock, Guards, SystemClock};
use crate::maker;
use crate::metrics::Metrics;
use crate::moderation;
use crate::problem::Problem;
use crate::publish;
use crate::routes;
use axum::extract::{MatchedPath, Request, State};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use graft_domain::limits::Limits;
use graft_render_host::Render;
use graft_storage::{BlobStore, Store};
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
    /// The database.
    pub store: Store,
    /// Audio storage.
    pub blobs: Arc<dyn BlobStore>,
    /// Caps and text limits.
    pub limits: Limits,
    /// How long issued blob URLs stay valid.
    pub blob_url_ttl: std::time::Duration,
    /// The canonical renderer, loaded once and shared by every request.
    pub renderer: Arc<dyn Render>,
    /// Permits for concurrent renders.
    pub renders: Arc<tokio::sync::Semaphore>,
    /// Settings for publishing.
    pub publish: PublishSettings,
    /// SHA-256 of the operator secret; `None` when admin access is not configured.
    pub admin_secret_hash: Option<[u8; 32]>,
    /// The kill switch, the per-visitor limits, the global cap and the storage threshold.
    pub guards: Arc<Guards>,
    /// What the consumer has counted, for the operator's read and the metrics.
    pub consumer_stats: Arc<graft_events::ConsumerStats>,
    /// Most events in one client batch.
    pub ingest_max_batch: usize,
    /// Whether visitors may publish their own source audio.
    pub uploads_enabled: bool,
}

/// Settings the publish route reads.
#[derive(Clone)]
pub struct PublishSettings {
    /// Most flips of one stage within an hour.
    pub max_forks_per_stage_per_hour: u32,
    /// Retries of a transaction that conflicted with concurrent work.
    pub serialization_retries: u32,
    /// How long a publish waits for the lock on its parent before answering "busy".
    pub lock_wait: std::time::Duration,
    /// Words refused in titles and names, beyond the built-in list.
    pub extra_deny_words: Vec<String>,
}

impl AppState {
    /// State wired to the real database check.
    #[must_use]
    pub fn new(
        config: &Config,
        store: Store,
        blobs: Arc<dyn BlobStore>,
        renderer: Arc<dyn Render>,
    ) -> Self {
        Self::with_clock(config, store, blobs, renderer, Arc::new(SystemClock))
    }

    /// As `new`, with the time source the guardrails read, so a test can move time.
    #[must_use]
    pub fn with_clock(
        config: &Config,
        store: Store,
        blobs: Arc<dyn BlobStore>,
        renderer: Arc<dyn Render>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let metrics = Arc::new(Metrics::default());
        metrics.set_publishing_open(config.guardrails.publishing_default);
        Self {
            readiness: Arc::new(StoreReadiness(store.clone())),
            metrics,
            guards: Arc::new(Guards::new(
                &config.guardrails,
                &config.limits,
                store.clone(),
                blobs.clone(),
                clock,
            )),
            store,
            blobs,
            consumer_stats: Arc::new(graft_events::ConsumerStats::default()),
            ingest_max_batch: config.events.ingest_max_batch as usize,
            uploads_enabled: config.guardrails.uploads_enabled,
            limits: config.limits.clone(),
            blob_url_ttl: std::time::Duration::from_secs(config.blob_url_ttl_secs),
            renderer,
            renders: Arc::new(tokio::sync::Semaphore::new(config.max_concurrent_renders)),
            admin_secret_hash: config
                .admin_secret
                .as_deref()
                .map(|s| *graft_domain::hash::Sha256Hash::of(s.as_bytes()).as_bytes()),
            publish: PublishSettings {
                max_forks_per_stage_per_hour: config.max_forks_per_stage_per_hour,
                serialization_retries: config.serialization_retries,
                lock_wait: std::time::Duration::from_millis(config.lock_wait_ms),
                extra_deny_words: config.extra_deny_words.clone(),
            },
        }
    }
}

/// Readiness backed by the database.
pub struct StoreReadiness(pub Store);

impl Readiness for StoreReadiness {
    fn check(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { self.0.ping().await.map_err(|e| e.to_string()) })
    }
}

/// Build the router with all middleware.
pub fn router(state: AppState, config: &Config) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/metrics", get(metrics))
        .route("/openapi.json", get(routes::openapi))
        .route("/v1/chains/{id}", get(routes::get_chain))
        .route("/v1/features", get(routes::get_features))
        .route("/v1/publications/{id}", get(routes::get_publication))
        .route(
            "/v1/publications/{id}/fork-permission",
            put(maker::set_fork_permission)
                .layer(axum::extract::DefaultBodyLimit::max(maker::MAX_BODY_BYTES)),
        )
        .route(
            "/v1/publications/{id}/withdraw",
            post(maker::withdraw)
                .layer(axum::extract::DefaultBodyLimit::max(maker::MAX_BODY_BYTES)),
        )
        .route(
            "/v1/reports",
            post(moderation::file_report)
                .layer(axum::extract::DefaultBodyLimit::max(
                    moderation::MAX_BODY_BYTES,
                ))
                .layer(middleware::from_fn_with_state(state.clone(), report_guard)),
        )
        .merge(admin_routes(state.clone()))
        .route(
            "/v1/sources",
            post(crate::source::publish_source)
                .layer(axum::extract::DefaultBodyLimit::max(
                    crate::source::max_body_bytes(&config.limits),
                ))
                .layer(middleware::from_fn_with_state(
                    state.clone(),
                    crate::source::upload_guard,
                )),
        )
        .route(
            "/v1/events",
            post(crate::ingest::ingest_events)
                .layer(axum::extract::DefaultBodyLimit::max(
                    crate::ingest::MAX_BODY_BYTES,
                ))
                .layer(middleware::from_fn_with_state(state.clone(), ingest_guard)),
        )
        .route(
            "/v1/publications",
            post(publish::publish_flip)
                .layer(axum::extract::DefaultBodyLimit::max(
                    publish::MAX_BODY_BYTES,
                ))
                .layer(middleware::from_fn_with_state(state.clone(), publish_guard)),
        )
        .fallback(|| async { Problem::not_found("there is nothing at this address") })
        .method_not_allowed_fallback(|| async { Problem::method_not_allowed() })
        .layer(tower_http::catch_panic::CatchPanicLayer::custom(
            |_panic: Box<dyn std::any::Any + Send + 'static>| {
                // Only that it happened: the payload of a panic can hold anything.
                // Logged as a warning: the tracker already has the panic from its own hook, and the
                // 500 that follows is the one report-worthy event.
                tracing::warn!("a request handler panicked");
                Problem::internal().into_response()
            },
        ))
        .layer(cors(config))
        .layer(middleware::from_fn_with_state(
            std::time::Duration::from_secs(config.request_timeout_secs),
            body_deadline,
        ))
        // Outermost, so every response (a refused preflight and a timeout included) is logged,
        // counted and given the security headers.
        .layer(middleware::from_fn_with_state(state.clone(), observe))
        .with_state(state)
}

/// Frees a request whose body does not arrive in time. Only the reading of the body is bounded:
/// a client that connects and stops sending is cut off here (its read fails with `BodyTimedOut`,
/// which the extractors answer with a timeout), instead of holding the request open for ever. The
/// handler itself is never cancelled, because a publish dropped half way would release its render
/// permit while the render goes on, or fall between taking a token and storing the result.
async fn body_deadline(
    State(limit): State<std::time::Duration>,
    request: Request,
    next: Next,
) -> Response {
    use futures::StreamExt;
    let (parts, body) = request.into_parts();
    let until = tokio::time::Instant::now() + limit;
    // (the body's data, whether it has already ended in an error)
    let stream = futures::stream::unfold(
        (body.into_data_stream(), false),
        move |(mut data, over)| async move {
            if over {
                return None;
            }
            match tokio::time::timeout_at(until, data.next()).await {
                Ok(None) => None,
                Ok(Some(Ok(bytes))) => Some((Ok(bytes), (data, false))),
                Ok(Some(Err(e))) => Some((Err(Box::new(e) as axum::BoxError), (data, true))),
                Err(_) => Some((
                    Err(Box::new(crate::problem::BodyTimedOut) as axum::BoxError),
                    (data, true),
                )),
            }
        },
    );
    next.run(Request::from_parts(
        parts,
        axum::body::Body::from_stream(stream),
    ))
    .await
}

/// The operator routes. The secret is checked by a layer, before any query or body is parsed.
fn admin_routes(state: AppState) -> Router<AppState> {
    Router::new()
        .route("/admin/reports", get(moderation::list_reports))
        .route("/admin/rollups", get(crate::events::get_rollups))
        .route(
            "/admin/switch",
            get(moderation::get_switch)
                .put(moderation::set_switch)
                .layer(axum::extract::DefaultBodyLimit::max(
                    moderation::MAX_BODY_BYTES,
                )),
        )
        .route(
            "/admin/publications/{id}/hide",
            post(moderation::hide)
                .layer(axum::extract::DefaultBodyLimit::max(
                    moderation::MAX_BODY_BYTES,
                ))
                .merge(delete(moderation::clear_hide)),
        )
        .route_layer(middleware::from_fn_with_state(
            state,
            moderation::require_admin,
        ))
}

/// The guard in front of every route that adds to what is published: the kill switch first, then
/// the visitor's own limit. Both run before the body is read, so a refused request costs nothing.
/// A new publishing route (a source upload, client events) is added here and in `WRITE_ROUTES`.
pub(crate) async fn publish_guard(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    write_guard(
        &state,
        Class::Publish,
        "rate_limited_publish",
        request,
        next,
    )
    .await
}

/// The same guard in front of the client event batches, with their own limit.
async fn ingest_guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    write_guard(&state, Class::Ingest, "rate_limited_ingest", request, next).await
}

async fn write_guard(
    state: &AppState,
    class: Class,
    refusal: &'static str,
    request: Request,
    next: Next,
) -> Response {
    if let Some(refusal) = publishing_closed(state).await {
        return refusal;
    }
    let ip = state
        .guards
        .client_ip(request.extensions(), request.headers());
    match state
        .guards
        .limiter
        .try_admit(class, ip, state.guards.clock.now_secs())
    {
        Ok(()) => next.run(request).await,
        Err(wait) => {
            state.metrics.refusal(refusal);
            Problem::rate_limited(wait).into_response()
        }
    }
}

/// The guard in front of reports: the visitor's own limit only. Reports stay open when publishing
/// is switched off, because they are how a problem is raised.
async fn report_guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let ip = state
        .guards
        .client_ip(request.extensions(), request.headers());
    match state
        .guards
        .limiter
        .try_admit(Class::Report, ip, state.guards.clock.now_secs())
    {
        Ok(()) => next.run(request).await,
        Err(wait) => {
            state.metrics.refusal("rate_limited_report");
            Problem::rate_limited(wait).into_response()
        }
    }
}

/// The refusal to send when the kill switch is closed, or `None` when publishing is open.
pub(crate) async fn publishing_closed(state: &AppState) -> Option<Response> {
    let open = state.guards.switch.publishing_open().await;
    state.metrics.set_publishing_open(open);
    if open {
        None
    } else {
        state.metrics.refusal("publishing_off");
        Some(Problem::publishing_off().into_response())
    }
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
            // The admin page sends the operator secret in a header from the browser.
            HeaderName::from_static("x-graft-admin-secret"),
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
    let mut text = state.metrics.render();
    text.push_str(&crate::events::metrics_text(&state).await);
    let mut response = text.into_response();
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
    let span = tracing::info_span!(
        "request",
        %request_id,
        %method,
        route = %route,
        trace_id = tracing::field::Empty
    );
    // Next to the request id, the trace id, when spans are being exported, so a log line leads to
    // its trace and back.
    if let Some(trace) = crate::observability::trace_id(&span) {
        span.record("trace_id", trace.as_str());
    }
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
        );
        // The one event that becomes an error report: which request, which route, nothing from
        // inside it. A busy or refused request is not an error; a 500 is.
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            // The ids are in the message itself, so the report names the request whichever
            // fields the tracker keeps.
            tracing::error!(
                target: crate::observability::REPORT_TARGET,
                request_id = %request_id,
                route = %route,
                "a request ended in a server error (request {request_id}, route {route})"
            );
        }
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
    // Browsers hold to secure transport for two years once they have seen this over it; it is
    // ignored over plain HTTP, so sending it always is safe behind a terminating proxy.
    headers.insert(
        header::STRICT_TRANSPORT_SECURITY,
        HeaderValue::from_static("max-age=63072000; includeSubDomains"),
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

    /// A renderer that is never called: these tests are about the HTTP shell, not publishing.
    struct NoRenderer;

    static FAKE_ID: graft_render_host::RendererIdentity = graft_render_host::RendererIdentity {
        name: "none",
        version: 0,
        wasm_sha256: String::new(),
    };

    impl Render for NoRenderer {
        fn render(
            &self,
            _cut: &[i16],
            _ratio: graft_render_host::Ratio,
            _method: graft_render_host::Method,
        ) -> Result<Vec<i16>, graft_render_host::RenderError> {
            Err(graft_render_host::RenderError::Internal("not used".into()))
        }

        fn output_frames(
            &self,
            _in_len: u32,
            _ratio: graft_render_host::Ratio,
        ) -> Result<u32, graft_render_host::RenderError> {
            Err(graft_render_host::RenderError::Internal("not used".into()))
        }

        fn identity(&self) -> &graft_render_host::RendererIdentity {
            &FAKE_ID
        }
    }

    fn app(readiness: Arc<dyn Readiness>) -> (Router, Arc<Metrics>) {
        let cfg = config();
        let store = Store::connect_lazy("postgres://u:p@127.0.0.1:1/none", 1).expect("lazy store");
        let mut state = AppState::new(
            &cfg,
            store,
            Arc::new(graft_storage::MemoryBlobStore::default()),
            Arc::new(NoRenderer),
        );
        state.readiness = readiness;
        let metrics = state.metrics.clone();
        (router(state, &cfg), metrics)
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
