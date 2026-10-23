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
| `graft-events` | domain, storage | the event-sink trait, the Postgres-only sink and a recording sink, the relay that delivers claimed ledger rows to a sink, the idempotent consumer and the retention job. The ledger's SQL stays in `graft-storage` so that a server event commits in the same transaction as its write |
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

**Identifiers.** A publication id is 60 bits shown as 12 characters from `0-9a-z` without `i`, `l`, `o` and `u`: opaque, non-sequential and URL-safe. Visitor publications get random ids from the service. *Seeded* publications (the source and the three flips of the seeded chain) get ids derived from their deterministic retry key (`SHA-256("graft-seeded-publication-v1:" + key)`, first eight bytes, low 60 bits). This is a small documented exception to "ids are random": it makes ids, content hashes and the shipped static snapshot identical in every environment, because a child's hash includes its parent's id. A test seeds two independent databases and compares ids, record ids and the chain read.

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
| `GRAFT_UPLOADS` | `off` | whether visitors may publish their own sources (`on` or `off`); off until the launch gate passes |
| `GRAFT_SWITCH_CACHE_MS` | 2000 | how long a read of the kill switch is reused; the most a change made on another instance needs to be seen |
| `GRAFT_TRUSTED_PROXY_HOPS` | 0 | trusted proxies in front of the service; with 1 behind a load balancer the visitor is the last `X-Forwarded-For` entry |
| `GRAFT_PUBLISH_PER_IP`, `GRAFT_PUBLISH_WINDOW_SECS` | 20, 3600 | publishes one address may make within the window |
| `GRAFT_REPORT_PER_IP`, `GRAFT_REPORT_WINDOW_SECS` | 10, 3600 | reports one address may file within the window |
| `GRAFT_ADMIN_FAILURES_PER_IP`, `GRAFT_ADMIN_WINDOW_SECS` | 10, 900 | refused admin attempts one address may make before it waits |
| `GRAFT_GLOBAL_PUBLISH_PER_HOUR`, `GRAFT_GLOBAL_PUBLISH_BURST` | 120, 30 | the global publish cap: tokens refilled per hour, and the most admitted in one burst |
| `GRAFT_STORAGE_LIMIT_BYTES` | 8,000,000,000 | what the host allows for audio; the admission threshold is this minus the overshoot bound |
| `GRAFT_STORAGE_REFRESH_SECS` | 60 | how often the stored total is read again |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | base address of an OTLP/HTTP collector; unset means no spans are exported |
| `GRAFT_TRACE_SAMPLE` | 0.1 | the share of traces exported, 0 to 1 |
| `GRAFT_ERROR_TRACKER_DSN` | unset | a Sentry-compatible tracker address; a secret, never logged; unset means no reports are sent |
| `GRAFT_ENVIRONMENT` | `development` | the environment name error reports carry |
| `GRAFT_INGEST_PER_IP`, `GRAFT_INGEST_WINDOW_SECS` | 30, 60 | client event batches one address may send within the window |
| `GRAFT_INGEST_SESSION_EVENTS`, `GRAFT_INGEST_SESSION_WINDOW_SECS` | 300, 3600 | events one session id may send within the window |
| `GRAFT_INGEST_MAX_BATCH` | 20 | most events in one client batch |
| `GRAFT_EVENT_PIPELINE` | `on` | whether this process runs the relay, the consumer and the retention job (`on` or `off`) |
| `GRAFT_RELAY_BATCH`, `GRAFT_RELAY_INTERVAL_MS` | 100, 1000 | events per delivered batch, and the pause between relay passes |
| `GRAFT_EVENT_RETENTION_DAYS`, `GRAFT_RETENTION_INTERVAL_SECS` | 30, 3600 | how long raw events are kept, and how often the retention job runs |

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
- Tests run through the public HTTP API against a real Postgres 16 (a fresh database per test; a service container in CI), with an in-memory blob store. Queries are runtime queries, so building needs no database and no offline query data.

## Observability and operations

Written by ticket 16, deepening "Operational baseline".

**Traces.** The service's spans are `tracing` spans: `request` (with the request id and, when spans are exported, the trace id, so a log line leads to its trace and back), `publish` (flip or source), `render` (the input size and the duration in microseconds, never audio), `blob.put`, `db.create_flip` with its `db.transaction`, `event.insert`, and `relay.batch`. A serialization conflict and its retry are events on the `db.create_flip` span. Two places would lose the parent by default and are handled: the database work runs in its own task (so a dropped request cannot abandon a transaction), which is instrumented with the publish span by hand, and the render runs on a blocking thread, so its span is made in the async code and the future is instrumented, not the closure. When `OTEL_EXPORTER_OTLP_ENDPOINT` is set the spans are exported over OTLP/HTTP, sampled by `GRAFT_TRACE_SAMPLE` (a trace that arrives sampled stays sampled); with it unset no exporter exists and nothing is sent. A test runs one publish through the real export pipeline into an in-process exporter and asserts the tree (render, blob write and transaction under publish under request; the event insert under the transaction), the size and duration on the render span, one trace for the lot, and the trace id beside the request id in the log line. **Deviation to confirm:** the ticket asked for a local collector container; an in-process exporter exercises the same SDK and layers without a new CI service, but no real collector has been run against the OTLP exporter yet, so that last hop is untested until the service is first deployed.

**Error tracking.** When `GRAFT_ERROR_TRACKER_DSN` is set, a request that ends in a 500 and a panic are reported to a Sentry-compatible tracker. The client is built with no default integrations (the contexts integration reports the operating system and host), no request integration (so no headers, cookies or bodies), no breadcrumbs, no user, no host name, no session replay and no performance data, and every string that is left passes through a scrubber that removes the secrets the process holds, any long hexadecimal run (a manage key), addresses of both families, and credentials in URLs. The 500 report is one event naming the request id and the route; the cause is in the log line with the same request id, which is where it is read. A busy or refused request is not an error and is not reported. The panic path (a catch layer that answers 500 and logs only that a handler panicked, plus the SDK's panic integration) is configured but has no test of its own. Server errors are logged without personal data whether or not a tracker is configured. A test sends a request carrying a manage key, an operator secret, an address, a forwarding header and a user agent into a service whose database has gone, then sends a message that contains the secrets, an address and a connection string through the same client, and searches the tracker's payload as the SDK serialised it, and every log line, for any of them.

**Metrics** (Prometheus text at `/metrics`, labels from fixed sets only; a test checks no id, key or visitor text is ever a label): requests and latency by route; `graft_publish_outcomes_total{kind,outcome}` (created, replay, or the refusal's stable name); `graft_refusals_total{reason}` (the guardrails); `graft_render_duration_seconds` and `graft_render_failures_total`; `graft_preview_mismatch_total`; `graft_serialization_retries_total` and `graft_serialization_retries_exhausted_total`; `graft_publishing_open`; `graft_relay_backlog`, `graft_relay_oldest_unsent_age_seconds`, `graft_consumer_lag_seconds`, `graft_events_applied_total`, `graft_events_duplicates_total`. A scripted scenario shows the publish counters adding up to the requests made, the render count matching the renders done, and the gauge following the switch.

**Proposed alert rules and service-level wording.** These are proposals with the reasoning stated, written as example rules; no paging system is stood up and nothing here claims one is. Thresholds are starting values to tune against the load test.

| Alert | Example condition | Why this threshold |
|---|---|---|
| Server errors | `increase(graft_http_requests_total{status="500"}[5m]) > 5` | a handful in five minutes is noise; more is a fault |
| Readiness failing | `/ready` answers 503 for 2 minutes | the database is unreachable; a restart will not fix it, so look at the database |
| Retries exhausted | `increase(graft_serialization_retries_exhausted_total[10m]) > 0` | the retry budget is sized so that this should not happen at the expected load |
| Consumer lag | `graft_consumer_lag_seconds > 300` for 10 minutes | rollups are minutes behind; the relay or consumer is stuck |
| Relay backlog | `graft_relay_backlog > 1000` | events are piling up undelivered |
| Dead-letter depth | any message in the dead-letter queue | applies once the queue leg (ticket 18) exists; until then there is no queue |
| Render failures | `increase(graft_render_failures_total[10m]) > 0` | a render failing is a renderer or artefact fault, not a visitor's |
| Publishing closed | `graft_publishing_open == 0` for longer than planned | the kill switch is a deliberate act; this reminds the operator it is still on |

Wording for the service-level target, to be confirmed against measurements: "publishing and reading answer correctly for at least 99% of requests over a rolling 30 days, measured by requests that did not end in a 500 or a failed readiness check." It is a target for a one-person experiment, not a commitment to anyone.

**Known limits, not hidden.** After the first rebuild of the rollups their table's constraint and index names drift from the migration's, so no later migration may name them. `/metrics` runs the ledger's lag query on every scrape, which is fine for one scraper at this scale. A request that finds the stored total stale waits for the blob store's listing to refresh it. A flip that reuses a retry key for different content still costs a render before the conflict shows (a source upload is checked first and writes nothing). When the per-address table is full of live entries every new address pays a scan of it and is then admitted; the global cap still bounds publishing, and failed admin attempts fail closed.

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
| Visitor uploads | off | 503 `uploads-off` |
| Per-address publish limit | 20 per hour | 429 `rate-limited` |
| Per-address report limit | 10 per hour | 429 `rate-limited` |
| Per-address failed admin attempts | 10 per 15 minutes | 429 `rate-limited` |
| Per-address client event batches | 30 per minute | 429 `rate-limited` |
| Per-session client events | 300 per hour | 429 `rate-limited` |
| Global publish cap | 120 per hour, burst 30 | 429 `publish-cap` |
| Storage admission threshold | 8 GB minus the overshoot bound | 503 `storage-full` |

**The kill switch** is a row in the database (`runtime_settings`), read through a short cache, and set through the operator's `PUT /admin/switch` (`GET` reads it). It needs no redeploy. It closes every route that adds to what is published: flips, source uploads and client event batches. Reads, reports, a maker's own withdrawal and the operator's routes stay open, so a bad moment can always be reported, undone and reopened. A test lists every write route, checks the list against the public interface document, and asserts the switch closes exactly the routes marked as closed; a new write route fails it until someone decides which kind it is. An instance sees its own change at once and another instance's within `GRAFT_SWITCH_CACHE_MS`. If the database cannot be read the last known state stands; before any read, the configured default.

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

## The roll

Written by ticket 23. The home page is the seeded chain as a roll of credit blocks over the playback engine. The code is in `web/`: `app/page.tsx` (a server page that reads the snapshot at build time), `components/` (the player, the credit blocks, the theme toggle, the footer), `lib/roll/` (the view-model, the speed wording, the audio decoder), `lib/copy.ts` (every string a visitor reads) and `lib/theme/tokens.ts` (the colours, defined once).

**Opening needs no API.** The page and its four audio files are static: the audio is fetched as `/seed/<sha-256>.pcm` (cacheable for a year, immutable) and decoded by a 16-bit little-endian reader that does not depend on the machine's byte order. The audio context is created on the first tap, inside the gesture, and not before; until then the page says plainly what to tap. A browser test blocks every other origin and checks that the page asks the API for nothing.

**The view-model.** `buildBlocks` turns a stage into a block: a numeral, a title, the credit lines for its face, and a details layer with the exact values (frame range, speed as a fraction with its percentage and nearest interval, length, renderer, stage and record identifiers, the audio hash). The details are derived from the numbers, and a test checks they agree with the lines the server wrote. A value the server marks with any state other than declared or computed is shown as unknown, the weakest claim. Dyes cycle by stage index and are always printed next to the numeral and the title.

**Honesty is text.** Each line ends with its state in words (declared, computed, unknown), and a declared value also says "as typed". A browser test checks every line has its word, a copy test walks every string for the words the project does not use, and a contrast test works the WCAG ratio from the definition over the tokens, and a second one measures the rendered text in both themes.

**Reduced motion and the keyboard.** With reduced motion the page does not scroll by itself, the cursor does not blink, and the main control reads "play all"; every block has a visible "play this stage" button in every mode. The keyboard runs the whole loop (a test does it). Controls are 44 px or larger (a test measures them).

**What is not here yet.** The record (ticket 24), the chain route and every other state (27), the make flow behind "flip this" (28; the button says so), and the about page the footer links to (30). The type and slab styling is a first coat; ticket 25 owns the look. The first-visit hint for the needle arrives with the record.

## The record

Written by ticket 24. The record is the timeline: the band is the stage, the angle along a band is time within that stage, and the stylus is the cursor. It is an instrument first and a picture second: **the roll works without it**, and every action it offers has a plain equivalent in the labels and the controls (a test does the same thing both ways). The code is in `web/components/Record.tsx` and the pure parts in `web/lib/record/`.

**Geometry, and why the old rule was replaced.** One band per stage, the source outermost, then one empty band for "the roll ends on you" (dashed, with no sound). Band thickness is the room between the label and the rim shared out evenly, so it scales with the chain length. The first rule asked for bands at least 60 px wide; a twelve-stage chain has thirteen rings, which would need about 780 px of radius on a phone, so the rule could not hold. Now the stylus snaps to the nearest band and changes band only once the pointer is a quarter of a band past the edge (a scripted path that shakes on an edge changes band once, in a test), and the precise selector is the label list and the stage controls, at 44 px or larger. The four dyes cycle by stage index and are always printed with the numeral and the title (the centre label shows the numeral, and the slider's spoken value gives the title), so colour never identifies a stage by itself. One turn of a band is the stage's whole output; the empty band and the label are not targets.

**Touch, mouse, keyboard.** A tap sets the stylus down at that point and plays from there; a drag scrubs (the sound follows, as an audition) and releasing carries on from the release point. The mouse also hovers: the stage's name appears and a ghost ring marks its band; over the record the pointer is replaced by a stylus and returns to normal off it. The record is a focusable slider: left and right move a tenth of a second, up and down move between stages keeping the same share of the stage, home and end go to its ends, Enter or Space plays from the cursor, and the spoken value reads "stage 2 of 4, up a fifth, 0.1 of 0.6 seconds". "Drag the needle" shows once per visit and is not stored anywhere.

**Drawing.** The grooves wobble with the stage's real waveform (the loudest sample in each of 96 slices of its audio), the played part of the groove is lit, the groove under the stylus gives way to it, and a small trace of the waveform sits on the centre label. The grooves are drawn once as SVG paths and kept; each animation frame moves only the stylus and the tonearm, lights the played part, and redraws the one groove under the stylus. Nothing re-renders per frame: the stylus reads the engine's `stagePosition` (a new, tested accessor: seconds into the current stage, frozen when paused, at the end of the groove in the gap between two repeats). A frame governor watches the median of the last 30 frame gaps; if it stays above 26 ms (under about 38 frames a second) the record goes back to the cached bands and stops redrawing the pushed groove for the rest of the visit, and says so in `data-record="cached"`. A browser test forces 70 ms frames and checks the switch. It does not spin at all, so reduced motion changes nothing in the record's drawing; the page's other reduced-motion rules apply.

**Evidence and its limits.** Unit tests work the geometry by hand from the rule (bands, radii, snapping, angles, the wobble and the push), the key table, and the governor. Eight browser tests at a phone viewport cover tap, drag, keyboard, the twelve-stage chain (13 rings, every label 44 px or more, the shaking pointer), frame pacing during playback (the median and 95th percentile are recorded in the test report), the forced-slow-frames fallback, reduced motion, and the numeral. The twelve-stage chain is the real roll over twelve stages, bundled and served only by the test. Not measured here: 60 frames a second on a mid-range phone (a manual check on a real phone, for the builder's listening and cold-phone test; the CI browser only shows the median stays under 25 ms), and iOS, where audio unlocks on the release of a touch, so the record also asks for the unlock when a touch ends.

## The chain route

Written by ticket 27. A permanent link to any publication, `/p/<public id>`, opens that publication's chain in the roll and the record: the credits, the states and the audio come from the service, not from the static snapshot the home page uses. The code is in `web/app/p/[id]/`, `web/components/LiveRoll.tsx`, `web/lib/roll/live.ts` and `web/lib/roll/audio.ts`.

**What the server renders, and what it does not.** The page is rendered on every request (`force-dynamic`, so `cache-control: no-store`): a hide or a withdrawal must show at once, and a cached page could keep saying a hidden stage is playable. It reads the chain from the service and renders the credits, the states and the link preview. It never writes an audio address into the page: those are short-lived and issued per stage that can be heard, so a hidden or held stage has none to leak. The browser reads the chain again from the service for the addresses (the service allows the site's origin through `GRAFT_CORS_ORIGINS`) and fetches the audio from the bucket directly. A test fetches the page for a chain with a stage hidden for rights and checks the response holds no bucket address, no signature, no `.pcm`, and not the hidden stage's audio hash.

**Link preview.** The title is the final stage's title and the description is one plain line ("a sound and the 4 flips that came before it, rolled as credits."). The framework mirrors the pair into the other preview tags it knows (`twitter:card`, `twitter:title`, `twitter:description`); no tag names an image, and there is no generated poster, embed card or share template (a test lists the tags). A chain whose final stage cannot be read gets the site's name, not a made-up title.

**States, each in the voice.** Not found: a quiet page with a 404 status and a way home (the page is rendered before anything streams, so the status is real; adding a route-level loading file would turn it into a 200). No longer here (withdrawn): the title and credit lines stay, the block says "this sound is no longer here, but its credit is.", its label is not pressable and its audio is never asked for; stages built on it stay playable. Held (a stage it was built on is hidden for rights): the same, with the explanation, and it plays again when the hide is lifted (a test hides, reads, lifts it and reads again). A parent that could not be read: the chain says so and is not shortened. A chain that goes back past the depth cap says so. Every hidden or held block says what a takedown does and does not do: new requests are refused, issued links expire, copies already downloaded cannot be recalled. The status line (polite, read aloud) says how many stages cannot be played. "Flipped N times" is shown for stages that can be heard, from publications data.

**Audio that expires.** An issued address lasts five minutes. If a fetch of one answers 401, 403 or 410 the chain is read again for fresh addresses and that stage is tried once more; the visitor sees nothing (a test refuses the first fetch as an expired address would be and checks the page still becomes ready). Any other failure, or a second refusal, is an error with a "try again" button; going back online retries by itself. The roll passes through a stage with no audio in silence for the length of its step.

**Bucket access from a browser.** The browser fetches issued addresses directly, so the bucket must allow the site's origin to read (cross-origin read access for GET); the test server does not send those headers, so the tests add them to its responses and say so. A deployment needs the real setting (ticket 34's checklist).

**How it is tested.** `scripts/service-e2e.sh` starts a private database and a bucket prefix on the Postgres and S3-compatible server the other tests use, seeds the chain, starts the service, builds the site and runs Playwright with `GRAFT_SERVICE_E2E` set so the specs under `web/e2e/service` run. CI runs it as a step of the `rust` job (which already has both servers and the built service) when the site or the service changed; Chromium comes from a cache keyed on the Playwright version.

## The operator's page

Written by ticket 33. `/admin` is a small page for one person, usable on a phone, over the admin routes that already exist (reports, hide and lift, the kill switch, the rollups). It is not a product surface and has no accounts: the service decides, by the secret, whether to answer.

**The gate.** The page is a form until the secret is typed. The secret is held in the page's memory and sent in the `x-graft-admin-secret` header of each call, straight from the browser to the service (which now lists that header in its CORS allowance, for the site's origin only; a test checks that another origin gets none). It is never in an address, a body or storage, a test finds it in none of them, and locking the page forgets it. Every refusal (a wrong secret, a missing one, too many tries) reads the same: "that was not accepted. wait a little before trying again." The page is sent with `x-robots-tag: noindex, nofollow, noarchive` and a robots tag, and no page links to it (a test looks on the home page and a chain page).

**What it shows.** The reports, newest first, each with its publication's title and name as typed, the category, the note, when it was filed and the publication's state now (visible, hidden: withdrawn, hidden: rights), with "hide: withdrawn", "hide: rights" and "lift the hide", and a link to open its chain. The two switches: publishing (open or closed, with a button; it applies from the next request) and uploads (on or off, read only: it is set when the service starts, so `GET /admin/switch` now reports both). The event path: events by hour and kind, what is waiting to be delivered and how old the oldest is, what is waiting to be counted and how old.

**What it says and does not say.** The events are labelled as best-effort counts of sessions, one session being one page load; the page never says visitors or people, and a test looks. Reports show no personal data because the service holds none: a report has a category, a note and a time. Everything the service sends is printed as text: the service refuses `<` in any public text, notes included, so markup cannot arrive at all; as the second layer a test files a note made of HTML entities and finds them printed as typed, with no element made from them.

**Tested against the real service.** Wrong and right secrets; the secret's whereabouts; the indexing headers; a report listed with its state, hidden for rights from the page, the stage built on it shown held on its chain, then lifted and released; hide and lift from the page; the kill switch closed from the page making a real publish answer 503 and opened making it answer 201; the event view after a client event; and the page on a phone (every control 44 px, nothing scrolling sideways).

## Events and the outbox

Written by ticket 13. The consumer, rollups and the operator's read are the next section (ticket 14); the client ingest endpoint is ticket 15.

**The table is the source of truth; any queue is transport.** Every event is a row in one append-only `events` table with an origin (`server` or `client`) and a relay state (`unsent` or `sent`). A queue, if one is deployed, only carries copies of rows that already exist; a rebuild replays the table, never the queue. The sink the relay delivers to is a trait, so the deployed queue and the Postgres-only sink (the batch goes straight to the consumer in the same process, the default for tests and local runs) are interchangeable and the consumer is the same either way.

**Five events, nothing else.** `publication_created` (detail `source` or `flip`) and `report_filed` (detail: the category, never the note) are server events; `roll_opened`, `stage_played` and `flip_started` are client events (ticket 15). A row holds an event id, a kind, a time, the publication or stage it is about and a short qualifier. It holds no address, no user agent and no email, and the schema has no column that could: a test lists the columns. A server event never carries a session id, and the database refuses one that does.

**Server events are transactional.** The row is inserted in the same transaction as the write it describes, in the publish transaction (flips and sources, including the seed path, so a seeded source counts as a created publication, which it is) and in the report transaction. A publish refused by any rule, a replay and a key conflict write no event; a transaction that dies after its inserts leaves neither the publication nor the event (a test ends the backend between the inserts and the commit and finds neither). There is no write without its event and no event without its write. Client events are the exception by design: they are best-effort counts, and only server events can never diverge from their write.

**The relay claims; it does not keep a cursor.** A relay reads unsent rows with `FOR UPDATE SKIP LOCKED` inside a transaction, hands the batch to the sink, and marks the rows sent in the same transaction when the sink acknowledges. It never remembers "the last id delivered": commit order is not id order, so a transaction that took a lower id can commit after a higher one was delivered, and a cursor would skip that row for good (a test holds such a transaction open, delivers the higher row, commits the lower one and finds it delivered on the next pass). Two relays over one backlog skip each other's rows and deliver every row (a test runs two over 200 rows with a slow sink and finds each delivered once).

**Delivery is at least once.** The claim lasts as long as the transaction. If the sink refuses or the process dies between the claim and the acknowledgement, the rows are released still unsent and are delivered again (a test aborts a relay while its sink holds the batch and finds the same rows delivered by the next one). A sink must therefore treat a repeated event id as a repeat; the consumer in ticket 14 dedupes on it.

**Retention.** Raw events are kept 30 days. The retention job deletes only events that were sent and are older than the window, and skips any row a relay is working on, so it can run alongside the relay and can never discard an event that was not delivered (tests: an old unsent event survives; a purge racing a relay loses and duplicates nothing).

**Wiring.** The service starts the relay (to the in-process consumer), and the retention job, unless `GRAFT_EVENT_PIPELINE=off`; claims skip locked rows, so any number of instances may run them.

## Client events are best-effort

Written by ticket 15.

`POST /v1/events` accepts a batch of the three events the browser reports: `roll_opened`, `stage_played` and `flip_started`. It writes into the same ledger as the server events, with origin `client`, and that is where the similarity ends. **Only server events can never diverge from their write.** A client event is a count the browser chose to send: it can be lost (the tab closed, the network failed, a privacy signal was on), repeated, or invented by anyone, so it never feeds a public fact. The public "flipped N times" is read from the publications; a test floods the endpoint and finds that count unchanged, and another looks through every public response for anything event-derived and finds nothing.

**Guards, in the order they run.** The kill switch and the per-address batch limit run before the body is read. Then the body is capped at 16 KB and a batch at 20 events; an event needs a 16 to 64 character id (the dedupe key), a session id of 8 to 64 characters, one of the three client kinds (a server kind from a browser is refused) and no field beyond those, so nothing else can be stored. A batch whose browser signals Global Privacy Control or Do Not Track is ignored whole: the client sends nothing in that case (ticket 32), and honouring the signal on the server as well is defence in depth; the answer is the same receipt with nothing accepted. A session id may send 300 events an hour, counted in memory; it is a browser's choice, so this stops one page flooding and not someone who invents a new id each time, which is what the per-address limit and the rest are for. An event naming a publication that does not exist is dropped, not refused, so one stale id loses one event and not the batch, and the refusal does not tell a probe which ids exist. Timestamps are the browser's, clamped: more than five minutes ahead of the server becomes the server's now, older than a day becomes a day ago.

**The receipt is minimal.** `{"accepted": n}`: the events newly stored. Fewer than sent means some were repeats, dropped, or ignored for a privacy signal; it does not say which. Limits refuse politely with a `Retry-After`.

**Privacy.** The ledger has no column for an address or a user agent, and the handler stores only the event's own fields: a test sends a batch with a distinctive address, forwarding header and user agent and finds none of them in the row.

**A stated bound, not a claim of scale.** A test sends 40 full batches at once while a flip is published and checks the publish finishes well inside ten seconds. It is a sanity check that event ingest does not hold up publishing, and it says nothing about load.

### The browser's side (ticket 32)

The code is in `web/lib/telemetry/`. The privacy design is the headline, and each part is a test.

- **A session id that lives only in memory.** It is made on the first event of a page load, never written to storage or a cookie, and replaced after thirty minutes without an event, so it groups one visit and cannot link visits. A test with a controlled clock checks the same id within the window (which slides with activity) and a new one after thirty-one quiet minutes; a browser test checks that after a full session there are no cookies, nothing in local or session storage or IndexedDB, and neither the session id nor an event id anywhere in them.
- **Two signals switch it all off.** If the browser sends Global Privacy Control or Do Not Track (in any of the spellings browsers have used; a browser object that cannot be read counts as signalling), nothing is queued, no timer is set, no page-hide listener is attached, and nothing is sent. A browser test sets each signal and both, plays a stage and leaves the page, and finds no request to the events address and none to anywhere but the site, the bucket and the chain read. The error tracker is behind the same gate: its code is loaded only when no signal is on and a tracker address is configured, and it starts with no stored address, no session replay, no default integrations or breadcrumbs, and a scrubber. **The tracker's SDK is not installed yet**: there is no tracker project (ticket 16 waits for the builder's account), so the seam is built and tested with a stand-in, and the page never loads one. The test that the SDK "is never loaded" is therefore a unit test of the gate, not a check of a global in the browser.
- **What is sent.** `roll_opened` when a roll is ready, `stage_played` once per stage per visit however many times the roll goes round it, and `flip_started` when "flip this" is pressed. Each carries a 22-character random id (the dedupe key), the session id, the kind, the time and the publication id, and nothing else. Batches of ten, or five seconds after the first event; a request that fails is retried twice (a second, then three) with the same ids, so a repeat is stored once, and is then dropped. A 429 discards what is waiting and stays quiet for the time given; a 503 (the kill switch) stops sending for the rest of the page load; a 422 is dropped. At most a hundred events are held. Nothing throws into the page.
- **Leaving the page.** On `pagehide`, and when the page goes to the background, what is waiting is sent with `fetch` and `keepalive`, with no cookies and no referrer. A cross-origin request that needs a preflight cannot finish while a page unloads, so the body is JSON sent as `text/plain` (the one type that needs no preflight), and the service reads the events route's body as JSON whatever its content type says, under the same size cap and field rules (tests for both). This makes the route postable from any site; that costs nothing here, because it is anonymous, stores no address, is limited per address and session, and its counts never become a public fact. A browser test navigates away from a page with a stage just played and finds the event in the ledger. The flush is also tested in Chromium, Firefox and WebKit with a stub endpoint (the engines differ here); the Firefox run is in CI only, because Playwright's Firefox does not start on the builder's macOS version.
- **Not checkable yet.** The about page's privacy statements (ticket 30) will be cross-checked against this behaviour when that page exists; the opted-in manage key (ticket 29) is the only value that may ever be stored, and does not exist yet. The home page reports only if `GRAFT_PUBLIC_API_URL` was set when the site was built; without it opening the home page makes no request to the service at all.

## First open and the static snapshot

Written by ticket 22.

**The first open must not wait on the database.** The chain the roll opens on is shipped with the web app as static files, so the first open needs no API call and works while the database is asleep or the API is down. The roll plays and reads from the snapshot; everything that needs the service (flipping, publishing, reading another chain) says plainly that it cannot reach it, and the roll itself keeps working.

**The chain is data.** `seed/chain.json` names one source and three flips (cuts in frames, speeds as fractions, titles, retry keys) and `seed/jazz-rhodes.pcm` is the source, a synthesized Dm9 electric piano chord of 1.2 s in canonical audio, made for graft (no third-party material). Swapping the sound after the listening gate means replacing the file and updating the manifest; no code changes.

**Made by the real publish path.** `graft-seed-chain` seeds the source, then each flip, through the same pipeline every visitor's flip goes through: the server renders it with the canonical renderer, checks the caps and writes the record and its event in one transaction. The only differences are the identity (the public id is derived from the retry key, and there is no manage key, so nobody can manage a seeded stage; this deterministic id exists only on the seed path) and a cross-check: each flip's expected output hash in the manifest was worked out by the independent reference renderer (`scripts/vectors/reference.py`), not by the service, and the seed refuses to proceed if the service's render differs. Running it twice yields one chain (a test counts the rows). Two independent fresh databases seeded by it give identical publication ids, record ids and snapshot (a test compares them, one of them seeded at another time and after other work).

**What the snapshot holds.** `web/snapshot/chain.json` holds, per stage, the public id, kind, title and name as typed, the parent, the credit lines with their honesty states, the record id, the source and output hashes, the cut, the speed, the renderer identity and the frame count, and where the stage's audio is. It holds nothing that varies between environments (no creation times, no flip counts, no signed URLs) and nothing secret (a test lists the exact fields and searches for manage, secret, key and address words). The audio is in `web/public/seed/`, each file named by the SHA-256 of its bytes, served with `Cache-Control: public, max-age=31536000, immutable`: a name that is its content can never serve different bytes, so a year is safe. A web test checks that every file is named for its hash, that nothing else is in the directory, that the chain links up, and that the header rule is there. The chain's public "flipped N times" is deliberately not in the snapshot: it changes as visitors flip, so the roll asks the API for it when it can.

**The snapshot cannot drift.** A Rust test, in the `rust` job that already has Postgres, seeds a fresh database and builds the snapshot from what the service holds, then compares it with the committed files byte for byte, audio included. A change to a seeded flip's cut fails it with a line naming the stage and what changed (a test makes that change and finds `stage 4 ... cut`; the stages before it are not reported). `graft-seed-chain --check-snapshot web` asks the same question of any database from the command line, and `--write-snapshot web` regenerates the files to commit.

## Visitor sources and the launch gate

Written by ticket 12.

A visitor can publish their own sound as a root publication, through the same model, the same retry-key idempotency and the same one-time manage key as a flip. `POST /v1/sources` carries the sound as base64 of canonical audio (48 kHz, mono, signed 16-bit little-endian, no header), because the browser decodes it first, with a title, a name as typed, a retry key and a rights declaration.

**Off by default, and the door is not opened here.** The route answers 503 `uploads-off` ("uploads are switched off for now; you can still flip the sounds that are already here") until `GRAFT_UPLOADS=on`, and the kill switch closes it like every other write. The two are independent: with the flag off and the kill switch open, flips work and uploads refuse; with the kill switch closed both refuse (a test shows each). Both run before the body is read. Turning uploads on in any deployed environment is a decision at the launch gate, after the report and hide flow and the operator procedure have been rehearsed end to end and the kill switch has been checked to close every publishing path.

**Validated before a byte is stored.** In order, cheapest first: the title and name (links and handles are removed and the response says so; nothing left is refused), the retry key, the declaration, the encoding, and then the sound itself: whole 16-bit samples, at least 10 ms and at most 15 s, not silent (the loudest sample within 32 of zero), not a flat line (the whole recording within 64 of one level), not mostly clipping noise (more than half the samples on the rails). A refusal is a 422 naming the field and the rule, with a sentence a person can read, and writes nothing: no blob, no row, no event (a test covers each). A pure steady tone is not detected; that is a stated limit. The body limit is derived from the source cap (the base64 of the longest allowed source, plus a small envelope), so a forged oversized body is cut off at that limit and not read in full: a test streams 128 MB through a counter and finds the service pulled only the limit.

**Declared, never established.** The declaration is a fixed statement ("I made this sound or I have the right to share it. It does not contain anyone's private conversation.") and the request must carry it character for character, so what is stored is what was shown, with the time it was accepted and the basis the visitor named (own recording, or the right to share). It appears in the chain as a line marked declared, and `rights` stays unknown. Nothing in a response says anyone checked it. The server computes from what was submitted: it cannot verify that a client decoded honestly, nor that the sound is what the visitor says it is. The stored sound is the submitted bytes, and its hash is what the details layer shows.

**Residual risk.** Someone can still upload what they should not: a sound that is not theirs, or one that holds a private conversation despite the declaration. The limits (per address, the global cap, the storage threshold), the report and hide flow and the kill switch cap how much damage and for how long; they do not make it impossible. An uploaded source can be flipped like any other, and a hide for rights holds the flips built on it.

## Rollups and the analytical read path

Written by ticket 14.

**Two read paths, on purpose.** The lineage data (publications, content records) is the transactional store: what the public reads, and the only source of a public fact. A stage's "flipped N times" is counted from it and never from events; a test floods the ledger and then wipes every event-derived table and finds the public count unchanged. The rollups are derived, eventually consistent and rebuildable: they are an analytical read path that only the operator sees, through the secret-protected `GET /admin/rollups` and this document. This is the OLTP-versus-derived-state split in a deliberately small form. It is an engineering demonstration of the pattern, kept separate from the product contract: a small experimental product does not need a distributed design.

**The consumer is idempotent on the event id.** It inserts each delivered id into a dedupe set (`processed_events`) and counts only those that were new, in one transaction, so a duplicate, a replay, a shuffled delivery or any batching gives the same counts. Rollup rows are keyed by hour (UTC), event kind and publication or stage, and hold counts only: no session id, address or agent (a test lists the columns and looks through the rows). The dedupe ids are kept at least as long as the events, and the retention job removes them with the events, except for ids of events still unsent.

**The properties, stated as the tests state them.** Applying a generated stream once, twice, shuffled, in random batch sizes, and rebuilding from the ledger all give identical rollups, and those equal the counts worked out by hand from the generated specification.

**Rebuild is a swap.** The rebuild command (`graft-rebuild-rollups`) locks the rollup and dedupe tables, snapshots the ledger in one statement, writes a fresh rollup table from the snapshot, and renames it over the live one in the same transaction, making the dedupe set equal to the snapshot's event ids. Consumers wait on the lock for that moment. The ledger is not locked, so events keep being accepted; one that arrived after the snapshot is not in the dedupe set and is counted once by the consumer when its turn comes, and one that arrived before it is already counted by the rebuild and recognised as a repeat. The approach is recorded as: apply the tail after the swap, by the ordinary consumer, with no pause of acceptance. A test forces that interleaving and finds each event exactly once; another shows a rebuild that fails part way leaves the live rollups and the table list untouched.

**What cannot be rebuilt.** Raw events are kept for 30 days (`GRAFT_EVENT_RETENTION_DAYS`); hourly rollups are kept. When retention deletes events it records how far back the ledger has been trimmed, and a rebuild carries every hour at or before that point over as it is instead of recounting it from a ledger that no longer holds its events (the hour that straddles the point is carried over too). So a rebuild can fix recent counts but cannot recover rollups older than the window; a test shows an old hour surviving a rebuild after its events were deleted.

**What the operator reads.** `GET /admin/rollups?hours=N` (1 to 720, default 24) returns hourly counts by kind, the relay backlog (events not yet delivered and the age of the oldest) and the consumer lag (events not yet counted and the age of the oldest: the event-to-rollup lag), computed against the service clock so tests can fix the time. Reports say sessions' events, never people, and the response says that client events are best-effort. The metrics endpoint exposes `graft_relay_backlog`, `graft_relay_oldest_unsent_age_seconds`, `graft_consumer_lag_seconds`, `graft_events_applied_total` and `graft_events_duplicates_total`.

## Security

_Not written yet. Tickets 17 onwards; consolidated by ticket 37._
