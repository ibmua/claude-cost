import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('quota_history', Path(__file__).parents[1] / 'quota_history.py')
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


class QuotaTests(unittest.TestCase):
    def test_normalize_unknown_and_null_windows(self):
        self.assertEqual(q.window('x','X',None,None), None)
        self.assertEqual(q.window('x','X',float('nan'),None), None)
        self.assertEqual(q.claude_windows({'limits':[{'kind':'weekly_scoped','percent':21,'scope':{'model':{'display_name':'Fable'}}}]} )[0]['remaining'], 79)
        windows = q.codex_windows({'rate_limit': {'primary_window': {'used_percent':35,'limit_window_seconds':604800}}, 'additional_rate_limits':[{'limit_name':'reserve','rate_limit':{'primary_window':{'used_percent':3}}}]})
        self.assertEqual([w['remaining'] for w in windows], [65,97])

    def test_success_is_idempotent_and_errors_remain_missing(self):
        with tempfile.TemporaryDirectory() as temp:
            config={'history':temp+'/history.jsonl','machine':'fixture','sources':[{'id':'a','provider':'codex','auth':temp+'/auth.json'}]}
            with patch.object(q,'probe',return_value={'accountId':'acct','account':'fixture','windows':[q.window('weekly','Weekly',35,100)]}), redirect_stdout(io.StringIO()):
                q.snapshot(config)
                q.snapshot(config)
            self.assertEqual(len(q.read_history(config['history'])),1)
            config['sources'][0]['id']='b'
            with patch.object(q,'probe',side_effect=RuntimeError('secret must not be logged')), redirect_stdout(io.StringIO()):
                q.snapshot(config)
            rows=q.read_history(config['history'])
            self.assertEqual(rows[-1]['status'],'error')
            self.assertEqual(rows[-1]['windows'],[])
            self.assertNotIn('secret',json.dumps(rows))


if __name__ == '__main__':
    unittest.main()
