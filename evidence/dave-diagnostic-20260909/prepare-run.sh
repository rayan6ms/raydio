#!/bin/bash
set -euo pipefail
binary=/opt/raydio/candidates/dave-diagnostic/bin/raydio
out=/var/lib/raydio/dave-diagnostic-20260909
test -x "$binary"
test ! -e "$out"
# The old Testbot failed and is idle; production remains untouched.
systemctl stop raydio-event-wake-six-hour.service
install -d -m 700 "$out"
python3 - <<'INNER'
from pathlib import Path
s=Path('/run/systemd/system/raydio-event-wake-six-hour.service').read_text()
s=s.replace('Raydio latest candidate six-hour Testbot','Raydio DAVE diagnostic Testbot')
s=s.replace('/opt/raydio/candidates/event-wake/bin/raydio','/opt/raydio/candidates/dave-diagnostic/bin/raydio')
assert 'Restart=no' in s and 'LD_PRELOAD' not in s
Path('/run/systemd/system/raydio-dave-diagnostic.service').write_text(s)
INNER
systemctl daemon-reload
systemctl start raydio-dave-diagnostic.service
pid=$(systemctl show raydio-dave-diagnostic.service -p MainPID --value)
peer=$(systemctl show raydio.service -p MainPID --value)
test "$pid" -gt 0
test "$peer" = 876
systemd-run --unit=raydio-dave-diagnostic-resources --property=MemoryMax=64M --property=TasksMax=8 /usr/bin/python3 /opt/raydio/diagnostics/endurance-host-dave.py --pid "$pid" --peer-pid "$peer" --expected-exe "$binary" --seconds 25200 --output "$out/resources.jsonl"
systemctl show raydio-dave-diagnostic.service raydio.service -p Id -p MainPID -p ActiveState -p NRestarts -p CPUQuotaPerSecUSec -p RuntimeMaxUSec > "$out/preflight.txt"
sha256sum "$binary" > "$out/binary.sha256"
timedatectl show -p NTPSynchronized >> "$out/preflight.txt"
systemd-run --unit=raydio-dave-diagnostic-restore --on-active=7h /usr/bin/systemctl start apt-daily.timer apt-daily-upgrade.timer fwupd-refresh.timer
systemctl stop apt-daily.timer apt-daily-upgrade.timer fwupd-refresh.timer
cat > /opt/raydio/diagnostics/save-dave-diagnostic.sh <<'SAVE'
#!/bin/sh
set -eu
out=/var/lib/raydio/dave-diagnostic-20260909
journalctl -u raydio-dave-diagnostic.service -u raydio.service --since 2026-09-09T07:45:00Z --no-pager -o short-iso-precise > "$out/service.log"
journalctl -k --since 2026-09-09T07:45:00Z --no-pager -o short-iso-precise > "$out/kernel.log"
systemctl show raydio-dave-diagnostic.service raydio.service -p Id -p ActiveState -p MainPID -p NRestarts -p MemoryCurrent -p CPUUsageNSec -p Result > "$out/final-service.txt"
SAVE
chmod 700 /opt/raydio/diagnostics/save-dave-diagnostic.sh
systemd-run --unit=raydio-dave-diagnostic-save --on-active=6h30m /opt/raydio/diagnostics/save-dave-diagnostic.sh
printf 'candidate_pid=%s production_pid=%s\n' "$pid" "$peer"
