import { describe, expect, it, vi } from 'vitest'
import {
  AVAILABLE_METADATA_VERSIONS,
  buildParamMetaTable,
  fetchParamMetadata,
  loadParamMetadata,
  lookupParamMeta,
  matchFirmwareVersion,
  metadataVersionBanner,
  type ParamMetaFile,
} from '../paramMetadata'
import sampleFixture from './fixtures/param-metadata-sample.json'

// The fixture's `range` fields are plain JSON arrays (`number[]`), not the
// 2-tuple TS infers `ParamMetaEntry.range` as — same shape at runtime, just
// not something `tsc` can verify from an imported JSON literal.
const sample = sampleFixture as unknown as ParamMetaFile

describe('buildParamMetaTable / lookupParamMeta', () => {
  const table = buildParamMetaTable(sample)

  it('resolves an exact literal name (real ArduPilot data: COMPASS_AUTO_ROT)', () => {
    const entry = lookupParamMeta(table, 'COMPASS_AUTO_ROT')
    expect(entry?.displayName).toBe('Automatically check orientation')
    expect(entry?.values).toContainEqual({ value: 2, label: 'CheckAndFix' })
  })

  it('resolves a literal name with rebootRequired set (real ArduPilot data: MOT_PWM_TYPE)', () => {
    const entry = lookupParamMeta(table, 'MOT_PWM_TYPE')
    expect(entry?.rebootRequired).toBe(true)
  })

  it('resolves a replicated/indexed param through its pattern entry (RC7_MIN -> RC{idx}_MIN)', () => {
    const entry = lookupParamMeta(table, 'RC7_MIN')
    expect(entry?.displayName).toBe('RC min PWM')
    expect(entry?.units).toBe('PWM')
    expect(entry?.range).toEqual([800, 2200])
  })

  it('resolves every RC channel index 1-16 through the same pattern', () => {
    for (let i = 1; i <= 16; i++) {
      expect(lookupParamMeta(table, `RC${i}_MIN`)?.displayName).toBe('RC min PWM')
    }
  })

  it('resolves an indexed pattern with a different prefix (SERVO3_FUNCTION -> SERVO{idx}_FUNCTION)', () => {
    expect(lookupParamMeta(table, 'SERVO3_FUNCTION')?.displayName).toBe('Servo output function')
  })

  it('does not match a name that merely contains the pattern as a substring', () => {
    expect(lookupParamMeta(table, 'XRC7_MIN')).toBeUndefined()
    expect(lookupParamMeta(table, 'RC7_MINX')).toBeUndefined()
  })

  it('returns undefined (not a throw) for a name with no exact or pattern match', () => {
    expect(lookupParamMeta(table, 'NOT_A_REAL_PARAM')).toBeUndefined()
  })

  it('prefers an exact match over a pattern match when both could apply', () => {
    const table2 = buildParamMetaTable({
      FOO7_BAR: { displayName: 'exact', description: '' },
      'FOO{idx}_BAR': { displayName: 'pattern', description: '' },
    })
    expect(lookupParamMeta(table2, 'FOO7_BAR')?.displayName).toBe('exact')
  })
})

describe('matchFirmwareVersion', () => {
  const available = ['4.3', '4.6']

  it('picks the exact major.minor match, ignoring patch/suffix', () => {
    expect(matchFirmwareVersion(available, '4.6.3')).toBe('4.6')
    expect(matchFirmwareVersion(available, '4.6.0-beta')).toBe('4.6')
  })

  it('picks the closest lower bundled version when there is no exact match', () => {
    expect(matchFirmwareVersion(available, '4.7.1')).toBe('4.6')
    expect(matchFirmwareVersion(available, '4.5.0')).toBe('4.3')
  })

  it('picks the newest bundled version when fwVersion is undefined', () => {
    expect(matchFirmwareVersion(available, undefined)).toBe('4.6')
  })

  it('falls back to the oldest bundled version when fwVersion is older than everything bundled', () => {
    expect(matchFirmwareVersion(available, '3.6.0')).toBe('4.3')
  })

  it('throws rather than returning a bogus version if nothing is bundled', () => {
    expect(() => matchFirmwareVersion([], '4.6.3')).toThrow()
  })
})

describe('metadataVersionBanner', () => {
  it('shows no banner (exact) when the bundled version matches fwVersion', () => {
    expect(metadataVersionBanner('4.6', '4.6.3')).toEqual({ kind: 'exact' })
  })

  it('shows the mismatch banner when fwVersion is known but not an exact match', () => {
    expect(metadataVersionBanner('4.3', '4.5.0')).toEqual({ kind: 'mismatch', bundled: '4.3', fwVersion: '4.5.0' })
  })

  it('shows the unknown-fw banner when fwVersion never arrived', () => {
    expect(metadataVersionBanner('4.6', undefined)).toEqual({ kind: 'unknown-fw', bundled: '4.6' })
  })
})

describe('fetchParamMetadata', () => {
  it('fetches the same-origin versioned file and builds a lookup table', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => sample,
    })

    const table = await fetchParamMetadata('9.9', fetchFn)

    expect(fetchFn).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}param-metadata/9.9.json`, { cache: 'no-cache' })
    expect(lookupParamMeta(table, 'COMPASS_AUTO_ROT')?.displayName).toBe('Automatically check orientation')
  })

  it('throws on a non-2xx response', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    await expect(fetchParamMetadata('0.0', fetchFn)).rejects.toThrow(/404/)
  })

  it.each([
    ['a JSON array instead of an object', ['not', 'an', 'object']],
    ['an entry that is not an object', { FOO: 'not an object' }],
    ['an entry missing displayName', { FOO: { description: 'y' } }],
    ['an entry missing description', { FOO: { displayName: 'x' } }],
  ])('rejects malformed metadata JSON: %s', async (_label, body) => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => body })
    await expect(fetchParamMetadata(`bad-${_label}`, fetchFn)).rejects.toThrow()
  })

  it('caches the result so a second call for the same version does not refetch', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => sample })
    await fetchParamMetadata('7.7', fetchFn)
    await fetchParamMetadata('7.7', fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('does not cache a rejected fetch, so a later call can retry', async () => {
    const fetchFn = vi.fn().mockRejectedValueOnce(new TypeError('network down')).mockResolvedValueOnce({ ok: true, json: async () => sample })
    await expect(fetchParamMetadata('8.8', fetchFn)).rejects.toThrow('network down')
    await expect(fetchParamMetadata('8.8', fetchFn)).resolves.toBeDefined()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})

describe('loadParamMetadata', () => {
  // Deliberately before the success case below: `AVAILABLE_METADATA_VERSIONS`
  // has exactly one bundled version, so both tests resolve to the same cache
  // key in `fetchParamMetadata`'s module-level cache — running the rejecting
  // fetch first (and relying on `fetchParamMetadata`'s "don't cache a
  // rejection" behavior, already covered on its own above) keeps that key
  // unprimed for the success test that follows.
  it('rejects if the underlying fetch fails, leaving degrade-to-raw-rendering to the caller', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('offline'))
    await expect(loadParamMetadata(undefined, fetchFn)).rejects.toThrow('offline')
  })

  it('combines version selection, banner, and fetch into one call', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => sample })

    const { table, banner } = await loadParamMetadata('4.6.3', fetchFn)

    expect(banner).toEqual({ kind: 'exact' })
    expect(fetchFn).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}param-metadata/${AVAILABLE_METADATA_VERSIONS[0]}.json`, { cache: 'no-cache' })
    expect(lookupParamMeta(table, 'COMPASS_AUTO_ROT')).toBeDefined()
  })
})
