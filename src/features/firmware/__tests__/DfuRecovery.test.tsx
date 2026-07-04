import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '../../../i18n'
import { DfuRecovery } from '../DfuRecovery'
import { useConnectionStore } from '../../../store/connection'
import type { FirmwareManifest } from '../../../core/firmware/manifest'
import fixtureManifest from '../../../core/firmware/__tests__/fixtures/manifest.json'

const manifest = fixtureManifest as FirmwareManifest
const initialConnectionState = useConnectionStore.getState()

afterEach(() => {
  useConnectionStore.setState(initialConnectionState, true)
})

describe('DfuRecovery — software-DFU gating (F4-only, per manifest softwareDfuAllowed)', () => {
  it('shows "Reboot into DFU" when connected to a board whose manifest entry allows software DFU (AF-F4_nano)', () => {
    useConnectionStore.setState({ phase: 'connected', identity: { boardId: 6203, fwVersion: '0.2.0', vehicleName: undefined } })

    render(<DfuRecovery manifest={manifest} />)

    expect(screen.getByRole('button', { name: 'Reboot into DFU' })).toBeInTheDocument()
  })

  it('hides "Reboot into DFU" for a connected board whose manifest entry disallows it (AF-F7_mini, non-F4)', () => {
    useConnectionStore.setState({ phase: 'connected', identity: { boardId: 6201, fwVersion: '0.2.0', vehicleName: undefined } })

    render(<DfuRecovery manifest={manifest} />)

    expect(screen.queryByRole('button', { name: 'Reboot into DFU' })).not.toBeInTheDocument()
    expect(screen.getByText('Connect a novaX board that supports one-click DFU to unlock this.')).toBeInTheDocument()
  })

  it('hides "Reboot into DFU" for an unknown board ID not present in the manifest at all', () => {
    useConnectionStore.setState({ phase: 'connected', identity: { boardId: 999999, fwVersion: '0.2.0', vehicleName: undefined } })

    render(<DfuRecovery manifest={manifest} />)

    expect(screen.queryByRole('button', { name: 'Reboot into DFU' })).not.toBeInTheDocument()
  })

  it('hides "Reboot into DFU" while not connected, even for an otherwise-allowed board identity', () => {
    useConnectionStore.setState({ phase: 'disconnected', identity: { boardId: 6203, fwVersion: '0.2.0', vehicleName: undefined } })

    render(<DfuRecovery manifest={manifest} />)

    expect(screen.queryByRole('button', { name: 'Reboot into DFU' })).not.toBeInTheDocument()
  })

  it('hides "Reboot into DFU" when no manifest has loaded yet', () => {
    useConnectionStore.setState({ phase: 'connected', identity: { boardId: 6203, fwVersion: '0.2.0', vehicleName: undefined } })

    render(<DfuRecovery manifest={null} />)

    expect(screen.queryByRole('button', { name: 'Reboot into DFU' })).not.toBeInTheDocument()
  })
})

describe('DfuRecovery — manual DFU panel', () => {
  it('always renders the BOOT0 instructions, Zadig hint, and "no device" placeholder before a device is picked', () => {
    useConnectionStore.setState({ phase: 'disconnected', identity: null })

    render(<DfuRecovery manifest={manifest} />)

    expect(screen.getByRole('button', { name: 'Select DFU device' })).toBeInTheDocument()
    expect(screen.getByText(/Hold the BOOT button/)).toBeInTheDocument()
    expect(screen.getByText(/Zadig/)).toBeInTheDocument()
    expect(screen.getByText('No DFU device selected')).toBeInTheDocument()
    // No Flash button until a device + local hex file are both present.
    expect(screen.queryByRole('button', { name: /^Flash/ })).not.toBeInTheDocument()
  })
})

describe('DfuRecovery — cross-tab busy gating', () => {
  it('disables "Select DFU device" (and "Reboot into DFU", when otherwise available) while Tab 1 is busy, to avoid racing it for the connection', () => {
    useConnectionStore.setState({ phase: 'connected', identity: { boardId: 6203, fwVersion: '0.2.0', vehicleName: undefined } })

    render(<DfuRecovery manifest={manifest} busy={true} />)

    expect(screen.getByRole('button', { name: 'Select DFU device' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reboot into DFU' })).toBeDisabled()
  })

  it('leaves both buttons enabled when Tab 1 is not busy', () => {
    useConnectionStore.setState({ phase: 'connected', identity: { boardId: 6203, fwVersion: '0.2.0', vehicleName: undefined } })

    render(<DfuRecovery manifest={manifest} busy={false} />)

    expect(screen.getByRole('button', { name: 'Select DFU device' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reboot into DFU' })).toBeEnabled()
  })
})
