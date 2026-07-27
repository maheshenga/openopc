FROM rust:1.97.1-bookworm@sha256:77fac8b98f9f46062bb680b6d25d5bcaabfc400143952ebc572e924bcbedc3fa AS build

WORKDIR /workspace

COPY apps/module-runner/Cargo.toml apps/module-runner/Cargo.lock apps/module-runner/rust-toolchain.toml apps/module-runner/
COPY apps/module-runner/src apps/module-runner/src
COPY packages/module-runtime-contracts/schema packages/module-runtime-contracts/schema

RUN cargo +1.97.1 build \
    --locked \
    --release \
    --manifest-path apps/module-runner/Cargo.toml

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e AS runtime

ENV HOME=/tmp/openopc-module-runner \
    TMPDIR=/tmp/openopc-module-runner \
    RUST_LOG=info

COPY --from=build --chown=65532:65532 /workspace/apps/module-runner/target/release/openopc-module-runner /usr/local/bin/openopc-module-runner

USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/openopc-module-runner"]
