"""Conservative quiet-interval attribution; proximity alone never proves a cause."""
import datetime as dt
import re


def classify_quiet(report, log, source_tail_ms, source_head_ms=0):
    start = dt.datetime.fromisoformat(report['startedAt'].replace('Z', '+00:00'))
    starts, finishes, transitions = [], [], []
    for line in log.splitlines():
        try:
            utc = dt.datetime.fromisoformat(line.split()[0].replace('Z', '+00:00'))
        except (ValueError, IndexError):
            continue
        match = re.search(r'track (started|finished) generation=(\d+)', line)
        if match:
            at = (utc-start).total_seconds()*1000
            (starts if match[1] == 'started' else finishes).append((at, int(match[2])))
            transitions.append((at, match[1], int(match[2])))
    natural = []
    # Pair consecutive finish/start events exactly once. A stale finish cannot
    # bless later manual restarts. Long handoffs remain evidence, never excluded.
    for previous, current in zip(transitions, transitions[1:]):
        ended, kind, generation = previous
        at, next_kind, next_generation = current
        if kind == 'finished' and next_kind == 'started' and next_generation == generation + 1 and at >= ended:
            natural.append({'endMs': ended, 'startMs': at,
                            'previousGeneration': generation, 'generation': next_generation,
                            'eventHandoffMs': at-ended})
    output = []
    for event in report['events']:
        if event['kind'] not in ('quiet', 'quiet-at-end'):
            continue
        end = event.get('audioEndMs', event['ms'])
        duration = event['durationMs']
        begin = end-duration
        nearest = min(natural, key=lambda x: abs(end-x['startMs']), default=None)
        aligned = nearest is not None and abs(end-nearest['startMs']) <= 2000
        uncertainty = []
        for other in report['events']:
            at = other['ms']
            span = other.get('windowMs', other.get('durationMs', 0))
            if at < begin-250 or at-span > end+250:
                continue
            kind = other['kind']
            if ((kind in ('ice', 'connection') and other.get('state') in ('disconnected', 'failed', 'closed'))
                or kind in ('network-offline', 'pcm-report-gap', 'audio-context', 'pcm-anomaly', 'receiver-long-task')
                or (kind == 'receiver' and (other.get('silentConcealedMs', 0) > 0
                    or other.get('concealedMs', 0) > 0 or other.get('packets') == 0
                    or other.get('windowMs', 0) > 2000 or other.get('lost', 0) > 0))):
                uncertainty.append(kind)
        reference = source_tail_ms + source_head_ms
        label = 'off-boundary-quiet'
        if aligned:
            label = ('extended-boundary-quiet' if duration > reference+100 or nearest['eventHandoffMs'] > 100
                     else 'boundary-quiet-with-overlapping-anomaly' if uncertainty
                     else 'source-tail-candidate')
        output.append({'utc': (start+dt.timedelta(milliseconds=end)).isoformat(),
            'startMs': begin, 'endMs': end, 'durationMs': duration,
            'timestampBasis': 'pcm-frame-clock' if 'audioEndMs' in event else 'report-receipt',
            'nearestStartOffsetSeconds': (end-nearest['startMs'])/1000 if nearest else None,
            'classification': label, 'naturalHandoff': nearest if aligned else None,
            'sourceBoundaryReferenceMs': reference,
            'excessOverReferenceAndToleranceMs': max(0, duration-reference-100) if aligned else None,
            'overlappingAnomalies': sorted(set(uncertainty)),
            'causeProven': False})
    return output
