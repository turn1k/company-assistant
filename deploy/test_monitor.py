import importlib.util
from pathlib import Path
import unittest
import tempfile, json, contextlib, io
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('monitor',Path(__file__).with_name('monitor.py'))
monitor=importlib.util.module_from_spec(spec);spec.loader.exec_module(monitor)
class MonitorTest(unittest.TestCase):
    def test_transient_failure_does_not_alert_and_recovery_clears(self):
        counts,active=monitor.advance({}, {'app':False,'https':True})
        self.assertEqual(active,[])
        counts,active=monitor.advance({'counts':counts,'active':active},{'app':False,'https':True})
        self.assertEqual(active,['app'])
        counts,active=monitor.advance({'counts':counts,'active':active},{'app':True,'https':True})
        self.assertEqual(active,[]);self.assertEqual(counts['app'],0)
    def test_single_failure_between_successes_is_ignored(self):
        counts,active=monitor.advance({'counts':{'https':1}}, {'https':True})
        self.assertEqual(monitor.advance({'counts':counts}, {'https':False})[1],[])
    def test_delivery_retries_and_deduplicates_then_sends_recovery(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(monitor,'ROOT',Path(tmp)), patch.object(monitor,'checks',return_value={'https':False}) as check, patch.object(monitor,'telegram',side_effect=[False,True,True]) as send, contextlib.redirect_stdout(io.StringIO()):
            monitor.run();self.assertEqual(send.call_count,0)
            monitor.run();self.assertEqual(send.call_count,1)
            self.assertTrue(json.loads((Path(tmp)/'status.json').read_text())['deliveryPending'])
            monitor.run();self.assertEqual(send.call_count,2)
            monitor.run();self.assertEqual(send.call_count,2)
            check.return_value={'https':True}
            monitor.run();self.assertEqual(send.call_count,3)
            self.assertIn('восстановлена',send.call_args.args[0])
if __name__=='__main__': unittest.main()
