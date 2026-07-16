import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { FirmwarePage } from '../FirmwarePage'
import { useConnectionStore } from '../../../store/connection'
import { useFlashSession } from '../flashSession'
import fixtureManifest from '../../../core/firmware/__tests__/fixtures/manifest.json'

const initialConnectionState = useConnectionStore.getState()
const initialFlashSessionState = useFlashSession.getState()

afterEach(() => {
  useConnectionStore.setState(initialConnectionState, true)
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
  function runningTarget() {
    return {
      boardName: 'AF-F4_nano',
      version: '0.2.0',
      apjBoardId: 6203,
      source: { kind: 'local' as const, fileName: 'x.apj', apj: { boardId: 6203, image: new Uint8Array(), imageSize: 0 } },
    }
  }

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
