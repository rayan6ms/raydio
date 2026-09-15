"""Rebuild results from captured logs. Run with uv run --no-project this_file.py."""
import hashlib
import json
import math
from pathlib import Path

root = Path(__file__).resolve().parent
trials = []
for log in sorted(root.glob('*.log')):
    for line in log.read_text().splitlines():
        if 'QUEUE_TRIAL=' not in line:
            continue
        trial = json.loads(line.split('QUEUE_TRIAL=', 1)[1])
        trial['source_log'] = log.name
        assert trial['received'] == trial['frames'] + 5
        for field in ('send_intervals_us', 'arrival_intervals_us'):
            if field in trial:
                assert len(trial[field]) == trial['frames'] - 1
        if 'send_intervals_us' in trial:
            ordered = sorted(trial['send_intervals_us'])
            trial['send_p99_us'] = ordered[math.ceil(0.99 * (len(ordered)-1))]
            trial['send_p999_us'] = ordered[math.ceil(0.999 * (len(ordered)-1))]
            assert max(ordered) == trial['send_interval_max_us']
            assert sum(value >= 40_000 for value in ordered) == trial['send_gaps_ge_40ms']
        if (trial.get('runtime_stall_ms', 0) > 0
                and trial.get('stalled_workers', 0) == trial.get('runtime_workers', -1)):
            assert trial['source_progress_during_fault'] == 0
            assert trial['preparation_progress_during_fault'] == 0
        trials.append(trial)

metadata = {
    'schema_version': 2,
    'timing_binary_sha256': '2cb205b68b87eded407c08517eb762de02ef0472d690830e7a5f7c1d93ffb40a',
    'baseline_oto_revision': 'e205f9a3f44be36fab2fa3cd48ef113cbb0f4d1f',
    'compiler': 'rustc 1.97.1',
    'production_changed': False,
    'runtime_workers_final_trials': 2,
    'scope': 'Synthetic loopback, no Discord receiver or production integration',
    'provenance': 'Parsed from raw logs. Early callback/untraced trials are labeled; only oracle- and traced- logs contain the final send-trace schema.',
    'raw_log_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                       for p in sorted(root.glob('*.log'))},
    'trials': trials,
}
(root / 'results.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(f'Validated and parsed {len(trials)} trials')
