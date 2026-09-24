"""Streaming analysis of the frozen sender-only snapshot; no receiver inference."""
import argparse,collections,datetime as dt,json,re,statistics
from pathlib import Path
P=Path(__file__).resolve().parent
parser=argparse.ArgumentParser()
parser.add_argument('--source',default='sender')
parser.add_argument('--start')
parser.add_argument('--seconds',type=float)
parser.add_argument('--output',default='summary.json')
args=parser.parse_args()
stamp=lambda x:dt.datetime.fromisoformat(x.replace('Z','+00:00')).timestamp()
iso=lambda x:dt.datetime.fromtimestamp(x,dt.timezone.utc).isoformat()
windows={k:dict(records=0,silence=0,missing=0,sequenceJumps=0,timestampJumps=0,reversed=0,gaps=[],first=None,last=None,maxGapUs=0,timing=[collections.Counter() for _ in range(7)]) for k in ['first54Minutes','all']}
prev={};start=stamp(args.start) if args.start else None;events=[];checkpoints=[];dropped=0;malformed=0
for raw in (P/args.source/'service.log').open():
 line=re.sub(r'\x1b\[[0-9;]*m','',raw)
 t=stamp(line.split()[0])
 if 'RTP send trace:' not in line:
  if 'voice diagnostic checkpoint' in line:
   checkpoints.append({'utc':iso(t),**{k:int(v) for k,v in re.findall(r'(frames_sent|silence_frames_sent|frames_unavailable|skipped_deadlines|send_failures|source_overruns|active_send_gaps_40ms|active_send_gaps_100ms|active_send_gaps_1s): (\d+)',line)}})
  elif any(x in line for x in ['track started','track finished','watchdog','source failed','connection failure','DAVE','cleaning up','sender stopped','WARN','ERROR']):
   events.append(line.strip())
  continue
 try:
  epoch=int(re.search(r'epoch_us=(\d+)',line)[1]);dropped=max(dropped,int(re.search(r'dropped=(\d+)',line)[1]))
  rows=json.loads(line.split(' records=',1)[1].replace('(','[').replace(')',']'))
 except (ValueError,TypeError,IndexError):malformed+=1;continue
 for row in rows:
  t=(epoch+row[1])/1e6;start=start or t;a=prev.get(epoch);prev[epoch]=row
  for name,s in windows.items():
   if t<start or (args.seconds is not None and t>=start+args.seconds):continue
   if name=='first54Minutes' and t>=start+3240:continue
   s['records']+=1;s['silence']+=row[7];s['first']=s['first'] or t;s['last']=t
   if len(row)>8 and row[8][0]:
    for h,v in zip(s['timing'],row[8][1:]):h[v]+=1
   if a is None:
    if not args.start:s['missing']+=row[0]-1
    continue
   if (epoch+a[1])/1e6<start:continue
   s['missing']+=max(0,row[0]-a[0]-1)
   s['reversed']+=row[0]<=a[0]
   if row[0]!=a[0]+1 or (a[2],a[4])!=(row[2],row[4]):continue
   s['sequenceJumps']+=row[6]!=(a[6]+1)%65536;s['timestampJumps']+=row[5]!=(a[5]+960)%2**32
   gap=row[1]-a[1];s['maxGapUs']=max(s['maxGapUs'],gap)
   if gap>=40000:s['gaps'].append({'utc':iso(t),'us':gap,'sourceChanged':row[3]!=a[3],'includesSilence':row[7] or a[7],'timing':row[8]})
resources=[json.loads(l) for l in (P/args.source/'resources.jsonl').open()]
def pct(h,p):
 target=(sum(h.values())-1)*p;c=0
 for v,n in sorted(h.items()):
  c+=n
  if c>target:return v
for name,s in windows.items():
 s['spanSeconds']=s['last']-s['first'];s['gap40']=len(s['gaps']);s['gap100']=sum(g['us']>=100000 for g in s['gaps']);s['gap1s']=sum(g['us']>=1000000 for g in s['gaps']);s['gap40PerHour']=s['gap40']/s['spanSeconds']*3600
 s['stages']={k:{'p50':pct(h,.5),'p99':pct(h,.99),'max':max(h) if h else None} for k,h in zip(['wake','source','daveRoundTrip','daveWall','daveCpu','crypto','udp'],s.pop('timing'))}
 rs=[r for r in resources if s['first']<=stamp(r['utc'])<=s['last'] and 'pssKiB' in r]
 f,l=rs[0],rs[-1];seconds=stamp(l['utc'])-stamp(f['utc']);ticks=[b-a for a,b in zip(f['cpuTicks'],l['cpuTicks'])]
 s['resources']={'samples':len(rs),'sampledSeconds':seconds,'pssMedianMiB':statistics.median(r['pssKiB']/1024 for r in rs),'pssMinMiB':min(r['pssKiB']/1024 for r in rs),'pssMaxMiB':max(r['pssKiB']/1024 for r in rs),'cpuPercent':(l['cpuSeconds']-f['cpuSeconds'])/seconds*100,'stealPercent':ticks[7]/sum(ticks[:8])*100,'pidCount':len({r['pid'] for r in rs}),'samplerErrors':sum('error' in r for r in rs),'maxSampleGapSeconds':max(stamp(b['utc'])-stamp(a['utc']) for a,b in zip(rs,rs[1:])),'udpDelta':{k:l['udp'][k]-v for k,v in f['udp'].items()},'oomKills':l['cgroupMemoryEvents']['oom_kill']-f['cgroupMemoryEvents']['oom_kill']}
 s['collectors']={k:{'cpuPercent':(l['collectors'][k]['cpu']['usage_usec']-v['cpu']['usage_usec'])/1e6/seconds*100,'oomKills':l['collectors'][k]['memoryEvents']['oom_kill']-v['memoryEvents']['oom_kill'],'maxEvents':l['collectors'][k]['memoryEvents']['max']-v['memoryEvents']['max'],'missing':sum('populated 1' not in r['collectors'][k]['events'] for r in rs)} for k,v in f['collectors'].items()}
 s['startUtc']=iso(s['first']);s['endUtc']=iso(s['last'])
 starts=[e for e in events if 'track started' in e and s['first']-2<=stamp(e.split()[0])<=s['last']]
 s['trackStarts']=len(starts)
 s['gapMinuteCounts']=dict(sorted(collections.Counter(g['utc'][:16] for g in s['gaps']).items()))
result={'windows':windows,'events':events,'checkpoints':checkpoints,'ringDropped':dropped,'malformedBatches':malformed,'receiverRecorded':False,'limitations':['No historical receiver packet loss, concealment, PCM clipping or silence measurement exists for this run.','Successful sends do not establish delivery.','Export starts after snapshot cutoff; later sends are not included.']}
(P/args.output).write_text(json.dumps(result,indent=2)+'\n')
for k,s in windows.items(): print(k,json.dumps({a:b for a,b in s.items() if a not in ['gaps','gapMinuteCounts']},indent=2))
print('events',len(events),'starts',sum('track started' in e for e in events),'finished',sum('track finished' in e for e in events),'warnings',[e for e in events if 'WARN' in e or 'ERROR' in e]);print('dropped',dropped,'malformed',malformed)
