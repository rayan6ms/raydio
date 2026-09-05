#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
arch=$(uname -m)
case "$arch" in x86_64|aarch64) ;; *) echo 'Unsupported architecture' >&2; exit 1;; esac
binary=${1:-target/release/raydio}
revision=${RAYDIO_REVISION:-$(git rev-parse HEAD)}
epoch=${SOURCE_DATE_EPOCH:-$(git show -s --format=%ct HEAD)}
out=target/package
mkdir -p "$out" dist
stage=$(mktemp -d "$out/stage.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/bin" "$stage/deploy"
install -m755 "$binary" "$stage/bin/raydio"
install -m755 deploy/raydioctl "$stage/deploy/raydioctl"
install -m644 deploy/raydio-system.service "$stage/deploy/raydio.service"
install -m644 .env.example "$stage/deploy/env.example"
install -m644 LICENSE "$stage/LICENSE"
printf '%s\n' "$revision" > "$stage/REVISION"
{
    printf 'source=%s\narchitecture=%s\n' "$revision" "$arch"
    rustc --version
    sha256sum Cargo.lock
} > "$stage/BUILD.txt"
python3 deploy/licenses.py "$stage/THIRD_PARTY_LICENSES.txt"
"$stage/bin/raydio" --version
"$stage/bin/raydio" --check
(cd "$stage" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner -C "$stage" -cf - . | gzip -n -9 > "dist/raydio-linux-$arch.tar.gz"
(cd dist && sha256sum "raydio-linux-$arch.tar.gz" > "raydio-linux-$arch.tar.gz.sha256")
