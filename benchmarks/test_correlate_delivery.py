"""Regression checks for diagnostic attribution, not audio quality tests."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class DeliveryCorrelation(unittest.TestCase):
    def run_probe(self, directory, truncated=0):
        root = Path(directory)
        (root / 'clock.json').write_text(json.dumps({'realtime_ns': 0, 'monotonic_ns': 0}))
        (root / 'receiver.json').write_text(json.dumps({
            'startedAt': '1970-01-01T00:00:01Z', 'status': 'completed',
            'elapsedSeconds': .1,
            'events': [{'kind': 'speaking', 'speaking': False, 'ms': 50,
                        'phase': {'label': 'middle'}}]}))
        # First gap crosses the measurement boundary. Both counters wrap
        # correctly, then skip once. The last packet is outside observation.
        packets = [(980, 65535, 2**32 - 960, 100), (1030, 0, 0, 100),
                   (1050, 1, 960, -1), (1070, 3, 2880, 100),
                   (4000, 4, 3840, 100)]
        (root / 'trace.csv').write_text(''.join(
            f'{ms * 1000000},100,5,{seq},{ts},100,{sent}\n'
            for ms, seq, ts, sent in packets))
        (root / 'scheduler.csv').write_text(
            'summary,900000000,1200000000,100000\n'
            f'timer,0,10,60000000,{truncated},0\n'
            'timer,1,10,15000000,0,0\n'
            'late,0,1020000000,60000000\n'
            'late,1,1060000000,15000000\n'
            'steal,0,900000000,10\nsteal,0,1100000000,11\n'
            'steal,1,900000000,10\nsteal,1,1100000000,10\n')
        result = subprocess.run([
            sys.executable, str(Path(__file__).with_name('correlate_delivery.py')),
            '--trace', str(root / 'trace.csv'), '--clock', str(root / 'clock.json'),
            '--receiver', str(root / 'receiver.json'),
            '--scheduler', str(root / 'scheduler.csv'),
            '--output', str(root / 'out.json')], capture_output=True, text=True)
        return result, root / 'out.json'

    def test_wrap_boundary_shutdown_and_independent_timer_overlap(self):
        with tempfile.TemporaryDirectory() as directory:
            result, output = self.run_probe(directory)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(output.read_text())
        aligned = report['aligned']
        self.assertEqual(aligned['packets'], 3)
        self.assertEqual(aligned['maxGapMs'], 50)
        self.assertEqual(aligned['sendFailures'], 1)
        self.assertEqual(aligned['sequenceDiscontinuities'], 1)
        self.assertEqual(aligned['timestampDiscontinuities'], 1)
        largest = aligned['largestGaps'][0]['scheduler']
        self.assertEqual([w['cpu'] for w in largest['lateWakes']], [0])
        self.assertEqual(largest['stealTickWindows'][0]['ticks'], 1)
        self.assertEqual(report['events'][0]['receiver']['kind'], 'speaking')
        self.assertLess(report['events'][0]['sender']['lastPacketMs'], 3000)

    def test_truncated_probe_cannot_be_treated_as_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            result, output = self.run_probe(directory, truncated=1)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('truncation', result.stderr)
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
