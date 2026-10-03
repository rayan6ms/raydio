"""Compare endpoint/full receiver observers without inventing PCM coverage.

Use archived terminal reports from browser_observer_trial.js. Each window is
retained, including failures; summaries are rates, not a significance test.
"""
import argparse
import json
from pathlib import Path


def compare(reports):
    reports = sorted(reports, key=lambda r: (r['observerTrial']['requestedAt'], r['observerTrial']['index']))
    rows = []
    groups = {}
    for report in reports:
        elapsed = report.get('elapsedSeconds', 0)
        delta = report.get('delta', {})
        mode = report['observer']
        clock = report.get('clockRate') or report.get('codec', {}).get('clockRate', 48000)
        continuous = report.get('uninterruptedConnection') if mode == 'endpoint' else report.get('coverage', {}).get('uninterruptedConnection')
        valid = (report.get('status') == 'completed' and continuous is True and elapsed >= report['requestedSeconds'] - 1
                 and delta.get('packetsReceived', 0) > 0 and clock > 0)
        if mode != 'endpoint':
            valid = valid and report.get('coverage', {}).get('completePollCoverage') is True
        if mode == 'pcm':
            valid = valid and report.get('coverage', {}).get('completePcmCoverage') is True
        concealed = delta.get('concealedSamples', 0) * 1000 / clock
        row = dict(mode=mode, index=report['observerTrial']['index'], startedAt=report.get('startedAt'),
                   status=report['status'], valid=valid, seconds=elapsed,
                   concealmentMs=concealed, concealmentMsPerMinute=concealed * 60 / elapsed if elapsed > 0 else None,
                   silentConcealmentMs=delta.get('silentConcealedSamples', 0) * 1000 / clock,
                   received=delta.get('packetsReceived'), netLost=delta.get('packetsLost'),
                   discarded=delta.get('packetsDiscarded'),
                   pcmCoverage=report.get('coverage', {}).get('completePcmCoverage') if mode == 'pcm' else None,
                   identity=report.get('receiverIdentity'), error=report.get('error'))
        rows.append(row)
        group = groups.setdefault(mode, dict(windows=0, validWindows=0, seconds=0, concealmentMs=0, netLost=0, discarded=0))
        group['windows'] += 1
        if valid:
            group['validWindows'] += 1
            for key in ['seconds', 'concealmentMs', 'netLost', 'discarded']:
                group[key] = group[key] + row[key] if group[key] is not None and row[key] is not None else None
    for group in groups.values():
        group['concealmentMsPerMinute'] = group['concealmentMs'] * 60 / group['seconds'] if group['seconds'] else None
    identities = {json.dumps(r['identity'], sort_keys=True) for r in rows}
    return dict(windows=rows, groups=groups, sameReceiver=len(identities) == 1 and None not in [r['identity'] for r in rows],
                allValid=bool(rows) and all(r['valid'] for r in rows),
                limitations=['Short sequential windows remain subject to time-varying network and host scheduling.',
                             'Endpoint mode has no PCM, quiet-interval or per-incident counter coverage.',
                             'Net lost packets retain late corrections; net zero does not prove no late packets.'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    reports = [json.loads(p.read_text()) for p in args.directory.glob('receiver-final-*.json')]
    reports = [r for r in reports if 'observerTrial' in r]
    print(json.dumps(compare(reports), indent=2))
