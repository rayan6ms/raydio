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
args = parser.parse_args()
if not 60 <= args.seconds <= 25200:
    parser.error('seconds must be 60..25200')
root = Path(f'/proc/{args.pid}')
expected = args.expected_exe.resolve(strict=True)
if (root / 'exe').resolve(strict=True) != expected:
    raise SystemExit('Unexpected executable')
identity = (root / 'stat').read_text().split(') ', 1)[1].split()[19]
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
        except (OSError, RuntimeError) as error:
            row['error'] = type(error).__name__
        output.write(json.dumps(row, separators=(',', ':')) + '\n')
        output.flush()
        if 'error' in row or time.monotonic() - started >= args.seconds:
            break
        time.sleep(min(60, max(0, args.seconds - (time.monotonic() - started))))
