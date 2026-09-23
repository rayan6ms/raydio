"""Export only a terminal receiver session, at least 60 seconds after its deadline.

Usage: uv run --no-project python benchmarks/collect_completed_run.py RUN_MANIFEST
Remote files are copied at a fixed byte boundary, then streamed uncompressed.
No bot/service is stopped. Existing exports are never overwritten.
"""
import datetime as dt
import json
from pathlib import Path
import re
import subprocess
import sys


def validate(manifest, session, receiver, now):
    end = dt.datetime.fromisoformat(manifest['expectedEndUtc'].replace('Z', '+00:00'))
    if now < end + dt.timedelta(seconds=60):
        raise ValueError('Recording deadline plus 60-second export margin has not passed')
    if session.get('requestedAt') != manifest.get('sessionRequestedAt'):
        raise ValueError('Session identity does not match manifest')
    if session.get('status') not in ('completed', 'completed-with-gaps', 'stopped', 'failed-to-start'):
        raise ValueError('Session is not terminal; inspect receiver before export')
    if receiver.get('status') not in ('completed', 'failed', 'stopped'):
        raise ValueError('Receiver is not terminal')
    segments = session.get('segments', [])
    if not segments or receiver.get('requestedAt') != segments[-1].get('requestedAt'):
        raise ValueError('Latest receiver is not the final archived session segment')
    if not session.get('finishedAt') or not receiver.get('finishedAt'):
        raise ValueError('Missing terminal timestamps')
    run_id = manifest['runId']
    if not re.fullmatch(r'[a-z0-9-]{1,64}', run_id):
        raise ValueError('Invalid run ID')
    if manifest['oracleDirectory'] != '/var/lib/raydio/' + run_id:
        raise ValueError('Unexpected Oracle evidence directory')


def main():
    manifest_path = Path(sys.argv[1]).resolve()
    root = manifest_path.parent / 'six-hour'
    manifest = json.loads(manifest_path.read_text())
    session = json.loads((root / 'receiver-session.json').read_text())
    receiver = json.loads((root / 'receiver.json').read_text())
    now = dt.datetime.now(dt.timezone.utc)
    validate(manifest, session, receiver, now)
    destination = root / 'oracle-completed.tar'
    if destination.exists():
        raise ValueError('Export already exists; preserve it')
    remote = manifest['oracleDirectory']
    ssh = ['ssh', '-o', 'ConnectTimeout=15', '-i', str(Path.home() / '.ssh/id_ed25519'),
           'ubuntu@137.131.202.133']
    # run ID is strictly validated above; all other text is fixed code.
    script = f'''from pathlib import Path
import json,datetime
src=Path({remote!r});dst=src/'guarded-completed-snapshot';dst.mkdir(exist_ok=False)
meta={{'copiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'bytes':{{}}}}
for p in src.iterdir():
 if not p.is_file():continue
 remaining=p.stat().st_size;meta['bytes'][p.name]=remaining
 with p.open('rb') as inp,(dst/p.name).open('wb') as out:
  while remaining:
   chunk=inp.read(min(1048576,remaining))
   if not chunk:raise RuntimeError('source truncated')
   out.write(chunk);remaining-=len(chunk)
(dst/'snapshot.json').write_text(json.dumps(meta,indent=2)+'\\n')
'''
    subprocess.run(ssh + ['sudo python3 -'], input=script, text=True, check=True)
    with destination.open('xb') as out:
        subprocess.run(ssh + [f'sudo tar -C {remote}/guarded-completed-snapshot -cf - .'],
                       stdout=out, check=True)
    (root / 'export-guard.json').write_text(json.dumps({
        'checkedAt': now.isoformat(), 'expectedEndUtc': manifest['expectedEndUtc'],
        'sessionStatus': session['status'], 'receiverStatus': receiver['status'],
        'remoteCompression': False, 'archive': destination.name}, indent=2) + '\n')
    print(destination)


if __name__ == '__main__':
    main()
