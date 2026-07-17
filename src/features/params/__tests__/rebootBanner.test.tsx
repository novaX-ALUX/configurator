import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { ParamsPage } from '../ParamsPage'
import { useConnectionStore } from '../../../store/connection'
import { MockTransport } from '../../../core/transport/mock'
import { defs } from '../../../core/mavlink/defs'
import { decodePayload } from '../../../core/mavlink/decode'
import { encodeFrame, FrameParser } from '../../../core/mavlink/frame'
import { encodePayload } from '../../../core/mavlink/encode'
import { MavRouter } from '../../../core/mavlink/router'
import { ParamStore } from '../../../core/mavlink/params'
import type { MavSession } from '../../../core/mavlink/session'
import type { ParamMetaFile } from '../../../core/paramMetadata'

const PARAM_SET_MSGID = 23
const COMMAND_LONG_MSGID = 76
const MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN = 246
const MAV_PARAM_TYPE_REAL32 = 9

const initialConnectionState = useConnectionStore.getState()

afterEach(() => {
  useConnectionStore.setState(initialConnectionState, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function paramValueFrame(opts: { name: string; value: number; type?: number; count: number; index: number }): Uint8Array {
  const payload = encodePayload(defs, 22, {
    param_id: opts.name,
    param_value: opts.value,
    param_type: opts.type ?? MAV_PARAM_TYPE_REAL32,
    param_count: opts.count,
    param_index: opts.index,
  })
  return encodeFrame(defs, { msgid: 22, payload }, 0, 1, 1)
}

function decodeSent(bytes: Uint8Array): { msgid: number; fields: Record<string, unknown> } {
  const parser = new FrameParser(defs)
  const [frame] = parser.push(bytes)
  return { msgid: frame.msgid, fields: decodePayload(defs, frame).fields }
}

/**
 * Runs a real, successfully-completed `fetchAll()` seeded with these entries
 * before the page ever mounts — not just frames injected with no
 * `fetchAll()` ever called. Only a completed `fetchAll()` sets
 * `paramStore.fetchProgress.completed`, which is what `ParamsPage` gates
 * "already loaded" on (issue #20).
 */
async function feedAll(paramStore: ParamStore, transport: MockTransport, entries: Array<{ name: string; value: number; type?: number }>): Promise<void> {
  const fetchPromise = paramStore.fetchAll()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  entries.forEach((e, index) => {
    transport.feed(paramValueFrame({ name: e.name, value: e.value, type: e.type, count: entries.length, index }))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  await fetchPromise
}

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function mockMetaFetch(body: ParamMetaFile): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
}

/** A connected Session + ParamStore sharing one MockTransport/MavRouter, so a PARAM_SET echo and a COMMAND_LONG reboot send are both observable on the same `transport.sent`. */
async function makeConnected(): Promise<{ transport: MockTransport; paramStore: ParamStore; session: MavSession }> {
  const transport = new MockTransport()
  const router = new MavRouter(transport, defs, {})
  await transport.open()
  router.start()
  const target = { sysid: 1, compid: 1 }
  const paramStore = new ParamStore(router, target)
  const session: MavSession = { router, target, paramStore, telemetry: {} as MavSession['telemetry'] }
  return { transport, paramStore, session }
}

function stage(paramName: string, newValue: string): void {
  const input = screen.getByLabelText(paramName)
  fireEvent.change(input, { target: { value: newValue } })
  fireEvent.blur(input)
}

describe('ParamsPage: reboot-required banner + rebootFlightController (issue #17)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('shows the reboot banner after a write batch containing a rebootRequired param succeeds', async () => {
    mockMetaFetch({
      RC_OPTIONS: { displayName: 'RC options', description: 'x', rebootRequired: true },
    })
    const { transport, paramStore, session } = await makeConnected()
    await feedAll(paramStore, transport, [{ name: 'RC_OPTIONS', value: 0 }])
    useConnectionStore.setState({ phase: 'connected', paramStore, session, identity: { fwVersion: '4.6.3' } })
    render(<ParamsPage />)
    for (const button of screen.getAllByRole('button')) {
      if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button)
    }
    await tick() // let the metadata fetch resolve

    expect(screen.queryByText('Reboot required for changes to take effect')).not.toBeInTheDocument()

    stage('RC_OPTIONS', '1')
    fireEvent.click(screen.getByRole('button', { name: 'Review & write' }))
    fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
    await tick()
    transport.feed(paramValueFrame({ name: 'RC_OPTIONS', value: 1, count: 1, index: 0 }))
    await tick()
    await tick(2000) // transient 'ok' display window elapses, drawer auto-closes

    expect(screen.getByText('Reboot required for changes to take effect')).toBeInTheDocument()
  })

  it('does not show the banner when the written batch has no rebootRequired param', async () => {
    mockMetaFetch({
      THR_MIN: { displayName: 'Throttle min', description: 'x' },
    })
    const { transport, paramStore, session } = await makeConnected()
    await feedAll(paramStore, transport, [{ name: 'THR_MIN', value: 0 }])
    useConnectionStore.setState({ phase: 'connected', paramStore, session, identity: { fwVersion: '4.6.3' } })
    render(<ParamsPage />)
    for (const button of screen.getAllByRole('button')) {
      if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button)
    }
    await tick()

    stage('THR_MIN', '5')
    fireEvent.click(screen.getByRole('button', { name: 'Review & write' }))
    fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
    await tick()
    transport.feed(paramValueFrame({ name: 'THR_MIN', value: 5, count: 1, index: 0 }))
    await tick()
    await tick(2000)

    expect(screen.queryByText('Reboot required for changes to take effect')).not.toBeInTheDocument()
  })

  it('clicking Reboot asks for confirmation, then sends MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN through the Session\'s router/target -- not a raw hardcoded sysid', async () => {
    mockMetaFetch({
      RC_OPTIONS: { displayName: 'RC options', description: 'x', rebootRequired: true },
    })
    // Deliberately not sysid/compid 1/1's usual test default meaning here --
    // target comes from whatever the Session resolved, proving the command
    // isn't hand-addressed by feature code (ADR-0002 rule 3).
    const { transport, paramStore, session } = await makeConnected()
    await feedAll(paramStore, transport, [{ name: 'RC_OPTIONS', value: 0 }])
    useConnectionStore.setState({ phase: 'connected', paramStore, session, identity: { fwVersion: '4.6.3' } })
    render(<ParamsPage />)
    for (const button of screen.getAllByRole('button')) {
      if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button)
    }
    await tick()

    stage('RC_OPTIONS', '1')
    fireEvent.click(screen.getByRole('button', { name: 'Review & write' }))
    fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
    await tick()
    transport.feed(paramValueFrame({ name: 'RC_OPTIONS', value: 1, count: 1, index: 0 }))
    await tick()
    await tick(2000)

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Reboot' }))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    await tick()

    const sentCommands = transport.sent.filter((b) => decodeSent(b).msgid === COMMAND_LONG_MSGID)
    expect(sentCommands).toHaveLength(1)
    const cmd = decodeSent(sentCommands[0]).fields
    expect(cmd).toMatchObject({
      target_system: session.target.sysid,
      target_component: session.target.compid,
      command: MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
      param1: 1,
    })
    // No PARAM_SET was re-sent as part of the reboot flow -- only the one
    // earlier write and this one COMMAND_LONG.
    expect(transport.sent.filter((b) => decodeSent(b).msgid === PARAM_SET_MSGID)).toHaveLength(1)
  })

  it('does not send anything if the user cancels the confirm dialog', async () => {
    mockMetaFetch({
      RC_OPTIONS: { displayName: 'RC options', description: 'x', rebootRequired: true },
    })
    const { transport, paramStore, session } = await makeConnected()
    await feedAll(paramStore, transport, [{ name: 'RC_OPTIONS', value: 0 }])
    useConnectionStore.setState({ phase: 'connected', paramStore, session, identity: { fwVersion: '4.6.3' } })
    render(<ParamsPage />)
    for (const button of screen.getAllByRole('button')) {
      if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button)
    }
    await tick()

    stage('RC_OPTIONS', '1')
    fireEvent.click(screen.getByRole('button', { name: 'Review & write' }))
    fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
    await tick()
    transport.feed(paramValueFrame({ name: 'RC_OPTIONS', value: 1, count: 1, index: 0 }))
    await tick()
    await tick(2000)

    vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: 'Reboot' }))
    await tick()

    expect(transport.sent.filter((b) => decodeSent(b).msgid === COMMAND_LONG_MSGID)).toHaveLength(0)
    // Banner stays up -- nothing was actually sent.
    expect(screen.getByText('Reboot required for changes to take effect')).toBeInTheDocument()
  })

  it('disables the Reboot button whenever there is no live Session (ADR-0002 rule 1\'s declared safety pattern)', async () => {
    mockMetaFetch({
      RC_OPTIONS: { displayName: 'RC options', description: 'x', rebootRequired: true },
    })
    const { transport, paramStore, session } = await makeConnected()
    await feedAll(paramStore, transport, [{ name: 'RC_OPTIONS', value: 0 }])
    useConnectionStore.setState({ phase: 'connected', paramStore, session, identity: { fwVersion: '4.6.3' } })
    render(<ParamsPage />)
    for (const button of screen.getAllByRole('button')) {
      if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button)
    }
    await tick()

    stage('RC_OPTIONS', '1')
    fireEvent.click(screen.getByRole('button', { name: 'Review & write' }))
    fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
    await tick()
    transport.feed(paramValueFrame({ name: 'RC_OPTIONS', value: 1, count: 1, index: 0 }))
    await tick()
    await tick(2000)
    expect(screen.getByRole('button', { name: 'Reboot' })).toBeEnabled()

    // Force the no-live-Session edge case directly (paramStore.all already
    // fetched, so the page stays on the loaded table view rather than
    // bouncing to the not-connected screen) -- the button must gate on
    // `session`, not just `phase`.
    await act(async () => {
      useConnectionStore.setState({ session: null })
    })
    expect(screen.getByRole('button', { name: 'Reboot' })).toBeDisabled()
  })

  it('the reboot banner and its state reset on disconnect (a stale banner from a dead session is meaningless)', async () => {
    mockMetaFetch({
      RC_OPTIONS: { displayName: 'RC options', description: 'x', rebootRequired: true },
    })
    const { transport, paramStore, session } = await makeConnected()
    await feedAll(paramStore, transport, [{ name: 'RC_OPTIONS', value: 0 }])
    useConnectionStore.setState({ phase: 'connected', paramStore, session, identity: { fwVersion: '4.6.3' } })
    render(<ParamsPage />)
    for (const button of screen.getAllByRole('button')) {
      if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button)
    }
    await tick()

    stage('RC_OPTIONS', '1')
    fireEvent.click(screen.getByRole('button', { name: 'Review & write' }))
    fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
    await tick()
    transport.feed(paramValueFrame({ name: 'RC_OPTIONS', value: 1, count: 1, index: 0 }))
    await tick()
    await tick(2000)
    expect(screen.getByText('Reboot required for changes to take effect')).toBeInTheDocument()

    await act(async () => {
      paramStore.dispose()
      useConnectionStore.setState({ phase: 'disconnected', paramStore: null, session: null })
    })

    expect(screen.queryByText('Reboot required for changes to take effect')).not.toBeInTheDocument()
  })
})
