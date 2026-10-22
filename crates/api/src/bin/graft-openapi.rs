//! Prints the OpenAPI document; CI compares it with the committed copy.
#![allow(clippy::print_stdout)]

fn main() {
    print!("{}", graft_api::openapi::pretty());
}
