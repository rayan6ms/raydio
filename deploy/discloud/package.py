"""Package a native Testbot binary with Discloud's minimal Rust entry point.

Usage: python3 deploy/discloud/package.py --env-file ../raydio/.env --output /tmp/raydio-test.zip
The output contains the test token: keep it private and never commit it.
"""
import argparse
import os
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', type=Path, default=Path('target/release/raydio'))
parser.add_argument('--env-file', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
token = None
for line in args.env_file.read_text().splitlines():
    key, separator, value = line.strip().partition('=')
    if separator and key == 'DISCORD_TOKEN_TESTBOT':
        token = value.strip().strip('\"\'')
if not token or not all(c.isascii() and (c.isalnum() or c in '._-') for c in token):
    raise SystemExit('Missing or invalid DISCORD_TOKEN_TESTBOT')
root = Path(__file__).resolve().parent
with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name in ('Cargo.toml', 'src/main.rs', 'discloud.config'):
            archive.write(root / name, name)
        archive.write(args.binary, 'bin/raydio')
        archive.writestr('.env', f'DISCORD_TOKEN_TESTBOT={token}\nDEFAULT_VOLUME=70\nLOG_LEVEL=info\n')
print(f'Wrote private Testbot package: {args.output.stat().st_size} bytes')
