import struct
import unittest
from rtp_header_capture import PcapHeaders, rtp_header


def packet(ssrc=7, options=False):
    data=bytearray(54)
    data[12:14]=b'\x08\x00';data[14]=0x46 if options else 0x45;data[23]=17
    data[38:40]=struct.pack('!H',260)
    data[42:54]=struct.pack('!BBHII',0x90,120,65535,2**32-960,ssrc)
    return bytes(data)


def pcap(data):
    return struct.pack('<IHHIIII',0xa1b2c3d4,2,4,0,0,54,1)+struct.pack('<IIII',100,123456,len(data),len(data)+200)+data


class HeaderCaptureTests(unittest.TestCase):
    def test_exact_header_has_no_payload_or_addresses(self):
        row=rtp_header(packet(),7)
        self.assertEqual(row['sequence'],65535)
        self.assertEqual(row['timestamp'],2**32-960)
        self.assertEqual(row['udpBytes'],260)
        self.assertTrue(row['extension'])
        self.assertEqual(set(row),{'sequence','timestamp','ssrc','udpBytes','marker','extension','csrcs'})

    def test_incremental_read_and_timestamp(self):
        stream=pcap(packet());parser=PcapHeaders(7);rows=[]
        for b in stream:rows.extend(parser.feed(bytes([b])))
        self.assertEqual(rows[0]['unixMicros'],100123456)
        self.assertEqual(rows[0]['wireBytes'],254)
        self.assertEqual(parser.buffer,bytearray())

    def test_layout_and_stream_rejection(self):
        self.assertIsNone(rtp_header(packet(8),7))
        self.assertIsNone(rtp_header(packet(options=True),7))
        self.assertIsNone(rtp_header(packet()+b'secret-payload',7))
        parser=PcapHeaders(7)
        self.assertEqual(parser.feed(pcap(packet(8))),[])
        self.assertEqual(parser.rejected,1)

    def test_unbounded_or_wrong_capture_format_rejected(self):
        stream=bytearray(pcap(packet()));struct.pack_into('<I',stream,16,96)
        with self.assertRaises(ValueError):PcapHeaders(7).feed(stream)
        with self.assertRaises(ValueError):PcapHeaders(7).feed(b'x'*(1024*1024+1))


if __name__=='__main__':unittest.main()
