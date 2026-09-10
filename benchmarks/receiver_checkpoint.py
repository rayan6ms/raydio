"""Bounded loopback persistence and independent receiver-host sampling.

Host samples keep arriving without a browser or a successful POST. No packet
interception, child process, or high-frequency scheduling probe is used.
"""
import argparse
import json
import os
from pathlib import Path
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


def host_snapshot(proc=Path('/proc')):
    host = {}
    paths = {name + 'Pressure': proc / 'pressure' / name for name in ('cpu', 'memory', 'io')}
    paths.update(cpuTicks=proc / 'stat', networkDevices=proc / 'net/dev',
                 udpCounters=proc / 'net/snmp', uptime=proc / 'uptime')
    for key, path in paths.items():
        try:
            raw = path.read_text()
            if key == 'cpuTicks':
                host[key] = list(map(int, raw.splitlines()[0].split()[1:]))
            elif key == 'networkDevices':
                host[key] = raw.splitlines()[2:]
            elif key == 'udpCounters':
                host[key] = [line for line in raw.splitlines() if line.startswith('Udp:')]
            else:
                host[key] = raw.strip()
        except (OSError, ValueError, IndexError) as error:
            host.setdefault('errors', {})[key] = type(error).__name__
    return host


class Collector:
    def __init__(self, output, *, sample=host_snapshot, expires_at=None):
        self.output = output
        self.sample = sample
        self.next_sample = 0
        self.host_samples = 0
        self.last_receiver = None
        self.expires_at = expires_at
        self.archive_run = None
        self.archived_sequence = 0
        self.archive_missing_events = 0
        self.archive_bytes = 0
        self.archive_limit_bytes = 64 * 1024 * 1024

    def tick(self, now):
        if now < self.next_sample:
            return
        row = {'savedAt': time.time(), 'monotonicSeconds': now,
               'lateMs': max(0, now - self.next_sample) * 1000 if self.host_samples else 0,
               'host': self.sample()}
        with (self.output / 'receiver-host.jsonl').open('a') as f:
            f.write(json.dumps(row, separators=(',', ':')) + '\n')
        self.host_samples += 1
        # No catch-up burst after suspension or slow disk. Record the lateness.
        self.next_sample = now + 60

    def save(self, data, size):
        if not isinstance(data, dict):
            raise ValueError('report must be an object')
        duration = data.get('requestedSeconds')
        if data.get('version') != 1 or type(duration) is not int or not 10 <= duration <= 21600:
            raise ValueError('invalid report version or duration')
        started = time.monotonic()
        temporary = self.output / 'receiver.next.json'
        with temporary.open('w') as f:
            json.dump(data, f, separators=(',', ':'))
            f.flush()
            os.fsync(f.fileno())
        temporary.replace(self.output / 'receiver.json')
        checkpoint = {'savedAt': time.time(), 'requestedAt': data.get('requestedAt'),
                      'status': data.get('status'), 'elapsedSeconds': data.get('elapsedSeconds'),
                      'bytes': size, 'saveDurationMs': (time.monotonic() - started) * 1000}
        with (self.output / 'checkpoints.jsonl').open('a') as f:
            f.write(json.dumps(checkpoint, separators=(',', ':')) + '\n')
        self.archive_events(data)
        self.last_receiver = checkpoint

    def archive_events(self, data):
        run = data.get('requestedAt')
        if run != self.archive_run:
            self.archive_run = run
            self.archived_sequence = 0
            self.archive_missing_events = 0
        events = [event for event in data.get('events', [])
                  if isinstance(event.get('sequence'), int) and event['sequence'] > self.archived_sequence]
        if not events:
            return
        payload = ''.join(json.dumps({'requestedAt': run, **event}, separators=(',', ':')) + '\n'
                          for event in events)
        size = len(payload.encode())
        if self.archive_bytes + size > self.archive_limit_bytes:
            raise ValueError('event archive reached its 64 MiB bound')
        with (self.output / 'receiver-events.jsonl').open('a') as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        for event in events:
            self.archive_missing_events += max(0, event['sequence'] - self.archived_sequence - 1)
            self.archived_sequence = event['sequence']
        self.archive_bytes += size

    def health(self):
        return {'hostSamples': self.host_samples, 'lastReceiver': self.last_receiver,
                'archivedSequence': self.archived_sequence, 'archiveMissingEvents': self.archive_missing_events,
                'archiveBytes': self.archive_bytes,
                'remainingSeconds': max(0, self.expires_at - time.monotonic()) if self.expires_at is not None else None}


def handler_for(collector):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def answer(self, status, data=None):
            body = json.dumps(data).encode() if data is not None else b''
            self.send_response(status)
            self.send_header('Access-Control-Allow-Origin', 'https://discord.com')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def do_OPTIONS(self):
            self.answer(204)

        def do_GET(self):
            if self.path != '/health' or self.headers.get('Origin') != 'https://discord.com':
                self.answer(403)
                return
            self.answer(200, collector.health())

        def do_POST(self):
            if self.path != '/checkpoint' or self.headers.get('Origin') != 'https://discord.com':
                self.answer(403)
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 1 <= size <= 4 * 1024 * 1024:
                    self.answer(413)
                    return
                collector.save(json.loads(self.rfile.read(size)), size)
                self.answer(204)
            except (ValueError, OSError):
                self.answer(400)
    return Handler


class Server(HTTPServer):
    def get_request(self):
        sock, address = super().get_request()
        sock.settimeout(5)
        return sock, address


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--port', type=int, default=18766)
    p.add_argument('--seconds', type=int, default=25200)
    a = p.parse_args()
    if not 60 <= a.seconds <= 25200:
        p.error('seconds must be 60..25200')
    # Each observation gets its own directory; never overwrite an earlier run.
    a.output.mkdir(parents=True, exist_ok=False, mode=0o700)
    os.chmod(a.output, 0o700)
    os.nice(19)
    started = time.monotonic()
    collector = Collector(a.output, expires_at=started + a.seconds)
    with Server(('127.0.0.1', a.port), handler_for(collector)) as server:
        server.timeout = 1
        while time.monotonic() - started < a.seconds:
            collector.tick(time.monotonic())
            server.handle_request()


if __name__ == '__main__':
    main()
