import datetime as dt
import json
from pathlib import Path
import re
import statistics
import argparse
from quiet_classification import classify_quiet
parser=argparse.ArgumentParser(description="Summarize receiver evidence without hiding extended song-boundary silence")
parser.add_argument('--input', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--source-tail-ms', required=True, type=float)
parser.add_argument('--source-head-ms', default=0, type=float)
args=parser.parse_args()
root=args.input
r=json.loads((root/'receiver.json').read_text())
start=dt.datetime.fromisoformat(r['startedAt'].replace('Z','+00:00'))
end=start+dt.timedelta(seconds=r['elapsedSeconds'])
planned_end=start+dt.timedelta(seconds=r.get('requestedSeconds',r['elapsedSeconds']))
d=r['delta']
samples_per_ms=r.get('codec',{}).get('clockRate',48000)/1000
archive_warnings=[]
archive=root/'receiver-events.jsonl'
if archive.exists():
    archived=[json.loads(line) for line in archive.read_text().splitlines()]
    events={e['sequence']:e for e in archived if e.get('requestedAt')==r.get('requestedAt')}
    events.update({e['sequence']:e for e in r['events'] if 'sequence' in e})
    if events:
        sequence=sorted(events)
        if sequence!=list(range(1,sequence[-1]+1)): archive_warnings.append('persisted event sequence has gaps')
        r['events']=[events[i] for i in sequence]
        r['persistedEventHistoryComplete']=not archive_warnings

window_archive=root/'receiver-windows.jsonl'
persisted_windows_complete=False
if window_archive.exists():
    windows={}
    for line in window_archive.read_text().splitlines():
        row=json.loads(line)
        if row.get('requestedAt')!=r.get('requestedAt'): continue
        window=row['window']; identity=window['id']
        if row['revision']>windows.get(identity,(0,None))[0]:
            windows[identity]=(row['revision'],window)
    # The final report may contain the newest in-progress revision if archival failed.
    merged={identity:pair[1] for identity,pair in windows.items()}
    merged.update({w['id']:w for w in r.get('diagnosticWindows',[]) if 'id' in w})
    expected=r.get('diagnosticWindowsCreated')
    persisted_windows_complete=(type(expected) is int and sorted(merged)==list(range(1,expected+1)))
    r['diagnosticWindows']=[merged[i] for i in sorted(merged)]

log=re.sub(r'\x1b\[[0-9;]*m','',(root/'service.log').read_text())
repeats=[]
checkpoints=[]
sender_events=[]
sender_log_times=[]
for line in log.splitlines():
    try: date=dt.datetime.fromisoformat(line.split()[0])
    except (ValueError,IndexError): continue
    sender_log_times.append(date)
    # A receiver failure must not hide a later sender failure. Keep this
    # separate from the counters measured during the receiver window.
    if start <= date <= planned_end:
        kind = next((kind for text,kind in (
            ('DAVE lifecycle transition','dave-lifecycle-transition'),
            ('audio sender stopped after a terminal failure','audio-terminal-failure'),
            ('voice connection failure','connection-failure'),
            ('voice closed; cleaning up playback','session-cleanup'),
            ('end watchdog','end-watchdog'),
        ) if text in line),None)
        if kind:
            fields={key:value for key,value in re.findall(
                r'\b(failure|dave_failure)=Some\((\w+)\)',line)}
            fields.update({key:int(value) for key,value in re.findall(
                r'\b(code|generation|position_ms|frames_sent|frames_unavailable|skipped_deadlines|send_failures|source_overruns|active_version)[=:] ?(\d+)',line)})
            fields.update({key:value=='true' for key,value in re.findall(
                r'\b(transition_pending|ready): (true|false)',line)})
            if kind=='dave-lifecycle-transition':
                # Keep the old/new contexts distinct. Never copy opaque gateway
                # payloads or crypto material into the analysis output.
                fields={key:int(value) for key,value in re.findall(
                    r'\b(connection_generation|opcode)=(\d+)',line)}
                for label,context in re.findall(r'\b(before|after)=DaveContext \{([^}]+)\}',line):
                    fields[label]={key:int(value) if key=='active_version' else value=='true'
                        for key,value in re.findall(r'\b(active_version|transition_pending|ready): (\d+|true|false)',context)}
            sender_events.append({'utc':date.isoformat(),'kind':kind,
                'afterReceiverEnd':date>end,**fields})
    if 'track started generation=' in line: repeats.append(date)
    if 'voice diagnostic checkpoint' in line:
        counters={k:int(v) for k,v in re.findall(r'(frames_sent|silence_frames_sent|frames_unavailable|skipped_deadlines|send_failures|source_overruns|active_send_gaps_40ms|active_send_gaps_100ms|active_send_gaps_1s): (\d+)',line)}
        if start <= date <= end:
            checkpoints.append({'utc':date.isoformat(),**counters})
quiet=classify_quiet(r, log, args.source_tail_ms, args.source_head_ms)
resources=[json.loads(x) for x in (root/'resources.jsonl').read_text().splitlines()]
samples=[s for s in resources if start <= dt.datetime.fromisoformat(s['utc']) <= end]
mem=[s['pssKiB']/1024 for s in samples if 'pssKiB' in s]
summary={'status':r['status'],'startedAt':r['startedAt'],'receiverSeconds':r['elapsedSeconds'],'coverage':r['coverage'],
    'requestedSeconds':r.get('requestedSeconds'),'plannedEndAt':planned_end.isoformat(),
    'receiverFinishedAt':r.get('finishedAt'),'receiverError':r.get('error'),
    'unobservedRequestedSeconds':max(0,(planned_end-end).total_seconds()),
    'senderEventsThroughPlannedEnd':sender_events,
    'senderLogExtent':{'first':min(sender_log_times).isoformat(),'last':max(sender_log_times).isoformat()} if sender_log_times else None,
    'packetsReceived':d['packetsReceived'],'lostNet':d['packetsLost'],'positiveLoss':r['sampling']['positiveLossDeltas'],'negativeLossDeltas':r['sampling']['negativeLossDeltas'],
    'discarded':d['packetsDiscarded'],'nacks':d['nackCount'],'concealmentMs':d['concealedSamples']/samples_per_ms,'silentConcealmentMs':d['silentConcealedSamples']/samples_per_ms,
    'concealmentMsPerMinute':d['concealedSamples']/samples_per_ms/(r['elapsedSeconds']/60),'pcm':r['pcm'],'quietIntervals':quiet,
    'quietRequiringReviewAtLeast100Ms':[q for q in quiet if q['durationMs']>=100 and q['classification']!='source-tail-candidate'],
    'networkEvents':[e for e in r['events'] if e['kind'] in ['ice','connection','network-offline','network-online']],
    'receiverScheduling':r['receiverScheduling'],'sampling':r['sampling'],
    'senderCheckpointDelta':None, 'senderCheckpoints':checkpoints,
    'senderCoverage':{'from':checkpoints[0]['utc'],'to':checkpoints[-1]['utc']} if checkpoints else None,
    'resourceSamples':len(samples),'pssMiB':{'min':min(mem),'max':max(mem),'median':statistics.median(mem)} if mem else None,
    'sourceTailReferenceMs':args.source_tail_ms,'sourceTailToleranceMs':100,'limitations':['one receiver cannot isolate network hop','short window is not six-hour guarantee','source-tail-candidate means temporal and duration agreement, not fresh decoded waveform alignment','negative cumulative loss deltas can include corrections to losses predating this observation' ,'sender/resource deltas cover only the interior minute samples; exact uncovered head/tail are reported; active send gap counts exclude a paused timeline']}
if len(samples)>1 and all('cpuSeconds' in sample and 'cpuTicks' in sample and 'udp' in sample and 'cgroupMemoryEvents' in sample for sample in (samples[0],samples[-1])):
    a,b=samples[0],samples[-1]
    elapsed=(dt.datetime.fromisoformat(b['utc'])-dt.datetime.fromisoformat(a['utc'])).total_seconds()
    summary['botCpuPercentOfOneCore']=(b['cpuSeconds']-a['cpuSeconds'])/elapsed*100
    ticks=[y-x for x,y in zip(a['cpuTicks'],b['cpuTicks'])]
    summary['hostStealPercent']=ticks[7]/max(1,sum(ticks[:8]))*100
    summary['udpCounterDelta']={k:b['udp'][k]-a['udp'][k] for k in a['udp']}
    summary['cgroupMemoryEventsDelta']={k:b['cgroupMemoryEvents'][k]-a['cgroupMemoryEvents'][k] for k in a['cgroupMemoryEvents']}
if (root/'checkpoints.jsonl').exists():
    saved=[json.loads(line) for line in (root/'checkpoints.jsonl').read_text().splitlines()]
    summary['checkpointSavesForThisRun']=sum(x.get('requestedAt')==r['requestedAt'] for x in saved)
    summary['checkpointSavesInCollectedFile']=len(saved)
summary['sourceHeadReferenceMs']=args.source_head_ms
summary['quietClassificationCounts']={label:sum(q['classification']==label for q in quiet) for label in sorted({q['classification'] for q in quiet})}
summary['evidenceWarnings']=archive_warnings
if any(e['kind']=='audio-terminal-failure' for e in sender_events):
    summary['evidenceWarnings'].append('terminal sender failure occurred during the requested observation window, possibly after receiver coverage ended')
summary['hostCollectionCoverage']={
    'samples':len(resources),
    'first':resources[0]['utc'] if resources else None,
    'last':resources[-1]['utc'] if resources else None,
    'errors':sum('error' in sample for sample in resources),
    'note':'Host collection after playback stops is not audio coverage; PSS and CPU above use only the receiver window.'}
summary['persistedEventHistoryComplete']=r.get('persistedEventHistoryComplete',r['coverage'].get('completeEventHistory'))
required=('frames_sent','silence_frames_sent','frames_unavailable','skipped_deadlines','send_failures','source_overruns')
if len(checkpoints)>1:
    complete=all(all(k in c for k in required) for c in checkpoints)
    shared=set.intersection(*(set(c)-{'utc'} for c in checkpoints))
    resets=any(any(b[k]<a[k] for k in shared) for a,b in zip(checkpoints,checkpoints[1:]))
    if complete and not resets:
        summary['senderCheckpointDelta']={k:checkpoints[-1][k]-checkpoints[0][k] for k in sorted(shared)}
    else: summary['evidenceWarnings'].append('sender counters reset or required counters missing; no aggregate subtraction')
    times=[dt.datetime.fromisoformat(c['utc']) for c in checkpoints]
    gaps=[(b-a).total_seconds() for a,b in zip(times,times[1:])]
    summary['senderCoverage'].update(unobservedHeadSeconds=(times[0]-start).total_seconds(),unobservedTailSeconds=(end-times[-1]).total_seconds(),maximumCheckpointGapSeconds=max(gaps))
    if max(gaps)>90: summary['evidenceWarnings'].append('sender checkpoint gap exceeds 90 seconds')
else: summary['evidenceWarnings'].append('insufficient sender checkpoints')
if r.get('missingCounters'): summary['evidenceWarnings'].append('unsupported receiver counters: '+', '.join(r['missingCounters']))
if r.get('clock',{}).get('pcmEpochUncertaintyMs',0)>50: summary['evidenceWarnings'].append('PCM-to-wall-clock uncertainty exceeds 50 ms')
summary['clock']=r.get('clock')
summary['uiObservation']=r.get('uiObservation')
if r.get('uiObservation',{}).get('rowRebindings',0) or r.get('uiObservation',{}).get('missingRowPolls',0):
    summary['evidenceWarnings'].append('voice UI was rebound or absent; speaking-indicator coverage is incomplete')
if r.get('uiObservation',{}).get('unknownPhasePolls',0):
    summary['evidenceWarnings'].append('track phase was unavailable for some polls; use logged lifecycle and retain uncertain quiet intervals')
summary['availableCounters']=r.get('availableCounters')
summary['sourceReference']=json.loads((root/'source-reference.json').read_text()) if (root/'source-reference.json').exists() else None
if summary['sourceReference'] is None: summary['evidenceWarnings'].append('source reference provenance missing')
if any('error' in sample for sample in samples): summary['evidenceWarnings'].append('sender-host sampler error')
if len({sample.get('pid') for sample in samples})>1: summary['evidenceWarnings'].append('sender process changed')
for key in ('completePollCoverage','completePcmCoverage','completeEventHistory','uninterruptedConnection'):
    if r['coverage'].get(key) is not True: summary['evidenceWarnings'].append(key+' not established')
summary['incidentWindows']={'retained':len(r.get('diagnosticWindows',[])),
    'created':r.get('diagnosticWindowsCreated'), 'browserEvictions':r.get('diagnosticWindowsDropped',0),
    'completePersistedHistory':persisted_windows_complete,
    'incompletePostIncidentWindows':sum(w.get('remaining',0)>0 for w in r.get('diagnosticWindows',[]))}
summary['diagnosticWindows']=r.get('diagnosticWindows',[])
if r.get('diagnosticWindowsDropped',0) and not persisted_windows_complete:
    summary['evidenceWarnings'].append('incident windows overwritten without complete archive')
if r.get('status')!='completed': summary['evidenceWarnings'].append('receiver did not complete')
if not samples: summary['evidenceWarnings'].append('no in-window sender-host samples')
summary['limitations'].append('Natural boundaries require a logged finish followed by a later generation start; all PCM quiet, including candidates, remains in the report. Coincidence never proves source-only silence.')
args.output.write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k not in ['pcm','sampling','quietIntervals','receiverScheduling']},indent=2))
