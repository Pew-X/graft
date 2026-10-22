//! SHA-256 digests as they appear in records: 32 bytes, shown as 64 lowercase hex characters.

use sha2::{Digest, Sha256};
use std::fmt;

/// A SHA-256 digest, used for blobs, content records and the renderer artefact.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Sha256Hash([u8; 32]);

/// The text is not 64 lowercase hex characters.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("a hash is 64 lowercase hexadecimal characters")]
pub struct ParseHashError;

impl Sha256Hash {
    /// Hash `bytes`.
    #[must_use]
    pub fn of(bytes: &[u8]) -> Self {
        Self(Sha256::digest(bytes).into())
    }

    /// Wrap raw digest bytes.
    #[must_use]
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// The raw digest bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// The 64-character lowercase hex form.
    #[must_use]
    pub fn to_hex(&self) -> String {
        use fmt::Write;
        self.0.iter().fold(String::with_capacity(64), |mut s, b| {
            // Writing to a String cannot fail.
            let _ = write!(s, "{b:02x}");
            s
        })
    }

    /// Parse the 64-character lowercase hex form; uppercase and wrong lengths are refused.
    pub fn parse(text: &str) -> Result<Self, ParseHashError> {
        if text.len() != 64 {
            return Err(ParseHashError);
        }
        let mut out = [0u8; 32];
        for (i, pair) in text.as_bytes().chunks(2).enumerate() {
            let hi = nibble(pair[0]).ok_or(ParseHashError)?;
            let lo = nibble(pair[1]).ok_or(ParseHashError)?;
            out[i] = (hi << 4) | lo;
        }
        Ok(Self(out))
    }
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

impl fmt::Display for Sha256Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl fmt::Debug for Sha256Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Sha256Hash({})", self.to_hex())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_empty_input_has_the_published_sha256() {
        // FIPS 180-4 / NIST example value for the empty message.
        assert_eq!(
            Sha256Hash::of(b"").to_hex(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn hex_round_trips_and_refuses_anything_but_lowercase_64() {
        let h = Sha256Hash::of(b"abc");
        assert_eq!(Sha256Hash::parse(&h.to_hex()), Ok(h));
        assert!(Sha256Hash::parse(&h.to_hex().to_uppercase()).is_err());
        assert!(Sha256Hash::parse(&h.to_hex()[..63]).is_err());
        assert!(Sha256Hash::parse(&format!("{}0", h.to_hex())).is_err());
        assert!(Sha256Hash::parse(&"g".repeat(64)).is_err());
    }
}
