import unittest
from quiet_classification import classify_quiet


class QuietTests(unittest.TestCase):
    def test_boundary_never_hides_stall_or_transport_anomaly(self):
        base = {'startedAt': '2026-09-10T00:00:00Z', 'events': [
            {'kind': 'quiet', 'ms': 20250, 'audioEndMs': 20000, 'durationMs': 976}]}
        log = ('2026-09-10T00:00:19.999Z track finished generation=1\n'
               '2026-09-10T00:00:20Z track started generation=2\n')
        def label(): return classify_quiet(base, log, 938)[0]
        self.assertEqual(label()['classification'], 'source-tail-candidate')
        self.assertEqual(label()['endMs'], 20000)
        base['events'].append({'kind': 'receiver', 'ms': 20000, 'windowMs': 1000, 'concealedMs': 20})
        self.assertEqual(label()['classification'], 'boundary-quiet-with-overlapping-anomaly')
        base['events'][0]['durationMs'] = 15000
        self.assertEqual(label()['classification'], 'extended-boundary-quiet')
        self.assertGreater(label()['excessOverReferenceAndToleranceMs'], 13000)
        self.assertFalse(label()['causeProven'])

    def test_stale_finish_does_not_match_multiple_later_starts(self):
        report = {'startedAt': '2026-09-10T00:00:00Z', 'events': [
            {'kind': 'quiet', 'ms': 40000, 'durationMs': 900}]}
        log = ('2026-09-10T00:00:19.999Z track finished generation=1\n'
               '2026-09-10T00:00:20Z track started generation=2\n'
               '2026-09-10T00:00:40Z track started generation=3\n')
        self.assertEqual(classify_quiet(report, log, 938)[0]['classification'], 'off-boundary-quiet')

    def test_manual_restart_and_unpaired_start_are_not_natural_tails(self):
        report = {'startedAt': '2026-09-10T00:00:00Z', 'events': [
            {'kind': 'quiet', 'ms': 20000, 'durationMs': 900}]}
        self.assertEqual(classify_quiet(report, '2026-09-10T00:00:20Z track started generation=1', 938)[0]['classification'], 'off-boundary-quiet')


if __name__ == '__main__': unittest.main()
