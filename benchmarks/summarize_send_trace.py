"""Analyze optional Oto header-only traces without calling local sends delivery.

Usage: uv run --no-project python benchmarks/summarize_send_trace.py SERVICE_LOG OUTPUT
Reads bounded batches; validates wraparound, missing records, and epoch boundaries.
"""
import ast
import json
from pathlib import Path
import re
import sys


def summarize(lines):
    streams = {}
    malformed = 0
    for raw in lines:
        line = re.sub(r'\x1b\[[0-9;]*m', '', raw)
        if 'RTP send trace:' not in line:
            continue
        try:
            epoch = int(re.search(r'\bepoch_us=(\d+)', line)[1])
            dropped = int(re.search(r'\bdropped=(\d+)', line)[1])
            data = re.search(r'\brecords=(\[.*\])', line)[1]
            records = ast.literal_eval(data.replace('true', 'True').replace('false', 'False'))
            if any(len(row) != 8 or any(type(v) is not int for v in row[:7])
                   or type(row[7]) is not bool for row in records):
                raise ValueError('invalid record')
            stream = streams.setdefault(epoch, {'records': {}, 'dropped': 0, 'conflicts': 0})
            stream['dropped'] = max(stream['dropped'], dropped)
            for row in records:
                if row[0] in stream['records'] and stream['records'][row[0]] != row:
                    stream['conflicts'] += 1
                stream['records'][row[0]] = row
        except (ValueError, TypeError, SyntaxError, IndexError):
            malformed += 1
    output = []
    for epoch, stream in sorted(streams.items()):
        rows = [stream['records'][i] for i in sorted(stream['records'])]
        gaps, sequence_jumps, timestamp_jumps, clock_reversals = [], 0, 0, 0
        missing = rows[0][0] - 1 if rows else 0
        maximum_gap = 0
        for a, b in zip(rows, rows[1:]):
            missing += b[0] - a[0] - 1
            if b[0] != a[0] + 1:
                continue  # missing diagnostics cannot be labeled missing audio
            clock_reversals += b[1] < a[1]
            if (a[2], a[4]) != (b[2], b[4]):
                continue  # a new transport/SSRC starts a distinct RTP timeline
            sequence_jumps += b[6] != (a[6] + 1) % 65536
            timestamp_jumps += b[5] != (a[5] + 960) % (2**32)
            gap = b[1] - a[1]
            maximum_gap = max(maximum_gap, gap)
            if gap >= 40000:
                gaps.append({'unixMicros': epoch + b[1], 'gapMicros': gap,
                             'beforeIndex': a[0], 'afterIndex': b[0],
                             'sourceChanged': a[3] != b[3],
                             'includesSilencePacket': a[7] or b[7]})
        output.append({'epochUnixMicros': epoch, 'records': len(rows),
                       'missingRecords': missing, 'ringDroppedRecords': stream['dropped'],
                       'conflictingRecords': stream['conflicts'],
                       'sequenceJumps': sequence_jumps, 'timestampJumps': timestamp_jumps,
                       'clockReversals': clock_reversals, 'maxGapMicros': maximum_gap,
                       'gapsAtLeast40Ms': gaps,
                       'firstUnixMicros': epoch + rows[0][1] if rows else None,
                       'lastUnixMicros': epoch + rows[-1][1] if rows else None})
    return {'streams': output, 'malformedBatches': malformed,
            'limitations': ['Successful UDP submission is not confirmation of delivery.',
                            'Gaps include pauses/control/source transitions; correlate lifecycle and receiver events.',
                            'Clock anchor has sampling and cross-host synchronization uncertainty.',
                            'A missing final batch cannot be detected from this trace alone.']}


if __name__ == '__main__':
    with Path(sys.argv[1]).open() as source:
        result = summarize(source)
    Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + '\n')
