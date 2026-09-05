"""Run the complete original testbot stack for interactive parity/playback checks.

Raw child logs are discarded. Enter stop (or close stdin) to shut down only
owned processes. A fifteen-minute deadline also bounds unattended runs.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import select
import shutil
import socket
import sys
import tempfile
import time
import urllib.request

from compare_idle import Process


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--profile", choices=["tuned", "ordinary"], default="tuned")
    args = parser.parse_args()
    node = args.node.resolve()
    original = root.parent / "raydio"
    crust = root.parent / "crust"
    token = next(line.partition("=")[2].strip().strip("\"'") for line in args.env_file.read_text().splitlines() if line.startswith("DISCORD_TOKEN_TESTBOT="))
    request = urllib.request.Request("https://discord.com/api/v10/users/@me", headers={
        "Authorization": "Bot " + token,
        "User-Agent": "DiscordBot (https://github.com/rayan6ms/raydio, 0.2.0)",
    })
    with urllib.request.urlopen(request, timeout=10) as response:
        if json.load(response)["id"] != "1544468432907669644":
            raise RuntimeError("Unexpected bot identity")
    env = {k: v for k, v in os.environ.items() if k not in ("APPIMAGE", "APPDIR", "ARGV0")}
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    password = secrets.token_hex(32)
    env.update(DISCORD_TOKEN=token, LOG_LEVEL="info", LAVALINK_SERVER_PASSWORD=password,
               LAVALINK_PASSWORD=password, LAVALINK_HOST="127.0.0.1", LAVALINK_PORT=str(port), LAVALINK_SECURE="false")
    processes = []
    with tempfile.TemporaryDirectory(prefix="raydio-live-reference-") as work:
        work = Path(work)
        config = (original / "lavalink/application.yml").read_text().replace("port: 2333", f"port: {port}").replace("address: 0.0.0.0", "address: 127.0.0.1")
        (work / "application.yml").write_text(config)
        (work / "plugins").mkdir()
        shutil.copyfile(crust / ".cache/reference/ecosystem-youtube/1.18.2/youtube-plugin-1.18.2.jar", work / "plugins/youtube-plugin-1.18.2.jar")
        try:
            heap = ["-Xms64m", "-Xmx192m", "-XX:ActiveProcessorCount=2"] if args.profile == "tuned" else ["-Xmx512m"]
            java = Process(["/opt/adoptium/temurin-25/bin/java", *heap, "-jar", str(crust / ".cache/reference/4.2.2/Lavalink.jar")], work, env, ["Lavalink is ready"])
            processes.append(java)
            java.wait_ready(time.monotonic() + 60)
            bot = Process([str(node), str(original / "dist/index.js")], work, env,
                          ['"event":"discord_ready"', '"event":"lavalink_ready"', '"event":"application_commands_ready"'])
            processes.append(bot)
            bot.wait_ready(time.monotonic() + 40)
            print(json.dumps({"stage": "ready", "profile": args.profile, "pids": [p.process.pid for p in processes]}), flush=True)
            if select.select([sys.stdin], [], [], 900)[0]:
                sys.stdin.readline()
        finally:
            for process in reversed(processes):
                process.stop()
            print("Owned reference stack stopped", flush=True)


if __name__ == "__main__":
    main()
