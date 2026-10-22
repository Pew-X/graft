//! Public text: titles and maker names are the one free-text surface that becomes permanent and
//! public, so it is kept small. The rules, in order: normalise whitespace; refuse control,
//! formatting, bidirectional and private-use characters; strip links and @handles (and say so);
//! allow letters and digits of any script plus a short list of punctuation; refuse words that mix
//! Latin with Cyrillic or Greek letters (lookalikes); enforce a length in characters; refuse a
//! small deny-list of impersonation words. Names are plain text "as typed" after these rules and
//! are never styled as a handle.

/// The result of cleaning one field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cleaned {
    /// The text to store and show.
    pub value: String,
    /// True when a link or a handle was removed, so the response can say the text was adjusted.
    pub adjusted: bool,
}

/// Which rule refused the text. Each names the rule so a form can say what to fix.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TextError {
    /// Nothing is left once whitespace, links and handles are removed.
    #[error("it is empty")]
    Empty,
    /// More characters than allowed.
    #[error("it is longer than {max} characters")]
    TooLong {
        /// The limit.
        max: usize,
    },
    /// A character outside the allowed set (this includes control and invisible characters).
    #[error("it contains a character that is not allowed: {0:?}")]
    Character(char),
    /// A word mixes Latin letters with Cyrillic or Greek ones, which can imitate another word.
    #[error("a word mixes letters from different scripts")]
    MixedScripts,
    /// A word is reserved.
    #[error("the word {0:?} is not allowed")]
    Denied(String),
}

impl TextError {
    /// A stable identifier of the rule, for clients and tests.
    #[must_use]
    pub fn rule(&self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::TooLong { .. } => "too_long",
            Self::Character(_) => "character",
            Self::MixedScripts => "mixed_scripts",
            Self::Denied(_) => "denied_word",
        }
    }
}

/// Words nobody may use as or inside a title or name: they imply staff or an affiliation.
pub const BUILT_IN_DENY: &[&str] = &["admin", "administrator", "moderator", "riffle"];

/// Top-level domains that make a bare `name.tld` look like a link. Short and deliberate: a longer
/// list would start stripping ordinary words.
const LINK_TLDS: &[&str] = &[
    "com", "net", "org", "io", "co", "me", "ly", "gg", "app", "dev", "xyz", "fm", "tv", "to",
    "link", "site", "online", "info", "biz", "in", "uk", "us", "de", "fr", "ru", "cn", "jp", "ai",
    "gl", "be", "page",
];

/// Punctuation allowed besides letters, digits and spaces.
const PUNCTUATION: &str = "-_'\u{2019}.,:;!?&()+/\"";

/// Clean one public text field. `extra_deny` extends the built-in list.
pub fn clean(input: &str, max_chars: usize, extra_deny: &[String]) -> Result<Cleaned, TextError> {
    // Bound the work before looking at the text: nothing that long can become valid.
    if input.chars().take(max_chars.saturating_mul(16) + 1).count() > max_chars.saturating_mul(16) {
        return Err(TextError::TooLong { max: max_chars });
    }
    if let Some(c) = input
        .chars()
        .find(|c| invisible(*c) || (c.is_control() && !c.is_whitespace()))
    {
        return Err(TextError::Character(c));
    }
    // Newlines and tabs are whitespace to Rust but have no place in a title: refuse them. Every
    // other kind of space becomes a plain space.
    if let Some(c) = input
        .chars()
        .find(|c| matches!(c, '\n' | '\r' | '\t' | '\u{2028}' | '\u{2029}'))
    {
        return Err(TextError::Character(c));
    }
    let mut adjusted = false;
    let kept: Vec<&str> = input
        .split(|c: char| c.is_whitespace())
        .filter(|t| !t.is_empty())
        .filter(|t| {
            let drop_it = is_link(t) || is_handle(t);
            adjusted |= drop_it;
            !drop_it
        })
        .collect();
    let value = kept.join(" ");
    if value.is_empty() {
        return Err(TextError::Empty);
    }
    if let Some(c) = value.chars().find(|c| !allowed(*c)) {
        return Err(TextError::Character(c));
    }
    if value.split(' ').any(mixes_scripts) {
        return Err(TextError::MixedScripts);
    }
    if value.chars().count() > max_chars {
        return Err(TextError::TooLong { max: max_chars });
    }
    for word in value.split(' ') {
        let bare: String = word
            .chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>()
            .to_lowercase();
        if BUILT_IN_DENY.iter().any(|d| *d == bare)
            || extra_deny.iter().any(|d| d.to_lowercase() == bare)
        {
            return Err(TextError::Denied(bare));
        }
    }
    Ok(Cleaned { value, adjusted })
}

fn trim_edges(token: &str) -> &str {
    token.trim_matches(|c: char| "([{\"'.,;:!?)]}".contains(c))
}

fn is_link(token: &str) -> bool {
    let t = trim_edges(token).to_lowercase();
    if t.contains("://") || t.starts_with("www.") {
        return true;
    }
    match t.rsplit_once('.') {
        Some((host, tld)) => {
            !host.is_empty()
                && LINK_TLDS.contains(&tld)
                && host
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '.')
        }
        None => false,
    }
}

fn is_handle(token: &str) -> bool {
    token
        .trim_start_matches(|c: char| "([{\"'".contains(c))
        .starts_with('@')
}

/// Control-like characters that render as nothing or change how text is laid out.
fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{ad}'
            | '\u{600}'..='\u{605}'
            | '\u{61c}'
            | '\u{6dd}'
            | '\u{70f}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{206f}'
            | '\u{feff}'
            | '\u{fff9}'..='\u{fffb}'
            | '\u{fffe}'
            | '\u{ffff}'
            | '\u{e000}'..='\u{f8ff}'
            | '\u{f0000}'..='\u{10ffff}'
    )
}

/// Combining marks of the scripts whose letters are written with them (the standard library has
/// no general-category lookup, so these are the blocks, not every mark in Unicode).
fn is_mark(c: char) -> bool {
    matches!(
        c,
        '\u{300}'..='\u{36f}'
            | '\u{483}'..='\u{489}'
            | '\u{591}'..='\u{5c7}'
            | '\u{64b}'..='\u{65f}'
            | '\u{900}'..='\u{dff}'
            | '\u{e00}'..='\u{e7f}'
            | '\u{f00}'..='\u{fff}'
            | '\u{1ab0}'..='\u{1aff}'
            | '\u{1dc0}'..='\u{1dff}'
            | '\u{20d0}'..='\u{20ff}'
            | '\u{3099}'..='\u{309a}'
    )
}

fn allowed(c: char) -> bool {
    c == ' ' || c.is_alphanumeric() || is_mark(c) || PUNCTUATION.contains(c)
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Script {
    Latin,
    Cyrillic,
    Greek,
}

fn script(c: char) -> Option<Script> {
    match c {
        'A'..='Z' | 'a'..='z' | '\u{c0}'..='\u{24f}' => Some(Script::Latin),
        '\u{400}'..='\u{52f}' => Some(Script::Cyrillic),
        '\u{370}'..='\u{3ff}' => Some(Script::Greek),
        _ => None,
    }
}

/// True when one word has letters of two of Latin, Cyrillic and Greek.
fn mixes_scripts(word: &str) -> bool {
    let mut seen: Option<Script> = None;
    for s in word.chars().filter_map(script) {
        match seen {
            None => seen = Some(s),
            Some(first) if first != s => return true,
            Some(_) => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(input: &str) -> Cleaned {
        clean(input, 32, &[]).unwrap_or_else(|e| panic!("{input:?} should be accepted: {e}"))
    }

    fn rule(input: &str) -> &'static str {
        clean(input, 32, &[]).expect_err("should be refused").rule()
    }

    #[test]
    fn plain_text_passes_through_unchanged() {
        assert_eq!(
            ok("a door, slowed"),
            Cleaned {
                value: "a door, slowed".into(),
                adjusted: false
            }
        );
        assert_eq!(ok("Ana-Maria O'Neil").value, "Ana-Maria O'Neil");
    }

    #[test]
    fn whitespace_is_trimmed_collapsed_and_unusual_spaces_become_plain_spaces() {
        assert_eq!(ok("  a   door  ").value, "a door");
        assert_eq!(ok("a\u{a0}door\u{2003}now").value, "a door now");
    }

    #[test]
    fn links_are_stripped_and_the_text_is_marked_adjusted() {
        for (input, want) in [
            ("hear this https://example.com/x now", "hear this now"),
            ("see www.example.org", "see"),
            ("mine on example.com", "mine on"),
            ("go to bit.ly", "go to"),
        ] {
            assert_eq!(
                ok(input),
                Cleaned {
                    value: want.into(),
                    adjusted: true
                },
                "{input}"
            );
        }
    }

    #[test]
    fn ordinary_words_with_dots_are_not_mistaken_for_links() {
        for input in ["Mr. Smith", "v2.final", "take 2.5", "a.m. mix"] {
            assert!(!ok(input).adjusted, "{input} was treated as a link");
        }
    }

    #[test]
    fn handles_are_stripped_and_the_text_is_marked_adjusted() {
        assert_eq!(
            ok("by @someone cool"),
            Cleaned {
                value: "by cool".into(),
                adjusted: true
            }
        );
    }

    #[test]
    fn text_that_is_only_a_link_or_a_handle_is_refused_as_empty() {
        assert_eq!(rule("@someone"), "empty");
        assert_eq!(rule("https://example.com"), "empty");
        assert_eq!(rule("   "), "empty");
        assert_eq!(rule(""), "empty");
    }

    #[test]
    fn control_invisible_and_bidirectional_characters_are_refused() {
        for input in [
            "a\nb",
            "a\tb",
            "a\u{0}b",
            "a\u{200b}b",
            "a\u{202e}b",
            "a\u{feff}b",
            "a\u{ad}b",
            "a\u{e000}b",
        ] {
            assert_eq!(rule(input), "character", "{input:?}");
        }
    }

    #[test]
    fn characters_outside_the_allowed_set_are_refused() {
        for input in ["a<b", "a|b", "a{b}", "50% off", "a\\b", "😀", "a=b"] {
            assert_eq!(rule(input), "character", "{input:?}");
        }
    }

    #[test]
    fn letters_and_digits_of_other_scripts_are_accepted() {
        for input in [
            "पीयूष",
            "José",
            "Łukasz",
            "Мария",
            "Δημήτρης",
            "東京 2",
            "สวัสดี",
        ] {
            assert_eq!(ok(input).value, input);
        }
    }

    #[test]
    fn a_word_that_mixes_latin_with_cyrillic_or_greek_is_refused() {
        // The first letter is Cyrillic "а" (U+0430), which looks exactly like Latin "a".
        assert_eq!(rule("\u{430}dmin"), "mixed_scripts");
        assert_eq!(rule("pαt"), "mixed_scripts");
        // Different words in different scripts are fine.
        assert_eq!(ok("Мария and Ana").value, "Мария and Ana");
    }

    #[test]
    fn length_counts_characters_not_bytes_and_is_checked_after_stripping() {
        assert!(
            clean(&"é".repeat(32), 32, &[]).is_ok(),
            "64 bytes but 32 characters"
        );
        assert_eq!(rule(&"a".repeat(33)), "too_long");
        assert!(clean("ok @verylonghandlethatwouldexceedthelimit", 32, &[]).is_ok());
        assert_eq!(
            clean(&"a".repeat(1_000_000), 32, &[])
                .expect_err("refused")
                .rule(),
            "too_long"
        );
    }

    #[test]
    fn impersonation_words_are_refused_in_any_case_and_extra_words_can_be_added() {
        assert_eq!(rule("Admin"), "denied_word");
        assert_eq!(rule("the MODERATOR said"), "denied_word");
        assert_eq!(rule("riffle official"), "denied_word");
        assert_eq!(rule("administrator!"), "denied_word");
        assert!(
            clean("a moderately good mix", 32, &[]).is_ok(),
            "only whole words count"
        );
        assert_eq!(
            clean("secret word", 32, &["secret".to_owned()])
                .expect_err("refused")
                .rule(),
            "denied_word"
        );
    }

    proptest::proptest! {
        #[test]
        fn whatever_is_accepted_is_short_plain_single_spaced_and_free_of_links_and_handles(input in proptest::prelude::any::<String>()) {
            if let Ok(cleaned) = clean(&input, 32, &[]) {
                let v = &cleaned.value;
                proptest::prop_assert!(v.chars().count() <= 32);
                proptest::prop_assert!(v.chars().all(allowed));
                proptest::prop_assert!(!v.chars().any(invisible));
                proptest::prop_assert!(!v.starts_with(' ') && !v.ends_with(' ') && !v.contains("  "));
                proptest::prop_assert!(!v.split(' ').any(|t| is_link(t) || is_handle(t)));
                // Cleaning is idempotent: a stored value cleans to itself.
                proptest::prop_assert_eq!(clean(v, 32, &[]).map(|c| c.value), Ok(v.clone()));
            }
        }
    }
}
