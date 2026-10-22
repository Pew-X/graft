//! Shared fixtures for the HTTP seam tests: a router over a real, private Postgres and an
//! in-memory blob store.
#![allow(dead_code, clippy::expect_used, clippy::panic)] // shared by several test binaries; helpers fail loudly

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use graft_api::config::Config;
use graft_api::guard::Clock;
use graft_api::http::{AppState, router};
use graft_api::seed::{SeedSource, seed_source};
use graft_domain::chain::SourceEvidence;
use graft_domain::hash::Sha256Hash;
use graft_domain::ids::PublicationId;
use graft_domain::limits::Limits;
use graft_domain::record::{ContentRecord, Cut, METHOD_HERMITE, RendererIdentity, Transform};
use graft_render_host::{Limits as HostLimits, Render, RenderHost};
use graft_storage::testing::TestDb;
use graft_storage::{MemoryBlobStore, NewPublication, Outcome};
use http_body_util::BodyExt;
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;

/// The canonical renderer, built from source once per test binary (never a cached file: a stale
/// artefact would make a test pass or fail for the wrong reason) and loaded through the pin check.
pub fn host() -> Arc<RenderHost> {
    static HOST: std::sync::OnceLock<Arc<RenderHost>> = std::sync::OnceLock::new();
    HOST.get_or_init(|| {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let status = std::process::Command::new("sh")
            .arg(root.join("scripts/build-wasm.sh"))
            .status()
            .expect("run scripts/build-wasm.sh");
        assert!(status.success(), "scripts/build-wasm.sh failed");
        let wasm = std::fs::read(root.join("target/wasm32-unknown-unknown/wasm/graft_render.wasm"))
            .expect("read the artefact");
        Arc::new(RenderHost::load(&wasm, HostLimits::default()).expect("load the artefact"))
    })
    .clone()
}

pub struct Harness {
    pub db: TestDb,
    pub blobs: Arc<MemoryBlobStore>,
    pub app: Router,
    pub limits: Limits,
    pub metrics: Arc<graft_api::metrics::Metrics>,
    /// The time the guardrails read; moves only when a test advances it.
    pub clock: Arc<graft_api::guard::ManualClock>,
    /// The state the router was built from, for tests that call the service's functions directly.
    pub state: AppState,
}

pub fn renderer() -> RendererIdentity {
    // The pinned hash of version 1, from the committed pin file.
    let pins = include_str!("../../../../fixtures/renderer/PINS");
    let line = pins
        .lines()
        .find(|l| l.starts_with("1 "))
        .expect("pin for version 1");
    RendererIdentity {
        name: "graft-render".into(),
        version: 1,
        wasm_sha256: Sha256Hash::parse(line.split_once(' ').expect("pin line").1)
            .expect("pin hash"),
    }
}

/// A one-second triangle wave as canonical audio: 48 kHz mono s16le.
pub fn audio(seed: i16) -> Vec<u8> {
    audio_frames(48_000, seed)
}

/// The same triangle wave, `frames` long.
pub fn audio_frames(frames: i32, seed: i16) -> Vec<u8> {
    (0..frames)
        .flat_map(|i| {
            let tri = ((i % 200) - 100) * 100;
            (tri as i16).wrapping_add(seed).to_le_bytes()
        })
        .collect()
}

impl Harness {
    pub async fn new() -> Self {
        Self::with_limits(Limits::default()).await
    }

    pub async fn with_limits(limits: Limits) -> Self {
        Self::configured(|c| c.limits = limits).await
    }

    /// A harness whose configuration is adjusted by `tweak` before the service is built.
    pub async fn configured(tweak: impl FnOnce(&mut Config)) -> Self {
        Self::configured_with_gate(tweak, |_| Arc::new(graft_storage::NoGate)).await
    }

    /// As `configured`, with a test gate on the store; `gate` receives the database pool so it can
    /// make conflicting writes from separate connections.
    pub async fn configured_with_gate(
        tweak: impl FnOnce(&mut Config),
        gate: impl FnOnce(sqlx::PgPool) -> Arc<dyn graft_storage::Gate>,
    ) -> Self {
        let db = TestDb::create().await;
        let blobs = Arc::new(MemoryBlobStore::default());
        let mut config =
            Config::from_lookup(|n| (n == "GRAFT_DATABASE_URL").then(|| db.url.clone()))
                .expect("config");
        // The per-visitor limits are out of the way unless a test sets them: every request here
        // comes from one unnamed address, and most tests are about something else.
        config.guardrails.publish_per_ip.count = 1_000_000;
        config.guardrails.report_per_ip.count = 1_000_000;
        config.guardrails.ingest_per_ip.count = 1_000_000;
        config.guardrails.ingest_session_events.count = 1_000_000;
        config.guardrails.global_publish_per_hour = 1_000_000;
        config.guardrails.global_publish_burst = 1_000_000;
        // ...and so is the storage threshold: the limit sits above the overshoot bound of that burst.
        config.guardrails.storage_limit_bytes =
            config.guardrails.overshoot_bound_bytes(&config.limits) + 8_000_000_000;
        tweak(&mut config);
        let limits = config.limits.clone();
        let renderer: Arc<dyn Render> = host();
        let store = db.store.clone().with_gate(gate(db.store.pool().clone()));
        let clock = Arc::new(graft_api::guard::ManualClock::new(
            graft_api::guard::SystemClock.now_secs(),
        ));
        let state = AppState::with_clock(&config, store, blobs.clone(), renderer, clock.clone());
        let metrics = state.metrics.clone();
        let app = router(state.clone(), &config);
        Self {
            db,
            blobs,
            app,
            limits,
            metrics,
            clock,
            state,
        }
    }

    pub async fn seed(&self, key: &str, seed_audio: i16) -> Outcome {
        self.seed_frames(key, 48_000, seed_audio).await
    }

    pub async fn seed_frames(&self, key: &str, frames: i32, seed_audio: i16) -> Outcome {
        seed_source(
            &self.db.store,
            self.blobs.as_ref(),
            &self.limits,
            SeedSource {
                key: key.to_owned(),
                title: "a door".into(),
                author: "pat".into(),
                evidence: SourceEvidence {
                    licence: "own recording".into(),
                    work_title: Some("door".into()),
                    work_author: Some("pat".into()),
                    url: None,
                    declaration: None,
                },
                audio: audio_frames(frames, seed_audio),
                renderer: renderer(),
            },
        )
        .await
        .expect("seed")
    }

    /// Write a flip straight through the store (publishing over HTTP arrives with ticket 06).
    pub async fn flip(&self, key: &str, parent: &PublicationId, out: u8) -> PublicationId {
        let parent_stage = self
            .db
            .store
            .publication(parent)
            .await
            .expect("read")
            .expect("parent");
        let record = ContentRecord::flip(
            parent.clone(),
            parent_stage.record.output_blob(),
            Cut {
                start: 0,
                end: 24_000,
            },
            Transform {
                p: 3,
                q: 2,
                method: METHOD_HERMITE,
            },
            renderer(),
            Sha256Hash::from_bytes([out; 32]),
        )
        .expect("record");
        let new = NewPublication {
            id: PublicationId::seeded(key),
            record,
            retry_key: key.to_owned(),
            title: "slower".into(),
            author: "jo".into(),
            evidence: None,
            manage_key_hash: None,
        };
        self.db
            .store
            .create_publication(&new)
            .await
            .expect("create");
        new.id
    }

    pub async fn get(&self, uri: &str) -> (StatusCode, axum::http::HeaderMap, Value) {
        let request = Request::builder()
            .uri(uri)
            .body(Body::empty())
            .expect("request");
        let response = self.app.clone().oneshot(request).await.expect("response");
        let (parts, body) = response.into_parts();
        let bytes = body.collect().await.expect("body").to_bytes();
        let json = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()));
        (parts.status, parts.headers, json)
    }

    /// An owned handle for spawning concurrent requests.
    pub fn client(&self) -> Client {
        Client {
            app: self.app.clone(),
        }
    }

    /// A request with arbitrary method, headers and body.
    pub async fn send(
        &self,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let body = match body {
            Some(json) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(json.to_string())
            }
            None => Body::empty(),
        };
        let request = builder.body(body).expect("request");
        let response = self.app.clone().oneshot(request).await.expect("response");
        let (parts, body) = response.into_parts();
        let bytes = body.collect().await.expect("body").to_bytes();
        let json = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()));
        (parts.status, parts.headers, json)
    }

    /// As `send`, from a stated visitor address (the connecting peer the service sees).
    pub async fn send_from(
        &self,
        ip: &str,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        self.client()
            .send_from(ip, method, uri, headers, body)
            .await
    }

    pub async fn count(&self, table: &'static str) -> i64 {
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) FROM {table}")))
            .fetch_one(self.db.store.pool())
            .await
            .expect("count")
    }

    pub async fn post(
        &self,
        uri: &str,
        body: &Value,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        self.post_raw(uri, body.to_string(), "application/json")
            .await
    }

    pub async fn post_raw(
        &self,
        uri: &str,
        body: String,
        content_type: &str,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let request = Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(body))
            .expect("request");
        let response = self.app.clone().oneshot(request).await.expect("response");
        let (parts, body) = response.into_parts();
        let bytes = body.collect().await.expect("body").to_bytes();
        let json = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()));
        (parts.status, parts.headers, json)
    }

    pub async fn raw(&self, uri: &str) -> String {
        let request = Request::builder()
            .uri(uri)
            .body(Body::empty())
            .expect("request");
        let response = self.app.clone().oneshot(request).await.expect("response");
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    pub async fn finish(self) {
        self.db.drop_db().await;
    }
}

pub fn is_problem(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v == "application/problem+json")
}

/// A cloneable, 'static handle to the router, so requests can run in spawned tasks.
#[derive(Clone)]
pub struct Client {
    app: Router,
}

impl Client {
    /// As `send`, from a stated visitor address (the connecting peer the service sees).
    pub async fn send_from(
        &self,
        ip: &str,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let body = match body {
            Some(json) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(json.to_string())
            }
            None => Body::empty(),
        };
        let mut request = builder.body(body).expect("request");
        let peer: std::net::SocketAddr = format!("{ip}:40000").parse().expect("an address");
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(peer));
        let response = self.app.clone().oneshot(request).await.expect("response");
        let (parts, body) = response.into_parts();
        let bytes = body.collect().await.expect("body").to_bytes();
        let json = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()));
        (parts.status, parts.headers, json)
    }

    pub async fn send(
        &self,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let body = match body {
            Some(json) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(json.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .app
            .clone()
            .oneshot(builder.body(body).expect("request"))
            .await
            .expect("response");
        let (parts, body) = response.into_parts();
        let bytes = body.collect().await.expect("body").to_bytes();
        let json = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()));
        (parts.status, parts.headers, json)
    }

    pub async fn post(
        &self,
        uri: &str,
        body: &Value,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let request = Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .expect("request");
        let response = self.app.clone().oneshot(request).await.expect("response");
        let (parts, body) = response.into_parts();
        let bytes = body.collect().await.expect("body").to_bytes();
        let json = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()));
        (parts.status, parts.headers, json)
    }

    /// Post, and on a 503 `retry-later` send the same request again, as a client is told to.
    pub async fn post_retrying(
        &self,
        uri: &str,
        body: &Value,
        tries: u32,
    ) -> (StatusCode, Value, u32) {
        for attempt in 1..=tries {
            let (status, _, json) = self.post(uri, body).await;
            if status != StatusCode::SERVICE_UNAVAILABLE || attempt == tries {
                return (status, json, attempt);
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        unreachable!("tries is at least 1")
    }
}
