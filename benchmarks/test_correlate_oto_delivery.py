import unittest
from correlate_oto_delivery import correlate


class Correlation(unittest.TestCase):
    def fixture(self, missing=False):
        epoch=1_700_000_000_000_000
        rows=[(i if not missing or i<50 else i+1, i*20000, 1, 1, 123, i*960, i, False,
               (1, 0, 2, 4, 2, 1, 2, 1)) for i in range(1,151)]
        log=f'RTP send trace: epoch_us={epoch} dropped=0 records={rows}'
        receiver={'startedAt':'2023-11-14T22:13:20.600Z','status':'completed','elapsedSeconds':2,
            'events':[{'kind':'receiver','ms':1000,'windowMs':1000,'concealedMs':50}]}
        resources=[{'utc':f'2023-11-14T22:13:2{i}Z','cpuTicks':[100,0,0,100,0,0,0,i],
            'cgroupCpu':{'usage_usec':i*1000,'throttled_usec':i*100}} for i in range(4)]
        return log,receiver,resources

    def test_full_trace_does_not_turn_concealment_into_a_sender_gap(self):
        result=correlate(*self.fixture())
        self.assertTrue(result['aligned']['senderCoverage'])
        self.assertFalse(result['aligned']['gapsAtLeast40Ms'])
        self.assertIn('downstream/client',result['incidents'][0]['interpretation'])
        self.assertTrue(result['incidents'][0]['senderAndHost']['hostDeltas'])

    def test_missing_trace_cannot_exclude_sender_gaps(self):
        result=correlate(*self.fixture(True))
        self.assertIn('incomplete',result['incidents'][0]['interpretation'])
        self.assertGreater(result['incidents'][0]['senderAndHost']['missingTraceRecords'],0)

    def test_real_send_gap_keeps_its_stage_and_host_context(self):
        log,receiver,resources=self.fixture()
        import ast
        prefix, encoded = log.split(' records=')
        rows = ast.literal_eval(encoded)
        rows = [row[:1] + (row[1] + (50000 if row[0] >= 50 else 0),) + row[2:]
                for row in rows]
        log = prefix + ' records=' + repr(rows)
        result=correlate(log,receiver,resources)
        gap=result['incidents'][0]['senderAndHost']['gapsAtLeast40Ms'][0]
        self.assertEqual(gap['gapMs'],70)
        self.assertEqual(gap['timingMicros'][0],1)

    def test_missing_final_trace_cannot_exclude_sender_gaps(self):
        log, receiver, resources = self.fixture()
        receiver['elapsedSeconds'] = 5
        receiver['events'][0]['ms'] = 4500
        result = correlate(log, receiver, resources)
        self.assertFalse(result['aligned']['senderCoverage'])
        self.assertIn('incomplete', result['incidents'][0]['interpretation'])

    def test_small_concealment_is_retained_for_timing_diagnosis(self):
        log, receiver, resources = self.fixture()
        receiver['events'][0]['concealedMs'] = 1.5
        result = correlate(log, receiver, resources)
        self.assertEqual(len(result['incidents']), 1)
        self.assertEqual(result['incidents'][0]['receiver']['concealedMs'], 1.5)

    def test_conflicting_trace_does_not_exclude_sender_gaps(self):
        log, receiver, resources = self.fixture()
        log += '\n' + log.replace('(50, 1000000,', '(50, 1050000,')
        result = correlate(log, receiver, resources)
        self.assertIn('incomplete', result['incidents'][0]['interpretation'])


if __name__=='__main__':
    unittest.main()
