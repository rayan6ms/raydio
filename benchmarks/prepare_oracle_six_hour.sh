#!/bin/bash
# Run only outside a receiver measurement window. Starts fresh Testbot idle;
# the browser starts playback and receiver timing only after readiness.
set -euo pipefail
expected=699272f8f7abfb4c4ac2e038c4b8d08fa277d6f05ba427d30ab889d48975abeb
binary=/opt/raydio/candidates/owned-channel/bin/raydio
actual=$(sha256sum "$binary" | cut -d' ' -f1)
test "$actual" = "$expected"
# Rerunning preparation must never restart a receiver window already in flight.
state=$(systemctl show raydio-owned-six-hour.service -p ActiveState --value)
case "$state" in
  active|activating|deactivating|reloading)
    printf 'Six-hour service is %s; refusing to disturb it.\n' "$state" >&2
    exit 1
    ;;
esac
python3 - <<'PY'
from pathlib import Path
p=Path('/run/systemd/system/raydio-owned-channel.service')
s=p.read_text()
assert 'RuntimeMaxSec=3600' in s
assert 'ExecStart=/opt/raydio/candidates/owned-channel/bin/raydio --testbot' in s
s=s.replace('RuntimeMaxSec=3600','RuntimeMaxSec=25200')
s=s.replace('Description=Raydio owned channel receiver validation Testbot','Description=Raydio owned channel six-hour qualification Testbot')
assert 'Restart=no' in s and 'LD_PRELOAD' not in s
Path('/run/systemd/system/raydio-owned-six-hour.service').write_text(s)
PY
for unit in raydio-owned-channel.service raydio-channel-retest-resources.service; do
  # Completed transient samplers can already have been unloaded by systemd.
  if test "$(systemctl show "$unit" -p LoadState --value)" != not-found; then
    systemctl stop "$unit"
  fi
done
systemctl daemon-reload
systemctl start raydio-owned-six-hour.service
pid=$(systemctl show raydio-owned-six-hour.service -p MainPID --value)
test "$pid" -gt 0
run_id=$(date -u +%Y%m%dT%H%M%SZ)
systemd-run --unit="raydio-six-hour-resources-$run_id" /usr/bin/python3 /opt/raydio/diagnostics/endurance-host.py --pid "$pid" --expected-exe "$binary" --seconds 24600 --output "/var/lib/raydio/six-hour-$run_id-resources.jsonl"
printf 'pid=%s run_id=%s sha256=%s\n' "$pid" "$run_id" "$actual"
