//! The queue service itself, through the AWS SDK. Credentials come from the environment the task runs
//! in (its role); nothing is read from a file in the repository.

use crate::transport::{QueueError, Received, Transport};
use aws_config::BehaviorVersion;
use aws_config::meta::region::RegionProviderChain;
use aws_config::timeout::TimeoutConfig;
use aws_sdk_sqs::Client;
use aws_sdk_sqs::types::{
    DeleteMessageBatchRequestEntry, MessageSystemAttributeName, SendMessageBatchRequestEntry,
};
use graft_storage::blob::BoxFuture;
use std::time::Duration;

/// The service takes at most ten messages in one batch request.
const BATCH: usize = 10;

/// Where the deployed service runs, used only when the environment names no region.
const FALLBACK_REGION: &str = "ap-south-1";

/// One queue, reached through the SDK.
pub struct SqsTransport {
    client: Client,
    url: String,
}

impl SqsTransport {
    /// Connect to the queue at `url`. `endpoint` replaces the service's address, for an emulator.
    pub async fn connect(url: &str, endpoint: Option<&str>) -> Self {
        let region = RegionProviderChain::default_provider().or_else(FALLBACK_REGION);
        let mut loader = aws_config::defaults(BehaviorVersion::latest())
            .region(region)
            // a receive may wait 20 seconds, so the limits sit above that
            .timeout_config(
                TimeoutConfig::builder()
                    .operation_attempt_timeout(Duration::from_secs(30))
                    .operation_timeout(Duration::from_secs(45))
                    .build(),
            );
        if let Some(endpoint) = endpoint {
            loader = loader.endpoint_url(endpoint);
        }
        let config = loader.load().await;
        Self {
            client: Client::new(&config),
            url: url.to_owned(),
        }
    }
}

fn request(error: impl std::fmt::Display) -> QueueError {
    QueueError::Request(error.to_string())
}

impl Transport for SqsTransport {
    fn send<'a>(&'a self, bodies: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>> {
        Box::pin(async move {
            for chunk in bodies.chunks(BATCH) {
                let entries = chunk
                    .iter()
                    .enumerate()
                    .map(|(i, body)| {
                        SendMessageBatchRequestEntry::builder()
                            .id(i.to_string())
                            .message_body(body)
                            .build()
                            .map_err(request)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let out = self
                    .client
                    .send_message_batch()
                    .queue_url(&self.url)
                    .set_entries(Some(entries))
                    .send()
                    .await
                    .map_err(|e| request(aws_sdk_sqs::error::DisplayErrorContext(e)))?;
                if let Some(failed) = out.failed().first() {
                    return Err(request(format!(
                        "{} ({})",
                        failed.message().unwrap_or("a message was refused"),
                        failed.code()
                    )));
                }
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
            let out = self
                .client
                .receive_message()
                .queue_url(&self.url)
                .max_number_of_messages(i32::try_from(max.clamp(1, 10)).unwrap_or(10))
                .wait_time_seconds(i32::try_from(wait.as_secs().min(20)).unwrap_or(20))
                .message_system_attribute_names(MessageSystemAttributeName::ApproximateReceiveCount)
                .send()
                .await
                .map_err(|e| request(aws_sdk_sqs::error::DisplayErrorContext(e)))?;
            Ok(out
                .messages()
                .iter()
                .filter_map(|m| {
                    let receipt = m.receipt_handle()?.to_owned();
                    let body = m.body()?.to_owned();
                    let receive_count = m
                        .attributes()
                        .and_then(|a| a.get(&MessageSystemAttributeName::ApproximateReceiveCount))
                        .and_then(|n| n.parse().ok())
                        .unwrap_or(1);
                    Some(Received {
                        receipt,
                        body,
                        receive_count,
                    })
                })
                .collect())
        })
    }

    fn delete<'a>(&'a self, receipts: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>> {
        Box::pin(async move {
            for chunk in receipts.chunks(BATCH) {
                let entries = chunk
                    .iter()
                    .enumerate()
                    .map(|(i, receipt)| {
                        DeleteMessageBatchRequestEntry::builder()
                            .id(i.to_string())
                            .receipt_handle(receipt)
                            .build()
                            .map_err(request)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let out = self
                    .client
                    .delete_message_batch()
                    .queue_url(&self.url)
                    .set_entries(Some(entries))
                    .send()
                    .await
                    .map_err(|e| request(aws_sdk_sqs::error::DisplayErrorContext(e)))?;
                if let Some(failed) = out.failed().first() {
                    return Err(request(format!(
                        "{} ({})",
                        failed.message().unwrap_or("a delete was refused"),
                        failed.code()
                    )));
                }
            }
            Ok(())
        })
    }
}
