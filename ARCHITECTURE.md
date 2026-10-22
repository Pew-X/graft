# Architecture

Each section names the ticket that writes it. A section that says "not written yet" describes work that has not happened.

## Module boundaries

One deployable Rust service plus a Next.js UI, built as a Cargo workspace. The arrows below are enforced in CI by `scripts/check-crate-graph.mjs`, which fails on any dependency edge (normal, dev or build) against them.

| Crate | Depends on | Role |
|---|---|---|
| `graft-domain` | nothing in the workspace | content record, publication, ancestry rules, honesty states, limits |
| `graft-render` | nothing at all | the integer renderer and its C-ABI wrapper, compiled to the canonical `.wasm` |
| `graft-storage` | domain | Postgres and blob store access behind traits |
| `graft-render-host` | domain | runs the canonical `.wasm` under wasmtime |
| `graft-events` | domain | outbox, relay, consumer, rollups behind an event-sink trait |
| `graft-vectors` | render | the renderer vector table: loader, generators, native and wasmtime harnesses (test support; nothing ships it) |
| `graft-api` | domain, storage, render-host, events | HTTP layer, OpenAPI, rate limits, admin routes, configuration |

Nothing depends on `graft-api`. `graft-render` is deliberately kept apart: the renderer is one artefact that must build alone, with no dependencies, to a reproducible `.wasm`.

Written by ticket 01.

## Toolchain and repository conventions

- Rust is pinned in `rust-toolchain.toml`, with the `wasm32-unknown-unknown` target. Node is pinned in `.node-version`, pnpm in `web/package.json`.
- Standards enforced in CI: rustfmt, clippy with warnings as errors, no `unwrap`/`expect`/`panic!` outside tests, `unsafe` denied by default (allowed only in the renderer's C boundary, with a written justification), TypeScript strict, ESLint, Prettier.
- Supply chain: cargo-deny (licences, advisories, sources), cargo-audit, `pnpm audit`, gitleaks. GitHub Actions are pinned to commit SHAs.
- Only code, scripts, README.md, ARCHITECTURE.md and configuration are committed. Commit messages are plain conventional text with no trailers or addresses; `scripts/lint-commit-msg.mjs` enforces that in the local hook and in CI, on every commit and on the pull request title.
- Branch flow: feature branch, then `dev` (squash), then `staging` and `main` by promotion pull requests (merge commit, so the branches stay aligned).

Written by ticket 01.

## Determinism contract

Two separate promises, kept apart on purpose.

1. **Renderer determinism.** The same canonical PCM, parameters, method and artefact give identical output bytes on every host that has been tested (the list is in "Determinism evidence").
2. **Input canonicalisation.** The same compressed recording may decode to slightly different canonical PCM on different engines. The guarantee begins at the canonical PCM boundary, not before it. The server cannot tell whether a client decoded honestly; a content record states what was submitted and what the system computed from it, not that it matches a recording in the world.

### Canonical audio

48 kHz, mono, signed 16-bit little-endian, headerless. The hash of a sound is the SHA-256 of those raw bytes. Canonicalisation happens once, in the browser, with two named integer-level rules, both fixed by vectors (`canonicalisation` in `fixtures/vectors/vectors.json`):

- float to 16-bit: scale by 32768, add one half, floor, clamp to [-32768, 32767]; NaN becomes 0. Ties round toward positive infinity, the same convention as the renderer.
- stereo to mono, on the 16-bit values: `(left + right + 1) >> 1`, arithmetic shift.

The renderer itself has no floats, so these rules live outside the artefact. `graft-vectors` holds a reference form of them so the rules are checked in a language other than the one that runs them in production.

### The renderer

One integer-only Rust library, compiled for `wasm32-unknown-unknown` into a single `.wasm` with no imports. The browser instantiates it with an empty import object; the server runs the same bytes under wasmtime.

```
exports:  memory, graft_version() -> u32,
          graft_alloc(size) -> ptr, graft_free(ptr, size),
          graft_out_len(in_len, p, q) -> i32,
          graft_render(in_ptr, in_len, p, q, method, out_ptr, out_cap) -> i32
imports:  none
```

Only 32-bit integers cross the boundary and the caller owns both buffers. Return values are frames written, or a negative status: `-1` for bad parameters, input over the ceiling or an unknown method, `-2` for an output buffer that is too small. Checks run in that order: parameters and ceiling, then method, then capacity. A trap means the renderer failed.

Output frame `k` reads input position `k*p/q` exactly:

- `index = floor(k*p/q)`, `remainder = (k*p) mod q`, fractional weight `t = floor(remainder*32768/q)` (Q15);
- output length `floor((L-1)*q/p) + 1` for `L` input frames; input outside the cut reads as zero, so the result depends only on the slice;
- method 0 is two-point linear interpolation; method 1 is cubic Hermite (Catmull-Rom) with weights that are the exact cubic polynomials floored once to Q30; sums are accumulated in 64-bit integers, rounded half toward positive infinity, and saturated once to 16 bits;
- a linear fade over `min(240, floor(n/2))` output frames (5 ms) at both ends, gain `floor(d*32768/fade)` applied as `(y*g + 16384) >> 15`. With two or more output frames the first and last are zero; a one-frame output has no ramp. The vectors pin both.

Limits: `p` and `q` in `1..=2^20` with `p/q` in `[1/4, 4]`, at most `2^21` input frames. The product caps (cut 480,000 frames, output 960,000 frames, a 480-frame minimum) are enforced by a later layer; the core is a total function down to one frame and the vectors exercise it at both ends and at the exact caps.

### What the vectors are, and where their expected values come from

`fixtures/vectors/vectors.json` holds each vector as a generator specification (not bytes), parameters, and the expected status, length and SHA-256. Three independent sources set the expected values, so the table does not restate the implementation:

- `scripts/vectors/reference.py`, a reference written from the contract text with unbounded integers and exact fractions (the Hermite weights are the cubic polynomials evaluated as fractions and floored, not the shifted integer expressions the Rust code uses). `scripts/vectors/generate.py` writes the table from it, and CI fails if the committed table differs.
- The 14 hashes recorded by the original spike, identical on six hosts; the generator refuses to write a table in which the reference disagrees with any of them.
- Outputs worked out by hand for the one-, two- and three-frame cases.

The table also holds the error codes and their order, the exact limits, `out_len` queries, the canonicalisation cases, and three multi-call scenarios in one instance (200 repeats, repeated 2^21-frame renders, and a trap on an output pointer outside memory, which only WebAssembly hosts run because the same call natively would be undefined).

### Identity and the pin

The renderer identity recorded in a content record is `{name, version, wasm_sha256}`: `graft_render::NAME`, `graft_render::VERSION`, and the hash pinned for that version in `fixtures/renderer/PINS`. The pin file is append-only. CI builds the artefact, compares its hash with the pin for the current version, and fails if a hash changed without a new version, if a version has no pin, or if a published pin line was edited.

### Reproducible build

`scripts/build-wasm.sh` builds with the `wasm` profile (LTO, one codegen unit, abort on panic, symbols stripped) and remaps source, toolchain and registry paths, so the bytes do not depend on the checkout directory. `scripts/check-reproducible.sh` builds from two copies at different depths and compares hashes; CI runs it. The pin was created on macOS arm64 and is checked on Linux x86_64 in CI, so the same bytes come out on both.

### Honest consequences

- Hermite with no anti-alias filter aliases when speeding up. That is accepted as the varispeed character and pinned by the method name; a prefilter would be a new method id.
- The browser's own playback-rate varispeed is implementation-defined and is not what is stored. Preview uses this artefact for that reason.
- After a trap, the module's internal frame pointer is not restored. A host must discard the instance after a trap rather than reuse it (the render host, ticket 03, uses a fresh instance per render).
- `unsafe` appears in one place: the module that turns the host's integer addresses into slices, after every parameter has been validated.

### One-day exit checkpoint (ticket 02)

The agreed exit to a TypeScript renderer applies if the artefact will not instantiate, hashes differ across hosts, the build is not reproducible, the toolchain cannot be pinned or the server cannot call it. At the end of the first day: the artefact instantiates with zero imports under wasmtime; native and wasmtime agree on every vector; two builds from different directories are byte-identical; the toolchain is pinned by `rust-toolchain.toml`. None of the exit conditions holds. The browser leg is added by ticket 04.

## Render host

_Not written yet. Tickets 03 and 03b write it._

## Determinism evidence

_Not written yet. Ticket 04 writes it._

## Data model, concurrency, events, operations, security

_Not written yet. Tickets 05 onwards; consolidated by ticket 37 write it._
