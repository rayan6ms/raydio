import datetime as dt
import json
from pathlib import Path
import re
import statistics
import argparse
parser=argparse.ArgumentParser(description="Summarize receiver evidence without hiding extended song-boundary silence")
parser.add_argument('--input', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--source-tail-ms', required=True, type=float)
args=parser.parse_args()
root=args.input
r=json.loads((root/'receiver.json').read_text())
start=dt.datetime.fromisoformat(r['startedAt'].replace('Z','+00:00'))
end=start+dt.timedelta(seconds=r['elapsedSeconds'])
d=r['delta']
log=re.sub(r'\x1b\[[0-9;]*m','',(root/'service.log').read_text())
repeats=[]
checkpoints=[]
for line in log.splitlines():
    try: date=dt.datetime.fromisoformat(line.split()[0])
    except (ValueError,IndexError): continue
    if 'track started generation=' in line: repeats.append(date)
    if 'voice diagnostic checkpoint' in line:
        counters={k:int(v) for k,v in re.findall(r'(frames_sent|silence_frames_sent|frames_unavailable|skipped_deadlines|send_failures|source_overruns): (\d+)',line)}
        if start <= date <= end: checkpoints.append({'utc':date.isoformat(),**counters})
quiet=[]
for e in r['events']:
    if e['kind'] not in ['quiet','quiet-at-end']: continue
    at=start+dt.timedelta(milliseconds=e['ms'])
    offset=min(((at-t).total_seconds() for t in repeats),key=abs,default=None)
    boundary=offset is not None and abs(offset)<=2
    # A quiet interval ending at a restart can still include a long stall.
    # 100 ms is an explicit tolerance, not a waveform match or quality promise.
    label=('extended-boundary-quiet' if e['durationMs']>args.source_tail_ms+100 else 'source-tail-candidate') if boundary else 'off-boundary-quiet'
    quiet.append({'utc':at.isoformat(),'durationMs':e['durationMs'],'nearestStartOffsetSeconds':offset,'classification':label})
resources=[json.loads(x) for x in (root/'resources.jsonl').read_text().splitlines()]
samples=[s for s in resources if start <= dt.datetime.fromisoformat(s['utc']) <= end]
mem=[s['pssKiB']/1024 for s in samples if 'pssKiB' in s]
summary={'status':r['status'],'startedAt':r['startedAt'],'receiverSeconds':r['elapsedSeconds'],'coverage':r['coverage'],
    'packetsReceived':d['packetsReceived'],'lostNet':d['packetsLost'],'positiveLoss':r['sampling']['positiveLossDeltas'],'negativeLossDeltas':r['sampling']['negativeLossDeltas'],
    'discarded':d['packetsDiscarded'],'nacks':d['nackCount'],'concealmentMs':d['concealedSamples']/48,'silentConcealmentMs':d['silentConcealedSamples']/48,
    'concealmentMsPerMinute':d['concealedSamples']/48/(r['elapsedSeconds']/60),'pcm':r['pcm'],'quietIntervals':quiet,
    'quietRequiringReviewAtLeast100Ms':[q for q in quiet if q['durationMs']>=100 and q['classification']!='source-tail-candidate'],
    'networkEvents':[e for e in r['events'] if e['kind'] in ['ice','connection','network-offline','network-online']],
    'receiverScheduling':r['receiverScheduling'],'sampling':r['sampling'],
    'senderCheckpointDelta':{k:checkpoints[-1][k]-checkpoints[0][k] for k in checkpoints[0] if k!='utc'} if len(checkpoints)>1 else None,
    'senderCoverage':{'from':checkpoints[0]['utc'],'to':checkpoints[-1]['utc']} if checkpoints else None,
    'resourceSamples':len(samples),'pssMiB':{'min':min(mem),'max':max(mem),'median':statistics.median(mem)} if mem else None,
    'sourceTailReferenceMs':args.source_tail_ms,'sourceTailToleranceMs':100,'limitations':['one receiver cannot isolate network hop','short window is not six-hour guarantee','source-tail-candidate means temporal and duration agreement, not fresh decoded waveform alignment','negative cumulative loss deltas can include corrections to losses predating this observation' ,'sender/resource counters use bracketing minute samples and cannot prove per-packet send timing']}
if len(samples)>1:
    a,b=samples[0],samples[-1]
    elapsed=(dt.datetime.fromisoformat(b['utc'])-dt.datetime.fromisoformat(a['utc'])).total_seconds()
    summary['botCpuPercentOfOneCore']=(b['cpuSeconds']-a['cpuSeconds'])/elapsed*100
    ticks=[y-x for x,y in zip(a['cpuTicks'],b['cpuTicks'])]
    summary['hostStealPercent']=ticks[7]/sum(ticks[:8])*100
    summary['udpCounterDelta']={k:b['udp'][k]-a['udp'][k] for k in a['udp']}
    summary['cgroupMemoryEventsDelta']={k:b['cgroupMemoryEvents'][k]-a['cgroupMemoryEvents'][k] for k in a['cgroupMemoryEvents']}
if (root/'checkpoints.jsonl').exists():
    saved=[json.loads(line) for line in (root/'checkpoints.jsonl').read_text().splitlines()]
    summary['checkpointSavesForThisRun']=sum(x.get('requestedAt')==r['requestedAt'] for x in saved)
    summary['checkpointSavesInCollectedFile']=len(saved)
args.output.write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k not in ['pcm','sampling','quietIntervals','receiverScheduling']},indent=2))
