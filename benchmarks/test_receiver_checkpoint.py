"""Persistence regression: receiver failure cannot stop independent host evidence."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from receiver_checkpoint import Collector, host_snapshot


class Checkpoints(unittest.TestCase):
    def test_browser_absent_failed_preflight_then_real_run(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            collector = Collector(root, sample=lambda: {'cpuTicks': [1, 2, 3]})
            collector.tick(100)
            collector.tick(159)
            collector.tick(160)  # browser absent, still samples
            self.assertEqual(collector.host_samples, 2)
            failed = dict(version=1, requestedSeconds=21600, status='failed', requestedAt='preflight')
            collector.save(failed, 100)
            collector.tick(220)
            running = dict(version=1, requestedSeconds=120, status='running', requestedAt='real', elapsedSeconds=60)
            with patch('receiver_checkpoint.os.fsync', side_effect=OSError('disk error')):
                with self.assertRaises(OSError):
                    collector.save(running, 150)
            self.assertEqual(json.loads((root / 'receiver.json').read_text()), failed)
            collector.tick(280)  # a failed write did not stop sampling
            collector.save(running, 150)
            self.assertEqual(collector.health()['lastReceiver']['requestedAt'], 'real')
            self.assertEqual(json.loads((root / 'receiver.json').read_text()), running)
            collector.tick(500)  # no catch-up storm after a delayed callback
            collector.tick(500)
            rows = [json.loads(line) for line in (root / 'receiver-host.jsonl').read_text().splitlines()]
            self.assertEqual(len(rows), 5)
            self.assertEqual(rows[-1]['lateMs'], 160000)
            self.assertEqual(collector.health()['hostSamples'], 5)

    def test_event_archive_deduplicates_and_detects_missing_history(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            collector = Collector(root)
            data = dict(version=1, requestedSeconds=21600, status='running', requestedAt='run',
                        events=[dict(sequence=i, kind='quiet', ms=i) for i in (1, 2)])
            collector.save(data, 100)
            collector.save(data, 100)
            data['events'] = [dict(sequence=i, kind='receiver', ms=i) for i in (2, 3, 5)]
            collector.save(data, 150)
            archived = [json.loads(line) for line in (root / 'receiver-events.jsonl').read_text().splitlines()]
            self.assertEqual([row['sequence'] for row in archived], [1, 2, 3, 5])
            self.assertEqual(collector.health()['archiveMissingEvents'], 1)
            collector.archive_limit_bytes = collector.archive_bytes
            data['events'] = [dict(sequence=6, kind='quiet', ms=6)]
            with self.assertRaises(ValueError): collector.save(data, 100)

    def test_bad_reports_do_not_replace_evidence(self):
        with TemporaryDirectory() as directory:
            collector = Collector(Path(directory))
            for data in [None, [], {'version': 1, 'requestedSeconds': True},
                         {'version': 1, 'requestedSeconds': 9},
                         {'version': 1, 'requestedSeconds': 21601}]:
                with self.assertRaises(ValueError):
                    collector.save(data, 20)
            self.assertIsNone(collector.last_receiver)

    def test_missing_host_fields_are_explicit(self):
        with TemporaryDirectory() as directory:
            sample = host_snapshot(Path(directory))
            self.assertEqual(len(sample['errors']), 7)
            self.assertNotIn('cpuTicks', sample)


if __name__ == '__main__':
    unittest.main()
