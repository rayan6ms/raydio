import copy
import unittest
from correlate_rtp_headers import correlate


class HeaderCorrelationTests(unittest.TestCase):
    def setUp(self):
        self.sender=[dict(unixMicros=980000+i*20000,ssrc=7,sequence=i,timestamp=i*960) for i in range(8)]
        self.receiver=copy.deepcopy(self.sender)
        for row in self.receiver:row['unixMicros']+=1000
        self.receiver[3]['unixMicros']+=19000
        self.report=dict(startedAt='1970-01-01T00:00:01Z',elapsedSeconds=.1,status='completed',
                         coverage=dict(completePollCoverage=True,uninterruptedConnection=True),
                         events=[dict(kind='receiver',ms=100,windowMs=100,concealedMs=10)])
        self.summary=dict(records=8,error=None,incompleteRecordBytes=0,rejected=0,
                          captureDiagnostics='0 packets dropped by kernel')

    def run_case(self,summary=None):
        return correlate(self.sender,self.receiver,self.report,self.summary,summary or self.summary)

    def test_matches_and_excess_ignore_constant_clock_offset(self):
        result=self.run_case()
        self.assertTrue(result['valid']);self.assertEqual(result['matchedReceiverPackets'],5)
        self.assertEqual(result['transitExcessOverObservedMinimumMs']['maximum'],19)
        self.assertEqual(result['incidents'][0]['sender']['maximumGapMs'],20)
        self.assertEqual(result['incidents'][0]['arrival']['maximumGapMs'],39)
        for row in self.sender:row['unixMicros']-=10000
        self.assertEqual(self.run_case()['transitExcessOverObservedMinimumMs']['maximum'],19)

    def test_invalid_empty_dropped_or_truncated_capture(self):
        for changes in [dict(records=0),dict(incompleteRecordBytes=3),dict(captureDiagnostics='1 packets dropped by kernel')]:
            summary={**self.summary,**changes};self.assertFalse(self.run_case(summary)['valid'])

    def test_identity_and_missing_packets_remain_visible(self):
        self.receiver[3]['ssrc']=8
        result=self.run_case();self.assertEqual(result['unmatchedReceiverPackets'],1)

    def test_clock_reversal_rejected(self):
        self.receiver[3]['unixMicros']=0
        with self.assertRaises(ValueError):self.run_case()

    def test_partial_header_export_cannot_qualify(self):
        self.receiver.pop()
        result=self.run_case()
        self.assertFalse(result['recordCountsMatch'])
        self.assertFalse(result['valid'])


if __name__=='__main__':unittest.main()
