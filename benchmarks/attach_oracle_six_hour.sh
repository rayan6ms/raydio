#!/bin/bash
# Attach a fresh observation to an already-running Testbot. No bot restart.
# Usage: attach_oracle_six_hour.sh BINARY SHA256 RUN_ID
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
out="/var/lib/raydio/$run_id"
test ! -e "$out"
unit=raydio-isolated-six-hour
pid=$(systemctl show "$unit.service" -p MainPID --value)
test "$pid" -gt 0
test "$(pgrep -x raydio | wc -l)" = 1
test "$(readlink -f "/proc/$pid/exe")" = "$binary"
install -d -m 700 "$out"
for maintenance in apt-daily.service apt-daily-upgrade.service fwupd-refresh.service motd-news.service; do
    if systemctl is-active --quiet "$maintenance"; then
        echo "Maintenance is active: $maintenance; retry after it completes." >&2
        exit 1
    fi
done
test -f /opt/raydio/diagnostics/start_oracle_capture.sh
started=$(date -u +%FT%TZ)
pid=$(systemctl show "$unit.service" -p MainPID --value)
test "$pid" -gt 0
test "$(pgrep -x raydio | wc -l)" = 1
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
bash /opt/raydio/diagnostics/start_oracle_capture.sh "$out" "$started" "$run_id"
systemd-run --unit="$run_id-resources" --property=MemoryMax=64M --property=TasksMax=8 /usr/bin/python3 /opt/raydio/diagnostics/endurance_host.py --pid "$pid" --expected-exe "$binary" --seconds 25200 --output "$out/resources.jsonl" --collector-cgroup "/sys/fs/cgroup/system.slice/$run_id-journal.service" --collector-cgroup "/sys/fs/cgroup/system.slice/$run_id-kernel.service" --capture-dir "$out"
printf 'candidate_pid=%s run_id=%s\n' "$pid" "$run_id"
