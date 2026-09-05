"""Matched authenticated Rust-only comparison; owns and cleans up each bot process.

uv run --no-project python benchmarks/compare_rust_idle.py --before PATH --after PATH
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import statistics
import time
import urllib.request

from compare_idle import run_trial


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, default=root.parent / "raydio/.env")
    parser.add_argument("--output", type=Path, default=root / "evidence/optimization-idle.json")
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--seconds", type=int, default=15)
    parser.add_argument("--before-arena-max", type=int, choices=range(1, 9))
    parser.add_argument("--after-arena-max", type=int, choices=range(1, 9))
    args = parser.parse_args()
    token = next(line.partition("=")[2].strip().strip("\"'") for line in args.env_file.read_text().splitlines() if line.startswith("DISCORD_TOKEN_TESTBOT="))
    request = urllib.request.Request("https://discord.com/api/v10/users/@me", headers={
        "Authorization": "Bot " + token, "User-Agent": "DiscordBot (https://github.com/rayan6ms/raydio, 0.2.0)"})
    with urllib.request.urlopen(request, timeout=10) as response:
        if json.load(response)["id"] != "1544468432907669644":
            raise RuntimeError("Unexpected bot identity")
    variants = {key: getattr(args, key).resolve() for key in ("before", "after")}
    report = {"date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "workload": "Authenticated idle, no commands or voice; alternating build order",
              "warmupSeconds": args.warmup, "trials": [],
              "binaries": {key: {"sha256": hashlib.file_digest(path.open("rb"), "sha256").hexdigest(), "bytes": path.stat().st_size} for key, path in variants.items()},
              "arenaMaxOverrides": {key: getattr(args, key + "_arena_max") for key in variants},
              "limitations": ["Shared host; idle only, no playback or end-to-end latency claim", "Three independent starts per variant; no compilation during sampling"]}
    for trial in range(args.trials):
        order = ["before", "after"] if trial % 2 == 0 else ["after", "before"]
        for variant in order:
            args.binary = variants[variant]
            args.arena_max = getattr(args, variant + "_arena_max")
            record = run_trial(args, "rust", token)
            record.update(variant=variant, trial=trial+1)
            report["trials"].append(record)
            args.output.write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(record), flush=True)
            time.sleep(3)
    report["medians"] = {v: {key: statistics.median(r[key] for r in report["trials"] if r["variant"] == v) for key in ("medianPssKiB", "medianRssKiB", "startupMs")} for v in variants}
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["medians"]), flush=True)


if __name__ == "__main__":
    main()
