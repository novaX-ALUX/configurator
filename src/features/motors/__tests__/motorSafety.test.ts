import { describe, expect, it, vi } from 'vitest'
import { MotorSafety } from '../motorSafety'

/** Fake clock + spies, mirroring the injected-`now` pattern used by flashSession.ts/accelCal.ts tests — the whole point of this module is that it never reads a real clock, so every test drives time by hand. */
function harness(overrides: { countdownMs?: number; idleLockMs?: number; spinIdleMs?: number; renewMs?: number; stallStopMs?: number } = {}) {
  let clock = 0
  const onStop = vi.fn()
  const onRenew = vi.fn()
  const safety = new MotorSafety({
    now: () => clock,
    onStop,
    onRenew,
    ...overrides,
  })
  return {
    safety,
    onStop,
    onRenew,
    advance: (ms: number) => {
      clock += ms
    },
    set: (ms: number) => {
      clock = ms
    },
  }
}

/** Arms straight through to 'ready' (propsConfirmed -> enable -> tick past the countdown). */
function arm(h: ReturnType<typeof harness>): void {
  h.safety.confirmProps(true)
  h.safety.enable()
  h.advance(h.safety.countdown || 3000)
  h.safety.tick()
}

/**
 * Advances the fake clock in `stepMs` increments (default 200ms — the real
 * page's own tick cadence), calling `tick()` at every step, instead of one
 * big jump. Required for any 'testing'-state boundary test that spans more
 * than a couple hundred ms: the stall detector (`stallStopMs`, motorSafety.ts)
 * deliberately can no longer tell a single huge `tick()` gap apart from a
 * genuinely stalled tick loop, so a lone big jump now (correctly) trips it.
 * Ticking periodically here keeps `lastRenew` fresh exactly like a real page
 * would, so these tests still land on the intended idle/spin boundary
 * instead of the stall boundary.
 */
function tickOverTime(h: ReturnType<typeof harness>, totalMs: number, stepMs = 200): void {
  let remaining = totalMs
  while (remaining > 0) {
    const step = Math.min(stepMs, remaining)
    h.advance(step)
    h.safety.tick()
    remaining -= step
  }
}

describe('MotorSafety', () => {
  describe('initial state', () => {
    it('starts locked, unconfirmed, with all readouts at zero', () => {
      const { safety } = harness()
      expect(safety.state).toBe('locked')
      expect(safety.propsConfirmed).toBe(false)
      expect(safety.countdown).toBe(0)
      expect(safety.idleLeft).toBe(0)
      expect(safety.stopLeft).toBe(0)
    })
  })

  describe('enable()', () => {
    it('is a no-op without propsConfirmed', () => {
      const { safety } = harness()
      safety.enable()
      expect(safety.state).toBe('locked')
      expect(safety.countdown).toBe(0)
    })

    it('starts the countdown once propsConfirmed and locked', () => {
      const { safety } = harness()
      safety.confirmProps(true)
      safety.enable()
      expect(safety.state).toBe('counting')
      expect(safety.countdown).toBe(3000)
    })

    it('is a no-op when not locked (already counting/ready/testing)', () => {
      const { safety, advance } = harness()
      safety.confirmProps(true)
      safety.enable()
      advance(100)
      safety.tick()
      const countdownBefore = safety.countdown
      safety.enable() // already 'counting' — must not restart the countdown
      expect(safety.countdown).toBe(countdownBefore)
    })

    it('respects a custom countdownMs', () => {
      const { safety } = harness({ countdownMs: 1500 })
      safety.confirmProps(true)
      safety.enable()
      expect(safety.countdown).toBe(1500)
    })
  })

  describe('countdown -> ready', () => {
    it('stays counting just before the boundary, flips to ready exactly at it', () => {
      const { safety, set } = harness()
      safety.confirmProps(true)
      safety.enable() // t=0
      set(2999)
      safety.tick()
      expect(safety.state).toBe('counting')
      expect(safety.countdown).toBe(1)

      set(3000)
      safety.tick()
      expect(safety.state).toBe('ready')
      expect(safety.countdown).toBe(0)
      expect(safety.idleLeft).toBe(30000)
    })

    it('ticking again once ready does not re-enter counting', () => {
      const { safety, set } = harness()
      safety.confirmProps(true)
      safety.enable()
      set(3000)
      safety.tick()
      set(3100)
      safety.tick()
      expect(safety.state).toBe('ready')
    })
  })

  describe('confirmProps()', () => {
    it('revoking while locked does not stop (nothing armed to stop)', () => {
      const { safety, onStop } = harness()
      safety.confirmProps(true)
      safety.confirmProps(false)
      expect(onStop).not.toHaveBeenCalled()
      expect(safety.state).toBe('locked')
      expect(safety.propsConfirmed).toBe(false)
    })

    it('revoking while counting stops with the exact reason', () => {
      const { safety, onStop } = harness()
      safety.confirmProps(true)
      safety.enable()
      safety.confirmProps(false)
      expect(onStop).toHaveBeenCalledTimes(1)
      expect(onStop).toHaveBeenCalledWith('Prop confirmation revoked')
      expect(safety.state).toBe('locked')
    })

    it('revoking while ready stops', () => {
      const h = harness()
      arm(h)
      h.safety.confirmProps(false)
      expect(h.onStop).toHaveBeenCalledWith('Prop confirmation revoked')
      expect(h.safety.state).toBe('locked')
    })

    it('revoking while testing stops', () => {
      const h = harness()
      arm(h)
      h.safety.setSpinning(true, [1])
      h.safety.confirmProps(false)
      expect(h.onStop).toHaveBeenCalledWith('Prop confirmation revoked')
      expect(h.safety.state).toBe('locked')
    })

    it('confirming true never stops', () => {
      const { safety, onStop } = harness()
      safety.confirmProps(true)
      expect(onStop).not.toHaveBeenCalled()
    })

    it('propsConfirmed survives an auto-stop, so re-enable() needs no re-check', () => {
      const h = harness()
      arm(h)
      h.safety.setSpinning(true, [1])
      h.advance(5000) // spin-idle boundary
      h.safety.tick()
      expect(h.safety.state).toBe('locked')
      expect(h.safety.propsConfirmed).toBe(true) // untouched by stop()
      h.safety.enable() // works again without re-calling confirmProps
      expect(h.safety.state).toBe('counting')
    })
  })

  describe('auto-lock (armed idle, 30s default)', () => {
    it('does not stop just before the boundary, stops exactly at it', () => {
      const h = harness()
      arm(h)
      expect(h.safety.state).toBe('ready')

      h.advance(29999)
      h.safety.tick()
      expect(h.safety.state).toBe('ready')
      expect(h.onStop).not.toHaveBeenCalled()
      expect(h.safety.idleLeft).toBe(1)

      h.advance(1)
      h.safety.tick()
      expect(h.safety.state).toBe('locked')
      expect(h.onStop).toHaveBeenCalledTimes(1)
      expect(h.onStop).toHaveBeenCalledWith('auto-lock')
    })

    it('noteActivity() resets the idle clock (boundary re-verified after reset)', () => {
      const h = harness()
      arm(h)

      h.advance(29900)
      h.safety.tick()
      expect(h.safety.state).toBe('ready') // not yet at 30000

      h.safety.noteActivity() // resets lastAct
      h.advance(29900)
      h.safety.tick()
      expect(h.safety.state).toBe('ready') // would have been 59800 without the reset
      expect(h.onStop).not.toHaveBeenCalled()

      h.advance(100)
      h.safety.tick()
      expect(h.safety.state).toBe('locked')
      expect(h.onStop).toHaveBeenCalledWith('auto-lock')
    })

    it('respects a custom idleLockMs', () => {
      const h = harness({ idleLockMs: 1000 })
      arm(h)
      h.advance(999)
      h.safety.tick()
      expect(h.safety.state).toBe('ready')
      h.advance(1)
      h.safety.tick()
      expect(h.safety.state).toBe('locked')
      expect(h.onStop).toHaveBeenCalledWith('auto-lock')
    })

    it('does not fire onRenew while ready', () => {
      const h = harness()
      arm(h)
      h.advance(10000)
      h.safety.tick()
      expect(h.onRenew).not.toHaveBeenCalled()
    })
  })

  describe('setSpinning() ready <-> testing', () => {
    it('transitions ready -> testing, tracks activeMotors, resets stopLeft/idleLeft', () => {
      const h = harness()
      arm(h)
      h.safety.setSpinning(true, [2, 3])
      expect(h.safety.state).toBe('testing')
      expect(h.safety.stopLeft).toBe(5000)
      expect(h.safety.idleLeft).toBe(0)
    })

    it('transitions testing -> ready, clears the spin-idle readout, restarts the idle-lock readout', () => {
      const h = harness()
      arm(h)
      h.safety.setSpinning(true, [1])
      h.advance(1000)
      h.safety.setSpinning(false, [])
      expect(h.safety.state).toBe('ready')
      expect(h.safety.stopLeft).toBe(0)
      expect(h.safety.idleLeft).toBe(30000)
    })

    it('setSpinning(true) is a no-op while locked', () => {
      const { safety } = harness()
      safety.setSpinning(true, [1])
      expect(safety.state).toBe('locked')
    })

    it('setSpinning(true) is a no-op while counting', () => {
      const { safety } = harness()
      safety.confirmProps(true)
      safety.enable()
      safety.setSpinning(true, [1])
      expect(safety.state).toBe('counting')
    })

    it('setSpinning(false) while already ready is a no-op (no idle-clock reset side effect)', () => {
      const h = harness()
      arm(h)
      h.advance(100)
      h.safety.tick()
      const idleLeftBefore = h.safety.idleLeft
      h.safety.setSpinning(false, [])
      expect(h.safety.state).toBe('ready')
      expect(h.safety.idleLeft).toBe(idleLeftBefore) // untouched — not silently refreshed
    })

    it('setSpinning(true) while already testing updates activeMotors and refreshes lastAct without changing state', () => {
      const h = harness()
      arm(h)
      h.safety.setSpinning(true, [1])
      tickOverTime(h, 2000)
      expect(h.safety.stopLeft).toBe(3000)
      h.safety.setSpinning(true, [1, 4]) // refreshes lastAct
      expect(h.safety.state).toBe('testing')
      tickOverTime(h, 4000) // would have tripped auto-stop well before this without the lastAct refresh above
      expect(h.safety.state).toBe('testing')
      expect(h.onRenew).toHaveBeenCalledWith([1, 4])
    })
  })

  describe('auto-stop (spinning idle, 5s default)', () => {
    it('does not stop at 4.9s, stops exactly at 5.0s', () => {
      const h = harness()
      arm(h)
      h.safety.setSpinning(true, [1])

      // Periodic ticks (not one big jump) — see tickOverTime's doc: a lone
      // 4900ms jump is now indistinguishable from a stalled tick loop and
      // would (correctly) trip the stall detector instead of this boundary.
      tickOverTime(h, 4900)
      expect(h.safety.state).toBe('testing')
      expect(h.onStop).not.toHaveBeenCalled()
      expect(h.safety.stopLeft).toBe(100)

      tickOverTime(h, 100)
      expect(h.safety.state).toBe('locked')
      expect(h.onStop).toHaveBeenCalledWith('auto-stop')
    })

    it('noteActivity() resets the spin-idle clock', () => {
      const h = harness()
      arm(h)
      h.safety.setSpinning(true, [1])

      tickOverTime(h, 4900)
      expect(h.safety.state).toBe('testing')

      h.safety.noteActivity()
      tickOverTime(h, 4900)
      expect(h.safety.state).toBe('testing') // would have tripped at 9800 without the reset
      expect(h.onStop).not.toHaveBeenCalled()

      tickOverTime(h, 100)
      expect(h.safety.state).toBe('locked')
      expect(h.onStop).toHaveBeenCalledWith('auto-stop')
    })

    it('respects a custom spinIdleMs', () => {
      const h = harness({ spinIdleMs: 800 })
      arm(h)
      h.safety.setSpinning(true, [1])
      h.advance(799)
      h.safety.tick()
      expect(h.safety.state).toBe('testing')
      h.advance(1)
      h.safety.tick()
      expect(h.safety.state).toBe('locked')
      expect(h.onStop).toHaveBeenCalledWith('auto-stop')
    })
  })

  describe('onRenew (short-timeout command renewal while testing)', () => {
    it('fires every renewMs with the current activeMotors while testing', () => {
      const h = harness()
      arm(h)
      h.safety.setSpinning(true, [1, 2])

      h.advance(399)
      h.safety.tick()
      expect(h.onRenew).not.toHaveBeenCalled()

      h.advance(1) // t=400
      h.safety.tick()
      expect(h.onRenew).toHaveBeenCalledTimes(1)
      expect(h.onRenew).toHaveBeenLastCalledWith([1, 2])

      h.advance(400) // t=800
      h.safety.tick()
      expect(h.onRenew).toHaveBeenCalledTimes(2)

      h.advance(400) // t=1200
      h.safety.tick()
      expect(h.onRenew).toHaveBeenCalledTimes(3)
    })

    it('never fires while locked', () => {
      const { safety, advance, onRenew } = harness()
      advance(10000)
      safety.tick()
      expect(onRenew).not.toHaveBeenCalled()
    })

    it('stops firing once stopped (testing -> auto-stop)', () => {
      const h = harness()
      arm(h)
      h.safety.setSpinning(true, [1])
      h.advance(5000)
      h.safety.tick() // auto-stop fires
      h.onRenew.mockClear()
      h.advance(400)
      h.safety.tick()
      expect(h.onRenew).not.toHaveBeenCalled()
    })

    it('respects a custom renewMs', () => {
      const h = harness({ renewMs: 100 })
      arm(h)
      h.safety.setSpinning(true, [5])
      h.advance(100)
      h.safety.tick()
      expect(h.onRenew).toHaveBeenCalledTimes(1)
    })
  })

  // Adversarial-review fix: if the JS thread itself stalls (GC pause, tab
  // backgrounded, debugger breakpoint, ...) for longer than a real FC
  // command's own timeout but still under spinIdleMs, a naive tick() would
  // resume renewing as if nothing happened — silently re-arming a motor
  // that may have already safe-failed stopped, without ever reconfirming
  // the user is still present. `stallStopMs` (default
  // max(renewMs*3, 1000) = 1200ms here) is the threshold `tick()` uses to
  // tell a stalled loop apart from ordinary renewal.
  describe('stalled-tick detection (stallStopMs)', () => {
    it('(a) regression: a normal ~200ms tick cadence keeps renewing indefinitely and never trips the stall detector', () => {
      const h = harness()
      arm(h)
      h.safety.setSpinning(true, [3])

      tickOverTime(h, 3000) // well past several renewMs(400) cycles, delivered on a realistic cadence
      expect(h.safety.state).toBe('testing')
      expect(h.onStop).not.toHaveBeenCalled()
      expect(h.onRenew.mock.calls.length).toBeGreaterThanOrEqual(6) // ~3000/400 renew cycles
      expect(h.onRenew).toHaveBeenLastCalledWith([3])
    })

    it('(b) a tick() gap beyond the stall threshold (but under spinIdleMs) stops instead of renewing', () => {
      const h = harness()
      arm(h)
      h.safety.setSpinning(true, [7])

      h.advance(2000) // > stallStopMs(1200), < spinIdleMs(5000) — one big gap simulating a stalled tick loop
      h.safety.tick()

      expect(h.safety.state).toBe('locked')
      expect(h.onStop).toHaveBeenCalledTimes(1)
      expect(h.onStop).toHaveBeenCalledWith('auto-stop: tick stall detected, outputs may have lapsed')
      expect(h.onRenew).not.toHaveBeenCalled() // must NOT silently re-arm across the gap
    })

    it('(c) boundary: no stall just under stallStopMs, stall-stops exactly at it', () => {
      const below = harness()
      arm(below)
      below.safety.setSpinning(true, [9])
      below.advance(1199) // stallStopMs(1200) - 1; single tick, no earlier renew to move the reference point
      below.safety.tick()
      expect(below.safety.state).toBe('testing')
      expect(below.onStop).not.toHaveBeenCalled()

      const at = harness()
      arm(at)
      at.safety.setSpinning(true, [9])
      at.advance(1200) // exactly stallStopMs
      at.safety.tick()
      expect(at.safety.state).toBe('locked')
      expect(at.onStop).toHaveBeenCalledWith('auto-stop: tick stall detected, outputs may have lapsed')
    })

    it('respects a custom stallStopMs', () => {
      // Two independent harnesses, each driven by a single tick() call right
      // at the boundary — an intermediate tick (e.g. at 599 then +1) would
      // itself fire a normal renew and reset the reference point, the same
      // pitfall test (c) above avoids.
      const below = harness({ stallStopMs: 600 })
      arm(below)
      below.safety.setSpinning(true, [1])
      below.advance(599)
      below.safety.tick()
      expect(below.safety.state).toBe('testing')

      const at = harness({ stallStopMs: 600 })
      arm(at)
      at.safety.setSpinning(true, [1])
      at.advance(600)
      at.safety.tick()
      expect(at.safety.state).toBe('locked')
      expect(at.onStop).toHaveBeenCalledWith('auto-stop: tick stall detected, outputs may have lapsed')
    })
  })

  describe('stop()', () => {
    it('is a no-op when already locked (does not re-fire onStop)', () => {
      const { safety, onStop } = harness()
      safety.stop('whatever')
      expect(onStop).not.toHaveBeenCalled()
      expect(safety.state).toBe('locked')
    })

    it('fires exactly once from counting, with the given reason', () => {
      const { safety, onStop } = harness()
      safety.confirmProps(true)
      safety.enable()
      safety.stop('Escape')
      expect(onStop).toHaveBeenCalledTimes(1)
      expect(onStop).toHaveBeenCalledWith('Escape')
      expect(safety.state).toBe('locked')
      expect(safety.countdown).toBe(0)
    })

    it('fires exactly once from ready, with the given reason', () => {
      const h = harness()
      arm(h)
      h.safety.stop('window blurred')
      expect(h.onStop).toHaveBeenCalledTimes(1)
      expect(h.onStop).toHaveBeenCalledWith('window blurred')
      expect(h.safety.idleLeft).toBe(0)
    })

    it('fires exactly once from testing, with the given reason, and clears readouts', () => {
      const h = harness()
      arm(h)
      h.safety.setSpinning(true, [1, 2])
      h.safety.stop('tab hidden')
      expect(h.onStop).toHaveBeenCalledTimes(1)
      expect(h.onStop).toHaveBeenCalledWith('tab hidden')
      expect(h.safety.state).toBe('locked')
      expect(h.safety.stopLeft).toBe(0)

      // Renewal must not keep firing for the now-cleared activeMotors.
      h.advance(400)
      h.safety.tick()
      expect(h.onRenew).not.toHaveBeenCalled()
    })

    it('a second stop() call after already-locked does not double-fire', () => {
      const h = harness()
      arm(h)
      h.safety.stop('STOP button')
      h.safety.stop('STOP button')
      expect(h.onStop).toHaveBeenCalledTimes(1)
    })

    it('each kill-switch reason string passes through distinctly', () => {
      const reasons = ['window blurred', 'tab hidden', 'Escape', 'left motor page', 'props revoked', 'STOP button']
      for (const reason of reasons) {
        const h = harness()
        arm(h)
        h.safety.stop(reason)
        expect(h.onStop).toHaveBeenCalledWith(reason)
      }
    })
  })

  describe('readouts are mutually exclusive per state', () => {
    it('only one of countdown/idleLeft/stopLeft is non-zero at a time', () => {
      const h = harness()
      h.safety.confirmProps(true)
      h.safety.enable() // counting
      expect([h.safety.countdown > 0, h.safety.idleLeft > 0, h.safety.stopLeft > 0].filter(Boolean).length).toBe(1)

      h.advance(3000)
      h.safety.tick() // ready
      expect(h.safety.countdown).toBe(0)
      expect(h.safety.idleLeft).toBeGreaterThan(0)
      expect(h.safety.stopLeft).toBe(0)

      h.safety.setSpinning(true, [1]) // testing
      expect(h.safety.countdown).toBe(0)
      expect(h.safety.idleLeft).toBe(0)
      expect(h.safety.stopLeft).toBeGreaterThan(0)

      h.safety.stop('done') // locked
      expect(h.safety.countdown).toBe(0)
      expect(h.safety.idleLeft).toBe(0)
      expect(h.safety.stopLeft).toBe(0)
    })
  })
})
