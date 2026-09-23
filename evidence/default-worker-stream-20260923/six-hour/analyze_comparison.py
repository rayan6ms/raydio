"""Reproduce bounded-memory trace and equal-prefix receiver comparison."""
import collections,datetime as dt,json,re,statistics
from pathlib import Path
P=Path(__file__).resolve().parent
stamp=lambda x:dt.datetime.fromisoformat(x.replace('Z','+00:00')).timestamp()
def analyze(root,receiver_path,log_path):
 r=json.loads(receiver_path.read_text());start=stamp(r['startedAt'])
 ranges={'first54Minutes':(start,start+3240),'receiverSegment':(start,start+r['elapsedSeconds']),'plannedSixHours':(start,start+21600)}
 stats={n:dict(records=0,gaps=[],maxGapUs=0,missing=0,sequenceJumps=0,timestampJumps=0,silence=0,first=None,last=None,timing=[collections.Counter() for _ in range(7)]) for n in ranges}
 prev={};cps=[];events=[];dropped=0
 for raw in log_path.open():
  line=re.sub(r'\x1b\[[0-9;]*m','',raw)
  if 'voice diagnostic checkpoint' in line:
   cps.append({'time':stamp(line.split()[0]),**{k:int(v) for k,v in re.findall(r'(frames_sent|silence_frames_sent|frames_unavailable|send_failures|source_overruns|active_send_gaps_40ms|active_send_gaps_100ms|active_send_gaps_1s): (\d+)',line)}})
  if 'RTP send trace:' not in line:continue
  epoch=int(re.search(r'epoch_us=(\d+)',line)[1]);dropped=max(dropped,int(re.search(r'dropped=(\d+)',line)[1]))
  rows=json.loads(line.split(' records=',1)[1].replace('(','[').replace(')',']'))
  for row in rows:
   t=(epoch+row[1])/1e6;last=prev.get(epoch);prev[epoch]=row
   for n,(a,b) in ranges.items():
    if not a<=t<b:continue
    s=stats[n];s['records']+=1;s['silence']+=row[7];s['first']=s['first'] or t;s['last']=t
    if row[8][0]:
     for h,v in zip(s['timing'],row[8][1:]):h[v]+=1
    if last and a<=(epoch+last[1])/1e6:
     s['missing']+=max(0,row[0]-last[0]-1)
     if row[0]!=last[0]+1 or (row[2],row[4])!=(last[2],last[4]):continue
     s['sequenceJumps']+=row[6]!=(last[6]+1)%65536;s['timestampJumps']+=row[5]!=(last[5]+960)%2**32
     gap=row[1]-last[1];s['maxGapUs']=max(s['maxGapUs'],gap)
     if gap>=40000:s['gaps'].append({'t':t,'us':gap,'timing':row[8],'sourceChanged':row[3]!=last[3]})
 resources=[json.loads(l) for l in (root/'resources.jsonl').open()]
 for n,(a,b) in ranges.items():
  s=stats[n];s['gap40']=len(s['gaps']);s['gap100']=sum(g['us']>=100000 for g in s['gaps']);s['gap1s']=sum(g['us']>=1000000 for g in s['gaps']);s['observedSpanSeconds']=(s['last']-s['first']) if s['first'] else 0
  s['gap40PerObservedHour']=s['gap40']/s['observedSpanSeconds']*3600 if s['observedSpanSeconds'] else None
  def pct(h,p):
   target=(sum(h.values())-1)*p;c=0
   for v,count in sorted(h.items()):
    c+=count
    if c>target:return v
  s['stages']={k:{'p50':pct(h,.5),'p99':pct(h,.99),'max':max(h) if h else None} for k,h in zip(['wake','source','daveRoundTrip','daveWall','daveCpu','crypto','udp'],s.pop('timing'))}
  cs=[c for c in cps if a<=c['time']<b]
  if len(cs)>1:
   f,l=cs[0],cs[-1];s['checkpointSeconds']=l['time']-f['time'];s['checkpointDelta']={k:l[k]-f[k] for k in f if k!='time'}
  rs=[v for v in resources if a<=stamp(v['utc'])<b and 'pssKiB' in v]
  if len(rs)>1:
   f,l=rs[0],rs[-1];seconds=stamp(l['utc'])-stamp(f['utc']);ticks=[y-x for x,y in zip(f['cpuTicks'],l['cpuTicks'])]
   s['host']={'seconds':seconds,'samples':len(rs),'pssMedianMiB':statistics.median(v['pssKiB']/1024 for v in rs),'cpuPercent':(l['cpuSeconds']-f['cpuSeconds'])/seconds*100,'stealPercent':ticks[7]/sum(ticks[:8])*100}
   s['collectors']={}
   for k,v in f['collectors'].items():
    z=l['collectors'][k];vals=[q['collectors'][k] for q in rs];s['collectors'][k]={'cpuPercent':(z['cpu']['usage_usec']-v['cpu']['usage_usec'])/1e6/seconds*100,'maxMiB':max(x['memoryBytes'] for x in vals)/2**20,'maxEvents':z['memoryEvents']['max']-v['memoryEvents']['max'],'oomKills':z['memoryEvents']['oom_kill']-v['memoryEvents']['oom_kill'],'missing':sum('populated 1' not in x['events'] for x in vals)}
 ms=[m for m in r['minutes'] if m['toMs']<=3240000]
 prefix={'buckets':len(ms),'seconds':(ms[-1]['toMs']-ms[0]['fromMs'])/1000}
 for k in ['packets','lostNet','positiveLoss','concealedSamples','silentConcealedSamples','concealmentEvents']:prefix[k]=sum(m.get(k,0) for m in ms)
 prefix['concealmentMs']=prefix['concealedSamples']/48;prefix['silentConcealmentMs']=prefix['silentConcealedSamples']/48;prefix['concealmentMsPerMinute']=prefix['concealmentMs']/(prefix['seconds']/60)
 return {'receiverStatus':r['status'],'receiverSeconds':r['elapsedSeconds'],'receiverPrefix':prefix,'ringDropped':dropped,'windows':stats}
default=analyze(P/'oracle',P/'first-segment/receiver.json',P/'oracle/service.log')
prior=P.parents[1]/'queued-worker-stream-20260922/six-hour'
worker=analyze(prior,prior/'receiver.json',prior/'oracle/service.log')
result={'default':default,'worker':worker}
(P/'comparison.json').write_text(json.dumps(result,indent=2)+'\n')
for name,x in result.items():
 print(name,json.dumps({'receiver':x['receiverPrefix'],'windows':{k:{a:b for a,b in s.items() if a!='gaps'} for k,s in x['windows'].items()}},indent=2))
