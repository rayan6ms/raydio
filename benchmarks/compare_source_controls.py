"""Compare two plays of one staged input; control changes apply to play two.

Input is the bounded source_packets --staged --repeat --redundant-filters output.
No audio content, track credentials or media URLs are emitted by this analysis.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct


def compare(path, report):
    runs = report['runs']
    if len(runs) != 2 or not report['staged']:
        raise ValueError('requires two plays of one staged input')
    digests = []
    packets = []
    with path.open('rb') as source:
        for run in runs:
            frames = []
            for _ in range(run['frames']):
                header = source.read(2)
                if len(header) != 2:
                    raise ValueError('missing packet length')
                size, = struct.unpack('<H', header)
                if not 1 <= size <= 1275:
                    raise ValueError('invalid packet length')
                payload = source.read(size)
                if len(payload) != size:
                    raise ValueError('truncated packet')
                frames.append(hashlib.sha256(payload).digest())
            packets.append(frames)
            digests.append(hashlib.sha256(b''.join(frames)).hexdigest())
        if source.read(1):
            raise ValueError('trailing packets')
    changed = sum(a != b for a, b in zip(*packets))
    return {'scope': 'same staged compressed input, first play without controls, second with identical volume every 100 frames; no Discord',
            'frames': [len(p) for p in packets], 'packetDigest': digests,
            'differentPackets': changed, 'unmatchedFrames': abs(len(packets[0]) - len(packets[1])),
            'bitIdentical': packets[0] == packets[1],
            'controlUpdates': runs[1]['filterUpdates'], 'controlUpdateMs': runs[1]['filterUpdateMs']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('packets', type=Path)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    print(json.dumps(compare(args.packets, json.loads(args.report.read_text())), indent=2))


if __name__ == '__main__':
    main()
