"""One-off bounded-memory analysis of preserved records; run from this directory."""
import collections, datetime as dt, hashlib, json, re, statistics
from pathlib import Path
ROOT=Path(__file__).resolve().parent
stamp=lambda s: dt.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
iso=lambda t: dt.datetime.fromtimestamp(t,dt.timezone.utc).isoformat()
r=json.loads((ROOT/'receiver.json').read_text()); start=stamp(r['startedAt']); end=start+21600
ranges={'sixHours':(start,end),'receiver':(start,start+r['elapsedSeconds'])}
stats={name:{'records':0,'gaps':[],'maxGapUs':0,'missingRecords':0,'sequenceJumps':0,'timestampJumps':0,'silencePackets':0,'first':None,'last':None,'connectionGenerations':set(),'sourceGenerations':set(),'timing':[collections.Counter() for _ in range(7)]} for name in ranges}
previous={}; batches=0; dropped=0; whole_missing=0
for line in (ROOT/'oracle/service.log').open():
 if 'RTP send trace:' not in line: continue
 epoch=int(re.search(r'epoch_us=(\d+)',line)[1]); dropped=max(dropped,int(re.search(r'dropped=(\d+)',line)[1])); batches+=1
 rows=json.loads(line.split(' records=',1)[1].replace('(', '[').replace(')', ']'))
 for row in rows:
  ts=(epoch+row[1])/1e6; prev=previous.get(epoch); previous[epoch]=row
  if prev: whole_missing+=max(0,row[0]-prev[0]-1)
  for name,(a,b) in ranges.items():
   if not a<=ts<=b: continue
   s=stats[name]; s['records']+=1; s['first']=s['first'] or iso(ts); s['last']=iso(ts); s['silencePackets']+=row[7]; s['connectionGenerations'].add(row[2]); s['sourceGenerations'].add(row[3])
   if len(row)>8 and row[8][0]:
    for hist,val in zip(s['timing'],row[8][1:]):
     if val!=2**64-1: hist[val]+=1
   if prev and a<=(epoch+prev[1])/1e6:
    s['missingRecords']+=max(0,row[0]-prev[0]-1)
    if row[0]!=prev[0]+1 or (row[2],row[4])!=(prev[2],prev[4]): continue
    s['sequenceJumps']+=row[6]!=(prev[6]+1)%65536; s['timestampJumps']+=row[5]!=(prev[5]+960)%2**32
    gap=row[1]-prev[1]; s['maxGapUs']=max(gap,s['maxGapUs'])
    if gap>=40000:s['gaps'].append({'utc':iso(ts),'us':gap,'sourceChanged':row[3]!=prev[3],'timingUs':row[8] if len(row)>8 else None})
def percentile(hist,p):
 n=sum(hist.values()); target=int((n-1)*p); cumulative=0
 for value,count in sorted(hist.items()):
  cumulative+=count
  if cumulative>target:return value
for name,s in stats.items():
 s['gapsAtLeast40ms']=len(s['gaps']); s['gapsAtLeast100ms']=sum(g['us']>=100000 for g in s['gaps']); s['gapsAtLeast1s']=sum(g['us']>=1000000 for g in s['gaps']); s['gapsPerHour']=len(s['gaps'])/((ranges[name][1]-ranges[name][0])/3600)
 s['connectionGenerations']=sorted(s['connectionGenerations']); s['sourceGenerations']=sorted(s['sourceGenerations'])
 s['stageUs']={name:{'p50':percentile(h,.5),'p99':percentile(h,.99),'max':max(h) if h else None} for name,h in zip(['wake','source','daveRoundTrip','daveWall','daveCpu','crypto','udp'],s.pop('timing'))}
resources=[json.loads(l) for l in (ROOT/'resources.jsonl').open()]; log=(ROOT/'service.log').read_text(); cps=[]
for line in log.splitlines():
 if 'voice diagnostic checkpoint' not in line: continue
 t=stamp(line.split()[0]); fields={k:int(v) for k,v in re.findall(r'(frames_sent|silence_frames_sent|frames_unavailable|skipped_deadlines|send_failures|source_overruns|active_send_gaps_40ms|active_send_gaps_100ms|active_send_gaps_1s): (\d+)',line)}
 cps.append({'utc':iso(t),'t':t,**fields})
for name,(a,b) in ranges.items():
 selected=[c for c in cps if a<=c['t']<=b]
 if len(selected)>1:
  first,last=selected[0],selected[-1]; seconds=last['t']-first['t']; stats[name]['checkpoint']={'first':first['utc'],'last':last['utc'],'seconds':seconds,'delta':{k:last[k]-first[k] for k in first if k not in ('utc','t')},'gap40PerHour':(last['active_send_gaps_40ms']-first['active_send_gaps_40ms'])/(seconds/3600)}
 samples=[s for s in resources if a<=stamp(s['utc'])<=b]
 if len(samples)>1:
  f,l=samples[0],samples[-1]; ticks=[y-x for x,y in zip(f['cpuTicks'],l['cpuTicks'])]; mem=[s['pssKiB']/1024 for s in samples]
  stats[name]['host']={'samples':len(samples),'first':f['utc'],'last':l['utc'],'cpuPercent':(l['cpuSeconds']-f['cpuSeconds'])/(stamp(l['utc'])-stamp(f['utc']))*100,'stealPercent':ticks[7]/sum(ticks[:8])*100,'pssMiB':{'min':min(mem),'median':statistics.median(mem),'max':max(mem)},'udpDelta':{k:l['udp'][k]-f['udp'][k] for k in f['udp']},'memoryEventsDelta':{k:l['cgroupMemoryEvents'][k]-f['cgroupMemoryEvents'][k] for k in f['cgroupMemoryEvents']}}
# Match entire first 86 minute buckets, including warm-up, without selecting by quality.
minutes=[m for m in r['minutes'] if m['index']<87]
pre={'buckets':len(minutes),'fromMs':minutes[0]['fromMs'],'toMs':minutes[-1]['toMs'],'packets':sum(m['packets'] for m in minutes),'concealmentMs':sum(m['concealedSamples'] for m in minutes)/48,'lostNet':sum(m['lostNet'] for m in minutes),'silentConcealmentMs':sum(m['silentConcealedSamples'] for m in minutes)/48}
pre['seconds']=(pre['toMs']-pre['fromMs'])/1000; pre['concealmentMsPerMinute']=pre['concealmentMs']/(pre['seconds']/60)
# Hourly sender distribution helps expose concentration.
hours=[]
for n in range(6):
 a=start+n*3600; b=a+3600; g=[g for g in stats['sixHours']['gaps'] if a<=stamp(g['utc'])<b]; samples=[s for s in resources if a<=stamp(s['utc'])<b]; f,l=samples[0],samples[-1]; ticks=[y-x for x,y in zip(f['cpuTicks'],l['cpuTicks'])]
 hours.append({'hour':n+1,'gaps40':len(g),'gaps100':sum(x['us']>=100000 for x in g),'stealPercent':ticks[7]/sum(ticks[:8])*100})
result={'traceBatches':batches,'ringDropped':dropped,'wholeTraceMissingRecords':whole_missing,'windows':stats,'first87MinuteBuckets':pre,'hourly':hours}
base=json.loads((ROOT.parents[1]/'final-six-hour-20260912/receiver.json').read_text())
bm=[m for m in base['minutes'] if m['index']<87]
bp={'buckets':len(bm),'seconds':(bm[-1]['toMs']-bm[0]['fromMs'])/1000,'packets':sum(m['packets'] for m in bm),'lostNet':sum(m['lostNet'] for m in bm),'concealmentMs':sum(m['concealedSamples'] for m in bm)/48,'silentConcealmentMs':sum(m['silentConcealedSamples'] for m in bm)/48}
bp['concealmentMsPerMinute']=bp['concealmentMs']/(bp['seconds']/60)
result['baselineFirst87MinuteBuckets']=bp
cp=stats['sixHours']['checkpoint']; inner=[g for g in stats['sixHours']['gaps'] if cp['first']<=g['utc']<=cp['last']]
result['crossCheck']={'traceGapsInsideCheckpointWindow':len(inner),'checkpointGaps':cp['delta']['active_send_gaps_40ms'],'match':len(inner)==cp['delta']['active_send_gaps_40ms']}
# Retain mismatches for investigation rather than hiding the output.
result['crossCheck']['requiresInvestigation']=not result['crossCheck']['match']
(ROOT/'analysis.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({**result,'windows':{n:{k:v for k,v in s.items() if k not in ('gaps','sourceGenerations')} for n,s in stats.items()}},indent=2))
