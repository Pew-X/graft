//! Service configuration, read from the environment. Every limit has a documented default
//! (ARCHITECTURE.md, "Configuration"); secrets are never defaults.

use graft_domain::limits::Limits;
use std::collections::HashMap;
use std::net::SocketAddr;

/// Why configuration could not be built.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    /// A required variable is missing.
    #[error("{0} is required")]
    Missing(&'static str),
    /// A variable has a value that cannot be used.
    #[error("{name} is invalid: {reason}")]
    Invalid {
        /// The variable.
        name: &'static str,
        /// What is wrong.
        reason: String,
    },
}

/// Everything the service reads at start-up. `Debug` is written by hand and redacts every secret,
/// so printing a config (in a log line, a panic message or a test failure) can never leak one.
#[derive(Clone)]
pub struct Config {
    /// Address to listen on.
    pub bind: SocketAddr,
    /// Postgres connection string. A secret: never logged.
    pub database_url: String,
    /// Origins allowed by CORS. Empty means no cross-origin access.
    pub cors_origins: Vec<String>,
    /// Caps and text limits.
    pub limits: Limits,
    /// How long a signed blob URL stays valid, in seconds.
    pub blob_url_ttl_secs: u64,
    /// Most flips of one stage within an hour; beyond it flips are refused politely.
    pub max_forks_per_stage_per_hour: u32,
    /// How many times a publish that conflicted with concurrent work is retried inside the service.
    pub serialization_retries: u32,
    /// How long a publish waits for the lock on its parent stage, in milliseconds.
    pub lock_wait_ms: u64,
    /// Most renders running at once.
    pub max_concurrent_renders: usize,
    /// The longest a request may take from its first byte to its answer, reading a slow body
    /// included; past it the request is answered with a timeout and freed.
    pub request_timeout_secs: u64,
    /// How many of the allowed origins were given (a typo is refused at start-up, never dropped).
    /// The canonical renderer artefact the service loads at start-up.
    pub renderer_wasm: Option<std::path::PathBuf>,
    /// Words refused in titles and names, on top of the built-in list.
    pub extra_deny_words: Vec<String>,
    /// The operator secret for the admin routes. A secret: never logged. When unset, the admin
    /// routes refuse every request.
    pub admin_secret: Option<String>,
    /// A directory for audio, for local runs. Used when no S3 bucket is configured.
    pub blob_dir: Option<std::path::PathBuf>,
    /// The S3-compatible bucket for audio, when configured. Its credentials are secrets.
    pub s3: Option<graft_storage::S3Config>,
    /// A blob older than this is refreshed when it is written again, in seconds.
    pub blob_refresh_secs: u64,
    /// The orphan cleanup leaves blobs younger than this alone, in seconds.
    pub orphan_grace_secs: u64,
    /// The abuse guardrails: kill switch default, per-visitor limits, global cap, storage threshold.
    pub guardrails: Guardrails,
    /// The event pipeline: whether this process runs the relay and consumer, and its pacing.
    pub events: EventSettings,
    /// Traces and error tracking; both off unless an address is given.
    pub observability: Observability,
}

/// Where traces and error reports go. Both are off by default.
#[derive(Clone, PartialEq)]
pub struct Observability {
    /// The OTLP/HTTP base address (`OTEL_EXPORTER_OTLP_ENDPOINT`); unset means nothing is exported.
    pub otlp_endpoint: Option<String>,
    /// The share of traces exported, 0 to 1 (`GRAFT_TRACE_SAMPLE`).
    pub trace_sample: f64,
    /// The error tracker's DSN (`GRAFT_ERROR_TRACKER_DSN`). A secret: never logged.
    pub error_tracker_dsn: Option<String>,
    /// The environment name reports carry (`GRAFT_ENVIRONMENT`).
    pub environment: String,
}

impl std::fmt::Debug for Observability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Observability")
            .field("otlp_endpoint", &self.otlp_endpoint)
            .field("trace_sample", &self.trace_sample)
            .field(
                "error_tracker_dsn",
                &self.error_tracker_dsn.as_ref().map(|_| "redacted"),
            )
            .field("environment", &self.environment)
            .finish()
    }
}

fn observability(lookup: &impl Fn(&str) -> Option<String>) -> Result<Observability, ConfigError> {
    let mut trace_sample = 0.1_f64;
    if let Some(text) = lookup("GRAFT_TRACE_SAMPLE") {
        trace_sample = text.trim().parse().map_err(|_| ConfigError::Invalid {
            name: "GRAFT_TRACE_SAMPLE",
            reason: format!("{text:?} is not a number"),
        })?;
        if !(0.0..=1.0).contains(&trace_sample) {
            return Err(ConfigError::Invalid {
                name: "GRAFT_TRACE_SAMPLE",
                reason: "must be between 0 and 1".to_owned(),
            });
        }
    }
    let otlp_endpoint = lookup("OTEL_EXPORTER_OTLP_ENDPOINT").filter(|e| !e.trim().is_empty());
    if let Some(e) = &otlp_endpoint
        && !(e.starts_with("http://") || e.starts_with("https://"))
    {
        return Err(ConfigError::Invalid {
            name: "OTEL_EXPORTER_OTLP_ENDPOINT",
            reason: "must start with http:// or https://".to_owned(),
        });
    }
    Ok(Observability {
        otlp_endpoint,
        trace_sample,
        error_tracker_dsn: lookup("GRAFT_ERROR_TRACKER_DSN").filter(|d| !d.trim().is_empty()),
        environment: lookup("GRAFT_ENVIRONMENT").unwrap_or_else(|| "development".to_owned()),
    })
}

/// How this process runs the event pipeline (ARCHITECTURE.md, "Events and the outbox").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventSettings {
    /// Whether this process runs the relay, the consumer and the retention job.
    pub pipeline: bool,
    /// Events delivered per batch.
    pub relay_batch: u32,
    /// Pause between relay passes, in milliseconds.
    pub relay_interval_ms: u64,
    /// Raw events are kept this many days.
    pub retention_days: u32,
    /// Pause between retention passes, in seconds.
    pub retention_interval_secs: u64,
    /// Most events in one client batch.
    pub ingest_max_batch: u32,
}

fn event_settings(lookup: &impl Fn(&str) -> Option<String>) -> Result<EventSettings, ConfigError> {
    let mut e = EventSettings {
        pipeline: true,
        relay_batch: 100,
        relay_interval_ms: 1000,
        retention_days: 30,
        retention_interval_secs: 3600,
        ingest_max_batch: 20,
    };
    match lookup("GRAFT_EVENT_PIPELINE").as_deref().map(str::trim) {
        None | Some("on") => {}
        Some("off") => e.pipeline = false,
        Some(_) => {
            return Err(ConfigError::Invalid {
                name: "GRAFT_EVENT_PIPELINE",
                reason: "must be `on` or `off`".to_owned(),
            });
        }
    }
    number(lookup, "GRAFT_RELAY_BATCH", &mut e.relay_batch)?;
    number(lookup, "GRAFT_RELAY_INTERVAL_MS", &mut e.relay_interval_ms)?;
    number(lookup, "GRAFT_EVENT_RETENTION_DAYS", &mut e.retention_days)?;
    number(
        lookup,
        "GRAFT_RETENTION_INTERVAL_SECS",
        &mut e.retention_interval_secs,
    )?;
    number(lookup, "GRAFT_INGEST_MAX_BATCH", &mut e.ingest_max_batch)?;
    for (name, value) in [
        ("GRAFT_INGEST_MAX_BATCH", u64::from(e.ingest_max_batch)),
        ("GRAFT_RELAY_BATCH", u64::from(e.relay_batch)),
        ("GRAFT_RELAY_INTERVAL_MS", e.relay_interval_ms),
        ("GRAFT_EVENT_RETENTION_DAYS", u64::from(e.retention_days)),
        ("GRAFT_RETENTION_INTERVAL_SECS", e.retention_interval_secs),
    ] {
        if value == 0 {
            return Err(ConfigError::Invalid {
                name,
                reason: "must be at least 1".to_owned(),
            });
        }
    }
    Ok(e)
}

/// A limit on how often something may happen: `count` times within `window_secs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rate {
    /// How many are allowed in the window.
    pub count: u32,
    /// The length of the window, in seconds.
    pub window_secs: u64,
}

/// The settings of the abuse guardrails (ARCHITECTURE.md, "Abuse guardrails").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Guardrails {
    /// Whether publishing is open when the operator has not set the kill switch.
    pub publishing_default: bool,
    /// How long a read of the kill switch is reused, in milliseconds: the most a toggle made on
    /// another instance can take to be seen.
    pub switch_cache_ms: u64,
    /// How many trusted proxies sit in front of the service; 0 uses the connecting address.
    pub trusted_proxy_hops: usize,
    /// Per visitor address: publishing a flip or a source.
    pub publish_per_ip: Rate,
    /// Per visitor address: filing reports.
    pub report_per_ip: Rate,
    /// Per visitor address: refused admin attempts before further attempts wait.
    pub admin_failures_per_ip: Rate,
    /// Whether visitors may publish their own source audio. Off until the launch gate passes.
    pub uploads_enabled: bool,
    /// Per visitor address: client event batches.
    pub ingest_per_ip: Rate,
    /// Per session id: client events (not batches) within the window.
    pub ingest_session_events: Rate,
    /// The global publish cap: publishes admitted per hour, across all visitors and instances.
    pub global_publish_per_hour: u32,
    /// The most publishes admitted in one burst.
    pub global_publish_burst: u32,
    /// The storage the host allows for audio, in bytes. The admission threshold is this minus the
    /// documented overshoot bound.
    pub storage_limit_bytes: u64,
    /// How often the storage total is read again, in seconds.
    pub storage_refresh_secs: u64,
}

impl Guardrails {
    /// The most bytes that can be stored beyond the threshold before the next refresh notices:
    /// the burst plus what the cap refills in one refresh interval, each as large as the largest
    /// blob the limits allow. A bound, not a measurement.
    #[must_use]
    pub fn overshoot_bound_bytes(&self, limits: &Limits) -> u64 {
        let largest_blob = u64::from(limits.max_output_frames.max(limits.max_source_frames)) * 2;
        let refill =
            (u64::from(self.global_publish_per_hour) * self.storage_refresh_secs).div_ceil(3600);
        (u64::from(self.global_publish_burst) + refill) * largest_blob
    }

    /// New publishes are refused once the stored total reaches this.
    #[must_use]
    pub fn admission_threshold_bytes(&self, limits: &Limits) -> u64 {
        self.storage_limit_bytes
            .saturating_sub(self.overshoot_bound_bytes(limits))
    }
}

fn guardrails(
    lookup: &impl Fn(&str) -> Option<String>,
    limits: &Limits,
) -> Result<Guardrails, ConfigError> {
    let mut g = Guardrails {
        publishing_default: true,
        uploads_enabled: false,
        switch_cache_ms: 2000,
        trusted_proxy_hops: 0,
        publish_per_ip: Rate {
            count: 20,
            window_secs: 3600,
        },
        report_per_ip: Rate {
            count: 10,
            window_secs: 3600,
        },
        admin_failures_per_ip: Rate {
            count: 10,
            window_secs: 900,
        },
        ingest_per_ip: Rate {
            count: 30,
            window_secs: 60,
        },
        ingest_session_events: Rate {
            count: 300,
            window_secs: 3600,
        },
        global_publish_per_hour: 120,
        global_publish_burst: 30,
        storage_limit_bytes: 8_000_000_000,
        storage_refresh_secs: 60,
    };
    match lookup("GRAFT_PUBLISHING").as_deref().map(str::trim) {
        None | Some("on") => {}
        Some("off") => g.publishing_default = false,
        Some(_) => {
            return Err(ConfigError::Invalid {
                name: "GRAFT_PUBLISHING",
                reason: "must be `on` or `off`".to_owned(),
            });
        }
    }
    match lookup("GRAFT_UPLOADS").as_deref().map(str::trim) {
        None | Some("off") => {}
        Some("on") => g.uploads_enabled = true,
        Some(_) => {
            return Err(ConfigError::Invalid {
                name: "GRAFT_UPLOADS",
                reason: "must be `on` or `off`".to_owned(),
            });
        }
    }
    number(lookup, "GRAFT_SWITCH_CACHE_MS", &mut g.switch_cache_ms)?;
    number(
        lookup,
        "GRAFT_TRUSTED_PROXY_HOPS",
        &mut g.trusted_proxy_hops,
    )?;
    number(lookup, "GRAFT_PUBLISH_PER_IP", &mut g.publish_per_ip.count)?;
    number(
        lookup,
        "GRAFT_PUBLISH_WINDOW_SECS",
        &mut g.publish_per_ip.window_secs,
    )?;
    number(lookup, "GRAFT_REPORT_PER_IP", &mut g.report_per_ip.count)?;
    number(
        lookup,
        "GRAFT_REPORT_WINDOW_SECS",
        &mut g.report_per_ip.window_secs,
    )?;
    number(
        lookup,
        "GRAFT_ADMIN_FAILURES_PER_IP",
        &mut g.admin_failures_per_ip.count,
    )?;
    number(
        lookup,
        "GRAFT_ADMIN_WINDOW_SECS",
        &mut g.admin_failures_per_ip.window_secs,
    )?;
    number(lookup, "GRAFT_INGEST_PER_IP", &mut g.ingest_per_ip.count)?;
    number(
        lookup,
        "GRAFT_INGEST_WINDOW_SECS",
        &mut g.ingest_per_ip.window_secs,
    )?;
    number(
        lookup,
        "GRAFT_INGEST_SESSION_EVENTS",
        &mut g.ingest_session_events.count,
    )?;
    number(
        lookup,
        "GRAFT_INGEST_SESSION_WINDOW_SECS",
        &mut g.ingest_session_events.window_secs,
    )?;
    number(
        lookup,
        "GRAFT_GLOBAL_PUBLISH_PER_HOUR",
        &mut g.global_publish_per_hour,
    )?;
    number(
        lookup,
        "GRAFT_GLOBAL_PUBLISH_BURST",
        &mut g.global_publish_burst,
    )?;
    number(
        lookup,
        "GRAFT_STORAGE_LIMIT_BYTES",
        &mut g.storage_limit_bytes,
    )?;
    number(
        lookup,
        "GRAFT_STORAGE_REFRESH_SECS",
        &mut g.storage_refresh_secs,
    )?;
    for (name, value) in [
        ("GRAFT_PUBLISH_PER_IP", u64::from(g.publish_per_ip.count)),
        ("GRAFT_PUBLISH_WINDOW_SECS", g.publish_per_ip.window_secs),
        ("GRAFT_INGEST_PER_IP", u64::from(g.ingest_per_ip.count)),
        ("GRAFT_INGEST_WINDOW_SECS", g.ingest_per_ip.window_secs),
        (
            "GRAFT_INGEST_SESSION_EVENTS",
            u64::from(g.ingest_session_events.count),
        ),
        (
            "GRAFT_INGEST_SESSION_WINDOW_SECS",
            g.ingest_session_events.window_secs,
        ),
        ("GRAFT_REPORT_PER_IP", u64::from(g.report_per_ip.count)),
        ("GRAFT_REPORT_WINDOW_SECS", g.report_per_ip.window_secs),
        (
            "GRAFT_ADMIN_FAILURES_PER_IP",
            u64::from(g.admin_failures_per_ip.count),
        ),
        (
            "GRAFT_ADMIN_WINDOW_SECS",
            g.admin_failures_per_ip.window_secs,
        ),
        (
            "GRAFT_GLOBAL_PUBLISH_PER_HOUR",
            u64::from(g.global_publish_per_hour),
        ),
        (
            "GRAFT_GLOBAL_PUBLISH_BURST",
            u64::from(g.global_publish_burst),
        ),
        ("GRAFT_STORAGE_REFRESH_SECS", g.storage_refresh_secs),
    ] {
        if value == 0 {
            return Err(ConfigError::Invalid {
                name,
                reason: "must be at least 1".to_owned(),
            });
        }
    }
    // The threshold is the host's limit minus the overshoot bound; a limit smaller than the bound
    // would leave no room to admit anything, and the service would silently refuse every publish.
    if g.storage_limit_bytes <= g.overshoot_bound_bytes(limits) {
        return Err(ConfigError::Invalid {
            name: "GRAFT_STORAGE_LIMIT_BYTES",
            reason: format!(
                "must exceed the overshoot bound of {} bytes (the burst plus one refresh interval of the global cap, each as large as the largest blob)",
                g.overshoot_bound_bytes(limits)
            ),
        });
    }
    Ok(g)
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("bind", &self.bind)
            .field("database_url", &"redacted")
            .field(
                "admin_secret",
                &self.admin_secret.as_ref().map(|_| "redacted"),
            )
            .field("s3", &self.s3)
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl Config {
    /// Read configuration from the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        let vars: HashMap<String, String> = std::env::vars().collect();
        Self::from_lookup(|name| vars.get(name).cloned())
    }

    /// Read configuration through `lookup`, so tests need no process environment.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let database_url =
            lookup("GRAFT_DATABASE_URL").ok_or(ConfigError::Missing("GRAFT_DATABASE_URL"))?;
        let bind_text = lookup("GRAFT_BIND").unwrap_or_else(|| "127.0.0.1:8080".to_owned());
        let bind = bind_text.parse().map_err(|e| ConfigError::Invalid {
            name: "GRAFT_BIND",
            reason: format!("{e}"),
        })?;
        let cors_origins: Vec<String> = lookup("GRAFT_CORS_ORIGINS")
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        // An origin is scheme://host[:port] with no path or trailing slash; anything else would never
        // match, so it is refused here and not silently dropped later.
        for origin in &cors_origins {
            let ok = (origin.starts_with("http://") || origin.starts_with("https://"))
                && !origin.ends_with('/')
                && origin.matches("://").count() == 1
                && !origin
                    .trim_start_matches("https://")
                    .trim_start_matches("http://")
                    .contains('/')
                && axum::http::HeaderValue::from_str(origin).is_ok();
            if !ok {
                return Err(ConfigError::Invalid {
                    name: "GRAFT_CORS_ORIGINS",
                    reason: "each origin must look like https://example.com (no path, no trailing slash)"
                        .to_owned(),
                });
            }
        }
        let mut limits = Limits::default();
        number(
            &lookup,
            "GRAFT_MAX_CHAIN_DEPTH",
            &mut limits.max_chain_depth,
        )?;
        number(
            &lookup,
            "GRAFT_MAX_SOURCE_FRAMES",
            &mut limits.max_source_frames,
        )?;
        number(&lookup, "GRAFT_MAX_CUT_FRAMES", &mut limits.max_cut_frames)?;
        number(
            &lookup,
            "GRAFT_MAX_OUTPUT_FRAMES",
            &mut limits.max_output_frames,
        )?;
        number(&lookup, "GRAFT_MIN_FRAMES", &mut limits.min_frames)?;
        number(
            &lookup,
            "GRAFT_MAX_TITLE_CHARS",
            &mut limits.max_title_chars,
        )?;
        number(
            &lookup,
            "GRAFT_MAX_AUTHOR_CHARS",
            &mut limits.max_author_chars,
        )?;
        let mut blob_url_ttl_secs = 300;
        number(&lookup, "GRAFT_BLOB_URL_TTL_SECS", &mut blob_url_ttl_secs)?;
        let mut max_forks_per_stage_per_hour = 20;
        number(
            &lookup,
            "GRAFT_MAX_FORKS_PER_STAGE_PER_HOUR",
            &mut max_forks_per_stage_per_hour,
        )?;
        let mut blob_refresh_secs: u64 = 600;
        number(&lookup, "GRAFT_BLOB_REFRESH_SECS", &mut blob_refresh_secs)?;
        let mut orphan_grace_secs: u64 = 3600;
        number(&lookup, "GRAFT_ORPHAN_GRACE_SECS", &mut orphan_grace_secs)?;
        if blob_refresh_secs == 0 {
            return Err(ConfigError::Invalid {
                name: "GRAFT_BLOB_REFRESH_SECS",
                reason: "must be at least 1".to_owned(),
            });
        }
        // The grace period must outlast a blob's refresh threshold by a wide margin, or the cleanup
        // could take a blob that a publish refreshed just in time.
        if orphan_grace_secs < blob_refresh_secs.saturating_mul(2) {
            return Err(ConfigError::Invalid {
                name: "GRAFT_ORPHAN_GRACE_SECS",
                reason: "must be at least twice GRAFT_BLOB_REFRESH_SECS".to_owned(),
            });
        }
        let s3 = match lookup("GRAFT_BLOB_S3_BUCKET") {
            None => None,
            Some(bucket) => {
                let mut c = graft_storage::S3Config::new(
                    lookup("GRAFT_BLOB_S3_ENDPOINT"),
                    bucket,
                    lookup("GRAFT_BLOB_S3_REGION").unwrap_or_else(|| "us-east-1".to_owned()),
                    lookup("GRAFT_BLOB_S3_ACCESS_KEY_ID")
                        .ok_or(ConfigError::Missing("GRAFT_BLOB_S3_ACCESS_KEY_ID"))?,
                    lookup("GRAFT_BLOB_S3_SECRET_ACCESS_KEY")
                        .ok_or(ConfigError::Missing("GRAFT_BLOB_S3_SECRET_ACCESS_KEY"))?,
                );
                c.allow_http = lookup("GRAFT_BLOB_S3_ALLOW_HTTP").is_some_and(|v| v == "true");
                c.prefix = lookup("GRAFT_BLOB_S3_PREFIX");
                c.refresh_after = std::time::Duration::from_secs(blob_refresh_secs);
                Some(c)
            }
        };
        let admin_secret = lookup("GRAFT_ADMIN_SECRET");
        if admin_secret
            .as_ref()
            .is_some_and(|s| s.len() < crate::moderation::MIN_ADMIN_SECRET_LEN)
        {
            return Err(ConfigError::Invalid {
                name: "GRAFT_ADMIN_SECRET",
                reason: format!(
                    "must be at least {} characters",
                    crate::moderation::MIN_ADMIN_SECRET_LEN
                ),
            });
        }
        let mut lock_wait_ms = 10_000;
        number(&lookup, "GRAFT_LOCK_WAIT_MS", &mut lock_wait_ms)?;
        if lock_wait_ms == 0 {
            return Err(ConfigError::Invalid {
                name: "GRAFT_LOCK_WAIT_MS",
                reason: "must be at least 1".to_owned(),
            });
        }
        let mut request_timeout_secs: u64 = 30;
        number(
            &lookup,
            "GRAFT_REQUEST_TIMEOUT_SECS",
            &mut request_timeout_secs,
        )?;
        if request_timeout_secs == 0 {
            return Err(ConfigError::Invalid {
                name: "GRAFT_REQUEST_TIMEOUT_SECS",
                reason: "must be at least 1".to_owned(),
            });
        }
        let mut max_concurrent_renders: usize = 4;
        number(
            &lookup,
            "GRAFT_MAX_CONCURRENT_RENDERS",
            &mut max_concurrent_renders,
        )?;
        if max_concurrent_renders == 0 {
            return Err(ConfigError::Invalid {
                name: "GRAFT_MAX_CONCURRENT_RENDERS",
                reason: "must be at least 1".to_owned(),
            });
        }
        let mut serialization_retries = 5;
        number(
            &lookup,
            "GRAFT_SERIALIZATION_RETRIES",
            &mut serialization_retries,
        )?;
        validate(&limits, blob_url_ttl_secs)?;
        let guardrails = guardrails(&lookup, &limits)?;
        let events = event_settings(&lookup)?;
        let observability = observability(&lookup)?;
        if max_forks_per_stage_per_hour == 0 {
            return Err(ConfigError::Invalid {
                name: "GRAFT_MAX_FORKS_PER_STAGE_PER_HOUR",
                reason: "must be at least 1".to_owned(),
            });
        }
        let extra_deny_words = lookup("GRAFT_DENY_WORDS")
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self {
            bind,
            database_url,
            cors_origins,
            limits,
            blob_url_ttl_secs,
            max_forks_per_stage_per_hour,
            serialization_retries,
            lock_wait_ms,
            max_concurrent_renders,
            request_timeout_secs,
            renderer_wasm: lookup("GRAFT_RENDERER_WASM").map(std::path::PathBuf::from),
            extra_deny_words,
            admin_secret,
            blob_dir: lookup("GRAFT_BLOB_DIR").map(std::path::PathBuf::from),
            s3,
            blob_refresh_secs,
            orphan_grace_secs,
            guardrails,
            events,
            observability,
        })
    }
}

/// Refuse limits that cannot work, so the service fails at start-up and not on the first request.
fn validate(l: &Limits, blob_url_ttl_secs: u64) -> Result<(), ConfigError> {
    let invalid = |name, reason: &str| {
        Err(ConfigError::Invalid {
            name,
            reason: reason.to_owned(),
        })
    };
    if l.max_output_frames < l.min_frames || l.max_cut_frames > l.max_source_frames {
        return invalid(
            "GRAFT_MAX_OUTPUT_FRAMES",
            "the output maximum must be at least the minimum, and the cut maximum at most the source maximum",
        );
    }
    if l.max_chain_depth == 0 {
        return invalid("GRAFT_MAX_CHAIN_DEPTH", "must be at least 1");
    }
    if l.min_frames == 0 {
        return invalid("GRAFT_MIN_FRAMES", "must be at least 1");
    }
    if l.min_frames > l.max_cut_frames || l.min_frames > l.max_source_frames {
        return invalid(
            "GRAFT_MIN_FRAMES",
            "must not exceed the cut and source maximums",
        );
    }
    if l.max_cut_frames > l.max_source_frames {
        return invalid("GRAFT_MAX_CUT_FRAMES", "must not exceed the source maximum");
    }
    if l.max_title_chars == 0 || l.max_author_chars == 0 {
        return invalid("GRAFT_MAX_TITLE_CHARS", "text limits must be at least 1");
    }
    if blob_url_ttl_secs == 0 {
        return invalid("GRAFT_BLOB_URL_TTL_SECS", "must be at least 1");
    }
    Ok(())
}

fn number<T: std::str::FromStr>(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &'static str,
    target: &mut T,
) -> Result<(), ConfigError> {
    if let Some(text) = lookup(name) {
        *target = text.trim().parse().map_err(|_| ConfigError::Invalid {
            name,
            reason: format!("{text:?} is not a whole number"),
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    #[test]
    fn only_the_database_url_is_required_and_everything_else_defaults() {
        let c = Config::from_lookup(env(&[("GRAFT_DATABASE_URL", "postgres://x")])).expect("valid");
        assert_eq!(c.bind.to_string(), "127.0.0.1:8080");
        assert!(
            c.cors_origins.is_empty(),
            "no cross-origin access unless configured"
        );
        assert_eq!(c.limits, Limits::default());
        assert_eq!(c.blob_url_ttl_secs, 300);
        assert_eq!(
            (c.max_forks_per_stage_per_hour, c.serialization_retries),
            (20, 5)
        );
        assert!(c.renderer_wasm.is_none() && c.extra_deny_words.is_empty());
        assert!(
            c.admin_secret.is_none(),
            "admin access is off unless a secret is configured"
        );
    }

    #[test]
    fn a_request_may_take_thirty_seconds_unless_told_otherwise_and_never_none() {
        let db = ("GRAFT_DATABASE_URL", "postgres://x");
        let c = Config::from_lookup(env(&[db])).expect("valid");
        assert_eq!(c.request_timeout_secs, 30);
        let c =
            Config::from_lookup(env(&[db, ("GRAFT_REQUEST_TIMEOUT_SECS", "5")])).expect("valid");
        assert_eq!(c.request_timeout_secs, 5);
        for bad in ["0", "-1", "soon", ""] {
            let err = Config::from_lookup(env(&[db, ("GRAFT_REQUEST_TIMEOUT_SECS", bad)]))
                .expect_err("a request needs a real deadline");
            assert!(
                matches!(
                    err,
                    ConfigError::Invalid {
                        name: "GRAFT_REQUEST_TIMEOUT_SECS",
                        ..
                    }
                ),
                "{bad:?}: {err:?}"
            );
        }
    }

    #[test]
    fn a_missing_database_url_is_named_in_the_error() {
        assert_eq!(
            Config::from_lookup(env(&[])).expect_err("a database URL is required"),
            ConfigError::Missing("GRAFT_DATABASE_URL")
        );
    }

    #[test]
    fn limits_and_origins_can_be_overridden() {
        let c = Config::from_lookup(env(&[
            ("GRAFT_DATABASE_URL", "postgres://x"),
            ("GRAFT_MAX_CHAIN_DEPTH", "5"),
            ("GRAFT_CORS_ORIGINS", "https://a.example, https://b.example"),
            ("GRAFT_BIND", "0.0.0.0:9000"),
        ]))
        .expect("valid");
        assert_eq!(c.limits.max_chain_depth, 5);
        assert_eq!(
            c.cors_origins,
            vec!["https://a.example", "https://b.example"]
        );
        assert_eq!(c.bind.port(), 9000);
    }

    #[test]
    fn limits_that_cannot_work_stop_the_service_at_start_up() {
        for (name, value) in [
            ("GRAFT_MAX_CHAIN_DEPTH", "0"),
            ("GRAFT_MIN_FRAMES", "0"),
            ("GRAFT_MIN_FRAMES", "999999999"),
            ("GRAFT_MAX_CUT_FRAMES", "999999999"),
            ("GRAFT_MAX_TITLE_CHARS", "0"),
            ("GRAFT_BLOB_URL_TTL_SECS", "0"),
            ("GRAFT_MAX_FORKS_PER_STAGE_PER_HOUR", "0"),
        ] {
            let result = Config::from_lookup(env(&[
                ("GRAFT_DATABASE_URL", "postgres://x"),
                (name, value),
            ]));
            assert!(
                matches!(result, Err(ConfigError::Invalid { .. })),
                "{name}={value} should be refused, got {result:?}"
            );
        }
    }

    #[test]
    fn printing_a_config_never_shows_a_secret() {
        let c = Config::from_lookup(env(&[
            (
                "GRAFT_DATABASE_URL",
                "postgres://user:db-password-123@host/db",
            ),
            ("GRAFT_ADMIN_SECRET", "an-operator-secret-0123456789"),
            ("GRAFT_BLOB_S3_BUCKET", "audio"),
            ("GRAFT_BLOB_S3_ACCESS_KEY_ID", "AKIAEXAMPLEKEYID"),
            ("GRAFT_BLOB_S3_SECRET_ACCESS_KEY", "s3-secret-value-abcdef"),
        ]))
        .expect("valid");
        let printed = format!("{c:?} {:#?}", c);
        for secret in [
            "db-password-123",
            "an-operator-secret",
            "AKIAEXAMPLEKEYID",
            "s3-secret-value",
        ] {
            assert!(!printed.contains(secret), "{secret} leaked: {printed}");
        }
    }

    #[test]
    fn s3_settings_need_credentials_and_the_grace_period_must_outlast_the_refresh_threshold() {
        let base = [
            ("GRAFT_DATABASE_URL", "postgres://x"),
            ("GRAFT_BLOB_S3_BUCKET", "audio"),
        ];
        let missing = Config::from_lookup(env(&base)).expect_err("credentials are required");
        assert_eq!(missing, ConfigError::Missing("GRAFT_BLOB_S3_ACCESS_KEY_ID"));
        let ok = Config::from_lookup(env(&[
            ("GRAFT_DATABASE_URL", "postgres://x"),
            ("GRAFT_BLOB_S3_BUCKET", "audio"),
            ("GRAFT_BLOB_S3_ACCESS_KEY_ID", "k"),
            ("GRAFT_BLOB_S3_SECRET_ACCESS_KEY", "s"),
            (
                "GRAFT_BLOB_S3_ENDPOINT",
                "https://account.r2.cloudflarestorage.com",
            ),
            ("GRAFT_BLOB_S3_REGION", "auto"),
        ]))
        .expect("valid");
        assert!(ok.s3.is_some() && ok.blob_dir.is_none());
        for (refresh, grace) in [("600", "1199"), ("0", "3600")] {
            let err = Config::from_lookup(env(&[
                ("GRAFT_DATABASE_URL", "postgres://x"),
                ("GRAFT_BLOB_REFRESH_SECS", refresh),
                ("GRAFT_ORPHAN_GRACE_SECS", grace),
            ]))
            .expect_err("too short");
            assert!(
                matches!(err, ConfigError::Invalid { .. }),
                "{refresh}/{grace}: {err:?}"
            );
        }
    }

    #[test]
    fn a_malformed_cors_origin_is_refused_and_an_output_limit_below_the_minimum_too() {
        for origin in [
            "example.com",
            "https://example.com/",
            "https://example.com/path",
            "ftp://x",
        ] {
            let r = Config::from_lookup(env(&[
                ("GRAFT_DATABASE_URL", "postgres://x"),
                ("GRAFT_CORS_ORIGINS", origin),
            ]));
            assert!(
                matches!(
                    r,
                    Err(ConfigError::Invalid {
                        name: "GRAFT_CORS_ORIGINS",
                        ..
                    })
                ),
                "{origin}"
            );
        }
        let ok = Config::from_lookup(env(&[
            ("GRAFT_DATABASE_URL", "postgres://x"),
            (
                "GRAFT_CORS_ORIGINS",
                "https://a.example, http://localhost:3000",
            ),
        ]));
        assert!(ok.is_ok());
        let bad = Config::from_lookup(env(&[
            ("GRAFT_DATABASE_URL", "postgres://x"),
            ("GRAFT_MAX_OUTPUT_FRAMES", "100"),
        ]));
        assert!(matches!(bad, Err(ConfigError::Invalid { .. })));
    }

    #[test]
    fn the_guardrail_defaults_leave_a_threshold_below_the_hosts_limit_by_the_overshoot_bound() {
        let c = Config::from_lookup(env(&[("GRAFT_DATABASE_URL", "postgres://x")])).expect("valid");
        let g = &c.guardrails;
        // The largest blob is the 20 s output: 960,000 frames of 2 bytes. A burst of 30 plus one
        // minute of the 120-an-hour cap (2) is 32 of them.
        assert_eq!(g.overshoot_bound_bytes(&c.limits), 32 * 1_920_000);
        assert_eq!(
            g.admission_threshold_bytes(&c.limits),
            8_000_000_000 - 32 * 1_920_000
        );
        assert!(g.publishing_default);
        assert!(!g.uploads_enabled, "visitor uploads are off by default");
        assert_eq!(g.trusted_proxy_hops, 0);
    }

    #[test]
    fn a_storage_limit_that_leaves_no_room_for_the_overshoot_is_refused_at_start_up() {
        let err = Config::from_lookup(env(&[
            ("GRAFT_DATABASE_URL", "postgres://x"),
            ("GRAFT_STORAGE_LIMIT_BYTES", "1000000"),
        ]))
        .expect_err("refused");
        assert!(
            err.to_string().contains("GRAFT_STORAGE_LIMIT_BYTES"),
            "{err}"
        );
    }

    #[test]
    fn guardrail_settings_can_be_overridden_and_nonsense_is_refused_by_name() {
        let c = Config::from_lookup(env(&[
            ("GRAFT_DATABASE_URL", "postgres://x"),
            ("GRAFT_PUBLISHING", "off"),
            ("GRAFT_TRUSTED_PROXY_HOPS", "2"),
            ("GRAFT_PUBLISH_PER_IP", "5"),
            ("GRAFT_PUBLISH_WINDOW_SECS", "60"),
        ]))
        .expect("valid");
        assert!(!c.guardrails.publishing_default);
        assert_eq!(c.guardrails.trusted_proxy_hops, 2);
        assert_eq!(
            c.guardrails.publish_per_ip,
            Rate {
                count: 5,
                window_secs: 60
            }
        );
        for (name, value) in [
            ("GRAFT_PUBLISHING", "maybe"),
            ("GRAFT_UPLOADS", "yes"),
            ("GRAFT_PUBLISH_PER_IP", "0"),
            ("GRAFT_GLOBAL_PUBLISH_BURST", "0"),
            ("GRAFT_STORAGE_REFRESH_SECS", "0"),
        ] {
            let err = Config::from_lookup(env(&[
                ("GRAFT_DATABASE_URL", "postgres://x"),
                (name, value),
            ]))
            .expect_err("refused");
            assert!(err.to_string().contains(name), "{name}: {err}");
        }
    }

    #[test]
    fn the_event_pipeline_defaults_and_overrides_and_refuses_nonsense_by_name() {
        let c = Config::from_lookup(env(&[("GRAFT_DATABASE_URL", "postgres://x")])).expect("valid");
        assert_eq!(
            c.events,
            EventSettings {
                pipeline: true,
                relay_batch: 100,
                relay_interval_ms: 1000,
                retention_days: 30,
                retention_interval_secs: 3600,
                ingest_max_batch: 20
            }
        );
        let c = Config::from_lookup(env(&[
            ("GRAFT_DATABASE_URL", "postgres://x"),
            ("GRAFT_EVENT_PIPELINE", "off"),
            ("GRAFT_EVENT_RETENTION_DAYS", "7"),
        ]))
        .expect("valid");
        assert!(!c.events.pipeline);
        assert_eq!(c.events.retention_days, 7);
        for (name, value) in [
            ("GRAFT_EVENT_PIPELINE", "sometimes"),
            ("GRAFT_RELAY_BATCH", "0"),
            ("GRAFT_EVENT_RETENTION_DAYS", "0"),
        ] {
            let err = Config::from_lookup(env(&[
                ("GRAFT_DATABASE_URL", "postgres://x"),
                (name, value),
            ]))
            .expect_err("refused");
            assert!(err.to_string().contains(name), "{name}: {err}");
        }
    }

    #[test]
    fn a_short_admin_secret_is_refused_and_never_echoed() {
        let err = Config::from_lookup(env(&[
            ("GRAFT_DATABASE_URL", "postgres://x"),
            ("GRAFT_ADMIN_SECRET", "short-secret"),
        ]))
        .expect_err("too short");
        assert!(matches!(
            err,
            ConfigError::Invalid {
                name: "GRAFT_ADMIN_SECRET",
                ..
            }
        ));
        assert!(!format!("{err}").contains("short-secret"));
        let ok = Config::from_lookup(env(&[
            ("GRAFT_DATABASE_URL", "postgres://x"),
            ("GRAFT_ADMIN_SECRET", &"s".repeat(24)),
        ]));
        assert!(ok.is_ok());
    }

    #[test]
    fn a_bad_number_is_refused_with_the_variable_name_and_never_echoes_the_database_url() {
        let err = Config::from_lookup(env(&[
            ("GRAFT_DATABASE_URL", "postgres://user:secret@host/db"),
            ("GRAFT_MAX_CHAIN_DEPTH", "twelve"),
        ]))
        .expect_err("invalid");
        assert!(matches!(
            err,
            ConfigError::Invalid {
                name: "GRAFT_MAX_CHAIN_DEPTH",
                ..
            }
        ));
        assert!(!format!("{err}").contains("secret"));
    }
}
