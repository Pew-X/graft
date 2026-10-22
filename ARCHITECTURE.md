# Architecture

Each section names the ticket that writes it. A section that says "not written yet" describes work that has not happened.

## Module boundaries

One deployable Rust service plus a Next.js UI, built as a Cargo workspace. The arrows below are enforced in CI by `scripts/check-crate-graph.mjs`, which fails on any dependency edge (normal, dev or build) against them.

| Crate | Depends on | Role |
|---|---|---|
| `graft-domain` | nothing in the workspace | content record, publication, ancestry rules, honesty states, limits |
| `graft-render` | nothing at all | the integer renderer and its C-ABI wrapper, compiled to the canonical `.wasm` |
| `graft-storage` | domain | Postgres store (migrations, idempotent writes, flip creation under the stage lock, maker and operator flag changes, reports, the chain read), the blob store trait with an in-memory, a directory-backed and an S3-compatible implementation, and the orphan cleanup. `Store` is a concrete type on purpose: the test seam is a real Postgres, so a trait would never have a second implementation. The blob store and the event sink are traits because they do have fakes |
| `graft-render-host` | domain | runs the canonical `.wasm` under wasmtime |
| `graft-events` | domain, storage | the event-sink trait, the Postgres-only sink and a recording sink, the relay that delivers claimed ledger rows to a sink, and the retention job; the consumer and rollups arrive with their ticket. The ledger's SQL stays in `graft-storage` so that a server event commits in the same transaction as its write |
| `graft-vectors` | render, render-host | the renderer vector table: loader, generators, and the native, wasmtime and render-host harnesses (test support; nothing ships it) |
| `graft-host-check` | render-host, vectors | throwaway check service for the first deployment (see "Check on the target host"); removed by the deploy pipeline ticket |
| `graft-api` | domain, storage, render-host, events | HTTP layer: reads, publishing, maker actions, reports and the operator routes; the OpenAPI document; configuration; the seed script and the cleanup command. Rate limits arrive with the abuse-guardrail ticket |

Nothing depends on `graft-api`. `graft-render` is deliberately kept apart: the renderer is one artefact that must build alone, with no dependencies, to a reproducible `.wasm`.

Written by ticket 01; rows for storage, events and api updated by ticket 05.

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

### Check on the target host (ticket 03b)

`Dockerfile` and the `graft-host-check` crate are a throwaway check for the first deployment, removed by the deploy pipeline ticket. The service will run on AWS (the same image runs on ECS with Fargate); the UI is hosted on Vercel. At start-up the check service loads the artefact through the render host (so the pin is checked), replays the whole vector table, runs the five worst-case renders, and records the result once. It serves only `GET /health` (200 when every check passed, 503 otherwise) and `GET /results` (the recorded document: renderer identity, region and execution environment from the platform, CPU count and the host's total memory, cold-start time, the checks and any failures, the measurements, peak resident memory). It looks only at the first line of a request (reading at most 8 KiB, within 3 seconds, and discarding the rest), answers anything but `GET` with 405, refuses connections beyond 32 at once with 503, serves a start-up failure as valid JSON that names no file paths, and never passes anything from the network to the renderer. Its failure modes (a line past the cap, a client dripping bytes, a connection closed mid-line, non-UTF-8 input, a start-up failure) have unit tests; the container CI job exercises GET, POST and an unknown path.

The `check image (container)` CI job builds the image and runs it at a small size (512 MB, one CPU), reads `/results` and fails on any vector failure, so the container itself is checked on Linux x86_64 before it is deployed. In one CI run, 110 of 110 checks passed in the container; load, compile and pin check took 29.8 ms; the costliest render (1.92M output frames) took a median of 17.4 ms; and the process peaked at about 30 MB resident. The container's CPU and memory limits do not show in `/proc/meminfo` (it reported the runner's 8 GB), so that field is the host's, not the limit. That is not the same machine as an AWS task: the numbers on the target host, and whether 512 MB is enough there, are recorded after the builder runs the image on AWS.

## Determinism evidence

What is checked, where, and what is not. Everything here compares the output hash of every vector in `fixtures/vectors/vectors.json` (and, for five vectors, the output bytes) with the table; a difference on any host fails the build and names the vector and the host.

| host | what runs | linux x86_64 | macOS arm64 |
|---|---|---|---|
| native Rust (`graft-render` safe entry points) | table | every pull request | on demand (and on the builder's own machine) |
| wasmtime (`graft-vectors` harness) | artefact, table, pointer and trap scenarios | every pull request | on demand (and on the builder's own machine) |
| render host (`graft-render-host`, the service's code path) | artefact, table | every pull request | on demand (and on the builder's own machine) |
| Node (V8) | artefact and the TypeScript port | every pull request | on demand (and on the builder's own machine) |
| Chromium, Firefox, WebKit (Playwright) | artefact, instantiated with an empty import object, and the TypeScript port; table, scenarios including the trap path | every pull request | on demand (and on the builder's own machine) |

- The artefact itself is built twice from different directories and compared, and its hash is compared with the pin (see "Determinism contract"); the macOS-built pin is compared with the Linux build on every pull request. In both operating-system jobs the artefact built in the job is checked against the pin (`scripts/cross-host.sh`) before any host runs it, and the render host checks it again when it loads.
- The TypeScript port lives in `tools/vectors` as test support. `scripts/check-repo.mjs` fails if anything under `web/` references it, so it cannot reach a UI bundle by accident. It also runs the ingest canonicalisation cases, because TypeScript is where that rule runs in production.
- Preview parity: for five vectors the artefact's output bytes in each browser are compared, byte for byte, with the output of the native renderer.
- The pointer scenario runs on every host that has raw pointers (wasmtime, the render host through its own checks, the artefact in Node and in each browser). The native harness and the TypeScript port are exempt by declaration, and the harness fails a host that claims raw pointers but does not run the cases.
- macOS runs only when started by hand (the `workflow_dispatch` trigger), not on pull requests and not after merges, because macOS minutes cost ten times Linux minutes on private repositories and the wait was costing more than the coverage was worth. The builder's own machine is macOS arm64 and runs the same test suite locally; a hand-started CI run is the independent confirmation, to be used before a release or when a change could behave differently on arm64. The macOS column above is therefore evidence from the last run of that job, not from every change.
- The slow Linux jobs (this matrix, the renderer reproducibility job and the check image) run on a pull request only when the files changed can affect them (the renderer, the vector table, the scripts, the toolchain and lock files, the playback engine and its browser test, the workflow itself; for the image, also its Dockerfile and service). A skipped job counts as passing for a required check. Pushes to `dev`, `staging` and `main` always run them in full, so what ships is never unchecked.
- Chromium runs in its full headless mode. In the stripped-down headless-shell variant, the tab crashed ("Target crashed") on the Linux x86_64 runner when the artefact trapped on a deliberate out-of-bounds write (the `wild-output` pointer case); the same case passes in Node's V8 on Linux and in Firefox and WebKit on Linux (CI), and in both Chromium variants on the builder's macOS machine (a local run, not CI). On `macos-15` CI, Chromium, Firefox and WebKit all passed. It was observed in CI, narrowed to that one case, and not investigated further.
- Run time: in one observed run the Linux job (`cross-host vectors (ubuntu-24.04)`) ran for about 4 minutes in Playwright's container image, which carries the browsers' system libraries; installing them on the bare runner needed about 9 minutes in an earlier run. The macOS job (`macos-15`, arm64) ran for about 2 minutes 15 seconds in one trial run. It uses `macos-15` because on `macos-14` Playwright's WebKit build failed to start a page ("Unknown setting: PushAPIEnabled"), a mismatch between that WebKit build and the older macOS image; the Rust hosts and Node passed there too. The container image and the rustup installer are pinned by digest and checksum.

Not checked:

- Real Safari. Playwright's WebKit is a proxy for it; a manual check on a real device is recorded by the builder, not by CI.
- Other CPU architectures than x86_64 and arm64, a second Rust patch version, mobile browsers, and Windows.
- Input canonicalisation across browsers' audio decoders: only the rule applied to given floats is checked, not what a decoder produces from a compressed file.
- Anything about listening quality; the vectors check bytes, not sound.

## Data model

Written by ticket 05.

**Content record and publication.** A *content record* is the immutable description of the work done in one stage: its format version, kind (source or flip), the parent *publication* (absent for a source), the hash of the audio the cut was taken from, the cut as a half-open frame range, the transform (the exact fraction `p/q` and the method id), the renderer (name, version and the SHA-256 of the `.wasm`) and the hash of the output. It carries no creation time and no maker. A *publication* is a maker's credited claim on a content record: public id, title and name as typed, creation time, a retry key, and for sources the declared evidence. Publications are not hashed.

**Why forks point at publications.** A flip names its parent publication, not the parent's audio. The roll can then show the exact credit line that was forked, and two makers who publish the same flip of the same parent get two publications that share one content record and one stored audio blob. The consequence is deliberate: because a child's record includes its parent's publication id, the same cut and speed of two different parents is two different records.

**Canonical encoding and the hash.** The record is encoded as canonical JSON, the subset of RFC 8785 that graft uses: objects, integers and strings only; keys ordered by UTF-16 code unit; minimal string escapes; integers limited to plus or minus 2^53 - 1; no whitespace. The record id is the SHA-256 of those bytes. `graft-domain` tests the encoder against hand-derived literals (including the UTF-16 key order that differs from UTF-8 byte order) and a shuffle property, and pins two whole records to byte-exact JSON and to digests computed outside Rust with Python's `hashlib`. A valid record id says which bytes were described, nothing about who made them or whether they may be shared.

**Identifiers.** A publication id is 60 bits shown as 12 characters from `0-9a-z` without `i`, `l`, `o` and `u`: opaque, non-sequential and URL-safe. Visitor publications get random ids from the service. *Seeded* publications get ids derived from their deterministic retry key (`SHA-256("graft-seeded-publication-v1:" + key)`, first eight bytes, low 60 bits). This is a small documented exception to "ids are random": it makes ids, content hashes and the shipped static snapshot identical in every environment, because a child's hash includes its parent's id. A test seeds two independent databases and compares ids, record ids and the chain read.

**Idempotent creation.** `create_publication` inserts the record (`ON CONFLICT DO NOTHING`, since records are content-addressed) and the publication (`ON CONFLICT (retry_key) DO NOTHING`) in one transaction. If the key already exists with the same record it returns the existing publication; with a different record it rolls back and reports a conflict, leaving no record behind. Isolation level, the per-parent advisory lock and the fork caps arrive with the publish ticket.

**Reading a chain.** The chain read is one SQL statement: a recursive walk from the requested publication up its parent links, bounded by the depth cap plus one row, joined to the records and counting children in the same snapshot. Assembly (`graft_domain::chain::assemble`) is pure: it orders stages source first, marks a named parent that could not be read as *unavailable* rather than shortening the chain, and reports `truncated: depth_cap` when the walk was cut short. A read past the cap is truncated with a stated reason and not refused, because publishing refuses to build deeper chains, so stored data never exceeds the cap and the read stays total. A chain exactly at the cap is not reported as truncated. A stored row whose record does not hash to its id is reported as damaged and not served.

**The count.** "Flipped N times" is the number of publications whose record names this one as parent, computed from publications data at read time (an index on the parent column), never from events.

**Why there is no closure table.** Ancestry is a bounded recursive walk of at most 12 rows per request. A closure table would be needed if the product needed whole-subtree reads (every descendant of a stage) or if the depth cap grew from 12 towards hundreds; neither is in scope.

**Honesty in the read model.** Every credit line carries `declared`, `computed` or `unknown`. Names, titles and notes are declared and are sent as plain text as typed, never as a handle. The cut and the speed are computed. Rights are `unknown` ("not established"). A test fails if any credit line contains one of the claim words the project never uses.

**What is not here yet.** The events ledger, the outbox relay and the rollups (tickets 13 and 14), and the per-IP and global rate limits (ticket 10). The manage key, fork permission, hiding with a reason, held descendants, the publish path, the S3 client and signed URLs are described in the sections that follow, and a test checks that no response contains the manage-key hash.

**Migrations.** Plain, numbered SQL files in `crates/storage/migrations`, applied by sqlx at start-up and by every test against a fresh database. They are forward-only by policy: a down migration is rarely safe to run against data that has changed since, so a change that must be undone is a new migration. Changes follow expand then contract: add the new shape, ship code that uses it, remove the old shape in a later migration. Constraints belong in the schema (the checks that refuse a source with a parent, a negative cut, a hash of the wrong length), so the database refuses invalid rows even if the application would not.

## Configuration

Written by ticket 05; later tickets add rows. Every value is read from the environment at start-up; only the database URL is required, and it is a secret that is never logged or echoed in an error.

| Variable | Default | Meaning |
|---|---|---|
| `GRAFT_DATABASE_URL` | none (required) | Postgres connection string |
| `GRAFT_BIND` | `127.0.0.1:8080` | listen address |
| `GRAFT_CORS_ORIGINS` | empty | comma-separated origins allowed cross-origin; empty means none |
| `GRAFT_MAX_CHAIN_DEPTH` | 12 | deepest chain, source counted as stage 1 |
| `GRAFT_MAX_SOURCE_FRAMES` | 720,000 | longest source (15 s at 48 kHz) |
| `GRAFT_MAX_CUT_FRAMES` | 480,000 | longest cut (10 s) |
| `GRAFT_MAX_OUTPUT_FRAMES` | 960,000 | longest rendered output (20 s) |
| `GRAFT_MIN_FRAMES` | 480 | shortest cut and output (10 ms) |
| `GRAFT_MAX_TITLE_CHARS` / `GRAFT_MAX_AUTHOR_CHARS` | 60 / 32 | public text limits |
| `GRAFT_BLOB_URL_TTL_SECS` | 300 | lifetime of an issued blob URL |
| `GRAFT_BLOB_DIR` | unset | local directory for audio, for development (used when no bucket is configured) |
| `GRAFT_BLOB_S3_BUCKET` | unset | the S3-compatible bucket for audio; setting it turns the S3 store on |
| `GRAFT_BLOB_S3_ACCESS_KEY_ID`, `GRAFT_BLOB_S3_SECRET_ACCESS_KEY` | none (required with a bucket) | credentials; secrets, never logged or printed |
| `GRAFT_BLOB_S3_ENDPOINT` | unset | endpoint for R2 or a test server; unset for Amazon S3 |
| `GRAFT_BLOB_S3_REGION` | `us-east-1` | region (`auto` for R2) |
| `GRAFT_BLOB_S3_PREFIX`, `GRAFT_BLOB_S3_ALLOW_HTTP` | unset, `false` | key prefix inside the bucket; plain HTTP for a local test server only |
| `GRAFT_BLOB_REFRESH_SECS` | 600 | a blob older than this is refreshed when written again |
| `GRAFT_ORPHAN_GRACE_SECS` | 3600 | the cleanup leaves younger blobs alone; at least twice the refresh threshold |
| `GRAFT_RENDERER_WASM` | none (required by the service) | path to the canonical renderer artefact; loading checks it against the pinned hash for the version it reports |
| `GRAFT_MAX_FORKS_PER_STAGE_PER_HOUR` | 20 | most flips of one stage within an hour; beyond it flips are refused with 429 |
| `GRAFT_SERIALIZATION_RETRIES` | 5 | retries of a publish transaction that conflicted with concurrent work |
| `GRAFT_DENY_WORDS` | empty | extra words refused in titles and names, beyond the built-in list |
| `GRAFT_ADMIN_SECRET` | unset | the operator secret (at least 24 characters); when unset every admin request is refused |
| `GRAFT_MAX_CONCURRENT_RENDERS` | 4 | most renders running at once; a request that waits over 5 s for a turn gets 503 retry-later |
| `GRAFT_LOCK_WAIT_MS` | 10000 | how long a publish or a flag change waits for the lock on its stage before answering 503 |
| `GRAFT_PUBLISHING` | `on` | whether publishing is open until the operator sets the kill switch (`on` or `off`) |
| `GRAFT_SWITCH_CACHE_MS` | 2000 | how long a read of the kill switch is reused; the most a change made on another instance needs to be seen |
| `GRAFT_TRUSTED_PROXY_HOPS` | 0 | trusted proxies in front of the service; with 1 behind a load balancer the visitor is the last `X-Forwarded-For` entry |
| `GRAFT_PUBLISH_PER_IP`, `GRAFT_PUBLISH_WINDOW_SECS` | 20, 3600 | publishes one address may make within the window |
| `GRAFT_REPORT_PER_IP`, `GRAFT_REPORT_WINDOW_SECS` | 10, 3600 | reports one address may file within the window |
| `GRAFT_ADMIN_FAILURES_PER_IP`, `GRAFT_ADMIN_WINDOW_SECS` | 10, 900 | refused admin attempts one address may make before it waits |
| `GRAFT_GLOBAL_PUBLISH_PER_HOUR`, `GRAFT_GLOBAL_PUBLISH_BURST` | 120, 30 | the global publish cap: tokens refilled per hour, and the most admitted in one burst |
| `GRAFT_STORAGE_LIMIT_BYTES` | 8,000,000,000 | what the host allows for audio; the admission threshold is this minus the overshoot bound |
| `GRAFT_STORAGE_REFRESH_SECS` | 60 | how often the stored total is read again |

Without a bucket or `GRAFT_BLOB_DIR` the service keeps audio in memory and says so in its log. The seed script refuses to seed into memory, and also reads `GRAFT_RENDERER_WASM` (the artefact, checked against the pins).

## Interface contract

Written by ticket 05.

The service generates its OpenAPI 3.1 document from the handlers' annotations (utoipa). The document is committed as `openapi/openapi.json`; CI regenerates it and fails on any difference. The typed TypeScript client types (`web/lib/api/schema.d.ts`) are generated from the committed document with openapi-typescript, CI regenerates them and fails on a difference, and the web build typechecks real uses of the client (`web/lib/api/chain.ts`), so renaming or removing a response field fails the UI build. This was shown twice on purpose. Locally: renaming `title` in the Rust view changed the OpenAPI document (the drift check fails) and, after regenerating, the client no longer typechecked (`Property 'title' does not exist`). In CI (scratch pull request, closed unmerged, run 39789486924): with both generated files regenerated consistently, the drift steps passed and `pnpm typecheck` was the only failing step in the `web` job, which shows the UI depends on the field and not just that a file changed. Errors are RFC 9457 problem details (`application/problem+json`) with a stable `type` URN. An id that is malformed and an id that does not exist get the same 404 body.

## Operational baseline

Written by ticket 05; ticket 16 deepens it.

- Logs are JSON, one line per event, each inside a span that carries a per-request id (also returned as `x-request-id`); a test parses every line of a real request and checks the id, and that no connection string appears.
- `GET /health` answers without touching the database; `GET /ready` pings it and returns 503 problem details when it fails, without echoing the connection string (tested against a closed pool).
- `GET /metrics` serves the Prometheus text format: a request counter by method, route pattern and status, and a latency histogram by route pattern, so label cardinality stays bounded.
- Every response carries `content-security-policy: default-src 'none'; frame-ancestors 'none'`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer` and `cache-control: no-store`. CORS allows nothing unless origins are configured.
- Tests run through the public HTTP API against a real Postgres 16 (a fresh database per test; a service container in CI), with an in-memory blob store and a no-op event sink. Queries are runtime queries, so building needs no database and no offline query data.

## Publishing a flip

Written by ticket 06.

`POST /v1/publications` accepts the parent publication's id, a cut (half-open frame range), the speed as an exact fraction `p/q`, a title, a name as typed, a client-chosen retry key and, optionally, the hash of the audio the client's preview rendered. No audio travels: the server renders it. The order of the steps is the design.

1. **No I/O.** Titles and names are cleaned by `graft_domain::text` (below); the retry key and preview hash are checked for shape; the cut and speed are checked against the limits (cut at least 480 and at most 480,000 frames, speed between 1/4 and 4 with `p` and `q` at most 2^20). Each refusal is a 422 problem naming the field and the rule.
2. **The parent.** It must exist, and the chain must have room for one more stage (depth cap 12).
3. **Render, outside any transaction.** The parent's audio is read from the blob store (a stored blob that does not hash to its name is an error, never served), the output length is asked of the renderer and checked against the 480-frame minimum and the 960,000-frame maximum, and the cut is rendered by the canonical `.wasm` under wasmtime on a blocking thread. A render never holds a database lock. The result is written with put-if-absent.
4. **The transaction.** See below.

**The server's render is the only canonical one.** The client's preview hash is a cross-check: on a mismatch the server's audio is stored, the response says `preview_matches: false`, and `graft_preview_mismatch_total` is incremented. Nothing silently picks the client's audio. The test compares the stored output with a render computed by the independent Python reference from ticket 02, not by the Rust code under test.

**The response.** The publication is shown exactly as every read shows it, through the availability rule, so a replay of a flip that has since been withdrawn or held carries no audio URL. If that view cannot be built after the commit, the 201 still carries the one-time manage key with an entry that says to read the publication again. 201 with the publication, the manage key and the list of fields whose text was adjusted; 200 with the same publication and no key when the same request is repeated. The manage key is 32 random bytes as 64 hex characters. It is shown in the response that creates the publication and never again: only its SHA-256 is stored, and tests check that no later response and no read contains it, and that the database holds the hash and not the key.

**Public text.** Titles and names pass through one pure function: whitespace is normalised; control, invisible, bidirectional-override and private-use characters are refused; links and `@handles` are removed and the response lists the adjusted fields; letters and digits of any script and a short list of punctuation are allowed; a word that mixes Latin letters with Cyrillic or Greek ones is refused, because it can imitate another word; the length is counted in characters after removal; and a short deny-list of impersonation words (`admin`, `administrator`, `moderator`, `riffle`, extendable by configuration) is refused. A property test checks that anything accepted is short, plain, single-spaced and free of links and handles, and that cleaning it again changes nothing. Limits: zero-width joiners are refused, which can affect some Indic conjuncts, and combining marks are allowed by script block rather than by Unicode category because the standard library has no category lookup.

**Problems.** Refusals are RFC 9457 problem details with a stable `type`; field-level ones add `field` and `rule`. Unknown parent 404, closed parent 403, hidden parent or depth cap or key conflict 409, field rules 422, fork cap 429 (with `Retry-After`), oversized body 413, and 503 with `Retry-After` when conflicts persist. A refusal decided before the render writes nothing, and that includes an unknown, closed or hidden parent: the parent's flags are read cheaply first, so such a request costs no render and leaves no audio. (A request whose retry key is already known skips that check, because an idempotent replay must return what was created even after the parent was closed.) The flags are read again inside the transaction, because they can change in between, and the fork cap is decided only there; a refusal decided inside the transaction happens after the render and the audio write, so it can leave one audio blob behind. No publication and no record is written, and the orphan blob is removed by the cleanup job of the blob ticket.

## Ownership without accounts

Written by ticket 08.

graft has no accounts, so a maker controls their own publication with the **manage key** returned once, in the response that creates it. It is not an identity. It grants exactly two actions on that one publication: closing or reopening it to new flips (`PUT /v1/publications/{id}/fork-permission`) and withdrawing it (`POST /v1/publications/{id}/withdraw`). Losing it means only that those flags can no longer be changed; nothing else is lost, and nothing about the sound is affected.

- **Where the key travels.** In the `X-Graft-Manage-Key` header only. A request that puts a key in the address is refused with a 400 before anything else happens (an address ends up in logs, histories and referrers), and a key in a body is not a field: unknown fields are refused and the request does nothing. A test captures the service's logs through a successful and a refused request and checks that no key appears.
- **How it is checked.** Only the SHA-256 of the key is stored. The comparison is constant-time, and a missing or malformed key, a missing publication and a publication that has no key are compared against a dummy value so that they cost the same as a wrong key.
- **One refusal for everything.** A missing key, an empty key, a malformed key, a wrong key, another publication's key, an id that does not exist, an id that is malformed, and a seeded source (which has no key, so nobody can manage it) all get the identical 403 `manage-key-refused` response. A test sends all of them and checks the bodies are equal and that none echoes a key. Rate limiting of attempts arrives with the abuse-guardrail ticket; guessing a 256-bit key is not feasible, but attempts are cheap and will be bounded there.
- **What the actions do.** Closing stops new flips only: existing flips, their audio and every roll that contains them are untouched, and the flag is visible in the read model (`fork_permitted`), not hidden. Reopening allows flips again. Withdrawing sets the hidden flag with the reason `withdrawn`. The maker cannot undo a withdrawal (only the operator can clear a hide, in the moderation ticket) and cannot weaken a hide the operator made for rights: withdrawing a stage hidden for rights leaves it hidden for rights. Closing, reopening and withdrawing are idempotent: repeating one returns the same state.
- **The read model.** Each position in a chain is `available`, `no_longer_here` (with its reason) or `unavailable` (a parent that could not be read). A hidden stage keeps its credit lines, title and name but carries no audio URL and no exact facts, and no URL is issued for its audio anywhere; stages built on a withdrawn stage stay playable; the chain is never shortened (a test counts the stages before and after). Whether a stage may be heard is decided by one function in the domain crate (`availability`), used by every read, so the rule and the reference model it will be tested against cannot drift. A hash is an identifier and not access: a descendant's record still names the audio it was cut from, and that is fine because nothing issues a URL from a hash.
- **Ordering against forks.** Closing, reopening and withdrawing acquire the same session lock on the stage as creating a flip (see "Concurrency and idempotency"). The test holds a fork between reading the stage's flags and writing, starts a revoke, and checks that the revoke waits, the fork that began first completes, and every fork after the revoke is refused.

## Moderation and held descendants

Written by ticket 09.

**Reporting.** `POST /v1/reports` (public, no account) accepts a publication id, a category from a closed set (`rights`, `private_conversation`, `harmful`, `spam`, `other`) and an optional note of at most 500 characters. The note goes through the same text rules as titles (links and handles removed, invisible and control characters refused), is for the operator only and is never shown publicly. The response is a plain confirmation. A report holds a category, a note and a time and nothing else: a test reads the table's columns and checks there is no place for an IP address, a user agent or an email address, and another captures the logs and checks the note does not reach them. Rate limiting arrives with the abuse-guardrail ticket.

**The operator.** The admin routes (`GET /admin/reports`, `POST` and `DELETE /admin/publications/{id}/hide`) are guarded by a secret from configuration (`GRAFT_ADMIN_SECRET`, at least 24 characters, refused at start-up if shorter) presented in the `X-Graft-Admin-Secret` header. Only its SHA-256 is kept in memory, the comparison is constant-time, and a wrong secret, a missing one and an unconfigured service all get the identical 403; a test sends all of them to all three routes and checks that the bodies are equal and nothing changed. The secret never reaches the logs (tested). The routes are deliberately absent from the public OpenAPI document (decision recorded here: they are internal, and the admin-page ticket will describe them in its own contract); a test checks the document. Until that page exists the operator lists and decides with plain HTTP calls; the operator runbook (ticket 36) is where they will be written down, and it does not exist yet. Reports are listed newest first, each with its publication's current state (`visible`, `withdrawn` or `rights`).

**One decision, reversible.** Hiding a publication needs a reason, `withdrawn` or `rights`; it is idempotent, a later decision replaces an earlier one, and clearing it (whoever hid it) restores the previous state. Hiding acquires the same lock on the stage as creating a flip, so a hide cannot be overtaken by a fork that already read the stage's flags; the test holds a fork before it writes, starts a hide, and checks that the hide waits, the earlier fork completes and every later fork is refused.

**Held descendants, computed at read time.** There is no stored cascade and no job. One function in the domain crate (`graft_domain::chain::availability`) decides, from the chain as read in one snapshot, what each stage is: a hidden stage is *no longer here* with its own reason; otherwise a stage with any ancestor hidden for `rights` is *held*; an ancestor hidden as `withdrawn` changes nothing for the stages built on it; a parent that could not be read holds nobody. The cost is bounded by the depth cap. Every read (chain and single publication) uses that function, and the response says which: `available`, `no_longer_here` (with its reason), `held` or `unavailable`. A hidden or held stage keeps its credit lines, title and name and carries no audio URL and no exact facts; no URL is issued for its audio anywhere, so new requests for it are refused by never issuing one. The chain is never shortened.

**What is tested against what.** The rule is also written a second time, from its wording, as a trivial reference model, and a property test compares the real read path (router, store and view) with it for generated forests and generated hide patterns, 12 cases per run, checking that the chain keeps its length, that audio is issued only for stages that may be heard, that every credit stays visible, and that clearing every hide restores every stage. Making a withdrawn ancestor hold its descendants by mistake makes the property fail and shrink to a minimal input (checked by hand).

**Blob identity never grants access.** Two publications can share one audio blob (two makers publishing the identical flip). Availability is decided per publication: hiding one leaves the other playable, and a test checks that. A hash is an identifier and not access: a descendant's record still names the audio it was cut from, and nothing issues a URL from a hash.

**A held stage cannot be flipped**; neither can a hidden one (409, with their own problem types). A fork accepted just before a hide on one of its ancestors becomes a descendant like any other and is held; a fork of a descendant cannot acquire the hidden stage's lock, because it is keyed on its own parent, so a rights hide above it can land a moment after a fork was accepted. That is harmless, because holding is computed when a chain is read, and it is tested.

**What a takedown achieves.** New requests for the audio of a hidden or held stage are refused; URLs already issued expire within their short lifetime; copies already downloaded cannot be recalled. A rights hide also holds everything built on the hidden stage while it stands. The report path and the operator's decision are the whole procedure; they do not verify anything about rights, and graft states that plainly.

## Abuse guardrails

The public write surface is anonymous, so what keeps it safe and cheap is a small set of limits. Each refuses politely with a stated reason (a problem document with a stable `type`, and a `Retry-After` header where waiting helps); none loses a request silently and none answers with an opaque 500.

| Guardrail | Default | Refusal |
|---|---|---|
| Kill switch (publishing) | open | 503 `publishing-off` |
| Per-address publish limit | 20 per hour | 429 `rate-limited` |
| Per-address report limit | 10 per hour | 429 `rate-limited` |
| Per-address failed admin attempts | 10 per 15 minutes | 429 `rate-limited` |
| Global publish cap | 120 per hour, burst 30 | 429 `publish-cap` |
| Storage admission threshold | 8 GB minus the overshoot bound | 503 `storage-full` |

**The kill switch** is a row in the database (`runtime_settings`), read through a short cache, and set through the operator's `PUT /admin/switch` (`GET` reads it). It needs no redeploy. It closes every route that adds to what is published: flips now, and the source upload and client event routes when they exist. Reads, reports, a maker's own withdrawal and the operator's routes stay open, so a bad moment can always be reported, undone and reopened. A test lists every write route, checks the list against the public interface document, and asserts the switch closes exactly the routes marked as closed; a new write route fails it until someone decides which kind it is. An instance sees its own change at once and another instance's within `GRAFT_SWITCH_CACHE_MS`. If the database cannot be read the last known state stands; before any read, the configured default.

**Per-address limits** count in the memory of one process, in a sliding window, and are forgotten when the window passes or the process restarts. An address is never written to a row, a log line or a metric label, and not stored in any other form either, hashed included; a test dumps every table, the log and the metrics after a mixed run and looks for it. IPv6 visitors count by their /64. With one instance behind a load balancer the connecting address is the balancer, so `GRAFT_TRUSTED_PROXY_HOPS` says how many proxies to trust: the visitor is the `X-Forwarded-For` entry that many places from the right, and anything the visitor wrote further left is ignored. Because the counts are per process, a second instance gives each visitor a second allowance; the global cap, which lives in the database, is what holds across instances. The table of tracked addresses is bounded; when it is full new addresses are not tracked, and the global cap still applies. Failed admin attempts are counted, successes are not, so the operator is not locked out by using the routes.

**The global publish cap** is a token bucket in one database row: a publish acquires one token, tokens refill at a fixed rate up to the burst. It is one conditional update, so any number of simultaneous publishers on any number of instances are admitted exactly as often as there are tokens (a test sends 40 at once against a burst of 7 and sees 7 admitted and 33 refused with a wait). A replay of a publish already made acquires no token and is never refused by the cap or the threshold. A publish that is refused later for another reason has still used its token, which only makes the bound conservative.

**The storage threshold is an admission threshold, not a quota.** The stored total is read from the blob store at most once per `GRAFT_STORAGE_REFRESH_SECS` and compared with the threshold outside any transaction, so it never makes unrelated publishes conflict. Publishes admitted between two reads add to the total, and the global cap bounds how many: at most the burst plus what the cap refills in one refresh interval, each no larger than the largest blob the limits allow. That is the documented **overshoot bound**; with the defaults it is 32 blobs of 1.92 MB, about 61 MB, and the threshold is the host's limit minus it. The service refuses to start if the limit does not exceed the bound. A test publishes a burst while the total is frozen below the threshold and asserts the final total is within the bound of the threshold and under the host's limit, then asserts that after a refresh publishes are refused and store nothing. If the total cannot be read, the last known value is used, and with none, publishing is admitted: refusing everything over a failed listing would be worse than the bounded overshoot. Reading the total lists every audio object, which is cheap at this scale and is the thing to replace first if it grew.

**Public text** policy is configuration (`GRAFT_DENY_WORDS`, on top of the built-in list) and is read at start-up; changing it needs a restart.

**Residual risk, stated plainly.** Someone could still publish what they should not. These limits cap how fast, how much and from how many places, and the reports, the hide and the switch let the operator respond; they do not make misuse impossible. Addresses behind one shared connection share an allowance, and a person with many addresses can exceed the per-address limit, which is why the global cap exists.

## Blobs

Written by ticket 11.

**Content addressing.** Audio is stored under the SHA-256 of its bytes, which is also the hash a content record holds. The store never trusts a name: every read hashes the bytes it found, and a blob that does not match its name is reported as damaged and never served (tested on the directory store and on S3, where a second client overwrites an object with other bytes). `put_verified` refuses bytes that do not hash to the hash they were offered under, and stores nothing.

**Three implementations, one contract.** `BlobStore` has an in-memory fake (fast tests, with a clock the test can move), a directory store (local runs) and an S3-compatible client (Amazon S3, Cloudflare R2 or any server that speaks the protocol). A single contract suite runs against all three, so the fake cannot drift from the real client: identical bytes stored once, safe under concurrent identical writes, a mismatching hash refused, reads that round-trip, deletes that report whether the blob existed, listings and metadata reads that agree, and the refresh rule below. Running it against a real server found one real difference worth knowing: on S3 a metadata read reports the last-modified time to the whole second while a listing reports milliseconds, so the contract says they agree to within a second.

**Dedupe and request idempotency are different mechanisms.** Blob dedupe is "the same bytes are stored once" (a property of the store, tested by the contract). Request idempotency is "the same publish request is handled once" (a property of the retry key, tested through the HTTP API). They are tested separately; two makers publishing an identical flip share one blob and have two publications.

**Delivery.** Audio is never proxied through the API: a chain read carries a short-lived signed URL for each stage's audio, and the browser fetches the bytes from the object store. The reason is cost and capacity (a database host with an egress cap is a poor audio server, and the object store serves bytes better), and it keeps the API small. A URL is issued per publication and only after the availability check, never from a hash alone. The lifetime defaults to 300 seconds (`GRAFT_BLOB_URL_TTL_SECS`); the bucket is private. Tested against a real server: a fresh URL serves exactly the bytes with no credentials, the secret key is never part of a URL, a signature covers one object (the same signature with another object's name is refused), and an issued URL stops working after its lifetime.

**What a takedown achieves.** New requests for the audio of a hidden or held stage get no URL. URLs already issued keep working until they expire (tested: after a withdrawal an issued URL still serves, and after its lifetime it does not), and copies already downloaded cannot be recalled. That is the whole claim.

**Credentials.** They come from the environment (`GRAFT_BLOB_S3_*`), live only inside the client, and are redacted from every `Debug` print; errors name a class of failure ("access denied", "request failed"), never an endpoint, a key or a path. Tests check that a refused credential, an unreachable server and a printed configuration reveal neither the key id, the secret, nor the address.

**Orphan cleanup.** A publish writes its audio before its database transaction, so a publish that fails afterwards leaves a blob nothing refers to. `graft-blob-cleanup` (run on a schedule; the deploy ticket wires that up) removes a blob only if it is older than the grace period (default one hour) and no content record names it as its source audio or its output. It is idempotent, and concurrent runs agree (tested: four at once remove each orphan exactly once).

Object store and database cannot be changed atomically together, so the job cannot make a race impossible. It makes it unlikely and repairable, with four defences, in this order:

1. A blob younger than the grace period is never touched; a publish finishes in seconds.
2. Writing a blob again refreshes its time if it is old (`put_if_absent` guarantees the blob is recent when it returns), so an old leftover with the bytes a new publish needs looks young the moment someone needs it. The pair of tests that matters most: with the refresh, a cleanup running while a publish is held just before its commit leaves the blob alone; with the refresh disabled the same interleaving deletes the blob and the flip still commits a record naming audio that is gone. The hazard is real, and the refresh is what prevents it.
3. Immediately before deleting, the job reads the blob's time again, so a blob refreshed after the listing is not deleted on stale information.
4. After a flip commits, the publish path writes its audio once more. If the blob was removed in the instant between the first write and the commit, this restores it; otherwise it is one cheap check.

What remains: a cleanup that listed a blob as old, found it unreferenced, re-read its time, and deleted it, all inside the few milliseconds between a publish's first write and its post-commit write, could still leave a record naming missing audio until the post-commit write restores it. The configuration refuses a grace period shorter than twice the refresh threshold. Because rendering is deterministic, missing output audio can always be regenerated from the content record (the parent's audio, the cut and the speed); a repair command is left for the operator runbook.

**Test environment.** An S3-compatible server container runs in the Rust CI job and locally (see the README). MinIO, which the ticket names, no longer publishes container images, so the tests use `rustfs`, pinned by digest; it enforces credentials and signed-URL expiry, which is what the tests need. It is a service of the existing job rather than a job of its own because a separate job would build the whole workspace twice; revisit with the CI work. Each test works under its own random key prefix in one bucket.

## Concurrency and idempotency

Written by tickets 06 and 07.

**Why concurrent forks mostly do not conflict.** Parents are immutable and children only insert, so forks of one stage do not contend on the parent's row. What can still go wrong is every rule that looks across children: the per-stage fork cap, the parent's permission and hidden state, and the retry key.

**The transaction.** Those rules are enforced in one `SERIALIZABLE` transaction (`Store::create_flip`), which keeps the answer correct whatever the interleaving. Inside it: an idempotent replay is answered first (so a retry after the parent closed forking, or after the cap filled, still returns what was created); then the parent's flags and the number of publications naming it as parent in the last hour; then the record (insert, conflict on its hash does nothing) and the publication (conflict on the retry key does nothing). Same key and same record returns the existing publication; the same key with a different record is a conflict and writes nothing.

**What measurement changed.** The design called for a transaction-scoped advisory lock keyed on the parent so that forks of one stage queue instead of aborting each other. Taken inside a `SERIALIZABLE` transaction that lock does not do that: the transaction's snapshot is taken at its first statement, before the wait for the lock ends, so every waiter reads stale data and is aborted. Measured with a counting test hook, 24 concurrent forks of one stage took 65 transaction attempts (41 retries). The lock is therefore a session-level advisory lock taken on the connection before the transaction begins, so the snapshot is taken after every earlier fork has committed. Re-measured: 48 concurrent forks over a pool of 16 connections took 48 attempts and no retries, in three runs. The consequences are part of the design, and each has a test:

- Everything in the critical section uses that one connection. A holder that asked the pool for a second connection while waiters held the rest would deadlock.
- The write runs in its own task, so a client that disconnects cannot abandon a transaction half way. The lock is held by a guard type: a normal exit unlocks, resets the one session setting the guard changed (`lock_timeout`) and returns the connection to the pool; every other exit, including an error, a timeout or a panic in the task, closes the connection, which ends the session and with it every lock and setting it had. A lock can therefore never outlive the work that took it, and the setting cannot leak into the pool. Disabling the guard's cleanup makes the panic test fail after the full 10-second wait (checked by hand), so the test does protect it.
- A wait for the lock gives up after `GRAFT_LOCK_WAIT_MS` (default 10 s) and the answer is 503 `retry-later`, not a hang and not a 500.
- Serialization failures are still possible when a writer that does not acquire the lock conflicts (a concurrent hide or revoke, a replayed key). They are retried a bounded number of times (default 5) with a short growing pause, and surfaced as 503 `retry-later` with `Retry-After` when they persist. The client repeats the same request with the same retry key; nothing was written, so no duplicate can result.

**Flag changes acquire the same lock (design for tickets 08 and 09).** A fork reads the parent's permission and hidden flags and commits later; a revoke or hide that did not acquire the parent's lock could commit in between, and serializable isolation would not abort the fork (there is no cycle). So every change to a stage's fork-relevant flags (the maker's revoke and restore, a withdrawal, an operator's hide) acquires the same session lock on that stage before it writes. A revoke then waits for the forks in flight and every fork after it is refused. Those tickets test this with the gate.

**Two guarantees, kept apart.**

1. *Below the limits, every valid concurrent fork of one stage ends up published exactly once, through a same-key retry if the service says "busy".* `races::many_more_simultaneous_forks_than_connections_all_publish_and_the_count_is_exact` sends 40 simultaneous forks at one stage (the pool has 16 connections), four rounds, through the real router, Postgres and renderer; all are published and the chain read shows `flipped_count == 40`. Measured: 160 forks in about 1.9 s with no client retries. Store-level: `flip::more_concurrent_forks_than_pool_connections_all_succeed_without_deadlock_or_conflicts`.
2. *At or beyond the limits, each request is accepted up to the limit or refused with a stated reason; none disappears.* `races::at_the_fork_cap_every_request_is_accepted_up_to_the_limit_or_refused_and_none_disappears` (20 sent, cap 5: exactly 5 accepted, 15 refused with 429, accepted plus refused equals sent) and `races::at_the_depth_cap_every_concurrent_request_is_refused_with_the_same_reason`. The same guarantee for per-IP rate limits and the global publish cap is shown where those limits are built (ticket 10).

**Idempotency.** `races::simultaneous_requests_with_the_same_key_and_payload_create_exactly_one_publication`: 24 simultaneous requests give exactly one 201 and 23 replays, every response names the same publication, and the manage key is in exactly one of them. (The responses cannot be literally identical, because the key is shown once; the publication bodies are identical.) `races::simultaneous_requests_with_the_same_key_and_different_payloads_yield_one_success_and_conflicts`: one success, the rest 409.

**Forcing the rare paths.** The store calls a `Gate` at named points (`locked`, `checked`, `before_commit`); production uses a gate that never waits. Tests hold a flip at `checked` and commit, from another connection and without the lock, a write that reads the parent's children and rewrites the parent's row, which is the cycle serializable isolation must break.

- `races::a_serialization_failure_is_retried_and_the_flip_then_succeeds_exactly_once` asserts more than one attempt (so the conflict really happened) and exactly one publication.
- `races::when_every_attempt_conflicts_the_error_is_retryable_and_the_same_key_then_succeeds_once` and its HTTP twin: with every attempt conflicting, the answer is `RetryExhausted` after exactly the configured attempts, then 503 `retry-later` with `Retry-After: 1`; once the conflicts stop the same request succeeds, a further repeat is a replay, and there is exactly one publication.
- `races::a_stage_that_stays_busy_gives_busy_not_a_hang_and_works_again_when_freed` and its HTTP twin: another session holds the stage's lock; the answer comes within the configured wait and the stage works again when freed.
- `races::a_panic_while_the_lock_is_held_cannot_leave_the_stage_stuck_or_the_pool_damaged`: the next fork proceeds and no advisory lock remains.
- Each of these asserts it finished well inside the lock wait; that is the evidence the lock is released on the error path.

**Properties over generated inputs.** Domain: for generated records (including names with quotes, control and non-ASCII characters) the canonical bytes are read back by an independent JSON parser and re-encoded unchanged, the id is the SHA-256 of the bytes, and two records share an id only if they are equal (`record_properties`). Store, against Postgres: in any generated forest every chain is whole, ordered and loop-free and every flipped count is exact; under generated concurrent requests each key has exactly one winner and every other answer agrees with it (`properties`). A flip cannot name itself or a later publication as its parent, so chains cannot loop. The property that ancestry stays consistent under every combination of hide, withdrawn and rights flags is written in ticket 09, against the rule it tests.

**Cost of the tests.** The new tests add about 3 seconds in total (races 2.0 s, store races 0.6 s, properties 0.5 s). Property cases that use the database are capped at 10 to 12 because each case writes rows, and the race tests run a fixed small number of rounds. A flaky race test is a bug in the test or the code and is fixed, not retried until green; the race tests passed three runs in a row.

**Blob idempotency and request idempotency are separate mechanisms and tested separately.** Same bytes stored once: `blob::tests::identical_bytes_are_stored_once_and_return_the_same_hash` and the concurrent-writers test of the directory store. Same request handled once: the tests above.

**Limits of the claim.** That concurrent forks cannot lose each other is true by construction for immutable parents; what the tests add is evidence for the cap, retry and idempotency paths, including the failure paths. No scale claim is made: the numbers are from one machine, a pool of 16 connections and a local database.

## Playback model

Written by ticket 21. The code is in `web/lib/playback/`: a pure state machine (`machine.ts`), the step list (`steps.ts`), an engine that carries the machine's effects out with an injected clock and audio graph (`engine.ts`), the Web Audio adapter (`webaudio.ts`) and the page-lifecycle hooks (`lifecycle.ts`). It has no visual design in it; the roll, the record and the make flow sit on top of it.

**Two modes.** *Roll* plays the chain as an ordered list of steps: the **teaser** (the finished flip), then each stage from the source forward, then **rest** (the finished flip again, looping, no end). Each step lasts 2.4 s, shrinking to `20 s / stages` for long chains and never below 1.6 s, so a twelve-stage chain still plays through in about twenty seconds. Within a step the stage plays from its start and repeats, with a 0.05 s gap and a 6 ms attack ramp, until the step's dwell ends and it is released; a stage longer than the dwell is therefore heard as an excerpt of its first seconds, and a shorter one repeats (the 1.2 s seeded final plays about twice in the 2.4 s teaser). *Audition* plays one stage's whole output once from a chosen offset, with no repeats.

**One position.** The state is always one of: idle (silent), rolling (a step and the seconds elapsed in it), auditioning (a stage, an offset, and whether it has ended), or paused (the frozen rolling or auditioning state). The stage the machine says is current and the stage that sounds are the same by construction, and a test checks it after every action.

**The rules** (each is a cell of a table of every state against every event, written by hand from the spec and not from the code):

- The first tap from idle starts the teaser: audio and roll begin as one event.
- Scrubbing is always an audition, and the audio follows the stylus: scrub events move an audition to the stage and offset under it, and releasing simply lets it continue. The roll's own progress is automatic.
- A tap on a stage auditions it from the start. A second tap on the stage that is playing pauses it; a tap after it ended replays it. A tap on another stage moves the audition there.
- The main control after an audition continues roll mode from the start of the audited stage's step (not the teaser), then forward to rest; after the finished flip it goes to rest, because it has been heard in full.
- Pause freezes the position and resume continues in the same mode, exactly (tapping the stage that was paused resumes it, the mirror of the tap that paused it): the same step, the same point of the same repeat (including a pause in the silence between two repeats), and the rest of the dwell.
- A move the person asks for (next, previous, a tap, a scrub) starts the sound again even when it lands on the same state, because the state does not record the passing of time: previous at the first step restarts it. A position or stage that is not a finite number is ignored or treated as zero and never reaches the audio. Next and previous move by step in roll mode and by stage in an audition; a hidden tab pauses; a route change stops everything and returns to idle; reduced motion changes no playback state (it is a presentation setting: no auto-scroll or spin, with the per-stage buttons as auditions and a play-all control that runs roll mode); stale timer events and events that mean nothing in a state leave it alone, so nothing is undefined.

**Effects, and the invariant.** A transition returns the state and a list of effects: stop, start, arm the end-of-step timer, cancel it. A start is always preceded by a stop, so at most one voice is live; the engine holds at most one voice and at most two timers (the end of the step and the next repeat), and it ignores callbacks from voices that have been replaced. A released voice still fades out over 20 ms while the next fades in over 6 ms, so a stage change has a very short overlap; a cross-fade is a listening decision left to the visual-identity ticket. Events raised while another is being handled (a voice that ends at once) wait their turn, so listeners see states in order; and if the audio graph throws, the engine goes silent and idle and reports it, so the state never claims sound that does not exist.

**Evidence.** 137 tests, run by `pnpm test` in the `web` job. The machine: all 84 combinations of six state shapes and fourteen events; the effects of entering each state; a roll's order; and properties over generated event sequences (any sequence on any chain length is handled, positions stay in range, every start is preceded by a stop, pause then play returns to the same place in the same mode, a route change always ends silent). The engine, against a fake clock and a fake audio graph: the exact start times of a whole roll over the seeded chain's lengths (worked out by hand: the teaser starts at 0 and 1.25 s, the first stage at 2.4 s and 3.65 s, and so on), attack and release, excerpts versus repeats, audition, pause and resume, scrubbing, backgrounding, route change; and properties over generated sequences of actions and passing time (never two sources sounding, timers bounded, sound and roll agreeing on the stage, silence whenever the state is not sounding, silence and no timers after leaving). The adapter, against a fake `AudioContext`: samples convert to floats as `value / 32768` exactly for every 16-bit value, no context exists until the first gesture, a browser with no Web Audio gives an error and not a crash, a browser that refuses a 48 kHz context gets its own rate and the audio is resampled (and says so), and the fade ramps. The lifecycle hooks: a hidden tab, leaving the page, a device change and the system taking the audio each pause playback, and detaching removes every listener. Writing these found one real bug in the machine (an audition that ended by itself re-entered itself and restarted the sound); it is fixed and has its own test. Breaking the "second tap pauses" rule fails exactly one table cell (checked by hand).

**In a real browser.** A Playwright test (`web/e2e`, Chromium, in the container job that already has it) loads the real engine over real Web Audio with an analyser tapped on the output, taps to create and unlock the context, and checks that a stage is audible while it plays, ends by itself, and is silent afterwards; that pausing silences it with no voices or timers left; that no context exists before the gesture; and that roll mode keeps one voice. Locally the context ran at the browser's own rate; the page can ask whether it was resampled.

**Tuning.** Per-stage gains for matching loudness are a table in `config.ts` (empty: every stage plays at 1). A cross-fade at a stage change and a cap on the teaser for a very short finished flip are listed in the spec as tuning items and are not implemented; they wait for the listening pass in the visual-identity ticket and will be added with their effect, not as constants that do nothing.

**Not tested here, by design.** Real iOS Safari: whether the context resumes on the first tap, and the behaviour with the silent switch on (Web Audio is muted by it on iOS). Phone performance. Headphones unplugged on a real device (the code pauses on the `devicechange` event and when the context is suspended or interrupted; only a device can show that those events fire in practice). These are manual checks for the builder's listening and cold-phone test, recorded as such.

## Events and the outbox

Written by ticket 13. The consumer, rollups and the admin read path are the next section's business (ticket 14); the client ingest endpoint is ticket 15.

**The table is the source of truth; any queue is transport.** Every event is a row in one append-only `events` table with an origin (`server` or `client`) and a relay state (`unsent` or `sent`). A queue, if one is deployed, only carries copies of rows that already exist; a rebuild replays the table, never the queue. The sink the relay delivers to is a trait, so the deployed queue and the Postgres-only sink (the batch goes straight to the consumer in the same process, the default for tests and local runs) are interchangeable and the consumer is the same either way.

**Five events, nothing else.** `publication_created` (detail `source` or `flip`) and `report_filed` (detail: the category, never the note) are server events; `roll_opened`, `stage_played` and `flip_started` are client events (ticket 15). A row holds an event id, a kind, a time, the publication or stage it is about and a short qualifier. It holds no address, no user agent and no email, and the schema has no column that could: a test lists the columns. A server event never carries a session id, and the database refuses one that does.

**Server events are transactional.** The row is inserted in the same transaction as the write it describes, in the publish transaction (flips and sources, including the seed path, so a seeded source counts as a created publication, which it is) and in the report transaction. A publish refused by any rule, a replay and a key conflict write no event; a transaction that dies after its inserts leaves neither the publication nor the event (a test ends the backend between the inserts and the commit and finds neither). There is no write without its event and no event without its write. Client events are the exception by design: they are best-effort counts, and only server events can never diverge from their write.

**The relay claims; it does not keep a cursor.** A relay reads unsent rows with `FOR UPDATE SKIP LOCKED` inside a transaction, hands the batch to the sink, and marks the rows sent in the same transaction when the sink acknowledges. It never remembers "the last id delivered": commit order is not id order, so a transaction that took a lower id can commit after a higher one was delivered, and a cursor would skip that row for good (a test holds such a transaction open, delivers the higher row, commits the lower one and finds it delivered on the next pass). Two relays over one backlog skip each other's rows and deliver every row (a test runs two over 200 rows with a slow sink and finds each delivered once).

**Delivery is at least once.** The claim lasts as long as the transaction. If the sink refuses or the process dies between the claim and the acknowledgement, the rows are released still unsent and are delivered again (a test aborts a relay while its sink holds the batch and finds the same rows delivered by the next one). A sink must therefore treat a repeated event id as a repeat; the consumer in ticket 14 dedupes on it.

**Retention.** Raw events are kept 30 days. The retention job deletes only events that were sent and are older than the window, and skips any row a relay is working on, so it can run alongside the relay and can never discard an event that was not delivered (tests: an old unsent event survives; a purge racing a relay loses and duplicates nothing).

**What is not wired yet.** The relay is a library with tests; the service starts it when the consumer exists (ticket 14), so no row is marked sent to nowhere in the meantime.

## Security

_Not written yet. Tickets 17 onwards; consolidated by ticket 37._
