"""Compare receiver buffer trials without treating a listener setting as a bot fix."""
import argparse
import json
from pathlib import Path


def compare(reports):
    reports = sorted(reports, key=lambda r: (r['receiverBufferTrial'].get('requestedAt', ''),
                                            r['receiverBufferTrial']['index']))
    rows, groups = [], {}
    for report in reports:
        trial = report['receiverBufferTrial']
        delta, coverage = report.get('delta', {}), report.get('coverage', {})
        seconds = report.get('elapsedSeconds', 0)
        clock = report.get('codec', {}).get('clockRate')
        required = ('packetsReceived', 'packetsLost', 'packetsDiscarded', 'concealedSamples',
                    'silentConcealedSamples', 'jitterBufferDelay', 'jitterBufferEmittedCount')
        known = all(isinstance(delta.get(k), (int, float)) for k in required)
        valid = (report.get('status') == 'completed' and known and clock is not None and clock > 0
                 and seconds >= report.get('requestedSeconds', 0) - .1
                 and all(coverage.get(k) is True for k in ('completePollCoverage', 'completePcmCoverage',
                         'completeEventHistory', 'uninterruptedConnection'))
                 and coverage.get('stableReceiverBuffer', True) is True
                 and delta['packetsReceived'] > 0
                 and 'actualSettingMs' in trial and trial['actualSettingMs'] == trial['targetMs'])
        ms = lambda k: delta[k] * 1000 / clock if clock and k in delta else None
        emitted = delta.get('jitterBufferEmittedCount', 0)
        mean_buffer = lambda k: delta[k] * 1000 / emitted if emitted and k in delta else None
        quiet = [e for e in report.get('events', []) if e.get('kind') == 'quiet' and e.get('durationMs', 0) >= 100]
        pcm = report.get('pcm', {})
        rows.append(dict(index=trial['index'], targetMs=trial['targetMs'], startedAt=report.get('startedAt'),
                         seconds=seconds, valid=valid, status=report.get('status'), coverage=coverage,
                         concealedMs=ms('concealedSamples'), silentConcealedMs=ms('silentConcealedSamples'),
                         meanBufferMs=mean_buffer('jitterBufferDelay'), meanTargetMs=mean_buffer('jitterBufferTargetDelay'),
                         received=delta.get('packetsReceived'), netLost=delta.get('packetsLost'),
                         discarded=delta.get('packetsDiscarded'), nackCount=delta.get('nackCount'),
                         positiveLoss=report.get('sampling', {}).get('positiveLossDeltas'),
                         negativeLoss=report.get('sampling', {}).get('negativeLossDeltas'),
                         insertedMs=ms('insertedSamplesForDeceleration'), removedMs=ms('removedSamplesForAcceleration'),
                         quietIntervals=quiet, pcmAnomalies={k: pcm.get(k) for k in ('nonFinite', 'nearFullScale', 'emptyFrames')},
                         receiverIdentity=report.get('receiverIdentity'), error=report.get('error')))
        row = rows[-1]
        name = 'default' if trial['targetMs'] is None else str(trial['targetMs'])
        group = groups.setdefault(name, dict(windows=0, validWindows=0, seconds=0, concealedMs=0,
                                            silentConcealedMs=0, netLost=0, discarded=0,
                                            bufferDelay=0, emittedCount=0))
        group['windows'] += 1
        if valid:
            group['validWindows'] += 1
            for field in ('seconds', 'concealedMs', 'silentConcealedMs', 'netLost', 'discarded'):
                group[field] += row[field]
            group['bufferDelay'] += delta['jitterBufferDelay']
            group['emittedCount'] += emitted
    for group in groups.values():
        group['concealmentMsPerMinute'] = group['concealedMs'] * 60 / group['seconds'] if group['seconds'] else None
        delay, emitted = group.pop('bufferDelay'), group.pop('emittedCount')
        group['meanBufferMs'] = delay * 1000 / emitted if emitted else None
    identities = {json.dumps(r['receiverIdentity'], sort_keys=True) for r in rows}
    same_receiver = bool(rows) and len(identities) == 1 and all(r['receiverIdentity'] for r in rows)
    return dict(windows=rows, groups=groups, sameReceiver=same_receiver,
                allValid=same_receiver and all(r['valid'] for r in rows),
                limitations=['The receiver target cannot be enforced by the bot for other Discord clients.',
                             'Mean buffer delay is not end-to-end audio latency.',
                             'Sequential trials remain subject to changing network conditions and buffer adaptation.',
                             'Quiet intervals are retained with track phase; track tails are not network concealment.',
                             'Net loss includes late corrections; zero does not establish zero lateness.'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    reports = [json.loads(p.read_text()) for p in args.directory.glob('receiver-final-*.json')]
    print(json.dumps(compare([r for r in reports if 'receiverBufferTrial' in r]), indent=2))
