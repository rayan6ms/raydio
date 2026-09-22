#!/bin/bash
# Incremental append-only capture. Each entry is formatted once, not every five minutes.
# Install at /opt/raydio/diagnostics/start_oracle_capture.sh before preparation.
set -euo pipefail
out=${1:?output directory required}
started=${2:?start timestamp required}
run_id=${3:?run id required}
[[ "$run_id" =~ ^[a-z0-9-]{1,64}$ ]]
[[ "$out" = "/var/lib/raydio/$run_id" ]]
test -d "$out"
test ! -e "$out/service.log"
test ! -e "$out/kernel.log"
common=(--property=Nice=19 --property=IOWeight=1 --property=MemoryMax=64M
        --property=TasksMax=8 --property=RuntimeMaxSec=7h --property=Restart=no)
systemd-run --unit="$run_id-journal" "${common[@]}" \
    --property="StandardOutput=append:$out/service.log" \
    /usr/bin/journalctl -u raydio-isolated-six-hour.service -u raydio.service \
    --since "$started" --follow --no-tail --no-pager -o short-iso-precise
systemd-run --unit="$run_id-kernel" "${common[@]}" \
    --property="StandardOutput=append:$out/kernel.log" \
    /usr/bin/journalctl -k --since "$started" --follow --no-tail --no-pager -o short-iso-precise
# Capture service/collector outcomes once after the measured window, not repeatedly.
python3 - "$out" "$started" "$run_id" <<'PY'
from pathlib import Path
import shlex,sys
out,started,run_id=sys.argv[1:]
script=Path('/opt/raydio/diagnostics')/(run_id+'-finalize.sh')
q=shlex.quote
script.write_text('#!/bin/sh\nset -eu\n'+
 'systemctl show raydio-isolated-six-hour.service raydio.service '+q(run_id+'-journal.service')+' '+q(run_id+'-kernel.service')+
 ' -p Id -p ActiveState -p MainPID -p NRestarts -p Result -p CPUUsageNSec -p MemoryPeak > '+q(out+'/final-service.txt')+'\n'+
 'journalctl -u '+q(run_id+'-journal.service')+' -u '+q(run_id+'-kernel.service')+' --since '+q(started)+
 ' --no-pager -o short-iso-precise > '+q(out+'/collector-lifecycle.log')+'\n')
script.chmod(0o700)
PY
systemd-run --unit="$run_id-finalize" --on-active=7h "/opt/raydio/diagnostics/$run_id-finalize.sh"
