"""Compare bounded sender/receiver RTP headers, without interpreting media.

Packet matching uses SSRC, sequence and RTP timestamp. Absolute transit values
include clock offset; only excess over the observed minimum is reported.
"""
import argparse
import datetime as dt
import json
import re
import statistics
from pathlib import Path


def key(row):
    return row['ssrc'],row['sequence'],row['timestamp']


def gaps(rows, begin, end):
    values=[dict(endUnixMicros=b['unixMicros'], gapMs=(b['unixMicros']-a['unixMicros'])/1000)
            for a,b in zip(rows,rows[1:]) if begin<=b['unixMicros']<=end]
    return dict(packets=sum(begin<=r['unixMicros']<=end for r in rows),
                covered=bool(rows and rows[0]['unixMicros']<=begin and rows[-1]['unixMicros']>=end),
                maximumGapMs=max((v['gapMs'] for v in values),default=None),
                gapsAtLeast40Ms=sum(v['gapMs']>=40 for v in values),
                gapsAtLeast100Ms=sum(v['gapMs']>=100 for v in values),
                largestGaps=sorted(values,key=lambda v:v['gapMs'],reverse=True)[:10])


def valid_capture(summary):
    dropped=re.search(r'(\d+) packets dropped by kernel',summary.get('captureDiagnostics',''))
    return (summary.get('error') is None and summary.get('records',0)>0
            and summary.get('incompleteRecordBytes')==0 and summary.get('rejected')==0
            and dropped is not None and int(dropped[1])==0)


def correlate(sender, receiver, report, sender_summary, receiver_summary):
    if len(sender)>10000 or len(receiver)>10000:raise ValueError('Header count exceeds capture bound')
    if any(b['unixMicros']<a['unixMicros'] for rows in (sender,receiver) for a,b in zip(rows,rows[1:])):
        raise ValueError('Capture clock reversed')
    start=dt.datetime.fromisoformat(report['startedAt'].replace('Z','+00:00')).timestamp()*1e6
    end=start+report['elapsedSeconds']*1e6
    by_key={key(row):row for row in sender}
    duplicate_sender=len(sender)-len(by_key)
    matches=[(by_key[key(r)],r) for r in receiver if key(r) in by_key]
    delays=[(r['unixMicros']-s['unixMicros'])/1000 for s,r in matches]
    floor=min(delays,default=0)
    measured=[(s,r) for s,r in matches if start<=r['unixMicros']<=end]
    excess=[(r['unixMicros']-s['unixMicros'])/1000-floor for s,r in measured]
    incidents=[]
    for event in report.get('events',[]):
        if event.get('kind')!='receiver' or not (event.get('concealedMs',0) or event.get('discarded',0) or event.get('lost',0)>0):continue
        at=start+event['ms']*1000
        begin=at-event.get('windowMs',1000)*1000-250000
        finish=at+250000
        incidents.append(dict(receiver=event,utc=dt.datetime.fromtimestamp(at/1e6,dt.timezone.utc).isoformat(),
                              sender=gaps(sender,begin,finish),arrival=gaps(receiver,begin,finish)))
    send_window=gaps(sender,start,end);receive_window=gaps(receiver,start,end)
    record_counts_match=(sender_summary.get('records')==len(sender)
                         and receiver_summary.get('records')==len(receiver))
    valid=(valid_capture(sender_summary) and valid_capture(receiver_summary) and duplicate_sender==0
           and record_counts_match
           and send_window['covered'] and receive_window['covered'] and report.get('status')=='completed'
           and report.get('coverage',{}).get('completePollCoverage') is True
           and report.get('coverage',{}).get('uninterruptedConnection') is True
           and len(measured)>0)
    return dict(valid=valid,receiverStart=report['startedAt'],receiverSeconds=report['elapsedSeconds'],
                sender=send_window,arrival=receive_window,matchedReceiverPackets=len(measured),
                unmatchedReceiverPackets=sum(start<=r['unixMicros']<=end and key(r) not in by_key for r in receiver),
                duplicateSenderKeys=duplicate_sender,recordCountsMatch=record_counts_match,
                transitExcessOverObservedMinimumMs=dict(
                    median=statistics.median(excess) if excess else None,maximum=max(excess,default=None)),
                incidents=incidents,limitations=[
                    'Capture timestamps require stable clocks; absolute one-way latency is not claimed.',
                    'Extra arrival jitter localizes delay after sender capture, but cannot distinguish SFU forwarding from network hops.',
                    'An arrival gap is not necessarily permanent packet loss; subsequent late/reordered arrivals can fill it.',
                    'Overlap with a receiver poll is correlation; decoding/playout happens after kernel arrival.',
                    'Short, instrumented diagnostic window is not a production improvement or endurance qualification.'])


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--sender',type=Path,required=True)
    p.add_argument('--receiver',type=Path,required=True)
    p.add_argument('--report',type=Path,required=True)
    a=p.parse_args()
    read=lambda path:[json.loads(s) for s in path.read_text().splitlines()]
    result=correlate(read(a.sender/'headers.jsonl'),read(a.receiver/'headers.jsonl'),json.loads(a.report.read_text()),
                     json.loads((a.sender/'summary.json').read_text()),json.loads((a.receiver/'summary.json').read_text()))
    print(json.dumps(result,indent=2))
