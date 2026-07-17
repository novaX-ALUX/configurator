import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { FirmwarePage } from '../FirmwarePage'
import { useConnectionStore } from '../../../store/connection'
import { useNavigationStore } from '../../../store/navigation'
import { useFlashSession } from '../flashSession'
import fixtureManifest from '../../../core/firmware/__tests__/fixtures/manifest.json'

const initialConnectionState = useConnectionStore.getState()
const initialNavigationState = useNavigationStore.getState()
const initialFlashSessionState = useFlashSession.getState()

afterEach(() => {
  useConnectionStore.setState(initialConnectionState, true)
  useNavigationStore.setState(initialNavigationState, true)
  useFlashSession.setState(initialFlashSessionState, true)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mockManifestFetch(body: unknown = fixtureManifest, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })),
  )
}

function runningTarget() {
  return {
    boardName: 'AF-F4_nano',
    version: '0.2.0',
    apjBoardId: 6203,
    source: { kind: 'local' as const, fileName: 'x.apj', apj: { boardId: 6203, image: new Uint8Array(), imageSize: 0 } },
  }
}

describe('FirmwarePage — online list (Tab 1)', () => {
  it('lists every board from the manifest regardless of connection identity, and only highlights the matching one as recommended', async () => {
    mockManifestFetch()
    // Connected, with a banner board name matching AF-F4_nano — a board NOT
    // recommended (AF-H7E) must still be fully listed: decisions-m1.md is
    // explicit that identity only highlights, never filters/hides.
    useConnectionStore.setState({ phase: 'connected', identity: { boardName: 'AF-F4_nano', fwVersion: '0.2.0' } })

    render(<FirmwarePage />)

    await waitFor(() => expect(screen.getByRole('button', { name: /AF-F4_nano/ })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /AF-F7_mini/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /AF-H7E/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /AF-H7_nano/ })).toBeInTheDocument()

    // Only the matching board is flagged recommended.
    const recommendedBadges = screen.getAllByText('Recommended for this board')
    expect(recommendedBadges).toHaveLength(1)
    const f4Card = screen.getByRole('button', { name: /AF-F4_nano/ })
    expect(within(f4Card).getByText('Recommended for this board')).toBeInTheDocument()
  })

  it('still lists every board when nothing is connected (no identity at all)', async () => {
    mockManifestFetch()
    useConnectionStore.setState({ phase: 'disconnected', identity: null })

    render(<FirmwarePage />)

    await waitFor(() => expect(screen.getByRole('button', { name: /AF-F4_nano/ })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /AF-F7_mini/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /AF-H7E/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /AF-H7_nano/ })).toBeInTheDocument()
    expect(screen.queryByText('Recommended for this board')).not.toBeInTheDocument()
  })

  it('shows a retry option and a local-file fallback note when the manifest fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    )
    useConnectionStore.setState({ phase: 'disconnected' })

    render(<FirmwarePage />)

    await waitFor(() => expect(screen.getByText(/Couldn't load the firmware list/)).toBeInTheDocument())
    expect(screen.getByText('You can still flash a local .apj file below.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('disables the Update button until connected, even with a board selected', async () => {
    mockManifestFetch()
    useConnectionStore.setState({ phase: 'disconnected' })

    render(<FirmwarePage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /AF-F4_nano/ })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /AF-F4_nano/ }))

    const updateButton = screen.getByRole('button', { name: /Update AF-F4_nano to 0.2.0/ })
    expect(updateButton).toBeDisabled()
  })

  it('shows static disabled copy (never em-dash placeholders) when nothing is selected', async () => {
    mockManifestFetch()
    useConnectionStore.setState({ phase: 'disconnected' })

    render(<FirmwarePage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /AF-F4_nano/ })).toBeInTheDocument())

    const updateButton = screen.getByRole('button', { name: 'Select firmware to update' })
    expect(updateButton).toBeDisabled()
    expect(screen.queryByText(/Update — to —/)).not.toBeInTheDocument()
  })

  it('opens a confirm dialog naming the board/version when Update is clicked while connected, and Cancel returns to idle', async () => {
    mockManifestFetch()
    useConnectionStore.setState({ phase: 'connected', identity: null })

    render(<FirmwarePage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /AF-F4_nano/ })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /AF-F4_nano/ }))
    fireEvent.click(screen.getByRole('button', { name: /Update AF-F4_nano to 0.2.0/ }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Update AF-F4_nano to 0.2.0?')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useFlashSession.getState().step).toBe('idle')
  })
})

describe('FirmwarePage — Cancel affordance on the in-progress view', () => {
  it('renders an enabled Cancel button while "connecting" (a safely-cancellable step), and clicking it returns the session to idle', async () => {
    mockManifestFetch()
    useConnectionStore.setState({ phase: 'connected' })
    useFlashSession.setState({ step: 'connecting', target: runningTarget() })

    render(<FirmwarePage />)

    const cancelButton = screen.getByRole('button', { name: 'Cancel' })
    expect(cancelButton).toBeEnabled()

    fireEvent.click(cancelButton)

    expect(useFlashSession.getState().step).toBe('idle')
  })

  it('disables the Cancel button (with an explanation) once programming has started — past the destructive point', async () => {
    mockManifestFetch()
    useConnectionStore.setState({ phase: 'connected' })
    useFlashSession.setState({ step: 'programming', progress: { done: 512, total: 1024 }, target: runningTarget() })

    render(<FirmwarePage />)

    const cancelButton = screen.getByRole('button', { name: 'Cancel' })
    expect(cancelButton).toBeDisabled()
    expect(screen.getByText(/Can't cancel once erasing has started/)).toBeInTheDocument()

    fireEvent.click(cancelButton) // no-op: disabled, and even if it fired, cancel() itself is a no-op for 'programming'
    expect(useFlashSession.getState().step).toBe('programming')
  })
})

describe('FirmwarePage — mid-flash navigation guard', () => {
  it('registers no guard while the session is idle', async () => {
    mockManifestFetch()
    useConnectionStore.setState({ phase: 'connected' })

    render(<FirmwarePage />)

    expect(useNavigationStore.getState().guardNavigation).toBeNull()
  })

  it('registers a confirm guard while a flash is in flight, so leaving the page is intercepted', async () => {
    mockManifestFetch()
    useConnectionStore.setState({ phase: 'connected' })
    useFlashSession.setState({ step: 'programming', progress: { done: 512, total: 1024 }, target: runningTarget() })

    render(<FirmwarePage />)

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    expect(useNavigationStore.getState().guardNavigation).not.toBeNull()
    useNavigationStore.getState().setActivePage('parameters')
    expect(confirmSpy).toHaveBeenCalled()
    expect(useNavigationStore.getState().activePage).toBe('firmware') // unchanged

    // The guard clears once the session leaves the in-flight steps.
    act(() => {
      useFlashSession.setState({ step: 'done' })
    })
    expect(useNavigationStore.getState().guardNavigation).toBeNull()
  })
})

describe('FirmwarePage — direct-bootloader entry (issue #29)', () => {
  /** Minimal fake `SerialPort` — real `ReadableStream`/`WritableStream` so `SerialTransport.open()` succeeds for real, mirroring `core/transport/__tests__/serial.test.ts`'s own `FakeSerialPort`. */
  class FakeSerialPort extends EventTarget implements SerialPort {
    readable: ReadableStream<Uint8Array> | null = null
    writable: WritableStream<Uint8Array> | null = null
    connected = true
    open(): Promise<void> {
      this.readable = new ReadableStream<Uint8Array>({})
      this.writable = new WritableStream<Uint8Array>({})
      return Promise.resolve()
    }
    close(): Promise<void> {
      this.readable = null
      this.writable = null
      return Promise.resolve()
    }
    forget(): Promise<void> {
      return Promise.resolve()
    }
    getInfo(): SerialPortInfo {
      return { usbVendorId: 0x1209, usbProductId: 0x5741 }
    }
  }

  // jsdom has no `navigator.serial` at all (see serial.ts's own module doc) —
  // defined per-test and restored after, mirroring how this repo's console
  // tests stub `navigator.clipboard` (inspectorUtils.test.ts).
  const originalSerial = (navigator as unknown as { serial?: unknown }).serial
  afterEach(() => {
    Object.defineProperty(navigator, 'serial', { value: originalSerial, configurable: true })
  })
  function stubRequestPort(impl: () => Promise<SerialPort>): void {
    Object.defineProperty(navigator, 'serial', { value: { requestPort: impl, getPorts: async () => [] }, configurable: true })
  }

  it('is hidden while connected, and hidden when nothing is selected', async () => {
    mockManifestFetch()
    useConnectionStore.setState({ phase: 'connected' })
    render(<FirmwarePage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /AF-F4_nano/ })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /already in bootloader/i })).not.toBeInTheDocument()
  })

  it('appears once disconnected with a board selected, and opens the port picker on click', async () => {
    mockManifestFetch()
    useConnectionStore.setState({ phase: 'disconnected' })
    let requestPortCalls = 0
    stubRequestPort(async () => {
      requestPortCalls++
      return new FakeSerialPort()
    })

    render(<FirmwarePage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /AF-F4_nano/ })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /AF-F4_nano/ }))

    const directButton = screen.getByRole('button', { name: /already in bootloader/i })
    expect(directButton).toBeEnabled()

    await act(async () => {
      fireEvent.click(directButton)
    })

    expect(requestPortCalls).toBe(1)
    await waitFor(() => expect(useFlashSession.getState().step).toBe('confirming'))
    expect(useFlashSession.getState().directEntry).toBe(true)
    // Direct-entry confirm copy must not claim a reboot is about to happen —
    // the board is already in its bootloader.
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/already in its bootloader/)).toBeInTheDocument()
  })

  it('silently does nothing when the user dismisses the native port picker', async () => {
    mockManifestFetch()
    useConnectionStore.setState({ phase: 'disconnected' })
    stubRequestPort(async () => {
      throw new DOMException('cancelled', 'NotFoundError')
    })

    render(<FirmwarePage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /AF-F4_nano/ })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /AF-F4_nano/ }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /already in bootloader/i }))
    })

    expect(useFlashSession.getState().step).toBe('idle')
    expect(screen.queryByText(/Couldn't open the bootloader port/)).not.toBeInTheDocument()
  })

  it('surfaces a non-dismissal requestPort() failure as an inline error', async () => {
    mockManifestFetch()
    useConnectionStore.setState({ phase: 'disconnected' })
    stubRequestPort(async () => {
      throw new Error('Web Serial is not available in this browser')
    })

    render(<FirmwarePage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /AF-F4_nano/ })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /AF-F4_nano/ }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /already in bootloader/i }))
    })

    expect(useFlashSession.getState().step).toBe('idle')
    expect(screen.getByText(/Couldn't open the bootloader port.*Web Serial is not available/)).toBeInTheDocument()
  })
})

describe('FirmwarePage — local .apj drop', () => {
  async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
    const reader = input.pipeThrough(new CompressionStream('deflate') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.length
      }
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }

  async function buildApjFile(): Promise<File> {
    const imageBytes = new Uint8Array([9, 8, 7, 6, 5])
    const compressed = await deflate(imageBytes)
    let binary = ''
    for (const b of compressed) binary += String.fromCharCode(b)
    const json = JSON.stringify({ board_id: 6203, image_size: imageBytes.length, image: btoa(binary) })
    return new File([json], 'custom.apj', { type: 'application/json' })
  }

  it('parses a dropped .apj immediately and shows its board ID and size', async () => {
    mockManifestFetch()
    useConnectionStore.setState({ phase: 'disconnected' })
    render(<FirmwarePage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /AF-F4_nano/ })).toBeInTheDocument())

    const file = await buildApjFile()
    const dropzone = screen.getByText('Drag a .apj file here, or click to choose one').closest('div')!

    await act(async () => {
      fireEvent.drop(dropzone, { dataTransfer: { files: [file] } })
    })

    await waitFor(() => expect(screen.getByText(/Board ID 6203/)).toBeInTheDocument())
  })
})
