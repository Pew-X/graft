//! Shared fixtures for the HTTP seam tests: a router over a real, private Postgres and an
//! in-memory blob store.
#![allow(dead_code, clippy::expect_used, clippy::panic)] // shared by several test binaries; helpers fail loudly

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use graft_api::config::Config;
use graft_api::http::{AppState, router};
use graft_api::seed::{SeedSource, seed_source};
use graft_domain::chain::SourceEvidence;
use graft_domain::hash::Sha256Hash;
use graft_domain::ids::PublicationId;
use graft_domain::limits::Limits;
use graft_domain::record::{ContentRecord, Cut, METHOD_HERMITE, RendererIdentity, Transform};
use graft_storage::testing::TestDb;
use graft_storage::{MemoryBlobStore, NewPublication, Outcome};
use http_body_util::BodyExt;
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;

pub struct Harness {
    pub db: TestDb,
    pub blobs: Arc<MemoryBlobStore>,
    pub app: Router,
    pub limits: Limits,
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
    (0..48_000i32)
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
        let db = TestDb::create().await;
        let blobs = Arc::new(MemoryBlobStore::default());
        let mut config =
            Config::from_lookup(|n| (n == "GRAFT_DATABASE_URL").then(|| db.url.clone()))
                .expect("config");
        config.limits = limits.clone();
        let state = AppState::new(&config, db.store.clone(), blobs.clone());
        let app = router(state, &config);
        Self {
            db,
            blobs,
            app,
            limits,
        }
    }

    pub async fn seed(&self, key: &str, seed_audio: i16) -> Outcome {
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
                },
                audio: audio(seed_audio),
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
