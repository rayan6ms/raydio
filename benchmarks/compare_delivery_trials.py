"""Compare completed delivery trials without mistaking corrections for lost audio.

Usage: uv run --no-project python benchmarks/compare_delivery_trials.py FOLDER...
Each folder contains receiver.json and summarize_receiver.py's summary.json.
This reports observations, not a statistical or causal verdict.
"""
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sys


def metrics(summary, receiver):
    if summary['status'] != 'completed' or receiver['status'] != 'completed':
        raise ValueError('Incomplete receiver trial')
    for key in ('completePollCoverage', 'completePcmCoverage', 'uninterruptedConnection'):
        if summary['coverage'].get(key) is not True:
            raise ValueError(f'Unqualified receiver coverage: {key}')
    seconds = summary['receiverSeconds']
    if abs(seconds - receiver['requestedSeconds']) > 2:
        raise ValueError('Receiver duration differs from requested duration')
    coverage = summary['senderCoverage']
    sender_seconds = (datetime.fromisoformat(coverage['to'])
                      - datetime.fromisoformat(coverage['from'])).total_seconds()
    counters = summary['senderCheckpointDelta']
    if not counters or sender_seconds <= 0 or coverage['maximumCheckpointGapSeconds'] > 90:
        raise ValueError('Insufficient continuous sender evidence')
    return {
        'receiverSeconds': seconds,
        'senderSeconds': sender_seconds,
        'codec': receiver['codec'],
        'packetsReceived': summary['packetsReceived'],
        'netLost': summary['lostNet'],
        'positiveLossDeltas': summary['positiveLoss'],
        'negativeLossCorrections': summary['negativeLossDeltas'],
        'discarded': summary['discarded'],
        'nacks': summary['nacks'],
        'concealmentMs': summary['concealmentMs'],
        'concealmentMsPerMinute': summary['concealmentMs'] * 60 / seconds,
        'silentConcealmentMs': summary['silentConcealmentMs'],
        'senderGaps40ms': counters['active_send_gaps_40ms'],
        'senderGaps40msPerHour': counters['active_send_gaps_40ms'] * 3600 / sender_seconds,
        'senderGaps100ms': counters['active_send_gaps_100ms'],
        'unavailableFrames': counters['frames_unavailable'],
        'silenceFrames': counters['silence_frames_sent'],
        'sendFailures': counters['send_failures'],
        'quietRequiringReview100ms': len(summary['quietRequiringReviewAtLeast100Ms']),
        'pcmNearFullScale': summary['pcm']['nearFullScale'],
        'pcmNonFinite': summary['pcm']['nonFinite'],
        'medianPssMiB': summary['pssMiB']['median'],
        'cpuPercentOneCore': summary['botCpuPercentOfOneCore'],
        'hostStealPercent': summary['hostStealPercent'],
        'warnings': summary['evidenceWarnings'],
    }


def compare(folders):
    rows = []
    for folder in map(Path, folders):
        files = {name: (folder / name).read_bytes() for name in ('summary.json', 'receiver.json')}
        row = metrics(json.loads(files['summary.json']), json.loads(files['receiver.json']))
        row['label'] = folder.name
        row['inputSha256'] = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
        if rows and row['codec'] != rows[0]['codec']:
            raise ValueError('Codec differs across trials')
        rows.append(row)
    return {'runs': rows, 'limitations': [
        'Sequential short observations do not isolate code effects from host/network variation.',
        'Sender rates use interior checkpoint duration, not the longer receiver duration.',
        'Positive loss deltas include late packets; negative corrections remain separate.',
        'Concealment is replacement audio, not necessarily silence or an audible artifact.',
        'Compare tracing state, source, volume, route, host pressure, and warnings before drawing conclusions.',
        'Full ten-minute coverage does not qualify six hours.',
    ]}


if __name__ == '__main__':
    print(json.dumps(compare(sys.argv[1:]), indent=2))
