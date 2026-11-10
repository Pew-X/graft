//! The consumer that long-polls the queue and applies what it receives.

use crate::envelope::decode;
use crate::transport::{QueueError, Transport};
use graft_events::BatchConsumer;
use std::sync::Arc;
use std::time::Duration;

/// How the consumer polls. The defaults are the ones to deploy: a long wait, so an idle queue costs
/// a few thousand requests a day and not a request a moment.
#[derive(Debug, Clone, Copy)]
pub struct PollSettings {
    /// How long one receive may wait for messages (the queue allows up to 20 seconds).
    pub wait: Duration,
    /// The most messages one receive returns (the queue allows 10).
    pub max: u32,
    /// The pause after a receive that returned nothing. A receive that returns at once with nothing
    /// (a short poll by mistake) must not become a busy loop, so this is a floor under that.
    pub empty_pause: Duration,
    /// The pause after a failed receive, doubling on each failure up to `backoff_max`.
    pub backoff_min: Duration,
    /// The longest pause after failures.
    pub backoff_max: Duration,
}

impl Default for PollSettings {
    fn default() -> Self {
        Self {
            wait: Duration::from_secs(20),
            max: 10,
            empty_pause: Duration::from_millis(500),
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
        }
    }
}

/// What one receive did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PollReport {
    /// Messages the queue handed out.
    pub received: usize,
    /// Messages applied and deleted.
    pub applied: usize,
    /// Messages whose events could not be applied this time. They stay in the queue and come back.
    pub failed: usize,
    /// Messages that could not be read at all (an unknown version, a broken body). They stay in the
    /// queue too, and the queue sets them aside after enough receives.
    pub unreadable: usize,
}

/// Applies queue messages with the same idempotent consumer the Postgres-only path uses. A message is
/// deleted only after its events were applied, so a crash anywhere loses nothing and a repeat counts
/// once. A message that fails is never deleted here: the queue's own redrive moves it to the
/// dead-letter queue after a bounded number of receives.
pub struct QueueConsumer {
    transport: Arc<dyn Transport>,
    apply: Arc<dyn BatchConsumer>,
    settings: PollSettings,
}

impl QueueConsumer {
    /// A consumer reading `transport` and applying with `apply`.
    #[must_use]
    pub fn new(
        transport: Arc<dyn Transport>,
        apply: Arc<dyn BatchConsumer>,
        settings: PollSettings,
    ) -> Self {
        Self {
            transport,
            apply,
            settings,
        }
    }

    /// One receive: apply each message, then delete the ones that were applied.
    pub async fn poll_once(&self) -> Result<PollReport, QueueError> {
        let messages = self
            .transport
            .receive(self.settings.wait, self.settings.max)
            .await?;
        let mut report = PollReport {
            received: messages.len(),
            ..PollReport::default()
        };
        let mut done = Vec::new();
        for message in messages {
            let events = match decode(&message.body) {
                Ok(events) => events,
                Err(error) => {
                    report.unreadable += 1;
                    tracing::error!(%error, receives = message.receive_count, "an unreadable queue message was left in the queue");
                    continue;
                }
            };
            match self.apply.apply(&events).await {
                Ok(()) => {
                    report.applied += 1;
                    done.push(message.receipt);
                }
                Err(error) => {
                    report.failed += 1;
                    tracing::warn!(%error, receives = message.receive_count, "a queue message could not be applied and was left in the queue");
                }
            }
        }
        if !done.is_empty() {
            self.transport.delete(&done).await?;
        }
        Ok(report)
    }

    /// Poll until `stop` changes. Stopping while a receive is waiting or a message is being applied is
    /// safe: nothing is deleted before it is applied, so the message simply comes back.
    pub async fn run(&self, mut stop: tokio::sync::watch::Receiver<bool>) {
        let mut backoff = self.settings.backoff_min;
        loop {
            let pause = tokio::select! {
                polled = self.poll_once() => match polled {
                    Ok(report) => {
                        backoff = self.settings.backoff_min;
                        if report.received == 0 { self.settings.empty_pause } else { Duration::ZERO }
                    }
                    Err(error) => {
                        tracing::error!(%error, "reading the event queue failed");
                        let pause = backoff;
                        backoff = (backoff * 2).min(self.settings.backoff_max);
                        pause
                    }
                },
                _ = stop.changed() => return,
            };
            if pause > Duration::ZERO {
                tokio::select! {
                    () = tokio::time::sleep(pause) => {}
                    _ = stop.changed() => return,
                }
            }
        }
    }
}
