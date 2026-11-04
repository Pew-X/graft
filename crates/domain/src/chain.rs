//! A chain: the ordered stages from a source to a final flip, read as one consistent snapshot.
//!
//! The storage layer fetches the publications along the parent links (up to the depth cap plus one)
//! and hands them here. Assembly is pure so the rules are tested without a database: every named
//! parent either exists or is marked unavailable, and a chain that runs past the cap is cut short
//! with a stated reason, never silently.

use crate::honesty::{CreditLine, Honesty};
use crate::ids::PublicationId;
use crate::record::{ContentRecord, Kind};
use std::collections::HashMap;

/// Declared evidence for a source: where the sound came from, as typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceEvidence {
    /// "own recording" or a licence name such as "CC0".
    pub licence: String,
    /// Title of the original work, if it has one.
    pub work_title: Option<String>,
    /// Author of the original work as typed.
    pub work_author: Option<String>,
    /// Where the original can be found.
    pub url: Option<String>,
    /// The rights declaration a visitor accepted when publishing their own source; `None` for
    /// seeded sources, which carry licence evidence instead.
    pub declaration: Option<Declaration>,
}

/// What a visitor declared about a sound they published. It is a statement by a person: it is
/// shown as declared, and nothing here says anyone checked it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Declaration {
    /// The statement exactly as accepted.
    pub text: String,
    /// When it was accepted, milliseconds since the Unix epoch; filled in by the store.
    pub at_ms: i64,
}

/// A publication joined with its content record: one stage as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredStage {
    /// Public id.
    pub id: PublicationId,
    /// The record this publication claims.
    pub record: ContentRecord,
    /// Title as typed.
    pub title: String,
    /// Maker's name as typed.
    pub author: String,
    /// The maker's note as typed, if they wrote one. The only part of a stage the maker can change
    /// later, and not part of the content record.
    pub note: Option<String>,
    /// Creation time, milliseconds since the Unix epoch.
    pub created_at_ms: i64,
    /// Declared evidence, present on sources.
    pub evidence: Option<SourceEvidence>,
    /// How many publications name this one as their parent.
    pub flipped_count: u32,
    /// Whether the maker allows new flips of this stage.
    pub fork_permitted: bool,
    /// Set when the stage is hidden, and why.
    pub hidden: Option<HideReason>,
}

/// Why a stage is hidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HideReason {
    /// The maker withdrew it, or the operator hid it for a reason that does not touch other
    /// people's work. Stages built on it stay playable.
    Withdrawn,
    /// A rights concern. Stages built on it are held (their credits show, their audio is not
    /// served) while the hide stands.
    Rights,
}

impl HideReason {
    /// The name used in the database and on the wire.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Withdrawn => "withdrawn",
            Self::Rights => "rights",
        }
    }

    /// Parse the stored name.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "withdrawn" => Some(Self::Withdrawn),
            "rights" => Some(Self::Rights),
            _ => None,
        }
    }
}

/// Whether a stage's audio may be served, decided from the chain as one snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    /// Credits and audio are served.
    Available,
    /// The stage itself is hidden: its credit stays, its audio is not served.
    NoLongerHere(HideReason),
    /// An ancestor is hidden for rights: this stage's credit stays and its audio is not served
    /// while that hide stands. Nothing is stored for it; clearing the hide releases it.
    Held,
}

/// The availability of every present entry of `chain`, in order; `None` for an unavailable
/// parent (nothing was read, so there is nothing to decide).
///
/// The rule, in full:
/// - a hidden stage is "no longer here" with its own reason;
/// - otherwise a stage with any ancestor hidden for rights is held;
/// - an ancestor hidden as withdrawn changes nothing for the stages built on it;
/// - a parent that could not be read holds nobody, because nothing is known about it.
///
/// Nothing is stored: the answer is computed from the chain as read, so clearing a hide restores
/// everything, and the cost is bounded by the depth cap.
#[must_use]
pub fn availability(chain: &Chain) -> Vec<Option<Availability>> {
    let mut rights_above = false;
    chain
        .entries
        .iter()
        .map(|entry| match entry {
            Entry::Present(stage) => {
                let this = match stage.hidden {
                    Some(reason) => Availability::NoLongerHere(reason),
                    None if rights_above => Availability::Held,
                    None => Availability::Available,
                };
                if stage.hidden == Some(HideReason::Rights) {
                    rights_above = true;
                }
                Some(this)
            }
            Entry::Unavailable(_) => None,
        })
        .collect()
}

/// Whether every flip made from the last stage of `chain` is held: a rights hide stands on that
/// stage or on one above it. This is the same rule as [`availability`] read from the parent's side
/// (a flip is held exactly when a rights hide stands on an ancestor), so a list of a stage's flips
/// and the chain read of any one of them never disagree. A withdrawn ancestor holds nothing, and a
/// parent that could not be read holds nobody.
#[must_use]
pub fn holds_flips(chain: &Chain) -> bool {
    chain.entries.iter().any(
        |entry| matches!(entry, Entry::Present(stage) if stage.hidden == Some(HideReason::Rights)),
    )
}

/// What a chain position holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    /// A stage that was read.
    Present(Box<StoredStage>),
    /// A parent that a record names but that could not be read.
    Unavailable(PublicationId),
}

/// Why a chain stops before its source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Truncation {
    /// The walk reached the depth cap with ancestors left.
    DepthCap,
}

/// The assembled chain, source first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chain {
    /// Entries from the oldest ancestor found to the requested publication.
    pub entries: Vec<Entry>,
    /// Set when the walk stopped at the depth cap before reaching a source.
    pub truncated: Option<Truncation>,
}

/// Assemble the chain ending at `leaf` from fetched stages.
///
/// Returns `None` when `leaf` itself is not among them.
#[must_use]
pub fn assemble(leaf: &PublicationId, fetched: Vec<StoredStage>, max_depth: u32) -> Option<Chain> {
    let mut by_id: HashMap<PublicationId, StoredStage> =
        fetched.into_iter().map(|s| (s.id.clone(), s)).collect();
    let mut entries = Vec::new();
    let mut truncated = None;
    let mut next = Some(leaf.clone());
    let mut first = true;
    while let Some(id) = next.take() {
        if entries.len() as u32 >= max_depth {
            truncated = Some(Truncation::DepthCap);
            break;
        }
        match by_id.remove(&id) {
            Some(stage) => {
                next = stage.record.parent().cloned();
                entries.push(Entry::Present(Box::new(stage)));
            }
            None if first => return None,
            None => entries.push(Entry::Unavailable(id)),
        }
        first = false;
    }
    entries.reverse();
    Some(Chain { entries, truncated })
}

/// The credit lines of one stage, each with its honesty state.
#[must_use]
pub fn credit_lines(stage: &StoredStage) -> Vec<CreditLine> {
    let record = &stage.record;
    let mut lines = Vec::new();
    match record.kind() {
        Kind::Source => {
            lines.push(CreditLine {
                role: "source",
                value: stage.title.clone(),
                honesty: Honesty::Declared,
            });
            if let Some(ev) = &stage.evidence {
                lines.push(CreditLine {
                    role: "licence",
                    value: ev.licence.clone(),
                    honesty: Honesty::Declared,
                });
                if let Some(author) = &ev.work_author {
                    lines.push(CreditLine {
                        role: "by",
                        value: author.clone(),
                        honesty: Honesty::Declared,
                    });
                }
                if let Some(note) = &stage.note {
                    lines.push(CreditLine {
                        role: "note",
                        value: note.clone(),
                        honesty: Honesty::Declared,
                    });
                }
                if let Some(declaration) = &ev.declaration {
                    lines.push(CreditLine {
                        role: "declaration",
                        value: declaration.text.clone(),
                        honesty: Honesty::Declared,
                    });
                }
            }
        }
        Kind::Flip => {
            lines.push(CreditLine {
                role: "flip",
                value: stage.title.clone(),
                honesty: Honesty::Declared,
            });
            lines.push(CreditLine {
                role: "flipped by",
                value: stage.author.clone(),
                honesty: Honesty::Declared,
            });
            if let Some(note) = &stage.note {
                lines.push(CreditLine {
                    role: "note",
                    value: note.clone(),
                    honesty: Honesty::Declared,
                });
            }
            let cut = record.cut();
            lines.push(CreditLine {
                role: "cut",
                value: format!("frames {} to {}", cut.start, cut.end),
                honesty: Honesty::Computed,
            });
            if let Some(t) = record.transform() {
                lines.push(CreditLine {
                    role: "speed",
                    value: format!("{}/{}", t.p, t.q),
                    honesty: Honesty::Computed,
                });
            }
        }
    }
    lines.push(CreditLine {
        role: "renderer",
        value: format!("{} {}", record.renderer().name, record.renderer().version),
        honesty: Honesty::Computed,
    });
    lines.push(CreditLine {
        role: "rights",
        value: "not established".to_owned(),
        honesty: Honesty::Unknown,
    });
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::Sha256Hash;
    use crate::record::{Cut, METHOD_HERMITE, RendererIdentity, Transform};

    fn renderer() -> RendererIdentity {
        RendererIdentity {
            name: "graft-render".into(),
            version: 1,
            wasm_sha256: Sha256Hash::from_bytes([1; 32]),
        }
    }

    fn id(n: u64) -> PublicationId {
        PublicationId::from_bits(n)
    }

    fn source(n: u64) -> StoredStage {
        let audio = Sha256Hash::from_bytes([n as u8; 32]);
        StoredStage {
            id: id(n),
            record: ContentRecord::source(audio, 48_000, renderer()).expect("valid"),
            title: format!("source {n}"),
            author: "a maker".into(),
            note: None,
            created_at_ms: 0,
            evidence: Some(SourceEvidence {
                licence: "CC0".into(),
                work_title: None,
                work_author: Some("someone".into()),
                url: None,
                declaration: None,
            }),
            flipped_count: 0,
            fork_permitted: true,
            hidden: None,
        }
    }

    fn flip(n: u64, parent: u64) -> StoredStage {
        let t = Transform {
            p: 3,
            q: 2,
            method: METHOD_HERMITE,
        };
        let record = ContentRecord::flip(
            id(parent),
            Sha256Hash::from_bytes([parent as u8; 32]),
            Cut {
                start: 0,
                end: 1000,
            },
            t,
            renderer(),
            Sha256Hash::from_bytes([n as u8; 32]),
        )
        .expect("valid");
        StoredStage {
            id: id(n),
            record,
            title: format!("flip {n}"),
            author: "jo".into(),
            note: None,
            created_at_ms: 0,
            evidence: None,
            flipped_count: 0,
            fork_permitted: true,
            hidden: None,
        }
    }

    fn ids(chain: &Chain) -> Vec<String> {
        chain
            .entries
            .iter()
            .map(|e| match e {
                Entry::Present(s) => s.id.to_string(),
                Entry::Unavailable(i) => format!("missing:{i}"),
            })
            .collect()
    }

    #[test]
    fn a_chain_reads_source_first_whatever_order_the_rows_arrive_in() {
        let chain =
            assemble(&id(3), vec![flip(3, 2), source(1), flip(2, 1)], 12).expect("leaf present");
        assert_eq!(
            ids(&chain),
            vec![id(1).to_string(), id(2).to_string(), id(3).to_string()]
        );
        assert_eq!(chain.truncated, None);
    }

    #[test]
    fn a_source_alone_is_a_chain_of_one() {
        let chain = assemble(&id(1), vec![source(1)], 12).expect("leaf present");
        assert_eq!(chain.entries.len(), 1);
    }

    #[test]
    fn an_orphaned_parent_is_marked_unavailable_never_dropped() {
        let chain = assemble(&id(3), vec![flip(3, 2)], 12).expect("leaf present");
        assert_eq!(
            ids(&chain),
            vec![format!("missing:{}", id(2)), id(3).to_string()]
        );
    }

    #[test]
    fn an_unknown_leaf_is_not_a_chain() {
        assert_eq!(assemble(&id(9), vec![source(1)], 12), None);
    }

    #[test]
    fn a_chain_deeper_than_the_cap_is_cut_short_and_says_so() {
        let mut rows = vec![source(1)];
        for n in 2..=6 {
            rows.push(flip(n, n - 1));
        }
        let chain = assemble(&id(6), rows, 4).expect("leaf present");
        assert_eq!(
            ids(&chain),
            vec![
                id(3).to_string(),
                id(4).to_string(),
                id(5).to_string(),
                id(6).to_string()
            ]
        );
        assert_eq!(chain.truncated, Some(Truncation::DepthCap));
    }

    #[test]
    fn a_chain_exactly_at_the_cap_is_not_reported_as_truncated() {
        let rows = vec![source(1), flip(2, 1), flip(3, 2)];
        let chain = assemble(&id(3), rows, 3).expect("leaf present");
        assert_eq!(chain.entries.len(), 3);
        assert_eq!(chain.truncated, None);
    }

    #[test]
    fn a_hidden_stage_is_no_longer_here_and_the_chain_keeps_its_length() {
        let mut hidden = flip(2, 1);
        hidden.hidden = Some(HideReason::Withdrawn);
        let chain =
            assemble(&id(3), vec![source(1), hidden, flip(3, 2)], 12).expect("leaf present");
        assert_eq!(
            chain.entries.len(),
            3,
            "a hidden stage never shortens the chain"
        );
        assert_eq!(
            availability(&chain),
            vec![
                Some(Availability::Available),
                Some(Availability::NoLongerHere(HideReason::Withdrawn)),
                Some(Availability::Available),
            ]
        );
    }

    fn chain_with(flags: &[Option<HideReason>]) -> Chain {
        let mut rows = vec![source(1)];
        for n in 2..=flags.len() as u64 {
            rows.push(flip(n, n - 1));
        }
        for (row, flag) in rows.iter_mut().zip(flags) {
            row.hidden = *flag;
        }
        assemble(&id(flags.len() as u64), rows, 12).expect("leaf present")
    }

    #[test]
    fn a_rights_hide_holds_every_descendant_and_only_descendants() {
        use Availability::{Available, Held, NoLongerHere};
        let chain = chain_with(&[None, Some(HideReason::Rights), None, None]);
        assert_eq!(
            availability(&chain),
            vec![
                Some(Available),
                Some(NoLongerHere(HideReason::Rights)),
                Some(Held),
                Some(Held)
            ]
        );
    }

    #[test]
    fn a_withdrawn_ancestor_does_not_hold_its_descendants() {
        use Availability::{Available, NoLongerHere};
        let chain = chain_with(&[None, Some(HideReason::Withdrawn), None, None]);
        assert_eq!(
            availability(&chain),
            vec![
                Some(Available),
                Some(NoLongerHere(HideReason::Withdrawn)),
                Some(Available),
                Some(Available)
            ]
        );
    }

    #[test]
    fn a_stage_hidden_itself_reads_as_gone_even_below_a_rights_hide() {
        use Availability::{Held, NoLongerHere};
        let chain = chain_with(&[
            Some(HideReason::Rights),
            None,
            Some(HideReason::Withdrawn),
            None,
        ]);
        assert_eq!(
            availability(&chain),
            vec![
                Some(NoLongerHere(HideReason::Rights)),
                Some(Held),
                Some(NoLongerHere(HideReason::Withdrawn)),
                Some(Held)
            ],
            "the rights hide at the top still holds everything below it"
        );
    }

    #[test]
    fn the_flips_of_a_stage_are_held_exactly_when_the_chain_read_of_one_of_them_says_held() {
        // Every combination of hides on a chain of up to four stages: extend it with a visible
        // flip and the new stage is held exactly when `holds_flips` says its parent chain holds.
        let options = [None, Some(HideReason::Withdrawn), Some(HideReason::Rights)];
        for length in 1..=4usize {
            for code in 0..options.len().pow(length as u32) {
                let flags: Vec<Option<HideReason>> = (0..length)
                    .map(|i| options[(code / options.len().pow(i as u32)) % options.len()])
                    .collect();
                let parent = chain_with(&flags);
                let mut extended = flags.clone();
                extended.push(None);
                let child = chain_with(&extended);
                let held =
                    availability(&child).last().copied().flatten() == Some(Availability::Held);
                assert_eq!(holds_flips(&parent), held, "hides {flags:?}");
            }
        }
    }

    #[test]
    fn an_unreadable_parent_holds_no_flips() {
        let chain = assemble(&id(3), vec![flip(3, 2)], 12).expect("leaf present");
        assert!(!holds_flips(&chain));
    }

    #[test]
    fn clearing_the_hide_restores_every_stage() {
        use Availability::Available;
        let chain = chain_with(&[None, None, None]);
        assert!(availability(&chain).iter().all(|a| *a == Some(Available)));
    }

    #[test]
    fn an_unreadable_parent_has_no_availability_to_decide() {
        let chain = assemble(&id(3), vec![flip(3, 2)], 12).expect("leaf present");
        assert_eq!(
            availability(&chain),
            vec![None, Some(Availability::Available)]
        );
    }

    #[test]
    fn hide_reasons_round_trip_through_their_stored_names() {
        for reason in [HideReason::Withdrawn, HideReason::Rights] {
            assert_eq!(HideReason::parse(reason.as_str()), Some(reason));
        }
        assert_eq!(HideReason::parse("other"), None);
    }

    #[test]
    fn credit_lines_label_names_as_declared_ratios_as_computed_and_rights_as_unknown() {
        let lines = credit_lines(&flip(2, 1));
        let get = |role: &str| lines.iter().find(|l| l.role == role).expect("line present");
        assert_eq!(get("flipped by").honesty, Honesty::Declared);
        assert_eq!(get("flipped by").value, "jo");
        assert_eq!(get("speed").honesty, Honesty::Computed);
        assert_eq!(get("speed").value, "3/2");
        assert_eq!(get("rights").honesty, Honesty::Unknown);
    }

    #[test]
    fn a_source_shows_its_declared_licence_evidence() {
        let lines = credit_lines(&source(1));
        let get = |role: &str| lines.iter().find(|l| l.role == role).expect("line present");
        assert_eq!(get("licence").value, "CC0");
        assert_eq!(get("licence").honesty, Honesty::Declared);
        assert_eq!(get("by").value, "someone");
    }

    #[test]
    fn no_credit_line_ever_uses_a_banned_claim_word() {
        for stage in [source(1), flip(2, 1)] {
            for line in credit_lines(&stage) {
                let text = format!("{} {}", line.role, line.value).to_lowercase();
                for banned in ["verified", "proven", "certified", "owned by", "cleared"] {
                    assert!(!text.contains(banned), "{text:?} contains {banned:?}");
                }
            }
        }
    }
}
