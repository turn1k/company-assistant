import contextlib
import importlib.util
import io
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)

class BackupTest(unittest.TestCase):
    def test_snapshot_excludes_chat_and_retains_source_and_valid_backups(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); destination=root/'backups'; destination.mkdir()
            database=root/'source.sqlite'; config=root/'config'; config.write_text('TEST_CONFIG=1')
            marker='PRIVATE_CHAT_MUST_NOT_SURVIVE_12345'
            with contextlib.closing(sqlite3.connect(database)) as db:
                db.executescript('CREATE TABLE users(id TEXT); CREATE TABLE latest(answer TEXT); CREATE TABLE sessions(token TEXT); CREATE TABLE login_attempts(key TEXT);')
                db.execute('INSERT INTO users VALUES (?)', ('user',))
                db.execute('INSERT INTO latest VALUES (?)', (marker,))
                db.execute('INSERT INTO sessions VALUES (?)', (marker,))
                db.commit()
            with patch.object(backup,'ROOT',destination), patch.object(backup,'DATA',database), patch.object(backup,'FILES',{'config/test':config}), patch.object(backup.subprocess,'check_output',return_value='test-commit'), contextlib.redirect_stdout(io.StringIO()):
                for _ in range(8): backup.backup()
                archives=list(destination.glob('*.tar.gz'))
                self.assertEqual(len(archives),7)
                for archive in archives:
                    self.assertEqual(backup.verify(archive),1)
                    with tarfile.open(archive) as tar:
                        self.assertNotIn(marker.encode(),tar.extractfile('data/app.sqlite').read())
                with contextlib.closing(sqlite3.connect(database)) as db:
                    self.assertEqual(db.execute('SELECT answer FROM latest').fetchone()[0],marker)
                config.unlink()
                with self.assertRaises(FileNotFoundError): backup.backup()
                self.assertEqual(set(archives),set(destination.glob('*.tar.gz')))

if __name__=='__main__': unittest.main()
