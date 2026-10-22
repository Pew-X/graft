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
| `graft-vectors` | render, render-host | the renderer vector table: loader, generators, and the native, wasmtime and render-host harnesses (test support; nothing ships it) |
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

Only 32-bit integers cross the boundary and the caller owns both buffers. Return values are frames written, or a negative status: `-1` for bad parameters, input over the ceiling, an unknown method, or a pointer mistake the module can detect (null, odd-aligned, wrapping the address space, or overlapping buffers), `-2` for an output buffer that is too small. Checks run in that order: parameters and ceiling, then method, then capacity, then (in the C-ABI only) the pointer checks. A trap means the renderer failed.

Output frame `k` reads input position `k*p/q` exactly:

- `index = floor(k*p/q)`, `remainder = (k*p) mod q`, fractional weight `t = floor(remainder*32768/q)` (Q15);
- output length `floor((L-1)*q/p) + 1` for `L` input frames; input outside the cut reads as zero, so the result depends only on the slice;
- method 0 is two-point linear interpolation; method 1 is cubic Hermite (Catmull-Rom) with weights that are the exact cubic polynomials floored once to Q30; sums are accumulated in 64-bit integers, rounded half toward positive infinity, and saturated once to 16 bits;
- a linear fade over `min(240, floor(n/2))` output frames (5 ms) at both ends, gain `floor(d*32768/fade)` applied as `(y*g + 16384) >> 15`. With two or more output frames the first and last are zero; a one-frame output has no ramp. The vectors pin both.

Limits: `p` and `q` in `1..=2^20` with `p/q` in `[1/4, 4]`, at most `2^21` input frames. The product caps (cut 480,000 frames, output 960,000 frames, a 480-frame minimum) are enforced by a later layer; the core is a total function down to one frame and the vectors exercise it at both ends and at the exact caps.

### What the vectors are, and where their expected values come from

`fixtures/vectors/vectors.json` holds each vector as a generator specification (not bytes), parameters, and the expected status, length and SHA-256. Three sources set the expected values, so the table does not restate the implementation. The reference and the Rust code are two implementations written from the same contract text, which is a cross-check of the code against the text and not an independent source of the contract itself:

- `scripts/vectors/reference.py`, a reference written from the contract text with unbounded integers and exact fractions (the Hermite weights are the cubic polynomials evaluated as fractions and floored, not the shifted integer expressions the Rust code uses). `scripts/vectors/generate.py` writes the table from it, and CI fails if the committed table differs.
- The 14 hashes recorded by the original spike. The spike's notes (kept outside this repository) record them as identical on wasmtime, native, Node, Chrome, WebKit and wazero; the repository itself only holds the hash strings, and the generator refuses to write a table in which the reference disagrees with any of them.
- Outputs worked out by hand for the one-, two- and three-frame cases. The downmix expectations are computed by a one-line reference rule and add little beyond pinning the rounding convention.

The table also holds the error codes and their order, the exact limits, `out_len` queries, the canonicalisation cases, and three multi-call scenarios in one instance: 200 repeats; repeated 2^21-frame renders; and wrong pointers (null, odd, overlapping, wrapping, which return `-1`, and an output pointer beyond linear memory, which traps with an out-of-bounds memory access). Only WebAssembly hosts run the pointer cases, because natively there are no raw pointers; the native harness calls the safe entry points and never touches the C-ABI module, so only the wasmtime run exercises it.

### Identity and the pin

The renderer identity recorded in a content record is `{name, version, wasm_sha256}`. A host reads the version from the loaded artefact's `graft_version()` export and computes the SHA-256 of the exact bytes it loaded; the pair must match the line for that version in `fixtures/renderer/PINS`, and a mismatch is a startup error (the render host, ticket 03, implements this; `graft-render` itself is not a dependency of the service). The pin file is append-only. CI builds the artefact, compares its hash with the pin for the current version, and fails if a hash changed without a new version, if a version has no pin, or if a published pin line was edited.

### Reproducible build

`scripts/build-wasm.sh` builds with the `wasm` profile (LTO, one codegen unit, abort on panic, symbols stripped) and remaps source, toolchain and registry paths, so the bytes do not depend on the checkout directory, and the script clears ambient cargo and rustc settings that could change them. `scripts/check-reproducible.sh` builds from two copies at different depths with different `CARGO_HOME` directories and compares hashes; CI runs it. The pin was created on macOS arm64 and CI compares the Linux x86_64 build with it on every run, so a difference between the two operating systems fails the build.

### Honest consequences

- Hermite with no anti-alias filter aliases when speeding up. That is accepted as the varispeed character and pinned by the method name; a prefilter would be a new method id.
- The browser's own playback-rate varispeed is implementation-defined and is not what is stored. Preview uses this artefact for that reason.
- After a trap, the module's internal frame pointer is not restored. A host must discard the instance after a trap rather than reuse it (the render host, ticket 03, uses a fresh instance per render).
- `unsafe` appears in one place: the module that turns the host's integer addresses into slices, after every parameter and every checkable pointer property has been validated. Whether an address lies inside linear memory cannot be checked without an import, so such a pointer traps.

### One-day exit checkpoint (ticket 02)

The agreed exit to a TypeScript renderer applies if the artefact will not instantiate, hashes differ across hosts, the build is not reproducible, the toolchain cannot be pinned or the server cannot call it. At the end of the first day: the artefact instantiates with zero imports under wasmtime; native and wasmtime agree on every vector; two builds from different directories are byte-identical; the toolchain is pinned by `rust-toolchain.toml`. The same artefact was also instantiated in Node (V8, the engine behind Chromium) with an empty import object, and all 44 render vectors matched; that was a one-off run and is not part of CI. Firefox and WebKit have not run this artefact yet, so condition (a) and (b) stay open for browsers until ticket 04 adds them to CI. No exit condition holds for the hosts tested so far.

## Render host

`graft-render-host` runs the pinned `.wasm` for the service. The publish path calls one trait, `Render::render(cut, ratio, method)`, and gets audio or a typed `RenderError`. The crate accepts audio as slices and returns audio as vectors; it has no network surface, and `scripts/check-crate-graph.mjs` fails if it gains a dependency outside a short allowlist (no HTTP, socket or async-runtime crate).

### Loading

`RenderHost::load` checks the artefact before anything runs. It refuses a module that imports anything or lacks any of the six exports, instantiates it once to read `graft_version()`, hashes the exact bytes it was given, and compares that hash with the line for that version in `fixtures/renderer/PINS`, which is compiled into the binary. An unpinned version or a different hash is a startup error. The resulting identity (`graft-render`, version, SHA-256) is what a content record embeds.

### Per-render isolation and limits

- The module is compiled once and shared (engine, module and pre-linked instance are `Send + Sync`); every render gets a fresh store and a fresh instance. Nothing a render does to memory or globals survives it, and a trapped instance is discarded, which matters because a trap leaves the module's internal frame pointer unrestored.
- Memory: a resource limiter refuses growth past `Limits::max_memory_bytes` (default 64 MiB; the renderer's own worst case, 2^21 input frames at speed 1/4, needs about 21 MiB). A refusal is recorded, so the caller gets `MemoryLimit` even if the module coped with the failed allocation.
- Interruption: fuel, not wall-clock epochs. Fuel is a count of executed instructions rather than elapsed time, so a request uses the same budget whatever the machine's speed and the tests are not timing-dependent. It is not bit-identical across platforms: the worst-case render counted 412,822,442 on macOS arm64 and 412,806,057 on Linux x86_64 (a difference of about 0.004%), so the budget needs headroom and is not a place to hide behaviour. The default budget is `Limits::max_fuel` = 1,000,000,000, about 2.4 times the most expensive render the renderer will accept (see the measurements). A module that runs out gets `Interrupted`. The module has no imports, so it can call nothing outside itself; its own instructions are metered by fuel and its memory growth by the memory limit. A test interrupts an endless loop with a 50,000,000 fuel budget and asserts that it returns within 5 seconds (in practice a few milliseconds).
- SIMD (including relaxed SIMD), multi-memory and 64-bit memories are switched off in the engine configuration; the engine is built without wasmtime's `threads` feature, so shared memory and atomics are unavailable.
- Errors: a negative return code is `InvalidParameters` (-1) or `OutputTooSmall` (-2); a trap is `Trapped`; any other return value is `Internal`. The host never panics on module output.

### What the tests show

Hostile modules written by hand (an endless loop, an `unreachable`, a memory-growth loop, a negative code outside the contract, an import, a missing export, a SIMD module, a shared-memory module) check each mapping, and that the next render on the same host still works. The real renderer's costliest accepted render is also interrupted when given a fuel budget that is too small. The real renderer is run through the host in `graft-vectors`: every vector in the table (including all error codes), render A then B then A with identical bytes, and 8 threads sharing one host. The per-render isolation tests use a module that copies its input and adds a per-instance counter, so reused state or a shared instance would change the output. During development two deliberate breaks (ignoring the memory-limit record, mapping out-of-fuel to a different error) each made a test fail; those were manual checks, not automated ones.

### Measurements

Measured by `crates/vectors/src/bin/render-measure.rs`, run by the `renderer` CI job on a GitHub-hosted `ubuntu-24.04` runner (the job summary keeps the output). Method: load once, one warm-up render per case, then 15 timed renders; the table shows the median and the slowest. Fuel and linear memory are the host's own accounting; the process peak is read from `/proc/self/status`. The input is the LCG noise used by the vectors, Hermite method.

Cold start on the runner: load, compile and pin check 35.7 ms; first render 0.11 ms.

| case | input frames | output frames | median | slowest | fuel | linear memory |
|---|---|---|---|---|---|---|
| cut cap at speed 1 | 480,000 | 480,000 | 7.9 ms | 14.8 ms | 103,206,760 | 2.9 MiB |
| speed 1/4, output at the 20 s cap | 240,000 | 959,997 | 14.7 ms | 16.4 ms | 206,406,021 | 3.4 MiB |
| speed 1/4, cut cap (beyond the output cap) | 480,000 | 1,919,997 | 27.0 ms | 27.5 ms | 412,806,057 | 5.7 MiB |
| speed 4, cut cap | 480,000 | 120,000 | 2.2 ms | 2.4 ms | 25,806,782 | 2.2 MiB |
| speed 4, renderer input ceiling | 2,097,152 | 524,288 | 8.3 ms | 9.8 ms | 112,728,765 | 6.2 MiB |

Process peak resident memory over the whole run: about 29 MB. What this sizes: a render is milliseconds and a few MiB; the 1,000,000,000 fuel budget is about 2.4 times the most expensive render the renderer will accept, and the 64 MiB limit is about three times the renderer's own worst case. These are single-threaded timings on a shared runner, not throughput or scale claims, and the numbers on the target host are added by ticket 03b.

## Determinism evidence

What is checked, where, and what is not. Everything here compares the output hash of every vector in `fixtures/vectors/vectors.json` (and, for five vectors, the output bytes) with the table; a difference on any host fails the build and names the vector and the host.

| host | what runs | linux x86_64 | macOS arm64 (configured; no CI run yet when this was written) |
|---|---|---|---|
| native Rust (`graft-render` safe entry points) | table | every pull request | after merges to dev, staging, main, and on demand |
| wasmtime (`graft-vectors` harness) | artefact, table, pointer and trap scenarios | every pull request | after merges and on demand |
| render host (`graft-render-host`, the service's code path) | artefact, table | every pull request | after merges and on demand |
| Node (V8) | artefact and the TypeScript port | every pull request | after merges and on demand |
| Chromium, Firefox, WebKit (Playwright) | artefact, instantiated with an empty import object, and the TypeScript port; table, scenarios including the trap path | every pull request | after merges and on demand |

- The artefact itself is built twice from different directories and compared, and its hash is compared with the pin (see "Determinism contract"); the macOS-built pin is compared with the Linux build on every pull request. In both operating-system jobs the artefact built in the job is checked against the pin (`scripts/cross-host.sh`) before any host runs it, and the render host checks it again when it loads.
- The TypeScript port lives in `tools/vectors` as test support. `scripts/check-repo.mjs` fails if anything under `web/` references it, so it cannot reach a UI bundle by accident. It also runs the ingest canonicalisation cases, because TypeScript is where that rule runs in production.
- Preview parity: for five vectors the artefact's output bytes in each browser are compared, byte for byte, with the output of the native renderer.
- The pointer scenario runs on every host that has raw pointers (wasmtime, the render host through its own checks, the artefact in Node and in each browser). The native harness and the TypeScript port are exempt by declaration, and the harness fails a host that claims raw pointers but does not run the cases.
- macOS runs after merges rather than on every pull request because macOS minutes cost ten times Linux minutes on private repositories.
- Chromium runs in its full headless mode. In the stripped-down headless-shell variant, the tab crashed ("Target crashed") on the Linux x86_64 runner when the artefact trapped on a deliberate out-of-bounds write (the `wild-output` pointer case); the same case passes in Node's V8 on Linux and in Firefox and WebKit on Linux (CI), and in both Chromium variants on the builder's macOS machine (a local run, not CI). It was observed in CI, narrowed to that one case, and not investigated further.
- Run time: in one observed run the Linux job (`cross-host vectors (ubuntu-24.04)`) ran for about 4 minutes in Playwright's container image, which carries the browsers' system libraries; installing them on the bare runner needed about 9 minutes in an earlier run. The macOS job had not run when this was written, so it has no figure. The container image and the rustup installer are pinned by digest and checksum.

Not checked:

- Real Safari. Playwright's WebKit is a proxy for it; a manual check on a real device is recorded by the builder, not by CI.
- Other CPU architectures than x86_64 and arm64, a second Rust patch version, mobile browsers, and Windows.
- Input canonicalisation across browsers' audio decoders: only the rule applied to given floats is checked, not what a decoder produces from a compressed file.
- Anything about listening quality; the vectors check bytes, not sound.

## Data model, concurrency, events, operations, security

_Not written yet. Tickets 05 onwards; consolidated by ticket 37 write it._

### Check on the target host (ticket 03b)

`Dockerfile`, `fly.toml` and the `graft-fly-check` crate are a throwaway check for the first deployment, removed by the deploy pipeline ticket. At start-up the service loads the artefact through the render host (so the pin is checked), replays the whole vector table, runs the five worst-case renders, and records the result once. It serves only `GET /health` (200 when every check passed, 503 otherwise) and `GET /results` (the recorded document: renderer identity, region and app name from the platform, CPU count and memory, cold-start time, the checks and any failures, the measurements, peak resident memory). It reads a request only as far as its first line, answers anything but `GET` with 405, and never passes anything from the network to the renderer.

The `check image (container)` CI job builds the image and runs it at the target size (512 MB, one CPU), reads `/results` and fails on any vector failure, so the container itself is checked on Linux x86_64 before it is deployed. That is not the same machine as a Fly VM: the numbers on Fly, and whether 512 MB is enough there, are recorded after the builder deploys it (the checklist is at the top of `fly.toml`).
