"""Own one live-test Rust bot; discard raw logs and stop on 'stop', EOF or deadline."""
import argparse
import os
from pathlib import Path
import select
import sys
import time
from compare_idle import Process

parser = argparse.ArgumentParser()
parser.add_argument("--binary", type=Path, required=True)
parser.add_argument("--env-file", type=Path, default=Path("../raydio/.env"))
parser.add_argument("--udp-trace-library", type=Path)
parser.add_argument("--udp-trace-output", type=Path)
args = parser.parse_args()
env = {k: v for k, v in os.environ.items() if k not in ("APPIMAGE", "APPDIR", "ARGV0")}
if args.udp_trace_library:
    if not args.udp_trace_output or args.udp_trace_output.exists():
        parser.error("UDP tracing needs a new --udp-trace-output file")
    env["LD_PRELOAD"] = str(args.udp_trace_library.resolve())
    env["RAYDIO_UDP_TRACE"] = str(args.udp_trace_output.resolve())
bot = Process([str(args.binary.resolve()), "--testbot", "--env-file", str(args.env_file.resolve())],
              Path.cwd(), env, ["Raydio ready"])
try:
    bot.wait_ready(time.monotonic() + 60)
    print(f"Testbot ready; owned PID {bot.process.pid}", flush=True)
    deadline = time.monotonic() + 1200
    while time.monotonic() < deadline and bot.process.poll() is None:
        if select.select([sys.stdin], [], [], 1)[0]:
            line = sys.stdin.readline()
            if not line or line.strip() == "stop":
                break
finally:
    bot.stop()
    print("Owned Testbot stopped", flush=True)
