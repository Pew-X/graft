# The host-check image: it builds the canonical renderer artefact and the check service, and runs the
# vector table inside whatever machine it is deployed to. The service itself is Dockerfile.service.
#
# Base images are pinned by version tag; pinning by digest needs registry access and is done by the
# deploy script, which records the digest it built from.
FROM rust:1.97.1-bookworm AS build
WORKDIR /src
COPY . .
# rust-toolchain.toml names the exact toolchain and the wasm32 target; install them explicitly.
RUN rustup toolchain install \
 && sh scripts/build-wasm.sh \
 && cargo build --release --locked -p graft-host-check

FROM debian:bookworm-slim
RUN useradd --system --no-create-home graft
WORKDIR /app
COPY --from=build /src/target/release/graft-host-check /app/graft-host-check
COPY --from=build /src/target/wasm32-unknown-unknown/wasm/graft_render.wasm /app/graft_render.wasm
COPY --from=build /src/fixtures/vectors/vectors.json /app/vectors.json
ENV PORT=8080
EXPOSE 8080
USER graft
CMD ["/app/graft-host-check"]
