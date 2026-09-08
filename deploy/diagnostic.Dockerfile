# Diagnostic experiment only. Same release bot, one low-frequency host sampler.
FROM rust:1.97-bookworm AS sampler
COPY benchmarks/container_sampler.c /tmp/container_sampler.c
RUN cc -Os -Wall -Wextra -Werror /tmp/container_sampler.c -o /tmp/container-sampler && strip /tmp/container-sampler

FROM debian:bookworm-slim AS unpack
ADD --checksum=sha256:340d269f8a5dabe3e1a87c91a0b4bfbf78295a92f63d740fabf72818fceef9f1 https://github.com/rayan6ms/raydio/releases/download/v0.2.2-rc.1/raydio-linux-x86_64.tar.gz /tmp/raydio.tar.gz
RUN tar -xzf /tmp/raydio.tar.gz -C /tmp

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=unpack /tmp/bin/raydio /usr/local/bin/raydio
COPY --from=unpack /tmp/THIRD_PARTY_LICENSES.txt /usr/share/doc/raydio/THIRD_PARTY_LICENSES.txt
COPY --from=sampler /tmp/container-sampler /usr/local/bin/container-sampler
ENV MALLOC_ARENA_MAX=2 RAYDIO_WORKER_THREADS=2
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/container-sampler", "900", "--", "/usr/local/bin/raydio"]
CMD ["--testbot"]
