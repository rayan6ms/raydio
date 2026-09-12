import unittest
from summarize_send_trace import summarize


class TraceTests(unittest.TestCase):
    def test_wraparound_missing_diagnostics_and_transport_reset(self):
        records = [(1, 0, 1, 1, 7, 2**32-960, 65535, False),
                   (2, 20000, 1, 1, 7, 0, 0, False),
                   (4, 60000, 1, 1, 7, 1920, 2, False),
                   (5, 120000, 1, 2, 7, 2880, 3, True),
                   (6, 140000, 2, 2, 8, 0, 99, False)]
        line = 'RTP send trace: epoch_us=1000000 dropped=1 records=' + repr(records).replace('False', 'false').replace('True', 'true')
        result = summarize([line, line])  # repeated journal export is deduplicated
        stream = result['streams'][0]
        self.assertEqual(stream['records'], 5)
        self.assertEqual(stream['missingRecords'], 1)
        self.assertEqual(stream['sequenceJumps'], 0)
        self.assertEqual(stream['timestampJumps'], 0)
        self.assertEqual(stream['gapsAtLeast40Ms'], [dict(unixMicros=1120000, gapMicros=60000,
            beforeIndex=4, afterIndex=5, sourceChanged=True, includesSilencePacket=True, timingMicros=None)])

    def test_stage_timings_preserve_legacy_records_and_reject_invalid_schema(self):
        line = 'RTP send trace: epoch_us=1 dropped=0 records='
        rows = [(1, 0, 1, 1, 7, 960, 1, False),
                (2, 60000, 1, 1, 7, 1920, 2, False, [1, 40000, 2, 120, 10, 8, 3, 7]),
                (3, 80000, 1, 1, 7, 2880, 3, False, [0, 0, 0, 9999, 0, 0, 0, 0])]
        stream = summarize([line + repr(rows)])['streams'][0]
        self.assertEqual(stream['gapsAtLeast40Ms'][0]['timingMicros'], rows[1][8])
        self.assertEqual(stream['stageTimingMicros']['daveRoundTrip'],
                         dict(count=1, max=120, p50=120, p99=120))
        for timing in ([1], [2] + [0]*7, [1, -1] + [0]*6, [True] + [0]*7):
            bad = [(*rows[1][:8], timing)]
            self.assertEqual(summarize([line + repr(bad)])['malformedBatches'], 1)

    def test_malformed_and_conflicting_batches_are_visible(self):
        result = summarize(['RTP send trace: malformed',
            'RTP send trace: epoch_us=1 dropped=0 records=[(1,0,1,1,7,960,1,false)]',
            'RTP send trace: epoch_us=1 dropped=0 records=[(1,0,1,1,7,960,2,false)]'])
        self.assertEqual(result['malformedBatches'], 1)
        self.assertEqual(result['streams'][0]['conflictingRecords'], 1)


if __name__ == '__main__':
    unittest.main()
