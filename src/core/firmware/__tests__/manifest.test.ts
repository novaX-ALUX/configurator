import { describe, expect, it, vi } from 'vitest'
import {
  ManifestError,
  fetchManifest,
  firmwareFileUrl,
  matchBoards,
  parseManifest,
} from '../manifest'
import goldenManifest from './fixtures/manifest.json'

describe('parseManifest', () => {
  it('parses the real gen_manifest.py fixture into 4 boards', () => {
    const manifest = parseManifest(goldenManifest)

    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.tag).toBe('v0.2.0')
    expect(manifest.boards).toHaveLength(4)
    expect(manifest.boards.map((b) => b.boardName)).toEqual([
      'AF-F4_nano',
      'AF-F7_mini',
      'AF-H7E',
      'AF-H7_nano',
    ])
    // Spot-check one full board, including a nested file entry.
    const nano = manifest.boards[0]
    expect(nano.apjBoardId).toBe(6203)
    expect(nano.mcuFamily).toBe('F4')
    expect(nano.method).toBe('ardupilot')
    expect(nano.softwareDfuAllowed).toBe(true)
    expect(nano.files).toHaveLength(3)
    expect(nano.files[0]).toEqual({
      kind: 'apj',
      name: 'AF-F4_nano-v0.2.0.apj',
      url: 'https://github.com/novaX-ALUX/flight_controller/releases/download/v0.2.0/AF-F4_nano-v0.2.0.apj',
      sha256: 'd4d85573249660044606e72542c025b11cddbf19ffa76b33c95d788454d0b877',
      size: 834354,
    })
  })

  it.each([
    ['missing sha256 on a file', (m: Record<string, unknown>) => {
      const boards = m.boards as Record<string, unknown>[]
      const files = boards[0].files as Record<string, unknown>[]
      delete files[0].sha256
    }],
    ['schemaVersion is 2', (m: Record<string, unknown>) => {
      m.schemaVersion = 2
    }],
    ['boards is not an array', (m: Record<string, unknown>) => {
      m.boards = { not: 'an array' }
    }],
    ['a file size is a string', (m: Record<string, unknown>) => {
      const boards = m.boards as Record<string, unknown>[]
      const files = boards[0].files as Record<string, unknown>[]
      files[0].size = '834354'
    }],
  ])('throws a schema ManifestError when %s', (_label, corrupt) => {
    const corrupted = structuredClone(goldenManifest) as Record<string, unknown>
    corrupt(corrupted)

    let caught: unknown
    try {
      parseManifest(corrupted)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ManifestError)
    expect((caught as ManifestError).reason).toBe('schema')
  })
})

describe('matchBoards', () => {
  const manifest = parseManifest(goldenManifest)

  it('returns the single board matching apjBoardId 6203', () => {
    const matches = matchBoards(manifest, 6203)
    expect(matches).toHaveLength(1)
    expect(matches[0].boardName).toBe('AF-F4_nano')
  })

  it('returns an empty array for an unknown board id', () => {
    expect(matchBoards(manifest, 9999)).toEqual([])
  })
})

describe('firmwareFileUrl', () => {
  it('resolves to a same-origin firmware/ path built from BASE_URL, never file.url', () => {
    const manifest = parseManifest(goldenManifest)
    const file = manifest.boards[0].files[0]

    const url = firmwareFileUrl(file)

    expect(url).toBe(`${import.meta.env.BASE_URL}firmware/${file.name}`)
    expect(url).not.toContain('github.com')
  })
})

describe('fetchManifest', () => {
  it('GETs the same-origin manifest.json with cache: no-cache and parses it', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(goldenManifest),
    })

    const manifest = await fetchManifest(fetchFn)

    expect(fetchFn).toHaveBeenCalledWith(
      `${import.meta.env.BASE_URL}firmware/manifest.json`,
      expect.objectContaining({ cache: 'no-cache' }),
    )
    expect(manifest.boards).toHaveLength(4)
  })

  it('throws an http ManifestError on a non-ok response (e.g. 404, mirror not synced yet)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve(undefined),
    })

    let caught: unknown
    try {
      await fetchManifest(fetchFn)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ManifestError)
    expect((caught as ManifestError).reason).toBe('http')
  })

  it('throws a network ManifestError when the fetch itself rejects', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))

    let caught: unknown
    try {
      await fetchManifest(fetchFn)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ManifestError)
    expect((caught as ManifestError).reason).toBe('network')
  })
})
