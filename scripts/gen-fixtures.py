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

Task 5.3 (M2) adds a *companion* fixture pair, deliberately kept separate
from the M1 files above rather than appended to them, because
router.test.ts's M1 integration test asserts the exact ordered list of
message names decoded from frames.bin (and an exact component count) --
appending frames there would silently break that assertion. The companion
pair covers the M2 telemetry/calibration/motor-test message set:

  - src/core/mavlink/__tests__/fixtures/frames-m2.bin
      HEARTBEAT (disarmed), HEARTBEAT (armed), ATTITUDE, SYS_STATUS (normal),
      SYS_STATUS (battery_remaining=-1 sentinel), GPS_RAW_INT (normal),
      GPS_RAW_INT (eph=65535 sentinel), RC_CHANNELS, SERVO_OUTPUT_RAW,
      COMMAND_LONG cmd=42429 (ACCELCAL_VEHICLE_POS) once per face value plus
      the success/failure sentinels, MAG_CAL_PROGRESS x2 (compass_id 0 and
      1), MAG_CAL_REPORT x2 (compass_id 0 and 1), and a COMMAND_ACK for
      DO_MOTOR_TEST (209) with result=ACCEPTED. No injected garbage bytes
      (frames-m2.bin is one real frame after another).

  - src/core/mavlink/__tests__/fixtures/frames-m2.expected.json
      Same schema as frames.expected.json above, one entry per frame in
      frames-m2.bin.

  ACCELCAL_VEHICLE_POS's param1 face/success/failure values are pymavlink's
  own `ACCELCAL_VEHICLE_POS_*` enum (ardupilotmega dialect): LEVEL=1,
  LEFT=2, RIGHT=3, NOSEDOWN=4, NOSEUP=5, BACK=6, SUCCESS=16777215,
  FAILED=16777216.

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


def write_fixture(bin_name, json_name, stream, entries):
    (FIXTURES_DIR / bin_name).write_bytes(bytes(stream))
    manifest = {
        'generatedBy': 'scripts/gen-fixtures.py',
        'pymavlinkVersion': pymavlink.__version__,
        'frames': entries,
    }
    (FIXTURES_DIR / json_name).write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'wrote {len(stream)} bytes to {bin_name}, {len(entries)} frame entries to {json_name}')


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

    write_fixture('frames.bin', 'frames.expected.json', stream, entries)

    # --- Task 5.3 (M2): companion fixture pair, see module doc ------------
    stream_m2 = bytearray()
    entries_m2 = []

    def emit_m2(seq, sysid, compid, msg):
        sink = ByteSink()
        mav = mavlink2.MAVLink(sink, srcSystem=sysid, srcComponent=compid)
        mav.seq = seq
        mav.send(msg)
        wire = bytes(sink.data)
        stream_m2.extend(wire)
        entries_m2.append(decode_entry(2, wire))

    seq = 0

    def next_seq():
        nonlocal seq
        seq = (seq + 1) % 256
        return seq - 1

    # -- Telemetry (sysid=1, compid=1, "the FC") ----------------------------
    # 1. HEARTBEAT, disarmed (base_mode bit 0x80 clear).
    emit_m2(next_seq(), 1, 1, v2_factory.heartbeat_encode(2, 3, 0x41, 0, 3))
    # 2. HEARTBEAT, armed (base_mode bit 0x80 set).
    emit_m2(next_seq(), 1, 1, v2_factory.heartbeat_encode(2, 3, 0xC1, 5, 4))
    # 3. ATTITUDE (~0.05rad roll, per the task brief).
    emit_m2(next_seq(), 1, 1, v2_factory.attitude_encode(123456, 0.05, -0.03, 1.2, 0.001, -0.002, 0.0015))
    # 4. SYS_STATUS, realistic non-sentinel values.
    emit_m2(next_seq(), 1, 1, v2_factory.sys_status_encode(
        0x1fff, 0x1fff, 0x1fff, 300, 12600, 150, 87, 0, 0, 0, 0, 0, 0,
    ))
    # 5. SYS_STATUS, battery_remaining=-1 ("unknown") sentinel.
    emit_m2(next_seq(), 1, 1, v2_factory.sys_status_encode(
        0x1fff, 0x1fff, 0x1fff, 300, 11800, 120, -1, 0, 0, 0, 0, 0, 0,
    ))
    # 6. GPS_RAW_INT, realistic 3D fix.
    emit_m2(next_seq(), 1, 1, v2_factory.gps_raw_int_encode(
        123456789, 3, 473977420, 85455940, 488000, 120, 150, 350, 9000, 14,
    ))
    # 7. GPS_RAW_INT, eph=65535 ("unknown" hdop) sentinel, no fix.
    emit_m2(next_seq(), 1, 1, v2_factory.gps_raw_int_encode(
        123457789, 0, 473977420, 85455940, 488000, 65535, 65535, 0, 0, 0,
    ))
    # 8. RC_CHANNELS (8 channels populated, 9-18 unused).
    emit_m2(next_seq(), 1, 1, v2_factory.rc_channels_encode(
        123456, 8, 1500, 1600, 1000, 1900, 1100, 1700, 1300, 1450,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200,
    ))
    # 9. SERVO_OUTPUT_RAW (8 outputs populated, 9-16 unused).
    emit_m2(next_seq(), 1, 1, v2_factory.servo_output_raw_encode(
        123456789, 0, 1500, 1520, 1480, 1600, 1400, 1550, 1600, 1450,
    ))

    # -- Inbound COMMAND_LONG cmd=42429 (ACCELCAL_VEHICLE_POS), FC -> GCS ---
    # param1 values are pymavlink's own ACCELCAL_VEHICLE_POS_* enum (see
    # module doc): one frame per face, plus the success/failure sentinels.
    ACCELCAL_VEHICLE_POS_CMD = 42429
    accelcal_positions = [
        mavlink2.ACCELCAL_VEHICLE_POS_LEVEL,
        mavlink2.ACCELCAL_VEHICLE_POS_LEFT,
        mavlink2.ACCELCAL_VEHICLE_POS_RIGHT,
        mavlink2.ACCELCAL_VEHICLE_POS_NOSEDOWN,
        mavlink2.ACCELCAL_VEHICLE_POS_NOSEUP,
        mavlink2.ACCELCAL_VEHICLE_POS_BACK,
        mavlink2.ACCELCAL_VEHICLE_POS_SUCCESS,
        mavlink2.ACCELCAL_VEHICLE_POS_FAILED,
    ]
    for param1 in accelcal_positions:
        emit_m2(next_seq(), 1, 1, v2_factory.command_long_encode(
            255, 0, ACCELCAL_VEHICLE_POS_CMD, 0, float(param1), 0, 0, 0, 0, 0, 0,
        ))

    # -- Compass cal: MAG_CAL_PROGRESS/MAG_CAL_REPORT, compass_id 0 and 1 --
    # (fan-out: a board with 2 compasses calibrating both at once.)
    for compass_id, direction in ((0, (0.5, 0.2, -0.1)), (1, (0.3, 0.4, -0.2))):
        emit_m2(next_seq(), 1, 1, v2_factory.mag_cal_progress_encode(
            compass_id, 0x03, mavlink2.MAG_CAL_RUNNING_STEP_TWO, 1, 45,
            [255, 255, 255, 255, 0, 0, 0, 0, 0, 0], *direction,
        ))
    for compass_id, offsets in ((0, (15.2, -8.7, 22.1)), (1, (10.1, 5.4, -3.2))):
        emit_m2(next_seq(), 1, 1, v2_factory.mag_cal_report_encode(
            compass_id, 0x03, mavlink2.MAG_CAL_SUCCESS, 1, 1.25,
            *offsets, 1.002, 0.998, 1.001, 0.01, -0.02, 0.005,
            orientation_confidence=0.95, old_orientation=0, new_orientation=0, scale_factor=1.0,
        ))

    # -- Motor test ACK: COMMAND_ACK for DO_MOTOR_TEST (209), ACCEPTED. -----
    DO_MOTOR_TEST_CMD = 209
    MAV_RESULT_ACCEPTED = 0
    emit_m2(next_seq(), 1, 1, v2_factory.command_ack_encode(
        DO_MOTOR_TEST_CMD, MAV_RESULT_ACCEPTED, target_system=1, target_component=1,
    ))

    write_fixture('frames-m2.bin', 'frames-m2.expected.json', stream_m2, entries_m2)


if __name__ == '__main__':
    main()
