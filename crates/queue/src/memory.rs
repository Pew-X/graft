//! An in-memory queue with the behaviour that matters: a message that is received and not deleted
//! comes back, and after enough receives it is set aside. For tests and for running without a queue
//! service; time is a method (`expire_visibility`), so a test never waits.

use crate::transport::{QueueError, Received, Transport};
use graft_storage::blob::BoxFuture;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

struct Message {
    id: u64,
    body: String,
    receives: u32,
}

#[derive(Default)]
struct State {
    next: u64,
    ready: VecDeque<Message>,
    in_flight: Vec<Message>,
    dead: Vec<String>,
    fail_sends: u32,
    sent: usize,
}

/// A queue held in memory.
pub struct MemoryQueue {
    state: Mutex<State>,
    max_receives: u32,
}

impl MemoryQueue {
    /// A queue that sets a message aside once it has been received `max_receives` times without being
    /// deleted, as a queue's redrive policy does.
    #[must_use]
    pub fn new(max_receives: u32) -> Self {
        Self {
            state: Mutex::new(State::default()),
            max_receives,
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        // a poisoned lock only means a test thread panicked; the data is still sound
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        f(&mut guard)
    }

    /// Fail the next `n` sends, so a test can watch the sink report a failure.
    pub fn fail_next_sends(&self, n: u32) {
        self.with(|s| s.fail_sends = n);
    }

    /// The visibility timeout passing: every message that was received and not deleted becomes
    /// available again, or is set aside if it has been received too many times.
    pub fn expire_visibility(&self) {
        let max = self.max_receives;
        self.with(|s| {
            for m in std::mem::take(&mut s.in_flight) {
                if m.receives >= max {
                    s.dead.push(m.body);
                } else {
                    s.ready.push_back(m);
                }
            }
        });
    }

    /// Bodies waiting to be received.
    #[must_use]
    pub fn ready(&self) -> usize {
        self.with(|s| s.ready.len())
    }

    /// Bodies received and not yet deleted.
    #[must_use]
    pub fn in_flight(&self) -> usize {
        self.with(|s| s.in_flight.len())
    }

    /// Bodies set aside after too many receives.
    #[must_use]
    pub fn dead_letters(&self) -> Vec<String> {
        self.with(|s| s.dead.clone())
    }

    /// How many bodies have been sent in all.
    #[must_use]
    pub fn sent(&self) -> usize {
        self.with(|s| s.sent)
    }

    /// Put a body in the queue directly, as something other than the sink might.
    pub fn put(&self, body: &str) {
        self.with(|s| {
            let id = s.next;
            s.next += 1;
            s.sent += 1;
            s.ready.push_back(Message {
                id,
                body: body.to_owned(),
                receives: 0,
            });
        });
    }
}

impl Transport for MemoryQueue {
    fn send<'a>(&'a self, bodies: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>> {
        Box::pin(async move {
            let refused = self.with(|s| {
                if s.fail_sends > 0 {
                    s.fail_sends -= 1;
                    true
                } else {
                    false
                }
            });
            if refused {
                return Err(QueueError::Request("told to fail".to_owned()));
            }
            for body in bodies {
                self.put(body);
            }
            Ok(())
        })
    }

    fn receive(
        &self,
        wait: Duration,
        max: u32,
    ) -> BoxFuture<'_, Result<Vec<Received>, QueueError>> {
        Box::pin(async move {
            // a real queue waits for messages; this one waits a moment, so a loop over it is paced
            tokio::time::sleep(wait.min(Duration::from_millis(5))).await;
            Ok(self.with(|s| {
                let mut out = Vec::new();
                while out.len() < max as usize {
                    let Some(mut m) = s.ready.pop_front() else {
                        break;
                    };
                    m.receives += 1;
                    out.push(Received {
                        receipt: format!("{}#{}", m.id, m.receives),
                        body: m.body.clone(),
                        receive_count: m.receives,
                    });
                    s.in_flight.push(m);
                }
                out
            }))
        })
    }

    fn delete<'a>(&'a self, receipts: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>> {
        Box::pin(async move {
            self.with(|s| {
                s.in_flight
                    .retain(|m| !receipts.contains(&format!("{}#{}", m.id, m.receives)));
            });
            Ok(())
        })
    }
}
