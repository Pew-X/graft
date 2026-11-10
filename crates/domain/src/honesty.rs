//! The honesty model: every displayed fact is declared, computed or unknown.

/// How much a displayed fact is backed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Honesty {
    /// A person said it (a name, a licence, a recording note), shown as typed.
    Declared,
    /// The system produced it and can reproduce it within stated limits.
    Computed,
    /// Nothing establishes it. The default for authorship, ownership and permission.
    Unknown,
}

impl Honesty {
    /// The word shown and sent over the wire; state is never conveyed by colour alone.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Declared => "declared",
            Self::Computed => "computed",
            Self::Unknown => "unknown",
        }
    }
}

/// One line of a credit block: a role word, its value, and how far it is backed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreditLine {
    /// Role word, such as "source", "cut" or "flipped by".
    pub role: &'static str,
    /// The value as text.
    pub value: String,
    /// Declared, computed or unknown.
    pub honesty: Honesty,
}
