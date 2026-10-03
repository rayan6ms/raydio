import copy
import unittest
from compare_buffer_trials import compare


class BufferComparisonTests(unittest.TestCase):
    def setUp(self):
        self.report = dict(status='completed', requestedSeconds=300, elapsedSeconds=300,
                           receiverBufferTrial=dict(requestedAt='trial', index=0, targetMs=None, actualSettingMs=None),
                           codec=dict(clockRate=48000), receiverIdentity=dict(id='rtp', ssrc=7, trackIdentifier='track'),
                           coverage={k: True for k in ('completePollCoverage', 'completePcmCoverage',
                                                      'completeEventHistory', 'uninterruptedConnection')},
                           delta=dict(packetsReceived=15000, packetsLost=0, packetsDiscarded=1,
                                      concealedSamples=4800, silentConcealedSamples=0,
                                      jitterBufferDelay=1440000, jitterBufferEmittedCount=14400000),
                           events=[dict(kind='quiet', durationMs=2000, phase=dict(label='tail'))])

    def test_rates_delay_and_quiet_classification_are_separate(self):
        result = compare([self.report])
        self.assertTrue(result['allValid'])
        self.assertEqual(result['groups']['default']['concealmentMsPerMinute'], 20)
        self.assertEqual(result['groups']['default']['meanBufferMs'], 100)
        self.assertEqual(len(result['windows'][0]['quietIntervals']), 1)

    def test_missing_counters_setting_or_coverage_cannot_qualify(self):
        for field in ('packetsDiscarded', 'concealedSamples', 'jitterBufferDelay'):
            report = copy.deepcopy(self.report)
            del report['delta'][field]
            self.assertFalse(compare([report])['allValid'])
        report = copy.deepcopy(self.report)
        del report['receiverBufferTrial']['actualSettingMs']
        self.assertFalse(compare([report])['allValid'])
        for field in self.report['coverage']:
            report = copy.deepcopy(self.report)
            report['coverage'][field] = False
            self.assertFalse(compare([report])['allValid'])

    def test_invalid_windows_are_retained_but_not_aggregated(self):
        report = copy.deepcopy(self.report)
        report['status'] = 'failed'
        result = compare([report])
        self.assertEqual(len(result['windows']), 1)
        self.assertEqual(result['groups']['default']['validWindows'], 0)
        self.assertIsNone(result['groups']['default']['concealmentMsPerMinute'])

    def test_receiver_changes_and_empty_input_are_not_matched(self):
        report = copy.deepcopy(self.report)
        report['receiverBufferTrial']['index'] = 1
        report['receiverIdentity']['ssrc'] = 8
        self.assertFalse(compare([self.report, report])['allValid'])
        self.assertFalse(compare([])['allValid'])


if __name__ == '__main__':
    unittest.main()
