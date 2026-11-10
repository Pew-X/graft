//! Traces, error tracking and the logging subscriber.
//!
//! Everything here is off unless configured. With no OTLP endpoint no exporter exists and nothing
//! is sent; with no tracker address no client exists. Local runs need nothing.
//!
//! **Traces.** The service's spans (a request, a publish, the database transaction, a render, a blob
//! write, an event insert, a relay batch) are `tracing` spans. When `OTEL_EXPORTER_OTLP_ENDPOINT` is
//! set they are also exported over OTLP/HTTP, sampled by `GRAFT_TRACE_SAMPLE`. A span carries sizes
//! and durations, never audio, text, keys or addresses.
//!
//! **Error tracking.** When `GRAFT_ERROR_TRACKER_DSN` is set, a request that ends in a server error
//! and a panic are reported to a Sentry-compatible tracker. The client is configured to send no
//! personal data: no addresses, no users, no request bodies or headers (there is no request
//! integration), no breadcrumbs, no device or host details, no session replay, and every string in
//! a report passes through the scrubber first.

use crate::config::Config;
use crate::scrub::Scrubber;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::WithExportConfig as _;
use opentelemetry_sdk::trace::{Sampler, SdkTracerProvider, SpanExporter};
use std::sync::Arc;
use tracing::Subscriber;
use tracing_subscriber::Layer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;

/// The target of the one log event that becomes an error report.
pub const REPORT_TARGET: &str = "graft_api::http";

/// Keeps the exporters alive and flushes them on drop.
pub struct Guard {
    provider: Option<SdkTracerProvider>,
    _tracker: Option<sentry::ClientInitGuard>,
}

impl Guard {
    /// Whether spans are being exported.
    #[must_use]
    pub fn exporting_traces(&self) -> bool {
        self.provider.is_some()
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if let Some(provider) = self.provider.take() {
            let _ = provider.shutdown();
        }
    }
}

/// A tracer provider that exports through `exporter`, sampling the given share of traces (a trace
/// that arrives already sampled stays sampled).
#[must_use]
pub fn tracer_provider<E: SpanExporter + 'static>(exporter: E, sample: f64) -> SdkTracerProvider {
    SdkTracerProvider::builder()
        .with_sampler(Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(
            sample.clamp(0.0, 1.0),
        ))))
        .with_resource(
            opentelemetry_sdk::Resource::builder()
                .with_service_name("graft-api")
                .build(),
        )
        .with_batch_exporter(exporter)
        .build()
}

/// The layer that turns the service's spans into exported ones.
pub fn trace_layer<S>(provider: &SdkTracerProvider) -> impl Layer<S> + use<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    tracing_opentelemetry::layer().with_tracer(provider.tracer("graft-api"))
}

/// The trace id of the current span, if spans are being exported, so a log line can name it.
#[must_use]
pub fn trace_id(span: &tracing::Span) -> Option<String> {
    use opentelemetry::trace::TraceContextExt;
    use tracing_opentelemetry::OpenTelemetrySpanExt;
    let context = span.context();
    let trace = context.span().span_context().trace_id();
    (trace != opentelemetry::trace::TraceId::INVALID).then(|| trace.to_string())
}

/// The scrubber for this process: it knows the secrets in `config`.
#[must_use]
pub fn scrubber(config: &Config) -> Scrubber {
    let mut secrets = vec![config.database_url.clone()];
    secrets.extend(config.admin_secret.clone());
    if let Some(s3) = &config.s3 {
        // The address of a role's credentials is as private as a key: anyone who can reach it can use them.
        match &s3.credentials {
            graft_storage::S3Credentials::Static {
                access_key_id,
                secret_access_key,
            } => {
                secrets.push(access_key_id.clone());
                secrets.push(secret_access_key.clone());
            }
            graft_storage::S3Credentials::Container {
                relative_uri,
                full_uri,
                token_file,
            } => secrets.extend(
                [relative_uri, full_uri, token_file]
                    .into_iter()
                    .flatten()
                    .cloned(),
            ),
        }
    }
    secrets.extend(config.observability.error_tracker_dsn.clone());
    Scrubber::new(secrets)
}

/// Options for the error tracker, with nothing personal switched on. `transport` replaces the
/// network transport, so a test can capture exactly what would be sent.
pub fn tracker_options(
    environment: &str,
    scrubber: Scrubber,
    transport: Option<Arc<dyn sentry::TransportFactory>>,
) -> sentry::ClientOptions {
    let scrub = Arc::new(scrubber);
    let mut options = sentry::ClientOptions::default();
    options.environment = Some(environment.to_owned().into());
    options.server_name = Some("graft".into());
    options.send_default_pii = false;
    options.max_breadcrumbs = 0;
    options.attach_stacktrace = false;
    // No default integrations: the contexts one reports the operating system and the host.
    options.default_integrations = false;
    options.transport = transport;
    options.before_send = Some(Arc::new(move |event| Some(scrub_event(&scrub, event))));
    options = options.add_integration(sentry::integrations::panic::PanicIntegration::default());
    options
}

/// Remove everything personal from a report and scrub every string left in it.
#[must_use]
pub fn scrub_event(
    scrub: &Scrubber,
    mut event: sentry::protocol::Event<'static>,
) -> sentry::protocol::Event<'static> {
    event.request = None;
    event.user = None;
    event.server_name = None;
    event.breadcrumbs = Default::default();
    event.contexts = Default::default();
    event.modules = Default::default();
    event.sdk = None;
    if let Some(m) = event.message.take() {
        event.message = Some(scrub.text(&m));
    }
    if let Some(entry) = event.logentry.as_mut() {
        entry.message = scrub.text(&entry.message);
        entry.params = entry
            .params
            .iter()
            .map(|p| scrub_value(scrub, p.clone()))
            .collect();
    }
    for exception in &mut event.exception.values {
        if let Some(v) = exception.value.take() {
            exception.value = Some(scrub.text(&v));
        }
        exception.module = None;
        exception.stacktrace = None;
        exception.raw_stacktrace = None;
    }
    event.extra = event
        .extra
        .into_iter()
        .map(|(k, v)| (k, scrub_value(scrub, v)))
        .collect();
    event.tags = event
        .tags
        .into_iter()
        .map(|(k, v)| (k, scrub.text(&v)))
        .collect();
    event.threads = Default::default();
    event
}

fn scrub_value(scrub: &Scrubber, value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => serde_json::Value::String(scrub.text(&s)),
        serde_json::Value::Array(a) => {
            serde_json::Value::Array(a.into_iter().map(|v| scrub_value(scrub, v)).collect())
        }
        serde_json::Value::Object(o) => serde_json::Value::Object(
            o.into_iter()
                .map(|(k, v)| (k, scrub_value(scrub, v)))
                .collect(),
        ),
        other => other,
    }
}

/// The layer that turns the one report-worthy log event into an error report.
pub fn tracker_layer<S>() -> impl Layer<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    sentry_tracing::layer()
        .event_filter(|metadata| {
            if metadata.target() == REPORT_TARGET && *metadata.level() == tracing::Level::ERROR {
                sentry_tracing::EventFilter::Event
            } else {
                sentry_tracing::EventFilter::Ignore
            }
        })
        .span_filter(|_| false)
}

/// Install the logging subscriber and whatever exporters are configured. Fails at start-up, not
/// later, if an address is unusable.
pub fn init(config: &Config) -> Result<Guard, Box<dyn std::error::Error>> {
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    let o = &config.observability;
    let provider = match &o.otlp_endpoint {
        None => None,
        Some(endpoint) => {
            let exporter = opentelemetry_otlp::SpanExporter::builder()
                .with_http()
                .with_endpoint(format!("{}/v1/traces", endpoint.trim_end_matches('/')))
                .build()?;
            Some(tracer_provider(exporter, o.trace_sample))
        }
    };
    let tracker = o.error_tracker_dsn.as_ref().map(|dsn| {
        sentry::init((
            dsn.as_str(),
            tracker_options(&o.environment, scrubber(config), None),
        ))
    });
    let tracker_on = tracker.as_ref().is_some_and(|t| t.is_enabled());
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().json())
        .with(provider.as_ref().map(trace_layer))
        .with(tracker_on.then(tracker_layer))
        .try_init()?;
    if provider.is_some() {
        tracing::info!("exporting traces over OTLP");
    }
    if tracker_on {
        tracing::info!("error tracking is on");
    }
    Ok(Guard {
        provider,
        _tracker: tracker,
    })
}
