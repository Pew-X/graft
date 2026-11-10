//! Prints the OpenAPI document; CI compares it with the committed copy.
#![allow(clippy::print_stdout)] // a command-line tool: output is its interface

fn main() {
    print!("{}", graft_api::openapi::pretty());
}
