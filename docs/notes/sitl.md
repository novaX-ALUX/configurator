# SITL bridge + integration test (Task 2.6)

How to build and launch ArduPilot SITL, run `tools/sitl-bridge.mjs`, and
exercise the real-protocol integration suite in
`src/core/__tests__/sitl.integration.test.ts`. This is a manual/nightly
gate, not part of CI — `npm test` skips the SITL test by default (see
"Running the integration test" below). CI's real-protocol confidence comes
from `src/core/mavlink/__tests__/fixtures.test.ts` (pymavlink-generated
fixtures), not from a live SITL process.

## 1. Build ArduPilot Copter SITL

The firmware submodule lives at
`../flight_controller/firmware/ardupilot` relative to this repo (adjust the
path below if your checkout differs). This repo never modifies that
submodule — only its own `build/` directory gets artifacts, which is normal
and is not something we commit.

```
cd flight_controller/firmware/ardupilot   # or wherever the submodule is checked out
./waf configure --board sitl
./waf copter -j"$(nproc)"
```

**First run takes a while.** A clean `--board sitl` configure + `./waf
copter` build compiles the full ArduCopter firmware for your host
architecture — expect several minutes on a modest machine (it was ~48s on a
16-core machine with a warm compiler cache; a cold cache or fewer cores can
take much longer). Subsequent builds are incremental and fast. The output
binary lands at `build/sitl/bin/arducopter`.

### Python dependencies

`waf configure`/`waf copter` need a Python 3 toolchain with `empy` (used by
ArduPilot's own code generation) on `sys.path`. If configure fails with
`ModuleNotFoundError: No module named 'em'`, install it:

```
python3 -m pip install --user empy pexpect future pymavlink
```

(`pexpect` is also installable via `apt install python3-pexpect` if you'd
rather not touch pip for it.) If pip refuses with `error:
externally-managed-environment` (PEP 668, common on Debian/Ubuntu), either
add `--break-system-packages` to the `pip install` above, or create a venv
and point `python3`/`waf` at it — either works, this is throwaway build
tooling for SITL, not anything shipped by this repo.

You do **not** need `MAVProxy` — the commands below launch the SITL binary
directly (or `sim_vehicle.py --no-mavproxy`, see the alternative below),
never a MAVProxy-driven `sim_vehicle.py` session.

## 2. Launch SITL

Run the built binary directly from some scratch working directory (it
writes `eeprom.bin` and logs into its current directory, so don't run it
from inside the ardupilot checkout unless you don't mind those files
appearing there):

```
mkdir -p /tmp/sitl-run && cd /tmp/sitl-run
/path/to/ardupilot/build/sitl/bin/arducopter -I0 --model quad \
  --home -35.363261,149.165230,584,353
```

You should see:

```
bind port 5760 for SERIAL0
SERIAL0 on TCP port 5760
Waiting for connection ....
```

SITL is now listening for a MAVLink client on **TCP `localhost:5760`**
(SERIAL0 — `-I0` means instance 0, i.e. no port offset). Leave it running;
`Ctrl-C` to stop.

**Alternative:** `Tools/autotest/sim_vehicle.py -v ArduCopter --no-mavproxy
-N` (`-N`/`--no-rebuild` skips re-invoking waf if you already built above)
does the same thing plus some conveniences (parameter defaults, EEPROM
location under the autotest tree) — use it if you want ArduPilot's own
"the way autotest does it" setup instead of the bare binary. `--no-mavproxy`
means it never imports `MAVProxy` (that import only happens inside the
function `start_mavproxy()`, which isn't called), so no extra Python
package is needed beyond what building SITL already requires.

## 3. Launch the bridge

From this repo's root:

```
node tools/sitl-bridge.mjs [wsPort] [tcpHost] [tcpPort]
# defaults: wsPort=5761, tcpHost=localhost, tcpPort=5760
node tools/sitl-bridge.mjs
```

This opens a WebSocket listener on `ws://localhost:5761` and, for each
client that connects, opens its own TCP connection to
`tcpHost:tcpPort` (SITL's `5760` by default) and relays bytes unmodified in
both directions. Connect/disconnect events and byte counts are logged to
stderr; `Ctrl-C` shuts it down cleanly (closes any open client/TCP pairs
first).

`ws` is a devDependency (not a runtime dependency of the app) added
specifically for this script — Node's own global `WebSocket` (used
everywhere else in this repo, including the integration test below) is a
*client* implementation only and has no server counterpart, so a WebSocket
*server* needs either `ws` or a hand-rolled RFC6455 server. `ws` was chosen
over hand-rolling: this script never ships in the production bundle (it's
only ever invoked standalone via `node tools/sitl-bridge.mjs`, never
imported by `src/`), so there's no bundle-size or license-surface reason to
avoid a well-maintained dependency here the way `mavlink-mappings` is
confined to one file (see `decisions-m1.md`) for a dependency that *does*
ship.

## 4. Run the integration suite

With SITL and the bridge both running (steps 2-3):

```
SITL=1 npx vitest run src/core/__tests__/sitl.integration.test.ts
```

The test connects `WebSocketTransport` to `ws://localhost:5761` (override
with `SITL_WS_URL`), starts a `MavRouter`, waits for `linkState` to reach
`'connected'` (first HEARTBEAT), runs `ParamStore.fetchAll()` (asserts
>500 params collected, which also implies none were left missing —
`fetchAll()` itself rejects on an incomplete table), then reads
`LOG_BITMASK`, writes it to a different value with `set()`, asserts the
echo confirms the write, and restores the original value — again
confirmed by `set()`'s echo, so the test leaves SITL exactly as it found
it. Timeouts are generous (up to 60s total) since a real param storm over
TCP is much slower than the `MockTransport`-backed unit tests elsewhere in
`src/core/mavlink/__tests__/`.

Without `SITL=1` (e.g. plain `npm test`), the test is skipped — this is the
normal/CI path, no SITL or bridge needed.

## Troubleshooting

- **`Address already in use` on port 5760/5761/9002/9003.** A previous SITL
  or bridge process is probably still running. Find and kill it:
  `pkill -f 'bin/arducopter'` / `pkill -f 'sitl-bridge.mjs'`, then check
  with `ss -ltn | grep 576` that the ports are free before relaunching.
- **Test hangs / times out waiting for `'connected'`.** Confirm SITL logged
  `Waiting for connection ....` (i.e. it's actually up) and the bridge
  logged `tcp connected to <host>:<port>` for your test's connection
  attempt — if the bridge shows `client connected` but never `tcp
  connected`, SITL isn't listening on the port the bridge is configured to
  reach.
- **SITL parameters look wrong / stale from a previous run.** SITL persists
  its parameters into `eeprom.bin` in whatever directory it was launched
  from. Wipe it and restart with `-w`/`--wipe`:
  `arducopter -I0 --model quad -w` (or just delete `eeprom.bin` in that
  directory before relaunching) to reset to firmware defaults.
- **`ModuleNotFoundError: No module named 'em'` from `waf configure`/`waf
  copter`.** See "Python dependencies" above — `empy`'s importable module
  name is `em`, not `empy`.
- **pip: `externally-managed-environment`.** See "Python dependencies"
  above — add `--break-system-packages` or use a venv.
