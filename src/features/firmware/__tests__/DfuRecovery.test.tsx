import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '../../../i18n'
import { DfuFlashControls, DfuRecovery } from '../DfuRecovery'
import type { Stm32DfuLike } from '../flashSession'
import type { ParsedHex } from '../../../core/firmware/intelhex'
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
    useConnectionStore.setState({ phase: 'connected', identity: { boardName: 'AF-F4_nano', fwVersion: '0.2.0' } })

    render(<DfuRecovery manifest={manifest} />)

    expect(screen.getByRole('button', { name: 'Reboot into DFU' })).toBeInTheDocument()
  })

  it('hides "Reboot into DFU" for a connected board whose manifest entry disallows it (AF-F7_mini, non-F4)', () => {
    useConnectionStore.setState({ phase: 'connected', identity: { boardName: 'AF-F7_mini', fwVersion: '0.2.0' } })

    render(<DfuRecovery manifest={manifest} />)

    expect(screen.queryByRole('button', { name: 'Reboot into DFU' })).not.toBeInTheDocument()
    expect(screen.getByText('Connect a novaX board that supports one-click DFU to unlock this.')).toBeInTheDocument()
  })

  it('hides "Reboot into DFU" for an unknown board name not present in the manifest at all', () => {
    useConnectionStore.setState({ phase: 'connected', identity: { boardName: 'NoSuchBoard-9000', fwVersion: '0.2.0' } })

    render(<DfuRecovery manifest={manifest} />)

    expect(screen.queryByRole('button', { name: 'Reboot into DFU' })).not.toBeInTheDocument()
  })

  it('hides "Reboot into DFU" while not connected, even for an otherwise-allowed board identity', () => {
    useConnectionStore.setState({ phase: 'disconnected', identity: { boardName: 'AF-F4_nano', fwVersion: '0.2.0' } })

    render(<DfuRecovery manifest={manifest} />)

    expect(screen.queryByRole('button', { name: 'Reboot into DFU' })).not.toBeInTheDocument()
  })

  it('hides "Reboot into DFU" when no manifest has loaded yet', () => {
    useConnectionStore.setState({ phase: 'connected', identity: { boardName: 'AF-F4_nano', fwVersion: '0.2.0' } })

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
    useConnectionStore.setState({ phase: 'connected', identity: { boardName: 'AF-F4_nano', fwVersion: '0.2.0' } })

    render(<DfuRecovery manifest={manifest} busy={true} />)

    expect(screen.getByRole('button', { name: 'Select DFU device' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reboot into DFU' })).toBeDisabled()
  })

  it('leaves both buttons enabled when Tab 1 is not busy', () => {
    useConnectionStore.setState({ phase: 'connected', identity: { boardName: 'AF-F4_nano', fwVersion: '0.2.0' } })

    render(<DfuRecovery manifest={manifest} busy={false} />)

    expect(screen.getByRole('button', { name: 'Select DFU device' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reboot into DFU' })).toBeEnabled()
  })
})

function hex(): ParsedHex {
  return { segments: [{ addr: 0x08000000, data: new Uint8Array([1, 2, 3]) }], minAddress: 0x08000000, maxAddress: 0x08000003, totalBytes: 3 }
}

describe('DfuFlashControls — Cancel affordance on the in-progress view', () => {
  it('disables the Cancel button (with an explanation) once DFU programming has started — no safely-cancellable window once erase begins', async () => {
    // flash() never resolves in this test (stalls mid-programming), same
    // "scripted engine" style as flashSession.test.ts's FakeStm32Dfu.
    const flasher: Stm32DfuLike = {
      flash: (_hex, onProgress) =>
        new Promise(() => {
          onProgress(500, 1000) // >= the 300-permille erase/programming boundary
        }),
    }

    render(<DfuFlashControls flasher={flasher} localHex={{ kind: 'parsed', fileName: 'x_with_bl.hex', size: 3, hex: hex() }} />)

    fireEvent.click(screen.getByRole('button', { name: /^Flash/ }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Erase & flash' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled())
    expect(screen.getByText(/Can't cancel once erasing has started/)).toBeInTheDocument()
  })
})
