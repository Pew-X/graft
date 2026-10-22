//! The S3-compatible blob store: Amazon S3, Cloudflare R2, or any server that speaks the same
//! protocol. Credentials come from configuration and are held only inside the client; they are
//! never part of an error, a log line or a `Debug` print.
//!
//! Objects are named by their content hash under an optional prefix. Reads verify the hash, so a
//! damaged object is never served. Audio is not proxied: callers get short-lived signed URLs and
//! the bytes flow from the object store to the listener, which keeps audio traffic off the API.

use crate::blob::{BlobError, BlobInfo, BlobStore, BoxFuture, DEFAULT_REFRESH_AFTER, now_ms};
use futures::TryStreamExt;
use graft_domain::hash::Sha256Hash;
use object_store::aws::{AmazonS3, AmazonS3Builder};
use object_store::path::Path;
use object_store::signer::{Method, Signer};
use object_store::{Error as ObjError, ObjectStore, ObjectStoreExt, PutMode};
use std::fmt;
use std::time::Duration;

/// How to reach the bucket.
#[derive(Clone)]
pub struct S3Config {
    /// The endpoint for S3-compatible servers (R2, a local test server); `None` for Amazon S3.
    pub endpoint: Option<String>,
    /// Bucket name.
    pub bucket: String,
    /// Region; `auto` for R2.
    pub region: String,
    /// Access key id.
    pub access_key_id: String,
    /// Secret access key. Never printed.
    pub secret_access_key: String,
    /// Allow plain HTTP, for a local test server only.
    pub allow_http: bool,
    /// A key prefix inside the bucket, so several environments or tests can share one bucket.
    pub prefix: Option<String>,
    /// Refresh the time of blobs older than this when they are written again.
    pub refresh_after: Duration,
}

impl S3Config {
    /// A config with the default refresh threshold and no prefix.
    #[must_use]
    pub fn new(
        endpoint: Option<String>,
        bucket: impl Into<String>,
        region: impl Into<String>,
        access_key_id: impl Into<String>,
        secret_access_key: impl Into<String>,
    ) -> Self {
        Self {
            endpoint,
            bucket: bucket.into(),
            region: region.into(),
            access_key_id: access_key_id.into(),
            secret_access_key: secret_access_key.into(),
            allow_http: false,
            prefix: None,
            refresh_after: DEFAULT_REFRESH_AFTER,
        }
    }
}

impl fmt::Debug for S3Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3Config")
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .field("credentials", &"redacted")
            .finish_non_exhaustive()
    }
}

/// The S3-compatible store.
pub struct S3BlobStore {
    store: AmazonS3,
    prefix: Option<String>,
    refresh_after: Duration,
}

impl fmt::Debug for S3BlobStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3BlobStore").finish_non_exhaustive()
    }
}

/// Reduce an error to the class of failure. The original can carry URLs and request detail, so
/// none of it is kept.
fn class(e: &ObjError) -> BlobError {
    let what = match e {
        ObjError::NotFound { .. } => "not found",
        ObjError::PermissionDenied { .. } | ObjError::Unauthenticated { .. } => "access denied",
        ObjError::NotImplemented { .. } | ObjError::NotSupported { .. } => "unsupported request",
        ObjError::Precondition { .. } | ObjError::AlreadyExists { .. } => "conflicting write",
        _ => "request failed",
    };
    BlobError::Store(what.to_owned())
}

impl S3BlobStore {
    /// Build a client. Nothing is sent until the first request.
    pub fn new(config: &S3Config) -> Result<Self, BlobError> {
        let mut builder = AmazonS3Builder::new()
            .with_bucket_name(&config.bucket)
            .with_region(&config.region)
            .with_access_key_id(&config.access_key_id)
            .with_secret_access_key(&config.secret_access_key)
            .with_allow_http(config.allow_http)
            // Path-style addressing works for every S3-compatible server; R2 and S3 accept it too.
            .with_virtual_hosted_style_request(false);
        if let Some(endpoint) = &config.endpoint {
            builder = builder.with_endpoint(endpoint);
        }
        let store = builder.build().map_err(|e| class(&e))?;
        Ok(Self {
            store,
            prefix: config.prefix.clone().filter(|p| !p.is_empty()),
            refresh_after: config.refresh_after,
        })
    }

    fn path(&self, hash: &Sha256Hash) -> Path {
        match &self.prefix {
            Some(p) => Path::from(format!("{p}/{}", hash.to_hex())),
            None => Path::from(hash.to_hex()),
        }
    }

    fn prefix_path(&self) -> Option<Path> {
        self.prefix.as_ref().map(|p| Path::from(p.as_str()))
    }
}

impl BlobStore for S3BlobStore {
    fn put_if_absent(&self, bytes: Vec<u8>) -> BoxFuture<'_, Result<Sha256Hash, BlobError>> {
        Box::pin(async move {
            let hash = Sha256Hash::of(&bytes);
            let path = self.path(&hash);
            match self.store.head(&path).await {
                Ok(meta) => {
                    // Already there. If it is old, write it again (same bytes) so its time is
                    // fresh and the orphan cleanup cannot take it from under a publish.
                    let age = now_ms().saturating_sub(meta.last_modified.timestamp_millis());
                    let refresh = i64::try_from(self.refresh_after.as_millis()).unwrap_or(i64::MAX);
                    if age >= refresh {
                        self.store
                            .put(&path, bytes.into())
                            .await
                            .map_err(|e| class(&e))?;
                    }
                    return Ok(hash);
                }
                Err(ObjError::NotFound { .. }) => {}
                Err(e) => return Err(class(&e)),
            }
            // Create-only where the server supports it; a concurrent writer of the same bytes
            // winning the race is success, because the bytes are identical by construction.
            match self
                .store
                .put_opts(&path, bytes.clone().into(), PutMode::Create.into())
                .await
            {
                Ok(_) | Err(ObjError::AlreadyExists { .. }) => Ok(hash),
                Err(ObjError::NotImplemented { .. } | ObjError::NotSupported { .. }) => {
                    self.store
                        .put(&path, bytes.into())
                        .await
                        .map_err(|e| class(&e))?;
                    Ok(hash)
                }
                Err(e) => Err(class(&e)),
            }
        })
    }

    fn get(&self, hash: Sha256Hash) -> BoxFuture<'_, Result<Option<Vec<u8>>, BlobError>> {
        Box::pin(async move {
            let got = match self.store.get(&self.path(&hash)).await {
                Ok(got) => got,
                Err(ObjError::NotFound { .. }) => return Ok(None),
                Err(e) => return Err(class(&e)),
            };
            let bytes = got.bytes().await.map_err(|e| class(&e))?;
            // Content addressing is only worth something if it is checked on the way out.
            if Sha256Hash::of(&bytes) != hash {
                return Err(BlobError::Damaged);
            }
            Ok(Some(bytes.to_vec()))
        })
    }

    fn signed_url(
        &self,
        hash: Sha256Hash,
        ttl: Duration,
    ) -> BoxFuture<'_, Result<String, BlobError>> {
        Box::pin(async move {
            self.store
                .signed_url(Method::GET, &self.path(&hash), ttl)
                .await
                .map(|u| u.to_string())
                .map_err(|e| class(&e))
        })
    }

    fn info(&self, hash: Sha256Hash) -> BoxFuture<'_, Result<Option<BlobInfo>, BlobError>> {
        Box::pin(async move {
            match self.store.head(&self.path(&hash)).await {
                Ok(meta) => Ok(Some(BlobInfo {
                    hash,
                    size: meta.size,
                    last_modified_ms: meta.last_modified.timestamp_millis(),
                })),
                Err(ObjError::NotFound { .. }) => Ok(None),
                Err(e) => Err(class(&e)),
            }
        })
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<BlobInfo>, BlobError>> {
        Box::pin(async move {
            let prefix = self.prefix_path();
            let metas: Vec<_> = self
                .store
                .list(prefix.as_ref())
                .try_collect()
                .await
                .map_err(|e| class(&e))?;
            // Only objects exactly at `<prefix>/<hash>`: a listing is recursive, so objects of
            // another environment under a longer prefix must not be mistaken for ours.
            let depth = self
                .prefix
                .as_deref()
                .map_or(0, |p| p.split('/').filter(|x| !x.is_empty()).count())
                + 1;
            Ok(metas
                .into_iter()
                .filter(|m| m.location.parts().count() == depth)
                .filter_map(|m| {
                    let hash = Sha256Hash::parse(m.location.filename()?).ok()?;
                    Some(BlobInfo {
                        hash,
                        size: m.size,
                        last_modified_ms: m.last_modified.timestamp_millis(),
                    })
                })
                .collect())
        })
    }

    fn delete(&self, hash: Sha256Hash) -> BoxFuture<'_, Result<bool, BlobError>> {
        Box::pin(async move {
            let path = self.path(&hash);
            match self.store.head(&path).await {
                Ok(_) => {}
                Err(ObjError::NotFound { .. }) => return Ok(false),
                Err(e) => return Err(class(&e)),
            }
            self.store.delete(&path).await.map_err(|e| class(&e))?;
            Ok(true)
        })
    }
}
