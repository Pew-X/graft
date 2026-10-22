//! The content record: the immutable, hashed description of the work done in one stage.
//!
//! A record never carries a creation time or a maker; those belong to the publication, which is a
//! credited claim on a record and is not hashed. A flip names its parent *publication*, so the same
//! cut of two different parents is two different records.

use crate::canonical::{self, Value};
use crate::hash::Sha256Hash;
use crate::ids::PublicationId;

/// The record format this code writes. A new format means new vectors and a new version.
pub const FORMAT_VERSION: i64 = 1;
/// Largest numerator or denominator of a speed ratio (2^20).
pub const MAX_RATIO_TERM: u32 = 1 << 20;
/// Interpolation method id for cubic Hermite, the one the canonical renderer implements.
pub const METHOD_HERMITE: u32 = 1;

/// Whether a stage starts a chain or flips an earlier stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A root: recorded or prepared sound, no parent.
    Source,
    /// One varispeed flip of a cut of the parent's output.
    Flip,
}

/// A half-open frame range `[start, end)` of 48 kHz mono samples.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cut {
    /// First frame included.
    pub start: u32,
    /// First frame not included.
    pub end: u32,
}

impl Cut {
    /// Number of frames in the cut.
    #[must_use]
    pub fn len(&self) -> u32 {
        self.end.saturating_sub(self.start)
    }

    /// True for an empty or inverted range, which no record may carry.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.end <= self.start
    }
}

/// One varispeed transform: the exact fraction `p/q`, read at `p/q` input frames per output frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Transform {
    /// Numerator.
    pub p: u32,
    /// Denominator.
    pub q: u32,
    /// Interpolation method id.
    pub method: u32,
}

/// Which renderer produced the output: the name, its version and the SHA-256 of the `.wasm`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RendererIdentity {
    /// Renderer name.
    pub name: String,
    /// Renderer version as reported by the artefact.
    pub version: u32,
    /// SHA-256 of the `.wasm` bytes.
    pub wasm_sha256: Sha256Hash,
}

/// Why a record cannot exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RecordError {
    /// A source has a parent, or a flip has none.
    #[error("a source has no parent and a flip has exactly one")]
    ParentMismatch,
    /// A source carries a transform, or a flip has none.
    #[error("a source has no transform and a flip has one")]
    TransformMismatch,
    /// The cut is empty or inverted.
    #[error("the cut must contain at least one frame")]
    EmptyCut,
    /// A source's cut does not start at frame 0.
    #[error("a source's cut is the whole source, starting at frame 0")]
    SourceCutNotWhole,
    /// A source's output is not its input.
    #[error("a source's output is its own source audio")]
    SourceOutputDiffers,
    /// p or q is zero or above 2^20.
    #[error("p and q must be between 1 and 2^20")]
    RatioTermOutOfRange,
    /// p/q is outside 1/4 to 4.
    #[error("the speed ratio must be between 1/4 and 4")]
    RatioOutOfRange,
}

/// The immutable, hashed description of one stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentRecord {
    kind: Kind,
    parent: Option<PublicationId>,
    source_blob: Sha256Hash,
    cut: Cut,
    transform: Option<Transform>,
    renderer: RendererIdentity,
    output_blob: Sha256Hash,
}

impl ContentRecord {
    /// A root record: the source audio is its own output and the cut is the whole source.
    pub fn source(
        audio: Sha256Hash,
        frames: u32,
        renderer: RendererIdentity,
    ) -> Result<Self, RecordError> {
        Self::new(
            Kind::Source,
            None,
            audio,
            Cut {
                start: 0,
                end: frames,
            },
            None,
            renderer,
            audio,
        )
    }

    /// A flip of `parent`: `cut` of the parent's output, read at `transform`, rendered to `output`.
    pub fn flip(
        parent: PublicationId,
        parent_output: Sha256Hash,
        cut: Cut,
        transform: Transform,
        renderer: RendererIdentity,
        output: Sha256Hash,
    ) -> Result<Self, RecordError> {
        Self::new(
            Kind::Flip,
            Some(parent),
            parent_output,
            cut,
            Some(transform),
            renderer,
            output,
        )
    }

    fn new(
        kind: Kind,
        parent: Option<PublicationId>,
        source_blob: Sha256Hash,
        cut: Cut,
        transform: Option<Transform>,
        renderer: RendererIdentity,
        output_blob: Sha256Hash,
    ) -> Result<Self, RecordError> {
        if matches!(kind, Kind::Source) != parent.is_none() {
            return Err(RecordError::ParentMismatch);
        }
        if matches!(kind, Kind::Source) != transform.is_none() {
            return Err(RecordError::TransformMismatch);
        }
        if cut.is_empty() {
            return Err(RecordError::EmptyCut);
        }
        if matches!(kind, Kind::Source) {
            if cut.start != 0 {
                return Err(RecordError::SourceCutNotWhole);
            }
            if output_blob != source_blob {
                return Err(RecordError::SourceOutputDiffers);
            }
        }
        if let Some(t) = transform {
            validate_ratio(t)?;
        }
        Ok(Self {
            kind,
            parent,
            source_blob,
            cut,
            transform,
            renderer,
            output_blob,
        })
    }

    /// Source or flip.
    #[must_use]
    pub fn kind(&self) -> Kind {
        self.kind
    }

    /// The parent publication, absent for a source.
    #[must_use]
    pub fn parent(&self) -> Option<&PublicationId> {
        self.parent.as_ref()
    }

    /// Hash of the audio the cut was taken from.
    #[must_use]
    pub fn source_blob(&self) -> Sha256Hash {
        self.source_blob
    }

    /// The cut, in frames of the source audio.
    #[must_use]
    pub fn cut(&self) -> Cut {
        self.cut
    }

    /// The transform, absent for a source.
    #[must_use]
    pub fn transform(&self) -> Option<Transform> {
        self.transform
    }

    /// The renderer that produced the output.
    #[must_use]
    pub fn renderer(&self) -> &RendererIdentity {
        &self.renderer
    }

    /// Hash of the output audio.
    #[must_use]
    pub fn output_blob(&self) -> Sha256Hash {
        self.output_blob
    }

    /// The canonical bytes that are hashed: canonical JSON, integers and strings only.
    #[must_use]
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut fields = vec![
            ("format".to_owned(), Value::Int(FORMAT_VERSION)),
            (
                "kind".to_owned(),
                Value::Str(
                    match self.kind {
                        Kind::Source => "source",
                        Kind::Flip => "flip",
                    }
                    .to_owned(),
                ),
            ),
            ("source".to_owned(), Value::Str(self.source_blob.to_hex())),
            (
                "cut".to_owned(),
                Value::Object(vec![
                    ("start".to_owned(), Value::Int(i64::from(self.cut.start))),
                    ("end".to_owned(), Value::Int(i64::from(self.cut.end))),
                ]),
            ),
            (
                "renderer".to_owned(),
                Value::Object(vec![
                    ("name".to_owned(), Value::Str(self.renderer.name.clone())),
                    (
                        "version".to_owned(),
                        Value::Int(i64::from(self.renderer.version)),
                    ),
                    (
                        "sha256".to_owned(),
                        Value::Str(self.renderer.wasm_sha256.to_hex()),
                    ),
                ]),
            ),
            ("output".to_owned(), Value::Str(self.output_blob.to_hex())),
        ];
        if let Some(parent) = &self.parent {
            fields.push(("parent".to_owned(), Value::Str(parent.as_str().to_owned())));
        }
        if let Some(t) = self.transform {
            fields.push((
                "transform".to_owned(),
                Value::Object(vec![
                    ("p".to_owned(), Value::Int(i64::from(t.p))),
                    ("q".to_owned(), Value::Int(i64::from(t.q))),
                    ("method".to_owned(), Value::Int(i64::from(t.method))),
                ]),
            ));
        }
        // Every value is a bounded integer, a hex string or a short name, so encoding cannot fail.
        canonical::to_bytes(&Value::Object(fields)).unwrap_or_default()
    }

    /// The content record id: SHA-256 of the canonical bytes.
    #[must_use]
    pub fn id(&self) -> Sha256Hash {
        Sha256Hash::of(&self.canonical_bytes())
    }
}

fn validate_ratio(t: Transform) -> Result<(), RecordError> {
    if t.p == 0 || t.q == 0 || t.p > MAX_RATIO_TERM || t.q > MAX_RATIO_TERM {
        return Err(RecordError::RatioTermOutOfRange);
    }
    // 1/4 <= p/q <= 4, in integers so no rounding is involved.
    let (p, q) = (u64::from(t.p), u64::from(t.q));
    if 4 * p < q || p > 4 * q {
        return Err(RecordError::RatioOutOfRange);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn h(byte: u8) -> Sha256Hash {
        Sha256Hash::from_bytes([byte; 32])
    }

    fn renderer() -> RendererIdentity {
        RendererIdentity {
            name: "graft-render".into(),
            version: 1,
            wasm_sha256: h(0xcd),
        }
    }

    fn parent_id() -> PublicationId {
        PublicationId::parse("abcdefghjkmn").expect("valid id")
    }

    fn flip(cut: Cut, t: Transform) -> Result<ContentRecord, RecordError> {
        ContentRecord::flip(parent_id(), h(0xaa), cut, t, renderer(), h(0xbb))
    }

    const T32: Transform = Transform {
        p: 3,
        q: 2,
        method: METHOD_HERMITE,
    };
    const CUT: Cut = Cut {
        start: 1000,
        end: 43200,
    };

    // The two literals and their digests were produced outside Rust: the JSON by hand from the
    // format description, the digests with Python's hashlib.
    const FLIP_JSON: &str = r#"{"cut":{"end":43200,"start":1000},"format":1,"kind":"flip","output":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","parent":"abcdefghjkmn","renderer":{"name":"graft-render","sha256":"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","version":1},"source":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","transform":{"method":1,"p":3,"q":2}}"#;
    const FLIP_ID: &str = "3689171d10ef236222adcac1a54466612227f84b3d38a02645e04292ae40b927";
    const SOURCE_JSON: &str = r#"{"cut":{"end":57600,"start":0},"format":1,"kind":"source","output":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","renderer":{"name":"graft-render","sha256":"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","version":1},"source":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#;
    const SOURCE_ID: &str = "c688434bdc9e73d50d9a15f388f9dada81de4cbfe1cede7f9cb9a9c5399a50a8";

    #[test]
    fn a_flip_encodes_to_the_committed_bytes_and_hash() {
        let r = flip(CUT, T32).expect("valid");
        assert_eq!(
            String::from_utf8(r.canonical_bytes()).expect("utf-8"),
            FLIP_JSON
        );
        assert_eq!(r.id().to_hex(), FLIP_ID);
    }

    #[test]
    fn a_source_encodes_without_parent_or_transform() {
        let r = ContentRecord::source(h(0xaa), 57_600, renderer()).expect("valid");
        assert_eq!(
            String::from_utf8(r.canonical_bytes()).expect("utf-8"),
            SOURCE_JSON
        );
        assert_eq!(r.id().to_hex(), SOURCE_ID);
    }

    #[test]
    fn the_same_cut_of_two_parent_publications_is_two_records() {
        let a = flip(CUT, T32).expect("valid");
        let other = PublicationId::parse("zzzzzzzzzzzz").expect("valid id");
        let b = ContentRecord::flip(other, h(0xaa), CUT, T32, renderer(), h(0xbb)).expect("valid");
        assert_ne!(a.id(), b.id());
    }

    #[test]
    fn changing_any_single_field_changes_the_id() {
        let base = flip(CUT, T32).expect("valid");
        let variants = [
            ContentRecord::flip(parent_id(), h(0xa0), CUT, T32, renderer(), h(0xbb)),
            ContentRecord::flip(
                parent_id(),
                h(0xaa),
                Cut { start: 1001, ..CUT },
                T32,
                renderer(),
                h(0xbb),
            ),
            ContentRecord::flip(
                parent_id(),
                h(0xaa),
                Cut { end: 43201, ..CUT },
                T32,
                renderer(),
                h(0xbb),
            ),
            ContentRecord::flip(
                parent_id(),
                h(0xaa),
                CUT,
                Transform { p: 5, ..T32 },
                renderer(),
                h(0xbb),
            ),
            ContentRecord::flip(
                parent_id(),
                h(0xaa),
                CUT,
                Transform { q: 3, ..T32 },
                renderer(),
                h(0xbb),
            ),
            ContentRecord::flip(
                parent_id(),
                h(0xaa),
                CUT,
                Transform { method: 0, ..T32 },
                renderer(),
                h(0xbb),
            ),
            ContentRecord::flip(
                parent_id(),
                h(0xaa),
                CUT,
                T32,
                RendererIdentity {
                    version: 2,
                    ..renderer()
                },
                h(0xbb),
            ),
            ContentRecord::flip(
                parent_id(),
                h(0xaa),
                CUT,
                T32,
                RendererIdentity {
                    wasm_sha256: h(0xce),
                    ..renderer()
                },
                h(0xbb),
            ),
            ContentRecord::flip(
                parent_id(),
                h(0xaa),
                CUT,
                T32,
                RendererIdentity {
                    name: "other".into(),
                    ..renderer()
                },
                h(0xbb),
            ),
            ContentRecord::flip(parent_id(), h(0xaa), CUT, T32, renderer(), h(0xbc)),
        ];
        for (i, v) in variants.into_iter().enumerate() {
            assert_ne!(
                v.expect("valid").id(),
                base.id(),
                "variant {i} left the id unchanged"
            );
        }
    }

    #[test]
    fn a_fresh_value_with_the_same_fields_has_the_same_id() {
        // Identity depends on the fields only: nothing like a creation time can reach the hash.
        assert_eq!(
            flip(CUT, T32).expect("valid").id(),
            flip(CUT, T32).expect("valid").id()
        );
    }

    #[test]
    fn a_source_cannot_have_a_parent_transform_or_a_partial_cut() {
        let src = h(0xaa);
        let bad_cut = ContentRecord::new(
            Kind::Source,
            None,
            src,
            Cut { start: 5, end: 100 },
            None,
            renderer(),
            src,
        );
        assert_eq!(bad_cut, Err(RecordError::SourceCutNotWhole));
        let with_parent = ContentRecord::new(
            Kind::Source,
            Some(parent_id()),
            src,
            Cut { start: 0, end: 9 },
            None,
            renderer(),
            src,
        );
        assert_eq!(with_parent, Err(RecordError::ParentMismatch));
        let with_transform = ContentRecord::new(
            Kind::Source,
            None,
            src,
            Cut { start: 0, end: 9 },
            Some(T32),
            renderer(),
            src,
        );
        assert_eq!(with_transform, Err(RecordError::TransformMismatch));
        let other_output = ContentRecord::new(
            Kind::Source,
            None,
            src,
            Cut { start: 0, end: 9 },
            None,
            renderer(),
            h(0xbb),
        );
        assert_eq!(other_output, Err(RecordError::SourceOutputDiffers));
    }

    #[test]
    fn a_flip_needs_a_parent_and_a_transform() {
        let no_parent = ContentRecord::new(
            Kind::Flip,
            None,
            h(0xaa),
            CUT,
            Some(T32),
            renderer(),
            h(0xbb),
        );
        assert_eq!(no_parent, Err(RecordError::ParentMismatch));
        let no_transform = ContentRecord::new(
            Kind::Flip,
            Some(parent_id()),
            h(0xaa),
            CUT,
            None,
            renderer(),
            h(0xbb),
        );
        assert_eq!(no_transform, Err(RecordError::TransformMismatch));
    }

    #[test]
    fn empty_and_inverted_cuts_are_refused() {
        assert_eq!(
            flip(Cut { start: 10, end: 10 }, T32),
            Err(RecordError::EmptyCut)
        );
        assert_eq!(
            flip(Cut { start: 11, end: 10 }, T32),
            Err(RecordError::EmptyCut)
        );
    }

    #[test]
    fn the_ratio_limits_are_exact_at_one_quarter_and_four() {
        let t = |p, q| Transform {
            p,
            q,
            method: METHOD_HERMITE,
        };
        assert!(flip(CUT, t(1, 4)).is_ok());
        assert!(flip(CUT, t(4, 1)).is_ok());
        assert!(flip(CUT, t(1 << 20, 1 << 20)).is_ok());
        assert_eq!(flip(CUT, t(1, 5)), Err(RecordError::RatioOutOfRange));
        assert_eq!(flip(CUT, t(5, 1)), Err(RecordError::RatioOutOfRange));
        assert_eq!(
            flip(CUT, t(1_048_575, 4_194_300)),
            Err(RecordError::RatioTermOutOfRange)
        );
        assert_eq!(flip(CUT, t(0, 1)), Err(RecordError::RatioTermOutOfRange));
        assert_eq!(flip(CUT, t(1, 0)), Err(RecordError::RatioTermOutOfRange));
        assert_eq!(
            flip(CUT, t((1 << 20) + 1, 1)),
            Err(RecordError::RatioTermOutOfRange)
        );
    }

    proptest! {
        #[test]
        fn any_accepted_ratio_is_within_a_quarter_to_four_and_any_refused_one_is_not(
            p in 1u32..=(1 << 20), q in 1u32..=(1 << 20)
        ) {
            let accepted = flip(CUT, Transform { p, q, method: METHOD_HERMITE }).is_ok();
            // Compared as floats, an independent route to the same boundary (all terms are
            // below 2^21, so the products are exact in f64).
            let within = (f64::from(p) / f64::from(q)) >= 0.25 && (f64::from(p) / f64::from(q)) <= 4.0;
            prop_assert_eq!(accepted, within);
        }

        #[test]
        fn the_id_is_a_function_of_the_fields_and_distinct_cuts_never_collide(
            a in 0u32..1_000_000, len_a in 1u32..500_000, b in 0u32..1_000_000, len_b in 1u32..500_000
        ) {
            let ra = flip(Cut { start: a, end: a + len_a }, T32).expect("valid");
            let rb = flip(Cut { start: b, end: b + len_b }, T32).expect("valid");
            prop_assert_eq!(ra.id() == rb.id(), (a, len_a) == (b, len_b));
        }
    }
}
