import unittest

from collection_coverage import collection_coverage


class CollectionCoverageTests(unittest.TestCase):
    def coverage(self, times, **options):
        return collection_coverage([dict(t=t) for t in times], 0, 300,
                                   timestamp=lambda row: row['t'], **options)

    def test_complete_with_minute_endpoint_slack(self):
        result = self.coverage([-10, 50, 110, 170, 230, 290, 350])
        self.assertTrue(result['complete'])
        self.assertEqual(result['inWindowSamples'], 5)
        self.assertEqual(result['headSeconds'], 50)
        self.assertEqual(result['tailSeconds'], 10)

    def test_final_report_saved_after_run_is_not_continuous_collection(self):
        result = self.coverage([410, 470, 530])
        self.assertFalse(result['complete'])
        self.assertEqual(result['inWindowSamples'], 0)
        self.assertIsNone(result['maximumGapSeconds'])

    def test_internal_gap_late_start_early_end_and_clock_regression(self):
        for times in ([10, 70, 250, 290], [120, 180, 240, 300],
                      [0, 60, 120], [0, 60, 120, 100, 180, 240, 300]):
            with self.subTest(times=times):
                self.assertFalse(self.coverage(times)['complete'])

    def test_invalid_timestamps_and_in_window_errors_fail(self):
        self.assertFalse(self.coverage([0, 60, float('nan'), 120, 180, 240, 300])['complete'])
        self.assertFalse(self.coverage([0, 60, 120, 180, 240, 300],
                                      error=lambda row: row['t'] == 120)['complete'])


if __name__ == '__main__':
    unittest.main()
