//! The message a batch of events travels in: one versioned JSON document. The version is the
//! compatibility rule. A reader accepts only the versions it knows, and a message it cannot read is
//! left in the queue (and so reaches the dead-letter queue) instead of being guessed at. New optional
//! fields may be added within a version; anything that changes the meaning of a field is a new version.

use graft_storage::{EventKind, Origin, StoredEvent};
use serde::{Deserialize, Serialize};

/// The version this build writes and reads.
pub const VERSION: u32 = 1;

/// The most bytes in one message body we make. The queue allows 256 KiB for a whole send of ten
/// messages, so ten of these always fit in one request.
pub const MAX_MESSAGE_BYTES: usize = 24 * 1024;

/// `{"v":1,"events":[]}`
const OVERHEAD: usize = 19;

/// Why a message could not be made or read.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EnvelopeError {
    /// One event alone is larger than a message may be.
    #[error("event {0} is too large for one message")]
    TooLarge(String),
    /// The body is not JSON of the expected shape.
    #[error("the message is not readable: {0}")]
    Unreadable(String),
    /// The message was written by a version this build does not know.
    #[error("the message is version {0}, which this build does not read")]
    UnknownVersion(u32),
    /// An event in the message has a kind or origin this build does not know.
    #[error("the message has an event this build does not know: {0}")]
    UnknownEvent(String),
}

#[derive(Serialize, Deserialize)]
struct Wire {
    v: u32,
    events: Vec<WireEvent>,
}

#[derive(Deserialize)]
struct Probe {
    v: u32,
}

#[derive(Serialize, Deserialize)]
struct WireEvent {
    seq: i64,
    event_id: String,
    kind: String,
    origin: String,
    #[serde(default)]
    session_id: Option<String>,
    occurred_at_ms: i64,
    hour_ms: i64,
    #[serde(default)]
    publication_id: Option<String>,
    #[serde(default)]
    detail: Option<String>,
}

impl From<&StoredEvent> for WireEvent {
    fn from(e: &StoredEvent) -> Self {
        Self {
            seq: e.seq,
            event_id: e.event_id.clone(),
            kind: e.kind.as_str().to_owned(),
            origin: e.origin.as_str().to_owned(),
            session_id: e.session_id.clone(),
            occurred_at_ms: e.occurred_at_ms,
            hour_ms: e.hour_ms,
            publication_id: e.publication_id.clone(),
            detail: e.detail.clone(),
        }
    }
}

impl TryFrom<WireEvent> for StoredEvent {
    type Error = EnvelopeError;

    fn try_from(w: WireEvent) -> Result<Self, Self::Error> {
        let kind = EventKind::parse(&w.kind)
            .ok_or_else(|| EnvelopeError::UnknownEvent(format!("kind {}", w.kind)))?;
        let origin = match w.origin.as_str() {
            "server" => Origin::Server,
            "client" => Origin::Client,
            other => return Err(EnvelopeError::UnknownEvent(format!("origin {other}"))),
        };
        Ok(Self {
            seq: w.seq,
            event_id: w.event_id,
            kind,
            origin,
            session_id: w.session_id,
            occurred_at_ms: w.occurred_at_ms,
            hour_ms: w.hour_ms,
            publication_id: w.publication_id,
            detail: w.detail,
        })
    }
}

fn message(events: Vec<WireEvent>) -> Result<String, EnvelopeError> {
    serde_json::to_string(&Wire { v: VERSION, events })
        .map_err(|e| EnvelopeError::Unreadable(e.to_string()))
}

/// Put a batch in as few messages as fit, in order. Every message is at most
/// [`MAX_MESSAGE_BYTES`]; an empty batch makes none.
pub fn encode(batch: &[StoredEvent]) -> Result<Vec<String>, EnvelopeError> {
    let mut messages = Vec::new();
    let mut current: Vec<WireEvent> = Vec::new();
    let mut size = OVERHEAD;
    for event in batch {
        let wire = WireEvent::from(event);
        // the event's own length, and the comma that separates it from the one before
        let n = serde_json::to_string(&wire)
            .map_err(|e| EnvelopeError::Unreadable(e.to_string()))?
            .len()
            + 1;
        if OVERHEAD + n > MAX_MESSAGE_BYTES {
            return Err(EnvelopeError::TooLarge(event.event_id.clone()));
        }
        if size + n > MAX_MESSAGE_BYTES && !current.is_empty() {
            messages.push(message(std::mem::take(&mut current))?);
            size = OVERHEAD;
        }
        current.push(wire);
        size += n;
    }
    if !current.is_empty() {
        messages.push(message(current)?);
    }
    Ok(messages)
}

/// Read the events out of one message body.
pub fn decode(body: &str) -> Result<Vec<StoredEvent>, EnvelopeError> {
    let probe: Probe =
        serde_json::from_str(body).map_err(|e| EnvelopeError::Unreadable(e.to_string()))?;
    if probe.v != VERSION {
        return Err(EnvelopeError::UnknownVersion(probe.v));
    }
    let wire: Wire =
        serde_json::from_str(body).map_err(|e| EnvelopeError::Unreadable(e.to_string()))?;
    wire.events.into_iter().map(StoredEvent::try_from).collect()
}
