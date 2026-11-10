#![allow(clippy::print_stdout)] // a command-line tool: output is its interface
//! See `graft_vectors::cli::USAGE`.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = graft_vectors::cli::run(&args, &mut std::io::stdout(), &mut std::io::stderr());
    std::process::exit(code);
}
