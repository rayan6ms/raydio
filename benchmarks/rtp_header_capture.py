"""Bounded capture of one owned Discord RTP stream; never save media payloads.

Requires capture permission (normally sudo). tcpdump snaplen is exactly 54:
Ethernet + fixed IPv4 + UDP + the 12-byte RTP header. Reject other layouts,
including IPv4 options/VLAN/IPv6, rather than exporting partial payloads.
No packet interception, socket mutation, raw pcap artifact, or audio decoding.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import time


def rtp_header(packet, ssrc, payload_type=120):
    if len(packet) != 54 or packet[12:14] != b'\x08\x00' or packet[14] != 0x45 or packet[23] != 17:
        return None
    # IP fragments cannot be interpreted as an independent RTP packet.
    if int.from_bytes(packet[20:22], 'big') & 0x3fff:
        return None
    udp = int.from_bytes(packet[38:40], 'big')
    if udp < 20:
        return None
    header = packet[42:54]
    if header[0] >> 6 != 2 or header[1] & 0x7f != payload_type:
        return None
    _, _, sequence, timestamp, identity = struct.unpack('!BBHII', header)
    if identity != ssrc:
        return None
    return dict(sequence=sequence, timestamp=timestamp, ssrc=identity, udpBytes=udp,
                marker=bool(header[1] & 0x80), extension=bool(header[0] & 0x10), csrcs=header[0]&15)


class PcapHeaders:
    def __init__(self, ssrc, payload_type=120):
        self.buffer = bytearray()
        self.endian = None
        self.ssrc = ssrc
        self.payload_type = payload_type
        self.rejected = 0

    def feed(self, chunk):
        self.buffer.extend(chunk)
        if len(self.buffer) > 1024 * 1024:
            raise ValueError('pcap buffer exceeded bound')
        if self.endian is None:
            if len(self.buffer) < 24:
                return []
            magic = bytes(self.buffer[:4])
            if magic not in (b'\xd4\xc3\xb2\xa1', b'\xa1\xb2\xc3\xd4'):
                raise ValueError('Expected microsecond pcap')
            self.endian = '<' if magic == b'\xd4\xc3\xb2\xa1' else '>'
            _, major, minor, _, _, snaplen, linktype = struct.unpack(self.endian+'IHHIIII', self.buffer[:24])
            if (major,minor,snaplen,linktype) != (2,4,54,1):
                raise ValueError('Expected 54-byte Ethernet capture')
            del self.buffer[:24]
        rows = []
        while len(self.buffer) >= 16:
            seconds, micros, captured, original = struct.unpack(self.endian+'IIII', self.buffer[:16])
            if captured > 54 or micros >= 1000000 or original < captured:
                raise ValueError('Invalid bounded capture record')
            if len(self.buffer) < 16+captured:
                break
            header = rtp_header(bytes(self.buffer[16:16+captured]), self.ssrc, self.payload_type)
            del self.buffer[:16+captured]
            if header:
                rows.append(dict(unixMicros=seconds*1000000+micros, wireBytes=original, **header))
            else:
                self.rejected += 1
        return rows


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--interface', required=True)
    p.add_argument('--peer', required=True)
    p.add_argument('--port', required=True, type=int)
    p.add_argument('--ssrc', required=True, type=int)
    p.add_argument('--payload-type',type=int,default=120,help='Negotiated Opus RTP type; browser forwarding may use 111')
    p.add_argument('--direction', choices=('receive','send'), required=True)
    p.add_argument('--seconds',type=int,default=120)
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    peer=ipaddress.IPv4Address(a.peer)
    if not 10<=a.seconds<=180 or not 0<a.port<65536 or not 0<=a.ssrc<2**32 or not 0<=a.payload_type<=127:
        p.error('Invalid duration, port, SSRC or payload type')
    if not a.interface or a.interface.startswith('-') or '/' in a.interface:
        p.error('Invalid interface')
    a.output.mkdir(parents=True,exist_ok=False,mode=0o700)
    direction='src' if a.direction=='receive' else 'dst'
    filt=(f'ip and udp and {direction} host {peer} and {direction} port {a.port}'
          f' and udp[8] & 0xc0 = 0x80 and udp[9] & 0x7f = {a.payload_type} and udp[16:4] = {a.ssrc}')
    parser=PcapHeaders(a.ssrc,a.payload_type)
    started=time.monotonic()
    fd=os.open(a.output/'headers.jsonl',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    proc=None
    rows=0
    error=None
    try:
        with os.fdopen(fd,'w') as output:
            proc=subprocess.Popen(['/usr/bin/tcpdump','-i',a.interface,'-n','-U','-w','-',
                                   '-s','54','--time-stamp-precision=micro','-c','10000',filt],
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            while time.monotonic()-started < a.seconds and rows<10000:
                if not select.select([proc.stdout],[],[],min(1,max(0,a.seconds-(time.monotonic()-started))))[0]:
                    continue
                chunk=os.read(proc.stdout.fileno(),65536)
                if not chunk:
                    if proc.poll() not in (None,0): raise RuntimeError('tcpdump failed to capture')
                    break
                batch=parser.feed(chunk)
                for row in batch:output.write(json.dumps(row,separators=(',',':'))+'\n')
                rows+=len(batch)
                output.flush()
    except Exception as e:
        error=type(e).__name__+': '+str(e)
    finally:
        if proc:
            if proc.poll() is None: proc.terminate()
            try: proc.wait(timeout=3)
            except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=3)
            stderr=proc.stderr.read(4096).decode(errors='replace')
        else:stderr=''
        summary=dict(seconds=time.monotonic()-started,requestedSeconds=a.seconds,records=rows,
                     payloadType=a.payload_type,ssrc=a.ssrc,
                     rejected=parser.rejected,incompleteRecordBytes=len(parser.buffer),error=error,
                     captureDiagnostics=stderr,exitCode=proc.returncode if proc else None,
                     limitations=['Kernel arrival/submission timestamp is not receiver playout time.',
                                  'Only one selected IPv4 Ethernet RTP stream is retained.',
                                  'No media payloads or credentials are saved.'])
        (a.output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    if error:raise SystemExit(error)
    print(json.dumps({k:summary[k] for k in ('records','rejected','seconds','error')}))


if __name__=='__main__':main()
