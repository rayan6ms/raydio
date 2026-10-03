import copy
import unittest
from compare_observers import compare


class ObserverComparisonTests(unittest.TestCase):
    def setUp(self):
        self.row = dict(observer='pcm', status='completed', requestedSeconds=180, elapsedSeconds=180,
                        observerTrial=dict(requestedAt='trial', index=0), receiverIdentity=dict(id='rtp', ssrc=1),
                        coverage=dict(uninterruptedConnection=True, completePollCoverage=True, completePcmCoverage=True),
                        delta=dict(packetsReceived=9000, packetsLost=-1, packetsDiscarded=2, concealedSamples=4800))

    def test_rates_and_signed_corrections(self):
        result = compare([self.row])
        self.assertTrue(result['allValid'])
        self.assertEqual(result['groups']['pcm']['concealmentMsPerMinute'], 100/3)
        self.assertEqual(result['groups']['pcm']['netLost'], -1)

    def test_endpoint_has_no_pcm_claim(self):
        row = copy.deepcopy(self.row)
        row.update(observer='endpoint', uninterruptedConnection=True)
        del row['coverage']
        result = compare([row])
        self.assertTrue(result['allValid'])
        self.assertIsNone(result['windows'][0]['pcmCoverage'])

    def test_failure_and_missing_coverage_remain_visible(self):
        for key in ('uninterruptedConnection', 'completePollCoverage', 'completePcmCoverage'):
            row = copy.deepcopy(self.row)
            row['coverage'][key] = False
            result = compare([row])
            self.assertFalse(result['allValid'])
            self.assertEqual(len(result['windows']), 1)
            self.assertEqual(result['groups']['pcm']['validWindows'], 0)

    def test_identity_change_is_not_matched_receiver(self):
        other = copy.deepcopy(self.row)
        other['observerTrial']['index'] = 1
        other['receiverIdentity']['ssrc'] = 2
        self.assertFalse(compare([self.row, other])['sameReceiver'])

    def test_missing_optional_counter_is_unknown(self):
        row=copy.deepcopy(self.row)
        del row['delta']['packetsDiscarded']
        self.assertIsNone(compare([row])['groups']['pcm']['discarded'])


if __name__ == '__main__':
    unittest.main()
