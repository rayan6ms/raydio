"""Correlate bounded header-only sender traces with a saved receiver report.

Requires synchronized host UTC clocks. Wide event windows tolerate ordinary
clock/network delay; they locate send-side anomalies, not downstream causes.
"""
import argparse
import bisect
import csv
import datetime
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--trace', required=True, type=Path)
parser.add_argument('--clock', required=True, type=Path)
parser.add_argument('--receiver', required=True, type=Path)
parser.add_argument('--scheduler', type=Path,
                    help='Optional completed scheduler_probe CSV from the sender host')
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
clock = json.loads(args.clock.read_text())
receiver = json.loads(args.receiver.read_text())
start = datetime.datetime.fromisoformat(receiver['startedAt'].replace('Z', '+00:00')).timestamp()
offset = clock['realtime_ns'] - clock['monotonic_ns']
packets = []
with args.trace.open() as trace:
    for row in csv.reader(trace):
        if len(packets) >= 60000:
            raise SystemExit('Trace exceeds declared 60,000-record bound')
        if len(row) != 7:
            raise SystemExit('Malformed sender trace row')
        ns, duration, fd, sequence, timestamp, size, sent = map(int, row)
        packets.append(dict(ms=(ns + offset) / 1e6 - start * 1000,
                            durationMs=duration / 1e6, fd=fd, sequence=sequence,
                            timestamp=timestamp, bytes=size, sent=sent))
if not packets:
    raise SystemExit('No sender packets captured')
packets.sort(key=lambda p: p['ms'])
late_wakes = []
steal_samples = {}
scheduler = None
if args.scheduler:
    with args.scheduler.open() as probe:
        rows = list(csv.reader(probe))
    headers = [r for r in rows if r[0] == 'summary']
    timers = [r for r in rows if r[0] == 'timer']
    if len(headers) != 1 or len(timers) != 2:
        raise SystemExit('Scheduler probe incomplete: expected summary and two timers')
    if any(int(r[4]) or int(r[5]) for r in timers):
        raise SystemExit('Scheduler probe had truncation or timer errors')
    _, begin, end, cpu_ns = headers[0]
    scheduler = dict(cpuSeconds=int(cpu_ns) / 1e9,
                     cpuPercentOneCore=100 * int(cpu_ns) / (int(end) - int(begin)),
                     timers=timers,
                     fromMs=(int(begin) + offset) / 1e6 - start * 1000,
                     toMs=(int(end) + offset) / 1e6 - start * 1000)
    for row in rows:
        if row[0] == 'late':
            _, cpu, at, late = row
            at_ms = (int(at) + offset) / 1e6 - start * 1000
            late_wakes.append(dict(cpu=int(cpu), atMs=at_ms,
                                   deadlineMs=at_ms - int(late) / 1e6,
                                   lateMs=int(late) / 1e6))
        elif row[0] == 'steal':
            _, cpu, at, ticks = row
            steal_samples.setdefault(int(cpu), []).append(
                ((int(at) + offset) / 1e6 - start * 1000, int(ticks)))


def scheduler_window(begin, end):
    return dict(lateWakes=[w for w in late_wakes if w['atMs'] >= begin and w['deadlineMs'] <= end],
                stealTickWindows=[dict(cpu=cpu, fromMs=a[0], toMs=b[0], ticks=b[1] - a[1])
                                  for cpu, samples in steal_samples.items()
                                  for a, b in zip(samples, samples[1:])
                                  if a[0] <= end and b[0] >= begin and b[1] > a[1]])


def summarize(begin, end):
    window = [p for p in packets if begin <= p['ms'] <= end]
    # Include the packet before the window so a gap crossing its left edge
    # cannot disappear. No post-window administrative packets are included.
    prior = next((p for p in reversed(packets) if p['ms'] < begin), None)
    gaps = []
    sequence_gaps = timestamp_gaps = 0
    for p in window:
        if prior is not None and p['fd'] == prior['fd']:
            gap = p['ms'] - prior['ms']
            gaps.append(dict(endMs=p['ms'], gapMs=gap))
            sequence_gaps += (p['sequence'] - prior['sequence']) % 65536 != 1
            timestamp_gaps += (p['timestamp'] - prior['timestamp']) % (2**32) != 960
        prior = p
    span = window[-1]['ms'] - window[0]['ms'] if len(window) > 1 else None
    return dict(fromMs=begin, toMs=end, packets=len(window),
                sendSpanMs=span,
                excessWallTimeVs20MsFrames=span - (len(window) - 1) * 20 if span is not None else None,
                firstPacketMs=window[0]['ms'] if window else None,
                lastPacketMs=window[-1]['ms'] if window else None,
                maxGapMs=max((g['gapMs'] for g in gaps), default=None),
                gapsAbove40Ms=sum(g['gapMs'] > 40 for g in gaps),
                maxSendCallMs=max((p['durationMs'] for p in window), default=None),
                sendFailures=sum(p['sent'] != p['bytes'] for p in window),
                sequenceDiscontinuities=sequence_gaps,
                timestampDiscontinuities=timestamp_gaps,
                largestGaps=[dict(g, **({'scheduler': scheduler_window(g['endMs'] - g['gapMs'], g['endMs'])}
                                       if scheduler else {}))
                             for g in sorted(gaps, key=lambda g: g['gapMs'], reverse=True)[:10]])


events = [e for e in receiver['events'] if
          (e['kind'] == 'quiet' and e['phase']['label'] != 'tail') or
          (e['kind'] == 'speaking' and not e['speaking'] and e['phase']['label'] != 'tail') or
          (e['kind'] == 'receiver' and
           (e.get('concealedMs', 0) > 0 or e.get('lost', 0) > 0 or
            e.get('discarded', 0) > 0 or e.get('nacks', 0) > 0))]
result = dict(scope='Header-only diagnostic correlation; not receiver qualification',
              clock=clock, tracePackets=len(packets),
              receiverStatus=receiver['status'],
              receiverSeconds=receiver['elapsedSeconds'],
              scheduler=scheduler,
              aligned=summarize(0, receiver['elapsedSeconds'] * 1000),
              events=[dict(receiver=e, sender=summarize(
                  e['ms'] - max(e.get('durationMs', 0), e.get('windowMs', 0)) - 2000,
                  e['ms'] + 2000)) for e in events],
              limitations=[
                  'Clock mapping assumes host clocks are UTC-synchronized; sample uncertainty is not inter-host clock accuracy.',
                  'Send completion does not establish NIC transmission, Discord forwarding, or receiver arrival.',
                  'The interposer adds syscall and file-write overhead; a clean trace is not a production quality pass.',
                  'Send-call duration includes the interposer socket-type check before its final timestamp.',
                  'Excess wall time is descriptive and assumes one continuous 20 ms RTP stream; inspect sequence and timestamp continuity first.',
                  'Independent low-priority timers can themselves be delayed by guest scheduling. Correlated steal samples strengthen host attribution but have one-second resolution.',
                  'Events use receiver callback times; PCM timing and network playout add delay.',
                  'No packet payload, key, source URL, or audio is captured.'])
if scheduler:
    # Same-host timestamps need no inter-host alignment to compare wake and
    # send times. A low-priority probe may wake after the bot; retain the prior
    # send as well so next-send delay alone cannot imply added bot latency.
    packet_times = [p['ms'] for p in packets]
    recovery = []
    for wake in late_wakes:
        if not (0 <= wake['atMs'] <= receiver['elapsedSeconds'] * 1000) or wake['lateMs'] < 20:
            continue
        i = bisect.bisect_left(packet_times, wake['atMs'])
        if i == 0 or i == len(packets):
            continue
        before, after = packets[i - 1], packets[i]
        recovery.append(dict(wake=wake, priorSendMs=before['ms'], nextSendMs=after['ms'],
                             nextSendAfterProbeMs=after['ms'] - wake['atMs'],
                             priorSendBeforeProbeMs=wake['atMs'] - before['ms'],
                             sendGapMs=after['ms'] - before['ms']))
    result['probeRecovery'] = recovery
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k: result[k] for k in ('receiverStatus', 'receiverSeconds', 'tracePackets', 'aligned')}))
print(json.dumps(dict(correlatedEvents=len(events))))
