"""Bounded loopback-only persistence for the controlled Discord receiver audit."""
import argparse
import json
import os
from pathlib import Path
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

p = argparse.ArgumentParser()
p.add_argument('--output', type=Path, required=True)
p.add_argument('--port', type=int, default=18766)
p.add_argument('--seconds', type=int, default=25200)
a = p.parse_args()
if not 60 <= a.seconds <= 25200:
    p.error('seconds must be 60..25200')
a.output.mkdir(parents=True, exist_ok=True)
os.chmod(a.output, 0o700)
started = time.monotonic()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def answer(self, status):
        self.send_response(status)
        self.send_header('Access-Control-Allow-Origin', 'https://discord.com')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_OPTIONS(self):
        self.answer(204)

    def do_POST(self):
        if self.path != '/checkpoint' or self.headers.get('Origin') != 'https://discord.com':
            self.answer(403)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 1 <= size <= 4 * 1024 * 1024:
                self.answer(413)
                return
            data = json.loads(self.rfile.read(size))
            if data.get('version') != 1 or data.get('requestedSeconds') != 21600:
                self.answer(400)
                return
            temporary = a.output / 'receiver.next.json'
            with temporary.open('w') as f:
                json.dump(data, f, separators=(',', ':'))
                f.flush()
                os.fsync(f.fileno())
            temporary.replace(a.output / 'receiver.json')
            with (a.output / 'checkpoints.jsonl').open('a') as f:
                f.write(json.dumps({'savedAt': time.time(), 'status': data.get('status'),
                    'elapsedSeconds': data.get('elapsedSeconds'), 'bytes': size}) + '\n')
            self.answer(204)
        except (ValueError, OSError):
            self.answer(400)


class Server(HTTPServer):
    def get_request(self):
        sock, address = super().get_request()
        sock.settimeout(5)
        return sock, address


with Server(('127.0.0.1', a.port), Handler) as server:
    server.timeout = 1
    while time.monotonic() - started < a.seconds:
        server.handle_request()
