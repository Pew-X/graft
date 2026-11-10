//! Canonical JSON for content-record hashing: the RFC 8785 subset graft uses.
//!
//! Only objects, integers and strings exist here. Keys are ordered by UTF-16 code unit, strings are
//! escaped minimally and emitted as UTF-8, integers are decimal and limited to the range every JSON
//! implementation reads exactly (plus or minus 2^53 - 1), and there is no insignificant whitespace.

/// Largest magnitude an integer may have (2^53 - 1), as in RFC 8785's I-JSON range.
pub const MAX_SAFE_INT: i64 = (1 << 53) - 1;

/// A canonical JSON value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    /// A whole number within plus or minus [`MAX_SAFE_INT`].
    Int(i64),
    /// A Unicode string.
    Str(String),
    /// An object; entry order here is irrelevant, the encoding sorts the keys.
    Object(Vec<(String, Value)>),
}

/// Why a value cannot be encoded.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EncodeError {
    /// An integer outside plus or minus 2^53 - 1.
    #[error("integer {0} is outside the exactly representable range")]
    IntOutOfRange(i64),
    /// Two entries of one object share a key.
    #[error("duplicate object key {0:?}")]
    DuplicateKey(String),
}

/// Encode a value to its canonical bytes.
pub fn to_bytes(value: &Value) -> Result<Vec<u8>, EncodeError> {
    let mut out = Vec::new();
    write_value(value, &mut out)?;
    Ok(out)
}

fn write_value(value: &Value, out: &mut Vec<u8>) -> Result<(), EncodeError> {
    match value {
        Value::Int(n) => {
            if n.unsigned_abs() > MAX_SAFE_INT.unsigned_abs() {
                return Err(EncodeError::IntOutOfRange(*n));
            }
            out.extend_from_slice(n.to_string().as_bytes());
        }
        Value::Str(s) => write_string(s, out),
        Value::Object(entries) => {
            let mut sorted: Vec<&(String, Value)> = entries.iter().collect();
            sorted.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            if let Some(pair) = sorted.windows(2).find(|w| w[0].0 == w[1].0) {
                return Err(EncodeError::DuplicateKey(pair[0].0.clone()));
            }
            out.push(b'{');
            for (i, (key, val)) in sorted.into_iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_string(key, out);
                out.push(b':');
                write_value(val, out)?;
            }
            out.push(b'}');
        }
    }
    Ok(())
}

fn write_string(s: &str, out: &mut Vec<u8>) {
    out.push(b'"');
    for c in s.chars() {
        match c {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{8}' => out.extend_from_slice(b"\\b"),
            '\u{c}' => out.extend_from_slice(b"\\f"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => {
                out.extend_from_slice(format!("\\u{:04x}", c as u32).as_bytes())
            }
            c => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out.push(b'"');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(entries: &[(&str, Value)]) -> Value {
        Value::Object(
            entries
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        )
    }

    fn text(value: &Value) -> String {
        String::from_utf8(to_bytes(value).expect("encodes")).expect("utf-8")
    }

    #[test]
    fn keys_are_sorted_and_there_is_no_whitespace() {
        let v = obj(&[("b", Value::Int(2)), ("a", Value::Str("x".into()))]);
        assert_eq!(text(&v), r#"{"a":"x","b":2}"#);
    }

    #[test]
    fn nested_objects_are_sorted_at_every_level() {
        let inner = obj(&[("z", Value::Int(1)), ("y", Value::Int(0))]);
        let v = obj(&[("k", inner), ("a", Value::Int(-7))]);
        assert_eq!(text(&v), r#"{"a":-7,"k":{"y":0,"z":1}}"#);
    }

    #[test]
    fn strings_use_the_minimal_escapes_of_rfc_8785() {
        let v = Value::Str("a\"b\\c\n\t\u{8}\u{c}\r\u{1}\u{1f}/é".into());
        assert_eq!(text(&v), "\"a\\\"b\\\\c\\n\\t\\b\\f\\r\\u0001\\u001f/é\"");
    }

    #[test]
    fn keys_sort_by_utf16_code_unit_not_by_utf8_byte() {
        // U+10000 is the surrogate pair D800 DC00 in UTF-16, so it sorts before U+E000;
        // in UTF-8 bytes it would sort after it.
        let v = obj(&[("\u{e000}", Value::Int(1)), ("\u{10000}", Value::Int(2))]);
        assert_eq!(text(&v), "{\"\u{10000}\":2,\"\u{e000}\":1}");
    }

    #[test]
    fn integers_are_plain_decimal_with_no_plus_or_leading_zero() {
        assert_eq!(text(&Value::Int(0)), "0");
        assert_eq!(text(&Value::Int(-1)), "-1");
        assert_eq!(text(&Value::Int(MAX_SAFE_INT)), "9007199254740991");
    }

    #[test]
    fn an_integer_beyond_two_to_the_53_is_refused() {
        assert_eq!(
            to_bytes(&Value::Int(MAX_SAFE_INT + 1)),
            Err(EncodeError::IntOutOfRange(MAX_SAFE_INT + 1))
        );
        assert_eq!(
            to_bytes(&Value::Int(-MAX_SAFE_INT - 1)),
            Err(EncodeError::IntOutOfRange(-MAX_SAFE_INT - 1))
        );
    }

    #[test]
    fn a_duplicate_key_is_refused_rather_than_silently_kept() {
        let v = obj(&[("a", Value::Int(1)), ("a", Value::Int(2))]);
        assert_eq!(to_bytes(&v), Err(EncodeError::DuplicateKey("a".into())));
    }

    #[test]
    fn entry_order_never_changes_the_bytes() {
        use proptest::prelude::*;
        let keys: Vec<String> = ["alpha", "beta", "gamma", "δ", "\u{10000}", "a b", "Z"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let reference: Vec<(String, Value)> = keys
            .iter()
            .enumerate()
            .map(|(i, k)| (k.clone(), Value::Int(i as i64)))
            .collect();
        let want = to_bytes(&Value::Object(reference.clone())).expect("encodes");
        proptest!(|(perm in Just(reference).prop_shuffle())| {
            prop_assert_eq!(to_bytes(&Value::Object(perm)).expect("encodes"), want.clone());
        });
    }
}
