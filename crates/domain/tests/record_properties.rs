#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Properties of content records over generated inputs. The expected values come from an
//! independent JSON parser (`serde_json`), not from the encoder under test.

use graft_domain::canonical::{self, Value};
use graft_domain::hash::Sha256Hash;
use graft_domain::ids::PublicationId;
use graft_domain::record::{ContentRecord, Cut, METHOD_HERMITE, RendererIdentity, Transform};
use proptest::prelude::*;

fn convert(v: &serde_json::Value) -> Value {
    match v {
        serde_json::Value::Number(n) => Value::Int(n.as_i64().expect("records hold only integers")),
        serde_json::Value::String(s) => Value::Str(s.clone()),
        serde_json::Value::Object(m) => {
            Value::Object(m.iter().map(|(k, v)| (k.clone(), convert(v))).collect())
        }
        other => panic!("a record never contains {other}"),
    }
}

fn hash() -> impl Strategy<Value = Sha256Hash> {
    proptest::array::uniform32(any::<u8>()).prop_map(Sha256Hash::from_bytes)
}

fn renderer() -> impl Strategy<Value = RendererIdentity> {
    // Names are any text, including quotes, backslashes, control and non-ASCII characters: the
    // encoder must escape them and an independent parser must read them back.
    (".{0,24}", 0u32..1000, hash()).prop_map(|(name, version, wasm_sha256)| RendererIdentity {
        name,
        version,
        wasm_sha256,
    })
}

fn record() -> impl Strategy<Value = ContentRecord> {
    let source = (hash(), 1u32..2_000_000, renderer())
        .prop_map(|(audio, frames, r)| ContentRecord::source(audio, frames, r).expect("valid"));
    let flip = (
        any::<u64>(),
        hash(),
        0u32..1_000_000,
        1u32..1_000_000,
        // Ratios inside 1/4..=4 by construction: p between q/4 and 4q, both at most 2^20.
        (1u32..=1 << 18, 1u32..=16),
        renderer(),
        hash(),
    )
        .prop_map(|(id, parent_out, start, len, (q, scale), r, out)| {
            // Rounded up so p/q is never just under 1/4; at most 4q = 2^20.
            let p = (q * scale).div_ceil(4);
            ContentRecord::flip(
                PublicationId::from_bits(id),
                parent_out,
                Cut {
                    start,
                    end: start + len,
                },
                Transform {
                    p,
                    q,
                    method: METHOD_HERMITE,
                },
                r,
                out,
            )
            .expect("valid")
        });
    prop_oneof![source, flip]
}

proptest! {
    #[test]
    fn the_canonical_bytes_survive_an_independent_parser_and_re_encoding_unchanged(r in record()) {
        let bytes = r.canonical_bytes();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).expect("valid JSON");
        // Re-serialisation through another implementation, then through ours, gives the same bytes.
        let again = canonical::to_bytes(&convert(&parsed)).expect("encodes");
        prop_assert_eq!(&again, &bytes);
    }

    #[test]
    fn the_id_is_exactly_the_sha256_of_the_canonical_bytes(r in record()) {
        prop_assert_eq!(r.id(), Sha256Hash::of(&r.canonical_bytes()));
    }

    #[test]
    fn two_records_share_an_id_only_if_they_are_the_same_record(a in record(), b in record()) {
        prop_assert_eq!(a.id() == b.id(), a == b);
    }

    #[test]
    fn a_record_and_its_clone_have_identical_bytes_and_id(a in record()) {
        let b = a.clone();
        prop_assert_eq!(a.canonical_bytes(), b.canonical_bytes());
        prop_assert_eq!(a.id(), b.id());
    }
}
