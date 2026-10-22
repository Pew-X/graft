# The throwaway check image for ticket 03b: it builds the canonical renderer artefact and the check
# service, and runs the vector table inside whatever machine it is deployed to. The deploy pipeline
# (ticket 34) replaces it with the real service image.
#
# Base images are pinned by version tag. Pinning by digest needs registry access and is done when the
# real image is written (ticket 34).
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
