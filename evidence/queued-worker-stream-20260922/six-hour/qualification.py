import datetime as dt,json,statistics
from pathlib import Path
P=Path(__file__).resolve().parent
stamp=lambda s:dt.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
r=json.loads((P/'receiver.json').read_text());s=json.loads((P/'summary.json').read_text());a=json.loads((P/'analysis.json').read_text());start=stamp(r['startedAt']);end=start+21600
samples=[json.loads(l) for l in (P/'resources.jsonl').read_text().splitlines()];samples=[v for v in samples if start<=stamp(v['utc'])<=end];f,l=samples[0],samples[-1];seconds=stamp(l['utc'])-stamp(f['utc']);collectors={}
for name,initial in f['collectors'].items():
 values=[v['collectors'][name] for v in samples]; final=values[-1]
 cpu=(final['cpu']['usage_usec']-initial['cpu']['usage_usec'])/1e6
 collectors[name]={'cpuSeconds':cpu,'cpuPercentOneCore':cpu/seconds*100,'memoryMiBMin':min(v['memoryBytes'] for v in values)/2**20,'memoryMiBMax':max(v['memoryBytes'] for v in values)/2**20,'errors':sum('error' in v for v in values),'unpopulated':sum('populated 1' not in v['events'] for v in values),'oomKills':final['memoryEvents']['oom_kill']-initial['memoryEvents']['oom_kill']}
bytes_=[v['captureFiles']['service.log']['bytes'] for v in samples]
export=stamp('2026-09-23T01:37:39.529495+00:00')
g=a['windows']['sixHours']['gaps'];before=[v for v in g if stamp(v['utc'])<export];after=[v for v in g if stamp(v['utc'])>=export]
q=[v for v in s['quietIntervals'] if v['classification']=='off-boundary-quiet' and v['durationMs']>=100]
qb=[v for v in q if start+v['endMs']/1000<export];qa=[v for v in q if start+v['startMs']/1000>=export]
cp=a['windows']['sixHours']['checkpoint'];inside=[v for v in g if cp['first']<=v['utc']<=cp['last']];unscheduled=[v for v in inside if v['timingUs'][0]==0]
result={'collectorSeconds':seconds,'collectors':collectors,'collectorTotalCpuPercent':sum(v['cpuPercentOneCore'] for v in collectors.values()),'logBytesFirst':bytes_[0],'logBytesLast':bytes_[-1],'nonadvancingMinuteSamples':sum(y<=x for x,y in zip(bytes_,bytes_[1:])),'exportOverlapSeconds':end-export,'rawGapCount':len(g),'rawGapsDuringExport':len(after),'rawGapsBeforeExport':len(before),'beforeExportSeconds':export-start,'beforeExportGapRatePerHour':len(before)/((export-start)/3600),'fullQuiet100':{'count':len(q),'ms':sum(v['durationMs'] for v in q)},'preExportQuiet100':{'count':len(qb),'ms':sum(v['durationMs'] for v in qb)},'exportQuiet100':{'count':len(qa),'ms':sum(v['durationMs'] for v in qa)},'interiorCrossCheck':{'rawTraceGaps':len(inside),'activeCounterGaps':cp['delta']['active_send_gaps_40ms'],'unscheduledStartGaps':unscheduled,'scheduledTraceMatchesCounter':len(inside)-len(unscheduled)==cp['delta']['active_send_gaps_40ms']}}
assert result['interiorCrossCheck']['scheduledTraceMatchesCounter']
(P/'qualification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
