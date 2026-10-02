"""Correlate Oto's optional timing batches with receiver and procfs evidence.

This uses Oto's existing trace, without an interposer, packet capture, extra
sender timer, or payload recording. Correlation is evidence, not a causal fix.
"""
import argparse
import bisect
import datetime as dt
import json
from pathlib import Path
from summarize_send_trace import parse_traces, summarize


def unix_seconds(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def correlate(log, receiver, resources):
    streams, malformed = parse_traces(log.splitlines())
    trace = summarize(log.splitlines())
    unreliable = malformed or any(s['conflictingRecords'] or s['clockReversals']
                                 for s in trace['streams'])
    start = unix_seconds(receiver['startedAt'])
    end = start + receiver['elapsedSeconds']
    records = []
    for epoch, stream in streams.items():
        for row in stream['records'].values():
            records.append((epoch + row[1], epoch, row))
    if len(records) > 60000:
        raise ValueError('trace exceeds 60,000-record short-run bound')
    records.sort()
    times = [at / 1e6 for at, _, _ in records]
    hosts = sorted((unix_seconds(row['utc']), row) for row in resources)

    def window(begin, finish):
        left = bisect.bisect_left(times, begin)
        right = bisect.bisect_right(times, finish)
        rows = records[max(0, left-1):right]
        gaps = []
        missing = 0
        for (at, epoch, a), (next_at, next_epoch, b) in zip(rows, rows[1:]):
            if epoch == next_epoch:
                missing += max(0, b[0]-a[0]-1)
            if epoch != next_epoch or b[0] != a[0]+1 or (a[2],a[4]) != (b[2],b[4]):
                continue
            if next_at-at >= 40000:
                gaps.append({'utc': dt.datetime.fromtimestamp(next_at/1e6, dt.timezone.utc).isoformat(),
                    'gapMs':(next_at-at)/1000, 'sourceChanged':a[3]!=b[3],
                    'includesSilence':a[7] or b[7],
                    'timingMicros':b[8] if len(b)==9 else None})
        host_deltas = []
        for (at,a),(next_at,b) in zip(hosts,hosts[1:]):
            if at > finish or next_at < begin or next_at <= at:
                continue
            cpu = [y-x for x,y in zip(a.get('cpuTicks',[]),b.get('cpuTicks',[]))]
            before, after = a.get('cgroupCpu',{}),b.get('cgroupCpu',{})
            host_deltas.append({'fromUtc':a['utc'],'toUtc':b['utc'],
                'stealPercent':100*cpu[7]/max(1,sum(cpu[:8])) if len(cpu)>=8 else None,
                'throttledMicros':after['throttled_usec']-before['throttled_usec']
                    if 'throttled_usec' in before and 'throttled_usec' in after else None,
                'botCpuMicros':after['usage_usec']-before['usage_usec']
                    if 'usage_usec' in before and 'usage_usec' in after else None,
                'hostError': 'error' in a or 'error' in b})
        return {'packets':right-left,'gapsAtLeast40Ms':gaps,'hostDeltas':host_deltas,
            'missingTraceRecords':missing,
            'senderCoverage':bool(times and times[0]<=begin and times[-1]>=finish)}

    incidents = []
    for event in receiver['events']:
        if event['kind'] != 'receiver' or not (event.get('lost',0)>0 or event.get('discarded',0)>0
                or event.get('concealedMs',0)>0):
            continue
        at = start + event['ms']/1000
        begin = at - event.get('windowMs',1000)/1000 - 0.5
        finish = at + 0.5
        details = window(begin, finish)
        incidents.append({'receiver':event,'senderAndHost':details,
            'interpretation':'trace coverage is incomplete; send-side gaps cannot be excluded'
                if not details['senderCoverage'] or details['missingTraceRecords'] or unreliable else
                'sender gap overlaps the incident window; inspect stage timing and host scheduling'
                if details['gapsAtLeast40Ms'] else
                'no traced sender gap >=40 ms in this window; downstream/client cause remains unresolved'})
    return {'receiverStatus':receiver['status'],'receiverSeconds':receiver['elapsedSeconds'],
        'trace':trace,'aligned':window(start,end),'incidents':incidents,
        'limitations':['Successful UDP submission is not confirmation of delivery.',
            'One receiver cannot distinguish Discord forwarding from the listener network/client.',
            'Incident windows include 500 ms tolerance; overlap does not prove a cause.',
            'Host counters have their actual sample resolution; missing coverage is retained.',
            'UTC anchors require synchronized clocks; neither sampling nor PCM resets proves inter-host clock accuracy.'],
        'malformedTraceBatches':malformed}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    root=args.input
    if (root/'service.log').stat().st_size > 16*1024*1024:
        raise SystemExit('service log exceeds short-run bound')
    report=correlate((root/'service.log').read_text(), json.loads((root/'receiver.json').read_text()),
        [json.loads(line) for line in (root/'resources.jsonl').read_text().splitlines()])
    args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'incidents':len(report['incidents']),'senderCoverage':report['aligned']['senderCoverage'],
        'packets':report['aligned']['packets'],'malformedTraceBatches':report['malformedTraceBatches']}))
