//! The graft service entry point.

use graft_api::config::Config;
use graft_api::http::{AppState, router};
use graft_render_host::{Limits as HostLimits, RenderHost};
use graft_storage::Store;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let config = Config::from_env()?;
    let store = Store::connect(&config.database_url, 10).await?;
    store.migrate().await?;
    let blobs = graft_api::blobs::build_blob_store(&config)?;
    let wasm_path = config
        .renderer_wasm
        .clone()
        .ok_or("GRAFT_RENDERER_WASM is required: the path to the canonical renderer artefact")?;
    // Loading checks the artefact against the pinned hash for the version it reports.
    let renderer = Arc::new(RenderHost::load(
        &std::fs::read(wasm_path)?,
        HostLimits::default(),
    )?);
    let state = AppState::new(&config, store, blobs, renderer);
    let app = router(state, &config);
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!(bind = %config.bind, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Resolves on Ctrl-C or, on Unix, SIGTERM, which is how container platforms stop a service.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut term) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            term.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutting down");
}
