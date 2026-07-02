#!/usr/bin/env python3
"""
gen-fixtures.py

Generates the deterministic MAVLink1/2 wire fixtures consumed by
src/core/mavlink/__tests__/integration.test.ts:

  - src/core/mavlink/__tests__/fixtures/frames.bin
      A single byte stream: HEARTBEAT (v2), garbage, ATTITUDE, PARAM_VALUE,
      garbage, STATUSTEXT (with extension fields), a second STATUSTEXT
      (short text, extensions all zero -> encode-time-truncated),
      COMMAND_ACK (with extension fields), garbage, and a MAVLink1
      HEARTBEAT -- generated with pymavlink so the bytes are an independent,
      known-good reference rather than round-tripped through our own
      encodeFrame().

  - src/core/mavlink/__tests__/fixtures/frames.expected.json
      For each *real* frame in frames.bin (not the injected garbage): its
      msgid/msgname/version/seq/sysid/compid, the exact wire (truncated,
      pre-zero-extension) payload as sent, and pymavlink's own decoded
      field values -- so the integration test can assert that our
      FrameParser + decodePayload agree with pymavlink byte-for-byte and
      field-for-field.

Both files are committed to the repo (CI does not need pymavlink to run the
test suite; this script is a dev-time generator only, re-run it after
editing the frame list below).

Requires: pymavlink (developed/tested against 2.4.49 -- `pip install
pymavlink` if not already installed).

Usage: python3 scripts/gen-fixtures.py
"""
import json
from pathlib import Path

import pymavlink
from pymavlink.dialects.v10 import ardupilotmega as mavlink1
from pymavlink.dialects.v20 import ardupilotmega as mavlink2

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURES_DIR = REPO_ROOT / 'src' / 'core' / 'mavlink' / '__tests__' / 'fixtures'

HEADER_LEN_V2 = 10
HEADER_LEN_V1 = 6


class ByteSink:
    """Minimal file-like object pymavlink's MAVLink.send()/mav.file.write() writes into."""

    def __init__(self):
        self.data = bytearray()

    def write(self, b):
        self.data += b


def field_value_for_json(value, ftype):
    """64-bit fields become decimal strings (JSON numbers lose precision
    above 2**53); everything else (numbers, trimmed char[] strings, plain
    numeric arrays) round-trips through JSON as-is."""
    if 'int64' in ftype:
        if isinstance(value, list):
            return [str(v) for v in value]
        return str(value)
    return value


def decode_entry(version, wire_bytes):
    """Re-decode `wire_bytes` (the exact bytes just written to the stream)
    via pymavlink's own decoder, independent of anything our TS code does,
    and build this frame's `frames.expected.json` entry."""
    mav = mavlink2.MAVLink(None) if version == 2 else mavlink1.MAVLink(None)
    msg = mav.decode(bytearray(wire_bytes))
    fields = {
        name: field_value_for_json(getattr(msg, name), ftype)
        for name, ftype in zip(msg.fieldnames, msg.fieldtypes)
    }

    header_len = HEADER_LEN_V2 if version == 2 else HEADER_LEN_V1
    length = wire_bytes[1]
    if version == 2:
        seq, sysid, compid = wire_bytes[4], wire_bytes[5], wire_bytes[6]
        msgid = wire_bytes[7] | (wire_bytes[8] << 8) | (wire_bytes[9] << 16)
    else:
        seq, sysid, compid = wire_bytes[2], wire_bytes[3], wire_bytes[4]
        msgid = wire_bytes[5]
    payload = wire_bytes[header_len:header_len + length]

    return {
        'version': version,
        'msgid': msgid,
        'msgname': msg.msgname,
        'seq': seq,
        'sysid': sysid,
        'compid': compid,
        'payloadHex': payload.hex(),
        'fields': fields,
    }


def main():
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    stream = bytearray()
    entries = []

    # Factories are only used to build message objects (`*_encode()` does not
    # send anything); a fresh throwaway `MAVLink` instance is created per
    # emitted frame below so each frame gets its own seq/sysid/compid.
    v2_factory = mavlink2.MAVLink(ByteSink())
    v1_factory = mavlink1.MAVLink(ByteSink())

    def emit_v2(seq, sysid, compid, msg):
        sink = ByteSink()
        mav = mavlink2.MAVLink(sink, srcSystem=sysid, srcComponent=compid)
        mav.seq = seq
        mav.send(msg)
        wire = bytes(sink.data)
        stream.extend(wire)
        entries.append(decode_entry(2, wire))

    def emit_v1(seq, sysid, compid, msg):
        sink = ByteSink()
        mav = mavlink1.MAVLink(sink, srcSystem=sysid, srcComponent=compid)
        mav.seq = seq
        mav.send(msg)
        wire = bytes(sink.data)
        stream.extend(wire)
        entries.append(decode_entry(1, wire))

    def emit_garbage(*byte_values):
        # Deliberately avoid 0xfd/0xfe so garbage never looks like a magic
        # byte -- FrameParser's resync contract covers that case separately
        # (see frame.test.ts), this fixture is about plain noise.
        stream.extend(bytes(byte_values))

    # 1. HEARTBEAT
    emit_v2(0, 1, 1, v2_factory.heartbeat_encode(6, 8, 81, 0, 4, 3))
    emit_garbage(0x11, 0x22, 0x33, 0x44)
    # 2. ATTITUDE
    emit_v2(1, 1, 1, v2_factory.attitude_encode(12345, 0.1, -0.2, 3.14159, 0.01, 0.02, 0.03))
    # 3. PARAM_VALUE (16-char param_id field, exercises char[] decode)
    emit_v2(2, 1, 1, v2_factory.param_value_encode(b'THR_MIN', 0.15000000596046448, 9, 50, 3))
    emit_garbage(0x55, 0x66)
    # 4. STATUSTEXT with nonzero extension fields (id, chunk_seq)
    emit_v2(3, 1, 1, v2_factory.statustext_encode(6, b'preflight check pass', 42, 1))
    # 5. STATUSTEXT with all-zero extensions -> encode-time truncated away
    #    entirely, exercising decode.ts's zero-extension on a shorter wire payload.
    emit_v2(4, 1, 1, v2_factory.statustext_encode(2, b'ok', 0, 0))
    # 6. COMMAND_ACK with nonzero extension fields
    emit_v2(5, 1, 1, v2_factory.command_ack_encode(
        400, 0, progress=50, result_param2=7, target_system=1, target_component=1,
    ))
    emit_garbage(0x77)
    # 7. MAVLink1 HEARTBEAT
    emit_v1(6, 2, 2, v1_factory.heartbeat_encode(6, 8, 0, 0, 0))

    (FIXTURES_DIR / 'frames.bin').write_bytes(bytes(stream))
    manifest = {
        'generatedBy': 'scripts/gen-fixtures.py',
        'pymavlinkVersion': pymavlink.__version__,
        'frames': entries,
    }
    (FIXTURES_DIR / 'frames.expected.json').write_text(json.dumps(manifest, indent=2) + '\n')

    print(f'wrote {len(stream)} bytes to frames.bin, {len(entries)} frame entries to frames.expected.json')


if __name__ == '__main__':
    main()
