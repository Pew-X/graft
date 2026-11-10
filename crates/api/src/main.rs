//! The graft service entry point.

use graft_api::config::Config;
use graft_api::http::{AppState, router};
use graft_render_host::{Limits as HostLimits, RenderHost};
use graft_storage::Store;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    // Held for the life of the process: dropping it flushes whatever is still to be exported.
    let _observability = graft_api::observability::init(&config)?;
    let store = Store::connect_waiting(
        &config.database_url,
        10,
        std::time::Duration::from_secs(config.db_startup_wait_secs),
    )
    .await?;
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
    let consumer = Arc::new(graft_events::Consumer::new(store.clone()));
    let mut state = AppState::new(&config, store.clone(), blobs, renderer);
    state.consumer_stats = consumer.stats();
    // The relay, consumer and retention run in this process unless the pipeline is switched off
    // (another instance can carry it; claims skip locked rows, so any number may run).
    let (stop_pipeline, stop_rx) = tokio::sync::watch::channel(false);
    // With a queue address the relay sends batches to the queue and a second task reads the queue and
    // applies them; without one (the default) the relay hands each batch straight to the consumer.
    let transport = match (&config.events.queue_url, config.events.pipeline) {
        (Some(url), true) => Some(Arc::new(
            graft_queue::SqsTransport::connect(url, config.events.queue_endpoint.as_deref()).await,
        )),
        _ => None,
    };
    let queue_task = transport.clone().map(|transport| {
        let reader = graft_queue::QueueConsumer::new(
            transport,
            consumer.clone(),
            graft_queue::PollSettings::default(),
        );
        let stop = stop_rx.clone();
        tokio::spawn(async move { reader.run(stop).await })
    });
    let sink: Arc<dyn graft_events::EventSink> = match transport {
        Some(transport) => Arc::new(graft_queue::QueueSink::new(
            transport,
            std::time::Duration::from_secs(10),
        )),
        None => Arc::new(graft_events::ConsumerSink(consumer.clone())),
    };
    let pipeline = config.events.pipeline.then(|| {
        let relay = graft_events::Relay::new(store.clone(), sink, config.events.relay_batch);
        let relay_interval = std::time::Duration::from_millis(config.events.relay_interval_ms);
        let relay_stop = stop_rx.clone();
        let retention = graft_events::Retention::new(store.clone(), config.events.retention_days);
        let retention_every = std::time::Duration::from_secs(config.events.retention_interval_secs);
        let mut retention_stop = stop_rx.clone();
        (
            tokio::spawn(async move { relay.run(relay_interval, relay_stop).await }),
            tokio::spawn(async move {
                loop {
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
                    if let Err(error) = retention.drain(now_ms).await {
                        tracing::error!(%error, "event retention failed");
                    }
                    tokio::select! {
                        () = tokio::time::sleep(retention_every) => {}
                        _ = retention_stop.changed() => return,
                    }
                }
            }),
        )
    });
    let app = router(state, &config);
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!(bind = %config.bind, "listening");
    // The connecting address is what the per-visitor limits count (or the entry a trusted proxy
    // appended, see GRAFT_TRUSTED_PROXY_HOPS); it is held in memory for one window and never stored.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    let _ = stop_pipeline.send(true);
    if let Some(reader) = queue_task {
        let _ = reader.await;
    }
    if let Some((relay, retention)) = pipeline {
        let _ = relay.await;
        let _ = retention.await;
    }
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
