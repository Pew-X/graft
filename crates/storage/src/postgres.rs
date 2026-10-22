//! Postgres access: migrations, idempotent publication writes, and the chain read.
//!
//! Queries are plain runtime queries, not compile-time checked ones, so building needs no database
//! and no committed offline data; the real-Postgres tests are what check the SQL.

use graft_domain::chain::{self, Chain, SourceEvidence, StoredStage};
use graft_domain::hash::Sha256Hash;
use graft_domain::ids::PublicationId;
use graft_domain::record::{ContentRecord, Cut, Kind, RendererIdentity, Transform};
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Postgres, Row, Transaction};

/// Why a storage call failed. Never carries a connection string.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StoreError {
    /// The database failed or could not be reached.
    #[error("database error: {0}")]
    Db(String),
    /// A stored row does not describe a valid record; the data is damaged.
    #[error("stored data is inconsistent: {0}")]
    Corrupt(String),
}

fn db(e: sqlx::Error) -> StoreError {
    // The driver's message can name the host; keep only the error class.
    let class = match &e {
        sqlx::Error::Database(d) => format!("{} ({})", d.message(), d.code().unwrap_or_default()),
        sqlx::Error::PoolTimedOut => "pool timed out".to_owned(),
        sqlx::Error::Io(_) => "i/o error".to_owned(),
        other => other
            .to_string()
            .split(" at ")
            .next()
            .unwrap_or("error")
            .to_owned(),
    };
    StoreError::Db(class)
}

/// A publication to create.
#[derive(Debug, Clone)]
pub struct NewPublication {
    /// The id to give it.
    pub id: PublicationId,
    /// The record it claims.
    pub record: ContentRecord,
    /// The client's retry key.
    pub retry_key: String,
    /// Title as typed.
    pub title: String,
    /// Maker's name as typed.
    pub author: String,
    /// Declared evidence for a source.
    pub evidence: Option<SourceEvidence>,
}

/// What a create call did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// A new publication was written.
    Created(Box<StoredStage>),
    /// The retry key and the content both matched an existing publication; nothing was written.
    Existing(Box<StoredStage>),
    /// The retry key exists with different content; nothing was written.
    KeyConflict,
}

/// The Postgres store.
#[derive(Clone)]
pub struct Store {
    pool: PgPool,
}

const STAGE_COLUMNS: &str = "p.id AS pub_id, c.id AS content_id, p.title, p.author, \
    (extract(epoch from p.created_at) * 1000)::bigint AS created_ms, \
    p.licence, p.work_title, p.work_author, p.work_url, \
    c.kind, c.parent_publication_id, c.source_blob, c.cut_start, c.cut_end, c.p, c.q, c.method, \
    c.renderer_name, c.renderer_version, c.renderer_sha256, c.output_blob, \
    (SELECT count(*) FROM content_records k JOIN publications kp ON kp.content_id = k.id \
       WHERE k.parent_publication_id = p.id)::bigint AS flipped";

impl Store {
    /// Connect with a small pool. The URL is a secret and is never logged.
    pub async fn connect(url: &str, max_connections: u32) -> Result<Self, StoreError> {
        let pool = PgPoolOptions::new()
            .max_connections(max_connections)
            .connect(url)
            .await
            .map_err(db)?;
        Ok(Self { pool })
    }

    /// A store that connects on first use, so building it never touches the network.
    pub fn connect_lazy(url: &str, max_connections: u32) -> Result<Self, StoreError> {
        let pool = PgPoolOptions::new()
            .max_connections(max_connections)
            .acquire_timeout(std::time::Duration::from_secs(3))
            .connect_lazy(url)
            .map_err(db)?;
        Ok(Self { pool })
    }

    /// Wrap an existing pool.
    #[must_use]
    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Apply every migration not yet applied.
    pub async fn migrate(&self) -> Result<(), StoreError> {
        sqlx::migrate!("./migrations")
            .run(&self.pool)
            .await
            .map_err(|e| StoreError::Db(e.to_string()))
    }

    /// Succeeds when the database answers a trivial query.
    pub async fn ping(&self) -> Result<(), StoreError> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(db)
    }

    /// The underlying pool, for test hooks.
    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Create a publication, idempotently by retry key.
    ///
    /// The same key with the same content record returns the existing publication; the same key
    /// with a different record is a conflict and writes nothing.
    pub async fn create_publication(&self, new: &NewPublication) -> Result<Outcome, StoreError> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        insert_record(&mut tx, &new.record).await?;
        let inserted = insert_publication(&mut tx, new).await?;
        if inserted {
            tx.commit().await.map_err(db)?;
            let stage = self.publication(&new.id).await?.ok_or_else(|| {
                StoreError::Corrupt("a publication vanished right after it was written".into())
            })?;
            return Ok(Outcome::Created(Box::new(stage)));
        }
        tx.rollback().await.map_err(db)?;
        let existing: (String, Vec<u8>) =
            sqlx::query_as("SELECT id, content_id FROM publications WHERE retry_key = $1")
                .bind(&new.retry_key)
                .fetch_one(&self.pool)
                .await
                .map_err(db)?;
        if existing.1 != new.record.id().as_bytes().as_slice() {
            return Ok(Outcome::KeyConflict);
        }
        let id =
            PublicationId::parse(&existing.0).map_err(|e| StoreError::Corrupt(e.to_string()))?;
        let stage = self.publication(&id).await?.ok_or_else(|| {
            StoreError::Corrupt("a publication vanished while it was read".into())
        })?;
        Ok(Outcome::Existing(Box::new(stage)))
    }

    /// One publication with its record, or `None`.
    pub async fn publication(&self, id: &PublicationId) -> Result<Option<StoredStage>, StoreError> {
        let sql = format!(
            "SELECT {STAGE_COLUMNS} FROM publications p JOIN content_records c ON c.id = p.content_id \
             WHERE p.id = $1"
        );
        let row = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(id.as_str())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        row.map(|r| stage_from_row(&r)).transpose()
    }

    /// The chain ending at `leaf`, read as one statement and so one consistent snapshot.
    pub async fn chain(
        &self,
        leaf: &PublicationId,
        max_depth: u32,
    ) -> Result<Option<Chain>, StoreError> {
        // The walk fetches one row more than the cap so assembly can tell "exactly at the cap"
        // from "cut short".
        let sql = format!(
            "WITH RECURSIVE walk(id, depth) AS ( \
               SELECT id, 1 FROM publications WHERE id = $1 \
               UNION ALL \
               SELECT parent.id, w.depth + 1 FROM walk w \
                 JOIN publications cur ON cur.id = w.id \
                 JOIN content_records rec ON rec.id = cur.content_id \
                 JOIN publications parent ON parent.id = rec.parent_publication_id \
               WHERE w.depth <= $2 \
             ) \
             SELECT {STAGE_COLUMNS} FROM walk w \
               JOIN publications p ON p.id = w.id JOIN content_records c ON c.id = p.content_id"
        );
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(leaf.as_str())
            .bind(i64::from(max_depth))
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
        let stages = rows
            .iter()
            .map(stage_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(chain::assemble(leaf, stages, max_depth))
    }
}

async fn insert_record(
    tx: &mut Transaction<'_, Postgres>,
    r: &ContentRecord,
) -> Result<(), StoreError> {
    let cut = r.cut();
    let t = r.transform();
    sqlx::query(
        "INSERT INTO content_records (id, format, kind, parent_publication_id, source_blob, cut_start, \
           cut_end, p, q, method, renderer_name, renderer_version, renderer_sha256, output_blob, canonical) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(r.id().as_bytes().as_slice())
    .bind(graft_domain::record::FORMAT_VERSION as i32)
    .bind(match r.kind() {
        Kind::Source => "source",
        Kind::Flip => "flip",
    })
    .bind(r.parent().map(PublicationId::as_str))
    .bind(r.source_blob().as_bytes().as_slice())
    .bind(cut.start as i32)
    .bind(cut.end as i32)
    .bind(t.map(|t| t.p as i32))
    .bind(t.map(|t| t.q as i32))
    .bind(t.map(|t| t.method as i32))
    .bind(&r.renderer().name)
    .bind(r.renderer().version as i32)
    .bind(r.renderer().wasm_sha256.as_bytes().as_slice())
    .bind(r.output_blob().as_bytes().as_slice())
    .bind(r.canonical_bytes())
    .execute(&mut **tx)
    .await
    .map_err(db)?;
    Ok(())
}

async fn insert_publication(
    tx: &mut Transaction<'_, Postgres>,
    n: &NewPublication,
) -> Result<bool, StoreError> {
    let ev = n.evidence.as_ref();
    let row = sqlx::query(
        "INSERT INTO publications (id, content_id, retry_key, title, author, licence, work_title, \
           work_author, work_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         ON CONFLICT (retry_key) DO NOTHING RETURNING id",
    )
    .bind(n.id.as_str())
    .bind(n.record.id().as_bytes().as_slice())
    .bind(&n.retry_key)
    .bind(&n.title)
    .bind(&n.author)
    .bind(ev.map(|e| e.licence.as_str()))
    .bind(ev.and_then(|e| e.work_title.as_deref()))
    .bind(ev.and_then(|e| e.work_author.as_deref()))
    .bind(ev.and_then(|e| e.url.as_deref()))
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?;
    Ok(row.is_some())
}

fn hash_col(row: &PgRow, name: &str) -> Result<Sha256Hash, StoreError> {
    let bytes: Vec<u8> = row.try_get(name).map_err(db)?;
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| StoreError::Corrupt(format!("{name} is not 32 bytes")))?;
    Ok(Sha256Hash::from_bytes(array))
}

fn frames(row: &PgRow, name: &str) -> Result<u32, StoreError> {
    let n: i32 = row.try_get(name).map_err(db)?;
    u32::try_from(n).map_err(|_| StoreError::Corrupt(format!("{name} is negative")))
}

fn stage_from_row(row: &PgRow) -> Result<StoredStage, StoreError> {
    let corrupt = |e: &dyn std::fmt::Display| StoreError::Corrupt(e.to_string());
    let id = PublicationId::parse(&row.try_get::<String, _>("pub_id").map_err(db)?)
        .map_err(|e| corrupt(&e))?;
    let renderer = RendererIdentity {
        name: row.try_get("renderer_name").map_err(db)?,
        version: frames(row, "renderer_version")?,
        wasm_sha256: hash_col(row, "renderer_sha256")?,
    };
    let source_blob = hash_col(row, "source_blob")?;
    let cut = Cut {
        start: frames(row, "cut_start")?,
        end: frames(row, "cut_end")?,
    };
    let kind: String = row.try_get("kind").map_err(db)?;
    let record = match kind.as_str() {
        "source" => ContentRecord::source(source_blob, cut.end, renderer),
        "flip" => {
            let parent: String = row.try_get("parent_publication_id").map_err(db)?;
            let parent = PublicationId::parse(&parent).map_err(|e| corrupt(&e))?;
            let transform = Transform {
                p: frames(row, "p")?,
                q: frames(row, "q")?,
                method: frames(row, "method")?,
            };
            ContentRecord::flip(
                parent,
                source_blob,
                cut,
                transform,
                renderer,
                hash_col(row, "output_blob")?,
            )
        }
        other => return Err(StoreError::Corrupt(format!("unknown kind {other}"))),
    }
    .map_err(|e| corrupt(&e))?;
    if record.id() != hash_col(row, "content_id")? {
        return Err(StoreError::Corrupt(
            "a content record does not hash to its id".into(),
        ));
    }
    let licence: Option<String> = row.try_get("licence").map_err(db)?;
    let evidence = match licence {
        Some(licence) => Some(SourceEvidence {
            licence,
            work_title: row.try_get("work_title").map_err(db)?,
            work_author: row.try_get("work_author").map_err(db)?,
            url: row.try_get("work_url").map_err(db)?,
        }),
        None => None,
    };
    Ok(StoredStage {
        id,
        record,
        title: row.try_get("title").map_err(db)?,
        author: row.try_get("author").map_err(db)?,
        created_at_ms: row.try_get("created_ms").map_err(db)?,
        evidence,
        flipped_count: u32::try_from(row.try_get::<i64, _>("flipped").map_err(db)?)
            .map_err(|_| StoreError::Corrupt("negative count".into()))?,
    })
}
