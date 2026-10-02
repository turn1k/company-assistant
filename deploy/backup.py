#!/usr/bin/env python3
"""Root-only account/config backups. Never archives chat content or sessions."""
from contextlib import closing
import argparse
import datetime
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile

ROOT = Path('/var/backups/company-assistant')
DATA = Path('/var/lib/company-assistant/app.sqlite')
FILES = {'config/company-assistant.env': Path('/etc/company-assistant.env'),
         'config/Caddyfile': Path('/etc/caddy/Caddyfile'),
         'config/company-assistant.service': Path('/etc/systemd/system/company-assistant.service')}

def verify(archive):
    with tarfile.open(archive, 'r:gz') as tar, tempfile.TemporaryDirectory(prefix='restore-check-', dir=ROOT) as tmp:
        member = tar.getmember('data/app.sqlite')
        if not member.isfile():
            raise RuntimeError('Database entry is not a regular file')
        restored = Path(tmp) / 'app.sqlite'
        with tar.extractfile(member) as source, restored.open('wb') as dest:
            while chunk := source.read(1024 * 1024):
                dest.write(chunk)
        with closing(sqlite3.connect(restored)) as db:
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Database integrity failed')
            if db.execute('PRAGMA foreign_key_check').fetchall():
                raise RuntimeError('Database foreign keys failed')
            for table in ('latest', 'sessions', 'login_attempts'):
                if db.execute('SELECT count(*) FROM ' + table).fetchone()[0]:
                    raise RuntimeError('Excluded data present: ' + table)
            users = db.execute('SELECT count(*) FROM users').fetchone()[0]
        for name in FILES:
            if not tar.getmember(name).isfile():
                raise RuntimeError('Missing configuration: ' + name)
        manifest = json.load(tar.extractfile('manifest.json'))
        if manifest['schema'] != 1:
            raise RuntimeError('Unsupported backup schema')
    return users

def backup():
    with tempfile.TemporaryDirectory(prefix='snapshot-', dir=ROOT) as tmp:
        snapshot = Path(tmp) / 'app.sqlite'
        # Online SQLite backup captures a consistent transaction, including WAL.
        with closing(sqlite3.connect(f'file:{DATA}?mode=ro', uri=True)) as source, closing(sqlite3.connect(snapshot)) as dest:
            source.backup(dest)
            dest.execute('PRAGMA secure_delete=ON')
            for table in ('latest', 'sessions', 'login_attempts'):
                dest.execute('DELETE FROM ' + table)
            dest.commit()
            dest.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            dest.execute('PRAGMA journal_mode=DELETE')
            dest.execute('VACUUM')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        manifest = {'schema': 1, 'createdUTC': stamp,
                    'gitCommit': subprocess.check_output(['git','-C','/opt/company-assistant','rev-parse','HEAD'], text=True).strip(),
                    'excludes': ['chat prompts and answers', 'attachments', 'sessions', 'login attempts'],
                    'restore': 'Stop service; restore database and config; create empty uploads; set ownership; start service.'}
        pending = Path(tmp) / 'backup.tar.gz'
        with tarfile.open(pending, 'w:gz') as tar:
            tar.add(snapshot, arcname='data/app.sqlite', recursive=False)
            for name, source in FILES.items():
                tar.add(source, arcname=name, recursive=False)
            payload = json.dumps(manifest, indent=2).encode()
            info = tarfile.TarInfo('manifest.json'); info.size = len(payload); info.mode = 0o600
            tar.addfile(info, io.BytesIO(payload))
        users = verify(pending)
        archive = ROOT / ('company-assistant-' + stamp + '.tar.gz')
        pending.chmod(0o600)
        os.replace(pending, archive)
        # Retain only verified snapshots, and only files belonging to this job.
        for old in sorted(ROOT.glob('company-assistant-*.tar.gz'), reverse=True)[7:]:
            if old.is_file() and not old.is_symlink():
                old.unlink()
        print(json.dumps({'backup': str(archive), 'verified': True, 'users': users, 'bytes': archive.stat().st_size}))

if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify', type=Path)
    args = parser.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    ROOT.chmod(0o700)
    if args.verify:
        print(json.dumps({'verified': True, 'users': verify(args.verify)}))
    else:
        backup()
