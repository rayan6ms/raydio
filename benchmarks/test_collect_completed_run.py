import datetime as dt
import unittest
from collect_completed_run import validate

class ExportGuard(unittest.TestCase):
    def setUp(self):
        self.m={'runId':'trial','oracleDirectory':'/var/lib/raydio/trial',
                'expectedEndUtc':'2026-09-23T06:00:00Z','sessionRequestedAt':'session'}
        self.s={'requestedAt':'session','status':'completed','finishedAt':'end',
                'segments':[{'requestedAt':'receiver'}]}
        self.r={'requestedAt':'receiver','status':'completed','finishedAt':'end'}
        self.now=dt.datetime(2026,9,23,6,1,tzinfo=dt.timezone.utc)
    def test_complete(self): validate(self.m,self.s,self.r,self.now)
    def test_early_even_when_report_claims_completed(self):
        with self.assertRaisesRegex(ValueError,'margin'):validate(self.m,self.s,self.r,self.now-dt.timedelta(seconds=1))
    def test_no_export_on_active_or_wrong_session(self):
        for s in [dict(self.s,status='recording'),dict(self.s,requestedAt='old')]:
            with self.assertRaises(ValueError):validate(self.m,s,self.r,self.now)
    def test_no_export_on_active_or_unarchived_receiver(self):
        for r in [dict(self.r,status='running'),dict(self.r,requestedAt='old'),dict(self.r,finishedAt=None)]:
            with self.assertRaises(ValueError):validate(self.m,self.s,r,self.now)
    def test_incomplete_run_can_be_preserved_after_end(self):
        validate(self.m,dict(self.s,status='completed-with-gaps'),dict(self.r,status='failed'),self.now)
    def test_reject_path_injection(self):
        for m in [dict(self.m,runId='../../other'),dict(self.m,oracleDirectory='/etc')]:
            with self.assertRaises(ValueError):validate(m,self.s,self.r,self.now)

if __name__=='__main__':unittest.main()
