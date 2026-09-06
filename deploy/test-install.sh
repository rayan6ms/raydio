#!/usr/bin/env bash
# Destructive only inside a disposable container. Uses a fake service manager;
# notification delivery is covered separately by the Rust test/live service test.
set -euo pipefail
[[ ${RAYDIO_DEPLOY_TEST:-} == 1 ]] || { echo 'Run in the deployment test container.' >&2; exit 1; }
[[ -f /.dockerenv || -f /run/.containerenv ]] || exit 1
cd "$(dirname "$0")/.."
mkdir -p /run/lock /etc/systemd/system /opt/raydio /tmp/raydio-deploy-test/bin
cat > /tmp/raydio-deploy-test/bin/systemctl <<'SH'
#!/bin/sh
if [ "$1" = is-failed ]; then
    test -f /tmp/raydio-unit-failed
    exit $?
fi
if [ "$1" = reset-failed ]; then
    # A fresh Ubuntu manager may not have loaded an inactive new unit yet.
    test -f /tmp/raydio-unit-failed || exit 1
    rm /tmp/raydio-unit-failed
fi
if [ "$1" = restart ] && [ -f /tmp/raydio-fail-revision ]; then
    if [ "$(cat /opt/raydio/current/REVISION)" = "$(cat /tmp/raydio-fail-revision)" ]; then
        touch /tmp/raydio-unit-failed
        exit 1
    fi
fi
exit 0
SH
chmod 755 /tmp/raydio-deploy-test/bin/systemctl
export PATH="/tmp/raydio-deploy-test/bin:$PATH"
make_package() {
    local rev=$1
    local dir="/tmp/raydio-deploy-test/$rev"
    mkdir -p "$dir/bin" "$dir/deploy"
    printf '#!/bin/sh\necho "fixture binary"\n' > "$dir/bin/raydio"
    chmod 755 "$dir/bin/raydio"
    cp deploy/raydioctl "$dir/deploy/raydioctl"
    cp deploy/raydio-system.service "$dir/deploy/raydio.service"
    cp .env.example "$dir/deploy/env.example"
    printf '%s\n' "$rev" > "$dir/REVISION"
    (cd "$dir" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
    chmod 700 "$dir" # Packaging may inherit mktemp's private directory mode.
    tar -czf "/tmp/raydio-deploy-test/$rev.tar.gz" -C "$dir" .
}
one=1111111111111111111111111111111111111111
two=2222222222222222222222222222222222222222
three=3333333333333333333333333333333333333333
for rev in "$one" "$two" "$three"; do make_package "$rev"; done
bash deploy/raydioctl install "/tmp/raydio-deploy-test/$one.tar.gz"
runuser -u raydio -- /opt/raydio/current/bin/raydio --check
printf 'DISCORD_TOKEN=fixture-not-a-real-token\n' > /etc/raydio/env
cp /etc/raydio/env /tmp/raydio-deploy-test/env.expected
bash deploy/raydioctl start
bash deploy/raydioctl update "/tmp/raydio-deploy-test/$two.tar.gz"
[[ $(cat /opt/raydio/current/REVISION) == "$two" ]]
[[ $(cat /opt/raydio/previous/REVISION) == "$one" ]]
bash deploy/raydioctl rollback
[[ $(cat /opt/raydio/current/REVISION) == "$one" ]]
printf '%s\n' "$three" > /tmp/raydio-fail-revision
if bash deploy/raydioctl update "/tmp/raydio-deploy-test/$three.tar.gz"; then exit 1; fi
[[ $(cat /opt/raydio/current/REVISION) == "$one" ]]
printf 'tampered\n' >> "/tmp/raydio-deploy-test/$two/bin/raydio"
tar -czf /tmp/raydio-deploy-test/tampered.tar.gz -C "/tmp/raydio-deploy-test/$two" .
if bash deploy/raydioctl update /tmp/raydio-deploy-test/tampered.tar.gz; then exit 1; fi
[[ $(cat /opt/raydio/current/REVISION) == "$one" ]]
cmp /etc/raydio/env /tmp/raydio-deploy-test/env.expected
[[ $(stat -c '%a' /etc/raydio/env) == 600 ]]
echo 'Deployment lifecycle: install, update, rollback, failed readiness, checksum rejection, and config preservation passed.'
