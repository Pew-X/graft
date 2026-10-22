//! Public identifiers.

use crate::hash::Sha256Hash;
use std::fmt;

const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
const LEN: usize = 12;
const SEED_DOMAIN: &[u8] = b"graft-seeded-publication-v1:";

/// An opaque, non-sequential, URL-safe publication id: 60 bits as 12 characters.
///
/// Visitor publications get random ids from the service. Seeded publications get ids derived from
/// their deterministic retry key ([`PublicationId::seeded`]), so that ids, content hashes and the
/// static snapshot are the same in every environment.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PublicationId(String);

/// The text is not a publication id.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("a publication id is 12 characters from 0-9 and a-z without i, l, o and u")]
pub struct ParseIdError;

impl PublicationId {
    /// Encode the low 60 bits of `bits`.
    #[must_use]
    pub fn from_bits(bits: u64) -> Self {
        let n = bits & ((1 << 60) - 1);
        let text = (0..LEN)
            .map(|i| char::from(ALPHABET[((n >> (5 * (LEN - 1 - i))) & 31) as usize]))
            .collect();
        Self(text)
    }

    /// The id of a seeded publication, derived from its retry key.
    #[must_use]
    pub fn seeded(retry_key: &str) -> Self {
        let mut input = SEED_DOMAIN.to_vec();
        input.extend_from_slice(retry_key.as_bytes());
        let digest = Sha256Hash::of(&input);
        let mut first = [0u8; 8];
        first.copy_from_slice(&digest.as_bytes()[..8]);
        Self::from_bits(u64::from_be_bytes(first))
    }

    /// Parse a publication id from untrusted text.
    pub fn parse(text: &str) -> Result<Self, ParseIdError> {
        let ok = text.len() == LEN && text.bytes().all(|b| ALPHABET.contains(&b));
        if ok {
            Ok(Self(text.to_owned()))
        } else {
            Err(ParseIdError)
        }
    }

    /// The id as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PublicationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for PublicationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PublicationId({})", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_seeded_id_matches_an_independent_derivation() {
        // Derived outside Rust: sha256("graft-seeded-publication-v1:seed:jazz-rhodes:source"),
        // first 8 bytes big-endian, low 60 bits, five bits per character.
        assert_eq!(
            PublicationId::seeded("seed:jazz-rhodes:source").as_str(),
            "e790b6ycz0yd"
        );
    }

    #[test]
    fn different_retry_keys_give_different_ids() {
        assert_ne!(
            PublicationId::seeded("seed:a"),
            PublicationId::seeded("seed:b")
        );
    }

    #[test]
    fn bits_beyond_sixty_are_ignored_and_ids_always_parse_back() {
        let id = PublicationId::from_bits(u64::MAX);
        assert_eq!(id.as_str(), "zzzzzzzzzzzz");
        assert_eq!(PublicationId::parse(id.as_str()), Ok(id));
        assert_eq!(PublicationId::from_bits(0).as_str(), "000000000000");
    }

    #[test]
    fn parse_refuses_wrong_length_case_and_lookalike_characters() {
        for bad in [
            "",
            "e790b6ycz0y",
            "e790b6ycz0ydd",
            "E790B6YCZ0YD",
            "e790b6ycz0yu",
            "e790b6ycz0y/",
            "e790b6ycz0yé",
        ] {
            assert!(
                PublicationId::parse(bad).is_err(),
                "{bad:?} should be refused"
            );
        }
    }
}
