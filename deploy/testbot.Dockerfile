# Same native candidate as the Oracle/Discloud comparison; no on-host Rust build.
# This is explicitly a test image. It never defaults to the production token.
FROM debian:bookworm-slim AS unpack
ADD --checksum=sha256:340d269f8a5dabe3e1a87c91a0b4bfbf78295a92f63d740fabf72818fceef9f1 https://github.com/rayan6ms/raydio/releases/download/v0.2.2-rc.1/raydio-linux-x86_64.tar.gz /tmp/raydio.tar.gz
RUN tar -xzf /tmp/raydio.tar.gz -C /tmp

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=unpack /tmp/bin/raydio /usr/local/bin/raydio
COPY --from=unpack /tmp/THIRD_PARTY_LICENSES.txt /usr/share/doc/raydio/THIRD_PARTY_LICENSES.txt
ENV MALLOC_ARENA_MAX=2 RAYDIO_WORKER_THREADS=2
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/raydio"]
CMD ["--testbot"]
