"""Regression: a restart-aligned silence must not hide an extended stall."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class SummaryTests(unittest.TestCase):
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
            }
            (root / 'receiver.json').write_text(json.dumps(receiver))
            (root / 'service.log').write_text(''.join(
                f'2026-09-09T00:00:{second:02d}Z INFO track started generation=1\n'
                for second in (20, 30, 40)))
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


if __name__ == '__main__':
    unittest.main()
