//! Removing what must never leave the service from text that is about to: secrets the service
//! holds, manage keys, connection strings and addresses. It is applied to every error report before
//! it is sent, as a second line of defence behind never putting these in messages at all.

use std::net::{IpAddr, SocketAddr};

const REDACTED: &str = "[redacted]";
const ADDRESS: &str = "[address]";

/// A scrubber that knows the secrets this process holds.
#[derive(Debug, Clone, Default)]
pub struct Scrubber {
    secrets: Vec<String>,
}

impl Scrubber {
    /// A scrubber for `secrets` (values shorter than 8 characters are not treated as secrets: they
    /// would redact ordinary words).
    #[must_use]
    pub fn new(secrets: impl IntoIterator<Item = String>) -> Self {
        Self {
            secrets: secrets.into_iter().filter(|s| s.len() >= 8).collect(),
        }
    }

    /// `input` with every known secret, hexadecimal key, address and credential in a URL replaced.
    #[must_use]
    pub fn text(&self, input: &str) -> String {
        let mut text = input.to_owned();
        for secret in &self.secrets {
            text = text.replace(secret.as_str(), REDACTED);
        }
        let mut out = String::with_capacity(text.len());
        let mut word = String::new();
        for c in text.chars() {
            if is_separator(c) {
                out.push_str(&redact_word(&word));
                word.clear();
                out.push(c);
            } else {
                word.push(c);
            }
        }
        out.push_str(&redact_word(&word));
        out
    }
}

fn is_separator(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '"' | '\'' | ',' | ';' | '(' | ')' | '{' | '}' | '<' | '>' | '='
        )
}

fn redact_word(word: &str) -> String {
    if word.is_empty() {
        return String::new();
    }
    // Credentials in a URL: keep the scheme and the rest, drop the user and password.
    if let Some((scheme, rest)) = word.split_once("://")
        && let Some((_, after)) = rest.split_once('@')
    {
        return format!("{scheme}://{REDACTED}@{after}");
    }
    // A 128-bit or longer hexadecimal run is a key or a hash of one.
    let trimmed = word.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    if trimmed.len() >= 32 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return word.replace(trimmed, REDACTED);
    }
    // An address, with or without a port, with or without brackets.
    let candidate = word.trim_matches(|c: char| matches!(c, '[' | ']' | '.' | ':' | '/' | '\\'));
    let is_address =
        |text: &str| text.parse::<IpAddr>().is_ok() || text.parse::<SocketAddr>().is_ok();
    if is_address(word) || is_address(candidate) {
        return ADDRESS.to_owned();
    }
    word.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scrubber() -> Scrubber {
        Scrubber::new([
            "an-operator-secret-0123456789".to_owned(),
            "short".to_owned(),
        ])
    }

    #[test]
    fn a_known_secret_is_removed_wherever_it_appears() {
        let out = scrubber().text("header an-operator-secret-0123456789 was refused; again an-operator-secret-0123456789.");
        assert!(!out.contains("operator-secret"), "{out}");
        assert!(out.contains(REDACTED));
    }

    #[test]
    fn a_value_shorter_than_eight_characters_is_not_treated_as_a_secret() {
        assert_eq!(scrubber().text("a short word"), "a short word");
    }

    #[test]
    fn a_manage_key_or_any_long_hexadecimal_run_is_removed() {
        let key = "ab".repeat(32);
        let out = scrubber().text(&format!("x-graft-manage-key: {key} failed, hash={key}"));
        assert!(!out.contains(&key), "{out}");
        // A short hexadecimal word is left alone.
        assert_eq!(scrubber().text("deadbeef"), "deadbeef");
    }

    #[test]
    fn addresses_are_removed_with_and_without_ports_and_in_both_families() {
        for text in [
            "from 203.0.113.9 refused",
            "peer 203.0.113.9:40000 refused",
            "peer [2001:db8::1]:443 refused",
            "forwarded 2001:db8:1:2::9 refused",
        ] {
            let out = scrubber().text(text);
            assert!(out.contains(ADDRESS), "{text} -> {out}");
            assert!(
                !out.contains("203.0.113") && !out.contains("2001:db8"),
                "{text} -> {out}"
            );
        }
    }

    #[test]
    fn credentials_in_a_url_are_removed_and_the_rest_is_kept() {
        let out = scrubber().text("connect postgres://graft:hunter2@db-internal:5432/graft failed");
        assert!(!out.contains("hunter2") && !out.contains("graft:"), "{out}");
        assert!(out.contains("db-internal:5432/graft"), "{out}");
    }

    #[test]
    fn ordinary_text_times_and_versions_are_untouched() {
        let text = "request failed at 12:34:56 in graft-render 1 with code 500 (version 1.2.3)";
        assert_eq!(scrubber().text(text), text);
    }
}
