import copy
import unittest

from compare_delivery_trials import metrics


class DeliveryComparisonTests(unittest.TestCase):
    def setUp(self):
        self.receiver = {'status': 'completed', 'requestedSeconds': 600,
                         'codec': {'mimeType': 'audio/opus', 'clockRate': 48000, 'channels': 2}}
        self.summary = {
            'status': 'completed', 'receiverSeconds': 600,
            'coverage': dict(completePollCoverage=True, completePcmCoverage=True, uninterruptedConnection=True),
            'persistedEventHistoryComplete': True,
            'collectionCoverage': {name: {'complete': True} for name in ('senderHost', 'receiverHost', 'receiverCheckpoints')},
            'senderCoverage': {'from': '2026-09-11T00:00:30+00:00',
                               'to': '2026-09-11T00:09:30+00:00', 'maximumCheckpointGapSeconds': 60},
            'senderCheckpointDelta': dict(active_send_gaps_40ms=9, active_send_gaps_100ms=0,
                                          frames_unavailable=0, silence_frames_sent=0, send_failures=0),
            'packetsReceived': 29999, 'lostNet': 0, 'positiveLoss': 1, 'negativeLossDeltas': -1,
            'discarded': 2, 'nacks': 3, 'concealmentMs': 600, 'silentConcealmentMs': 0,
            'quietRequiringReviewAtLeast100Ms': [], 'pcm': dict(nearFullScale=0, nonFinite=0),
            'pssMiB': {'median': 16}, 'botCpuPercentOfOneCore': 4, 'hostStealPercent': .3,
            'evidenceWarnings': [],
        }

    def test_different_sender_and_receiver_windows_and_late_corrections(self):
        row = metrics(self.summary, self.receiver)
        self.assertEqual(row['senderGaps40msPerHour'], 60)
        self.assertEqual(row['concealmentMsPerMinute'], 60)
        self.assertEqual((row['netLost'], row['positiveLossDeltas'], row['negativeLossCorrections']), (0, 1, -1))

    def test_completed_status_does_not_override_missing_observations(self):
        for field in ('completePollCoverage', 'completePcmCoverage'):
            broken = copy.deepcopy(self.summary)
            broken['coverage'][field] = False
            with self.assertRaises(ValueError):
                metrics(broken, self.receiver)

    def test_fully_observed_connection_interruption_remains_an_outcome(self):
        interrupted = copy.deepcopy(self.summary)
        interrupted['coverage']['uninterruptedConnection'] = False
        interrupted['networkEvents'] = [{'kind': 'ice', 'state': 'disconnected', 'ms': 1000},
                                        {'kind': 'ice', 'state': 'connected', 'ms': 1035}]
        interrupted['lostNet'] = 12
        row = metrics(interrupted, self.receiver)
        self.assertFalse(row['uninterruptedConnection'])
        self.assertEqual(row['networkEvents'], interrupted['networkEvents'])
        self.assertEqual(row['netLost'], 12)

    def test_missing_diagnostics_or_event_history_cannot_qualify(self):
        for name in ('senderHost', 'receiverHost', 'receiverCheckpoints'):
            broken = copy.deepcopy(self.summary)
            del broken['collectionCoverage'][name]
            with self.assertRaisesRegex(ValueError, name):
                metrics(broken, self.receiver)
        for field in ('collectionCoverage', 'persistedEventHistoryComplete'):
            broken = copy.deepcopy(self.summary)
            del broken[field]
            with self.assertRaises(ValueError):
                metrics(broken, self.receiver)

    def test_short_duration_or_missing_sender_cannot_qualify(self):
        for key, value in [('receiverSeconds', 599 - 300), ('senderCheckpointDelta', None)]:
            broken = copy.deepcopy(self.summary)
            broken[key] = value
            with self.assertRaises(ValueError):
                metrics(broken, self.receiver)

    def test_complete_pcm_does_not_override_late_collector(self):
        broken = copy.deepcopy(self.summary)
        broken['collectionCoverage']['receiverHost']['complete'] = False
        with self.assertRaisesRegex(ValueError, 'receiverHost'):
            metrics(broken, self.receiver)


if __name__ == '__main__':
    unittest.main()
