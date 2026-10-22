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
        let cors_origins = lookup("GRAFT_CORS_ORIGINS")
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
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
        let mut serialization_retries = 5;
        number(
            &lookup,
            "GRAFT_SERIALIZATION_RETRIES",
            &mut serialization_retries,
        )?;
        validate(&limits, blob_url_ttl_secs)?;
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
            renderer_wasm: lookup("GRAFT_RENDERER_WASM").map(std::path::PathBuf::from),
            extra_deny_words,
            admin_secret,
            blob_dir: lookup("GRAFT_BLOB_DIR").map(std::path::PathBuf::from),
            s3,
            blob_refresh_secs,
            orphan_grace_secs,
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
