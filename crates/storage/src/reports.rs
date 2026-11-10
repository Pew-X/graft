//! Reports: anyone can ask that a publication be looked at, and the operator reads them.
//!
//! A report holds a category, an optional short note and a time. It holds no identity of any kind:
//! no account, no address of any sort, no IP address and no user agent, so there is nothing to
//! protect and nothing to leak. The note is for the operator and is never shown publicly.

use crate::postgres::{Store, StoreError, db};
use graft_domain::chain::HideReason;
use graft_domain::ids::PublicationId;
use sqlx::Row;

/// Why a report was filed. A small closed set, so the operator can sort by it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportCategory {
    /// Someone's rights in the sound.
    Rights,
    /// The sound contains a private conversation.
    PrivateConversation,
    /// The sound or its text is harmful.
    Harmful,
    /// Spam.
    Spam,
    /// Anything else.
    Other,
}

impl ReportCategory {
    /// The name used in the database and on the wire.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rights => "rights",
            Self::PrivateConversation => "private_conversation",
            Self::Harmful => "harmful",
            Self::Spam => "spam",
            Self::Other => "other",
        }
    }

    /// Parse a name; `None` for anything not in the set.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        [
            Self::Rights,
            Self::PrivateConversation,
            Self::Harmful,
            Self::Spam,
            Self::Other,
        ]
        .into_iter()
        .find(|c| c.as_str() == text)
    }
}

/// A report as the operator sees it, with the publication's current state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportRow {
    /// Report number.
    pub id: i64,
    /// The publication reported.
    pub publication_id: PublicationId,
    /// Why.
    pub category: ReportCategory,
    /// The reporter's note, if any.
    pub note: Option<String>,
    /// When it was filed, milliseconds since the Unix epoch.
    pub created_at_ms: i64,
    /// The reported publication's title.
    pub title: String,
    /// The reported publication's maker name as typed.
    pub author: String,
    /// Whether it is hidden now, and why.
    pub hidden: Option<HideReason>,
    /// The maker's note on the publication now.
    pub maker_note: Option<String>,
    /// When the maker last changed that note, milliseconds since the Unix epoch; `None` if it was never
    /// changed after publishing. Compare it with `created_at_ms`: a note changed after the report was
    /// filed is not the note that was reported.
    pub maker_note_updated_ms: Option<i64>,
}

impl Store {
    /// File a report. Returns `false` when the publication does not exist; nothing is written then.
    pub async fn create_report(
        &self,
        publication: &PublicationId,
        category: ReportCategory,
        note: Option<&str>,
    ) -> Result<bool, StoreError> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let inserted = sqlx::query(
            "INSERT INTO reports (publication_id, category, note) \
             SELECT id, $2, $3 FROM publications WHERE id = $1",
        )
        .bind(publication.as_str())
        .bind(category.as_str())
        .bind(note)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        if inserted.rows_affected() != 1 {
            tx.rollback().await.map_err(db)?;
            return Ok(false);
        }
        // The event commits with the report or not at all. It carries the category and the
        // publication, never the note.
        crate::events::append(
            &mut tx,
            &crate::events::NewEvent::server(
                crate::events::EventKind::ReportFiled,
                publication.as_str(),
                category.as_str(),
            ),
        )
        .await?;
        tx.commit().await.map_err(db)?;
        Ok(true)
    }

    /// The newest reports first, at most `limit`, each with its publication's current state.
    pub async fn list_reports(&self, limit: u32) -> Result<Vec<ReportRow>, StoreError> {
        let rows = sqlx::query(
            "SELECT r.id, r.publication_id, r.category, r.note, \
                    (extract(epoch from r.created_at) * 1000)::bigint AS created_ms, \
                    p.title, p.author, p.hidden_reason, p.note AS maker_note, \
                    (extract(epoch from p.note_updated_at) * 1000)::bigint AS note_updated_ms \
             FROM reports r JOIN publications p ON p.id = r.publication_id \
             ORDER BY r.created_at DESC, r.id DESC LIMIT $1",
        )
        .bind(i64::from(limit))
        .fetch_all(&self.pool)
        .await
        .map_err(db)?;
        rows.iter()
            .map(|row| {
                let corrupt = |what: &str| StoreError::Corrupt(what.to_owned());
                let category: String = row.try_get("category").map_err(db)?;
                let hidden: Option<String> = row.try_get("hidden_reason").map_err(db)?;
                Ok(ReportRow {
                    id: row.try_get("id").map_err(db)?,
                    publication_id: PublicationId::parse(
                        &row.try_get::<String, _>("publication_id").map_err(db)?,
                    )
                    .map_err(|_| corrupt("a report names a malformed publication id"))?,
                    category: ReportCategory::parse(&category)
                        .ok_or_else(|| corrupt("a report has an unknown category"))?,
                    note: row.try_get("note").map_err(db)?,
                    created_at_ms: row.try_get("created_ms").map_err(db)?,
                    title: row.try_get("title").map_err(db)?,
                    author: row.try_get("author").map_err(db)?,
                    hidden: hidden
                        .map(|h| {
                            HideReason::parse(&h).ok_or_else(|| corrupt("an unknown hide reason"))
                        })
                        .transpose()?,
                    maker_note: row.try_get("maker_note").map_err(db)?,
                    maker_note_updated_ms: row.try_get("note_updated_ms").map_err(db)?,
                })
            })
            .collect()
    }
}
