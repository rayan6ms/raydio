"""Read-only, minute-resolution resource samples for an owned endurance bot.

No packet tracing, polling of Discord, per-frame work, or process mutation.
Run before playback at nice 19; keep the same process for the whole test.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import time

parser = argparse.ArgumentParser()
parser.add_argument('--pid', type=int, required=True)
parser.add_argument('--expected-exe', type=Path, required=True)
parser.add_argument('--seconds', type=int, default=22200)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--peer-pid', type=int, help='Optional production process sharing the instance')
args = parser.parse_args()
if not 60 <= args.seconds <= 25200:
    parser.error('seconds must be 60..25200')
root = Path(f'/proc/{args.pid}')
expected = args.expected_exe.resolve(strict=True)
if (root / 'exe').resolve(strict=True) != expected:
    raise SystemExit('Unexpected executable')
identity = (root / 'stat').read_text().split(') ', 1)[1].split()[19]
cgroup = None
for line in (root / 'cgroup').read_text().splitlines():
    if line.startswith('0::'):
        cgroup = Path('/sys/fs/cgroup') / line[3:].lstrip('/')
peer_root = Path(f'/proc/{args.peer_pid}') if args.peer_pid else None
peer_identity = (peer_root / 'stat').read_text().split(') ', 1)[1].split()[19] if peer_root else None
peer_exe = (peer_root / 'exe').resolve(strict=True) if peer_root else None
os.nice(19)
started = time.monotonic()
with args.output.open('x') as output:
    while True:
        row = dict(utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   elapsedSeconds=round(time.monotonic() - started, 3), pid=args.pid,
                   cpuTicks=list(map(int, Path('/proc/stat').read_text().splitlines()[0].split()[1:])))
        try:
            stat = (root / 'stat').read_text().split(') ', 1)[1].split()
            if stat[19] != identity or (root / 'exe').resolve(strict=True) != expected:
                raise RuntimeError('Sampled process identity changed')
            row.update(cpuSeconds=(int(stat[11]) + int(stat[12])) / os.sysconf('SC_CLK_TCK'),
                       threads=int(stat[17]))
            for line in (root / 'smaps_rollup').read_text().splitlines():
                if line.startswith('Rss:'): row['rssKiB'] = int(line.split()[1])
                elif line.startswith('Pss:'): row['pssKiB'] = int(line.split()[1])
            if cgroup is not None:
                row['cgroupBytes'] = int((cgroup / 'memory.current').read_text())
                memory = dict(line.split() for line in (cgroup / 'memory.stat').read_text().splitlines())
                row['cgroupMemory'] = {key: int(memory[key]) for key in ('anon', 'file', 'file_dirty', 'file_writeback')}
                row['cgroupMemoryEvents'] = {key: int(value) for key, value in
                                           (line.split() for line in (cgroup / 'memory.events').read_text().splitlines())}
                row['cgroupCpu'] = {key: int(value) for key, value in
                                   (line.split() for line in (cgroup / 'cpu.stat').read_text().splitlines())}
        except (OSError, RuntimeError) as error:
            row['error'] = type(error).__name__
        # One extra procfs read group per minute distinguishes production load
        # from candidate/host load without adding another sampler process.
        if peer_root is not None:
            try:
                peer_stat = (peer_root / 'stat').read_text().split(') ', 1)[1].split()
                if peer_stat[19] != peer_identity or (peer_root / 'exe').resolve(strict=True) != peer_exe:
                    raise RuntimeError('Peer process identity changed')
                peer = dict(pid=args.peer_pid,
                            cpuSeconds=(int(peer_stat[11]) + int(peer_stat[12])) / os.sysconf('SC_CLK_TCK'),
                            threads=int(peer_stat[17]))
                for line in (peer_root / 'smaps_rollup').read_text().splitlines():
                    if line.startswith('Pss:'): peer['pssKiB'] = int(line.split()[1])
                    elif line.startswith('Rss:'): peer['rssKiB'] = int(line.split()[1])
                row['peer'] = peer
            except (OSError, RuntimeError) as error:
                row['peer'] = dict(pid=args.peer_pid, error=type(error).__name__)
        row['pressure'] = {name: (Path('/proc/pressure') / name).read_text().strip()
                           for name in ('cpu', 'memory', 'io') if (Path('/proc/pressure') / name).exists()}
        row['hostMemoryKiB'] = {line.split(':')[0]: int(line.split()[1])
                                for line in Path('/proc/meminfo').read_text().splitlines()
                                if line.startswith(('MemAvailable:', 'SwapFree:', 'SwapTotal:', 'Dirty:', 'Writeback:'))}
        row['load'] = Path('/proc/loadavg').read_text().split()[:3]
        row['networkDevices'] = {}
        for line in Path('/proc/net/dev').read_text().splitlines()[2:]:
            name, values = line.split(':', 1); values = list(map(int, values.split()))
            row['networkDevices'][name.strip()] = dict(rxBytes=values[0], rxPackets=values[1],
                rxErrors=values[2], rxDrops=values[3], txBytes=values[8], txPackets=values[9],
                txErrors=values[10], txDrops=values[11])
        snmp = Path('/proc/net/snmp').read_text().splitlines()
        row['udp'] = {}
        for index in range(0, len(snmp)-1, 2):
            if snmp[index].startswith('Udp:'):
                row['udp'] = dict(zip(snmp[index].split()[1:], map(int, snmp[index+1].split()[1:])))
        output.write(json.dumps(row, separators=(',', ':')) + '\n')
        output.flush()
        if 'error' in row or time.monotonic() - started >= args.seconds:
            break
        time.sleep(min(60, max(0, args.seconds - (time.monotonic() - started))))
