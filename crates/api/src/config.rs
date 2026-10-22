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

/// Everything the service reads at start-up.
#[derive(Debug, Clone, PartialEq, Eq)]
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
        validate(&limits, blob_url_ttl_secs)?;
        Ok(Self {
            bind,
            database_url,
            cors_origins,
            limits,
            blob_url_ttl_secs,
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
    }

    #[test]
    fn a_missing_database_url_is_named_in_the_error() {
        assert_eq!(
            Config::from_lookup(env(&[])),
            Err(ConfigError::Missing("GRAFT_DATABASE_URL"))
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
