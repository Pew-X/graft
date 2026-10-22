//! The graft service entry point.

use graft_api::config::Config;
use graft_api::http::{AppState, BoxFuture, Readiness, router};
use graft_api::metrics::Metrics;
use std::sync::Arc;

struct NotReady;

impl Readiness for NotReady {
    fn check(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Err("no database is wired yet".to_owned()) })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let config = Config::from_env()?;
    let state = AppState {
        readiness: Arc::new(NotReady),
        metrics: Arc::new(Metrics::default()),
    };
    let app = router(state, &config);
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!(bind = %config.bind, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
