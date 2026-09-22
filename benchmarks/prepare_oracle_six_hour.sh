#!/bin/bash
# Run as root on Oracle before playback. The production service must be disabled.
# Usage: prepare_oracle_six_hour.sh BINARY SHA256 RUN_ID
set -euo pipefail
binary=${1:?binary required}
expected=${2:?sha256 required}
run_id=${3:?run id required}
[[ "$run_id" =~ ^[a-z0-9-]{1,64}$ ]]
[[ "$binary" = /opt/raydio/candidates/*/bin/raydio ]]
[[ "$expected" =~ ^[a-f0-9]{64}$ ]]
test "$(sha256sum "$binary" | cut -d' ' -f1)" = "$expected"
test "$(systemctl show raydio.service -p MainPID --value)" = 0
test "$(systemctl is-enabled raydio.service)" = disabled
if pgrep -x raydio >/dev/null; then
    echo 'A bot is already running; refusing to disturb playback.' >&2; exit 1
fi
out="/var/lib/raydio/$run_id"
test ! -e "$out"
unit=raydio-isolated-six-hour
case "$(systemctl show "$unit.service" -p ActiveState --value)" in
    active|activating|deactivating|reloading) exit 1;;
esac
install -d -m 700 "$out"
runuser -u raydio -- "$binary" --check
python3 - "$binary" <<'PY'
import sys
from pathlib import Path
s=Path('/run/systemd/system/raydio-event-wake-six-hour.service').read_text()
s=s.replace('Raydio latest candidate six-hour Testbot','Raydio isolated six-hour diagnostic Testbot')
s=s.replace('/opt/raydio/candidates/event-wake/bin/raydio',sys.argv[1])
assert 'Restart=no' in s and 'LD_PRELOAD' not in s
assert 'EnvironmentFile=/etc/raydio/testbot.env' in s
assert 'RAYDIO_WORKER_THREADS=2' in s
s=s.replace('Environment=RAYDIO_WORKER_THREADS=2', 'Environment=RAYDIO_WORKER_THREADS=2\nEnvironment=RAYDIO_SEND_TRACE=1')
Path('/run/systemd/system/raydio-isolated-six-hour.service').write_text(s)
PY
systemctl daemon-reload
for maintenance in apt-daily.service apt-daily-upgrade.service fwupd-refresh.service motd-news.service; do
    if systemctl is-active --quiet "$maintenance"; then
        echo "Maintenance is active: $maintenance; retry after it completes." >&2
        exit 1
    fi
done
started=$(date -u +%FT%TZ)
systemctl start "$unit.service"
pid=$(systemctl show "$unit.service" -p MainPID --value)
test "$pid" -gt 0
test "$(pgrep -x raydio | wc -l)" = 1
systemd-run --unit="$run_id-resources" --property=MemoryMax=64M --property=TasksMax=8 /usr/bin/python3 /opt/raydio/diagnostics/endurance-host-queued-20260921.py --pid "$pid" --expected-exe "$binary" --seconds 25200 --output "$out/resources.jsonl"
systemctl show "$unit.service" raydio.service -p Id -p MainPID -p ActiveState -p UnitFileState -p NRestarts -p CPUQuotaPerSecUSec -p RuntimeMaxUSec > "$out/preflight.txt"
sha256sum "$binary" > "$out/binary.sha256"
timedatectl show -p NTPSynchronized >> "$out/preflight.txt"
date -u +%FT%TZ > "$out/prepared-at.txt"
cat /proc/sys/kernel/random/boot_id > "$out/boot-id.txt"
# A timer stop alone is insufficient: apt-daily-upgrade may already be queued,
# and its unattended-upgrades/needrestart transaction can stop active services.
# Runtime masks prevent both the timers and their units from starting during the
# bounded observation. A separately scheduled restore runs even if the caller
# disconnects, then removes only these runtime masks.
maintenance_units=(apt-daily.service apt-daily-upgrade.service apt-daily.timer apt-daily-upgrade.timer fwupd-refresh.service fwupd-refresh.timer motd-news.service motd-news.timer)
maintenance_timers=(apt-daily.timer apt-daily-upgrade.timer fwupd-refresh.timer motd-news.timer)
restore_unmask=()
restore_timers=()
for maintenance in "${maintenance_units[@]}"; do
    state=$(systemctl is-enabled "$maintenance" 2>/dev/null || true)
    case "$state" in masked|masked-runtime) ;; *) restore_unmask+=("$maintenance");; esac
done
for maintenance in "${maintenance_timers[@]}"; do
    if systemctl is-active --quiet "$maintenance"; then restore_timers+=("$maintenance"); fi
done
# Schedule restoration before masking so a preparation interruption cannot strand masks.

cat > "/opt/raydio/diagnostics/$run_id-restore-maintenance.sh" <<EOF
#!/bin/sh
set -eu
if [ ${#restore_unmask[@]} -gt 0 ]; then systemctl unmask --runtime ${restore_unmask[*]}; fi
if [ ${#restore_timers[@]} -gt 0 ]; then systemctl start ${restore_timers[*]}; fi
EOF
chmod 700 "/opt/raydio/diagnostics/$run_id-restore-maintenance.sh"
systemd-run --unit="$run_id-restore" --on-active=7h "/opt/raydio/diagnostics/$run_id-restore-maintenance.sh"
systemctl stop "${maintenance_timers[@]}"
if (( ${#restore_unmask[@]} )); then systemctl mask --runtime "${restore_unmask[@]}"; fi
python3 - "$out" "$started" "$run_id" <<'PY'
from pathlib import Path
import sys,shlex
out,started,run_id=sys.argv[1:]
script=Path('/opt/raydio/diagnostics') / (run_id+'-save.sh')
script.write_text('#!/bin/sh\nset -eu\n'+
    'journalctl -u raydio-isolated-six-hour.service -u raydio.service --since '+shlex.quote(started)+' --no-pager -o short-iso-precise > '+shlex.quote(out+'/service.log')+'\n'+
    'journalctl -k --since '+shlex.quote(started)+' --no-pager -o short-iso-precise > '+shlex.quote(out+'/kernel.log')+'\n'+
    'systemctl show raydio-isolated-six-hour.service raydio.service -p Id -p ActiveState -p MainPID -p NRestarts -p MemoryCurrent -p CPUUsageNSec -p Result > '+shlex.quote(out+'/final-service.txt')+'\n')
script.chmod(0o700)
PY
systemd-run --unit="$run_id-save" --property=Nice=19 --property=MemoryMax=64M --property=TasksMax=8 --on-active=60s --on-unit-active=5m "/opt/raydio/diagnostics/$run_id-save.sh"
systemd-run --unit="$run_id-save-stop" --on-active=7h /usr/bin/systemctl stop "$run_id-save.timer"
printf 'candidate_pid=%s run_id=%s\n' "$pid" "$run_id"
