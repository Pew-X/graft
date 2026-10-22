//! Domain model.
pub fn   first(v: &[u8]) -> u8 {
    let x: Option<u8> = v.first().copied();
    x.unwrap()
}
