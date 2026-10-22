//! The pinned renderer hashes, one per version (`fixtures/renderer/PINS`).

use crate::error::ArtefactError;
use std::collections::BTreeMap;

/// Version to SHA-256 of the artefact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pins(BTreeMap<u32, String>);

impl Pins {
    /// Parses the pin file format: `<version> <sha256>` per line, `#` comments.
    ///
    /// # Errors
    /// [`ArtefactError::BadPins`] for a malformed or duplicated line.
    pub fn parse(text: &str) -> Result<Self, ArtefactError> {
        let mut map = BTreeMap::new();
        for line in text
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        {
            let bad = || ArtefactError::BadPins(line.to_string());
            let (version, sha) = line.split_once(' ').ok_or_else(bad)?;
            let version: u32 = version.parse().map_err(|_| bad())?;
            let is_sha =
                sha.len() == 64 && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
            if !is_sha || map.insert(version, sha.to_string()).is_some() {
                return Err(bad());
            }
        }
        Ok(Self(map))
    }

    /// The pins committed to the repository, compiled into the binary.
    ///
    /// # Errors
    /// [`ArtefactError::BadPins`] if the committed file is malformed.
    pub fn embedded() -> Result<Self, ArtefactError> {
        Self::parse(include_str!("../../../fixtures/renderer/PINS"))
    }

    /// The pinned hash for a version.
    #[must_use]
    pub fn get(&self, version: u32) -> Option<&str> {
        self.0.get(&version).map(String::as_str)
    }
}
