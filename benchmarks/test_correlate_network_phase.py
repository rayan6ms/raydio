import unittest
from correlate_network_phase import parse, describe, correlate


class NetworkPhaseTests(unittest.TestCase):
    def test_reply_time_is_not_send_phase(self):
        rows = parse('[1790991672.030000] 64 bytes: icmp_seq=1 ttl=58 time=60.0 ms\n')
        self.assertAlmostEqual(rows[0]['sentAt'], 1790991671.97)
        self.assertEqual(int(rows[0]['sentAt'] % 15), 11)

    def test_missing_sequences_and_upper_bound(self):
        rows = parse('[10.0] 64 bytes: icmp_seq=1 time<1 ms\n[10.2] 64 bytes: icmp_seq=3 time=2 ms\nnoise')
        self.assertTrue(rows[0]['upperBound'])
        self.assertEqual(describe(rows)['missingSequenceNumbers'], 1)
        self.assertEqual(describe([])['samples'], 0)

    def test_only_same_window_samples_enter_incident(self):
        rx = dict(startedAt='1970-01-01T00:00:10Z', elapsedSeconds=10,
                  events=[dict(kind='receiver', ms=2000, windowMs=1000, concealedMs=20, discarded=1)])
        probes = {'wan':[dict(replyAt=11.6,sentAt=11.5,sequence=1,rttMs=100),
                         dict(replyAt=25,sentAt=24.9,sequence=2,rttMs=100)]}
        result = correlate(rx,probes)
        self.assertEqual(result['paths']['wan']['samples'],1)
        self.assertEqual(result['incidents'][0]['paths']['wan']['maximumMs'],100)
        self.assertEqual(len(result['utcModulo15']['wan']),15)


if __name__ == '__main__':
    unittest.main()
