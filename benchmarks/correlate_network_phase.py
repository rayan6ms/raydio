"""Correlate bounded ICMP timing with receiver incidents; not UDP attribution.

Input ping -n -D output. UTC phase is measured at estimated send time, because
reply timestamps shift late packets away from the phase that delayed them.
"""
import argparse
import datetime as dt
import json
import re
import statistics
from pathlib import Path

REPLY = re.compile(r'\[([\d.]+)\].*icmp_seq=(\d+).*time([=<])([\d.]+) ms')


def parse(text):
    samples = []
    for line in text.splitlines():
        match = REPLY.search(line)
        if match:
            at, sequence, relation, latency = match.groups()
            latency = float(latency)
            samples.append(dict(replyAt=float(at), sentAt=float(at)-latency/1000,
                                sequence=int(sequence), rttMs=latency, upperBound=relation=='<'))
    return samples


def describe(rows):
    values = sorted(row['rttMs'] for row in rows)
    if not values:
        return dict(samples=0)
    return dict(samples=len(rows), minimumMs=values[0], medianMs=statistics.median(values),
                p95Ms=values[min(len(values)-1, int(len(values)*.95))], maximumMs=values[-1],
                missingSequenceNumbers=sum(max(0,b['sequence']-a['sequence']-1) for a,b in zip(rows,rows[1:])))


def correlate(receiver, paths):
    start = dt.datetime.fromisoformat(receiver['startedAt'].replace('Z','+00:00')).timestamp()
    end = start + receiver['elapsedSeconds']
    paths = {name: [row for row in rows if start <= row['sentAt'] <= end] for name,rows in paths.items()}
    summaries = {name:describe(rows) for name,rows in paths.items()}
    phases = {name:[dict(phaseFromSeconds=phase, **describe([row for row in rows if int(row['sentAt'] % 15)==phase]))
                   for phase in range(15)] for name,rows in paths.items()}
    incidents = []
    for event in receiver['events']:
        if event['kind'] != 'receiver' or not event.get('concealedMs',0):
            continue
        at = start + event['ms']/1000
        begin = at - event.get('windowMs',1000)/1000 - .25
        finish = at + .25
        incidents.append(dict(utc=dt.datetime.fromtimestamp(at,dt.timezone.utc).isoformat(),
                              concealedMs=event['concealedMs'], discarded=event.get('discarded'),
                              paths={name:describe([row for row in rows if begin<=row['sentAt']<=finish]) for name,rows in paths.items()}))
    return dict(receiverStart=receiver['startedAt'], receiverSeconds=receiver['elapsedSeconds'],
                paths=summaries, utcModulo15=phases, incidents=incidents,
                limitations=['ICMP endpoints have different paths and treatment from Discord UDP.',
                             'Simultaneous independent WAN spikes with stable LAN support an access/ISP-path hypothesis; they do not isolate one hop.',
                             'Estimated send time subtracts RTT from reply timestamp; host scheduling and ping implementation add uncertainty.',
                             'Probes run only in a separate diagnostic window; exclude this window from unprobed observer comparisons.'])


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--receiver',required=True,type=Path)
    p.add_argument('--probes',required=True,type=Path)
    a=p.parse_args()
    receiver=json.loads(a.receiver.read_text())
    paths={file.stem:parse(file.read_text()) for file in a.probes.glob('*.txt')}
    print(json.dumps(correlate(receiver,paths),indent=2))
