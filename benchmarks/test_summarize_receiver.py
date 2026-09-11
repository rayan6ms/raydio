"""Regression: a restart-aligned silence must not hide an extended stall."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class SummaryTests(unittest.TestCase):
    def test_sender_failure_after_receiver_disconnect_remains_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            receiver=dict(status='failed',requestedAt='r',startedAt='2026-09-09T00:00:00Z',
                requestedSeconds=21600,elapsedSeconds=120,finishedAt='2026-09-09T00:02:01Z',
                error='receiver disconnected',coverage={},pcm={},receiverScheduling={},events=[],
                sampling=dict(positiveLossDeltas=0,negativeLossDeltas=0),
                delta=dict(packetsReceived=6000,packetsLost=0,packetsDiscarded=0,nackCount=0,
                           concealedSamples=0,silentConcealedSamples=0))
            (root/'receiver.json').write_text(json.dumps(receiver))
            (root/'service.log').write_text(
                '2026-09-09T00:02:40Z connection_generation=1 opcode=24 '
                'before=DaveContext { active_version: 1, transition_pending: false, ready: true } '
                'after=DaveContext { active_version: 0, transition_pending: false, ready: false } '
                'DAVE lifecycle transition\n'
                '2026-09-09T00:02:42Z audio sender stopped after a terminal failure '
                'failure=Some(DaveTransition) dave_failure=Some(InvalidState) '
                'dave_context=Some(DaveContext { active_version: 0, transition_pending: false, ready: false }) '
                'frames_sent=8000 frames_unavailable=0 send_failures=0 skipped_deadlines=3\n'
                '2026-09-09T00:02:43Z voice closed; cleaning up playback code=0 generation=4 position_ms=500\n'
                '2026-09-09T06:02:00Z audio sender stopped after a terminal failure failure=Some(SendIo)\n')
            (root/'resources.jsonl').write_text('\n'.join(json.dumps(dict(utc=time,pssKiB=pss))
                for time,pss in [('2026-09-09T00:01:00Z',16384),('2026-09-09T06:00:00Z',8192)]))
            subprocess.run([sys.executable,str(Path(__file__).with_name('summarize_receiver.py')),
                '--input',str(root),'--output',str(root/'summary.json'),'--source-tail-ms','938'],
                check=True,capture_output=True)
            summary=json.loads((root/'summary.json').read_text())
            events=summary['senderEventsThroughPlannedEnd']
            self.assertEqual(len(events),3)
            self.assertTrue(all(e['afterReceiverEnd'] for e in events))
            self.assertEqual(events[0]['opcode'],24)
            self.assertTrue(events[0]['before']['ready'])
            self.assertFalse(events[0]['after']['ready'])
            self.assertEqual(events[1]['dave_failure'],'InvalidState')
            self.assertEqual(events[1]['frames_sent'],8000)
            self.assertFalse(events[1]['ready'])
            self.assertEqual(summary['receiverError'],'receiver disconnected')
            self.assertEqual(summary['unobservedRequestedSeconds'],21480)
            self.assertEqual(summary['hostCollectionCoverage']['samples'],2)
            self.assertEqual(summary['pssMiB']['median'],16) # Exclude post-failure idle memory.
            self.assertTrue(any('terminal sender failure' in w for w in summary['evidenceWarnings']))

    def test_counter_reset_is_not_reported_as_negative_error_count(self):
        # Exercise the real command with complete data, then a reset in every sender field.
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            receiver=dict(status='completed', requestedAt='r', startedAt='2026-09-09T00:00:00Z', elapsedSeconds=180,
                          coverage={},pcm={},receiverScheduling={},events=[],sampling={'positiveLossDeltas':0,'negativeLossDeltas':0},
                          delta=dict(packetsReceived=9000,packetsLost=0,packetsDiscarded=0,nackCount=0,concealedSamples=0,silentConcealedSamples=0))
            (root/'receiver.json').write_text(json.dumps(receiver))
            keys=('frames_sent','silence_frames_sent','frames_unavailable','skipped_deadlines','send_failures','source_overruns')
            (root/'service.log').write_text('\n'.join(f'2026-09-09T00:0{i}:00Z voice diagnostic checkpoint '+', '.join(f'{k}: {n}' for k in keys) for i,n in [(1,100),(2,0)]))
            (root/'resources.jsonl').write_text('')
            subprocess.run([sys.executable,str(Path(__file__).with_name('summarize_receiver.py')),'--input',str(root),'--output',str(root/'summary.json'),'--source-tail-ms','938'],check=True,capture_output=True)
            summary=json.loads((root/'summary.json').read_text())
            self.assertIsNone(summary['senderCheckpointDelta'])
            self.assertTrue(any('reset' in warning for warning in summary['evidenceWarnings']))

    def test_boundary_duration_and_run_specific_checkpoints(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receiver = {
                'status': 'completed', 'requestedAt': 'current-run',
                'startedAt': '2026-09-09T00:00:00Z', 'elapsedSeconds': 60,
                'coverage': {}, 'pcm': {}, 'receiverScheduling': {},
                'sampling': {'positiveLossDeltas': 2, 'negativeLossDeltas': -3},
                'delta': {'packetsReceived': 3000, 'packetsLost': -1,
                          'packetsDiscarded': 0, 'nackCount': 0,
                          'concealedSamples': 0, 'silentConcealedSamples': 0},
                'events': [{'kind': 'quiet', 'ms': ms, 'durationMs': duration}
                           for ms, duration in [(20000, 15623.75), (30000, 976.25),
                                                (40000, 1136.25), (45000, 330.0)]],
                'diagnosticWindowsCreated': 2, 'diagnosticWindowsDropped': 1,
                'diagnosticWindows': [dict(id=2, remaining=0, samples=[[2000]])],
            }
            (root / 'receiver-windows.jsonl').write_text('\n'.join(json.dumps(row) for row in [
                dict(requestedAt='current-run',revision=1,window=dict(id=1,remaining=5,samples=[[0]])),
                dict(requestedAt='current-run',revision=2,window=dict(id=1,remaining=0,samples=[[0],[1000]])),
                dict(requestedAt='other-run',revision=9,window=dict(id=1,remaining=0,samples=[])),
            ]))
            (root / 'receiver.json').write_text(json.dumps(receiver))
            (root / 'service.log').write_text(''.join(
                f'2026-09-09T00:00:{second-1:02d}.999Z INFO track finished generation={generation}\n'
                f'2026-09-09T00:00:{second:02d}Z INFO track started generation={generation+1}\n'
                for generation, second in enumerate((20, 30, 40), 1)))
            (root / 'resources.jsonl').write_text('')
            (root / 'checkpoints.jsonl').write_text('\n'.join(
                json.dumps({'requestedAt': run}) for run in
                ('previous-run', 'current-run', 'current-run')))
            subprocess.run([sys.executable, str(Path(__file__).with_name('summarize_receiver.py')),
                            '--input', str(root), '--output', str(root / 'summary.json'),
                            '--source-tail-ms', '938.458'], check=True, capture_output=True)
            summary = json.loads((root / 'summary.json').read_text())
            self.assertEqual([q['durationMs'] for q in summary['quietRequiringReviewAtLeast100Ms']],
                             [15623.75, 1136.25, 330.0])
            self.assertEqual(len(summary['quietIntervals']), 4)
            self.assertEqual(summary['checkpointSavesForThisRun'], 2)
            self.assertEqual(summary['checkpointSavesInCollectedFile'], 3)
            self.assertEqual(summary['negativeLossDeltas'], -3)
            self.assertNotIn('recoveredLoss', summary)
            self.assertTrue(summary['incidentWindows']['completePersistedHistory'])
            self.assertEqual(summary['diagnosticWindows'][0]['samples'], [[0], [1000]])
            self.assertFalse(any('windows overwritten' in w for w in summary['evidenceWarnings']))


if __name__ == '__main__':
    unittest.main()
