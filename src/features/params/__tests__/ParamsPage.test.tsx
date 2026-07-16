import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { ParamsPage } from '../ParamsPage'
import { useConnectionStore } from '../../../store/connection'
import { useNavigationStore } from '../../../store/navigation'
import { MockTransport } from '../../../core/transport/mock'
import { defs } from '../../../core/mavlink/defs'
import { encodeFrame, FrameParser } from '../../../core/mavlink/frame'
import { encodePayload } from '../../../core/mavlink/encode'
import { decodePayload } from '../../../core/mavlink/decode'
import { MavRouter } from '../../../core/mavlink/router'
import { ParamStore } from '../../../core/mavlink/params'
import type { ParamMetaFile } from '../../../core/paramMetadata'

const PARAM_SET_MSGID = 23
const MAV_PARAM_TYPE_REAL32 = 9

const initialConnectionState = useConnectionStore.getState()
const initialNavigationState = useNavigationStore.getState()

afterEach(() => {
  useConnectionStore.setState(initialConnectionState, true)
  useNavigationStore.setState(initialNavigationState, true)
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

/** Real ParamStore backed by a MockTransport+MavRouter — same "test the real protocol state machine" style as params.test.ts/connection.test.ts, rather than a fake ParamStore. */
async function makeConnectedParamStore(opts?: ConstructorParameters<typeof ParamStore>[2]): Promise<{ transport: MockTransport; paramStore: ParamStore }> {
  const transport = new MockTransport()
  const router = new MavRouter(transport, defs, {})
  await transport.open()
  router.start()
  const paramStore = new ParamStore(router, { sysid: 1, compid: 1 }, opts)
  return { transport, paramStore }
}

/** Feeds one PARAM_VALUE per entry (index = array position, count = entries.length) and lets fetchAll's arrival handling settle. */
async function feedAll(transport: MockTransport, entries: Array<{ name: string; value: number; type?: number }>): Promise<void> {
  entries.forEach((e, index) => {
    transport.feed(paramValueFrame({ name: e.name, value: e.value, type: e.type, count: entries.length, index }))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/**
 * Issue #14 (PA2): every group section starts collapsed, so a row's input
 * isn't in the DOM until its section is expanded. Tests below this file's
 * "search / collapsible group sections" block predate that change and only
 * care about staging/write behavior, not collapsing — expanding every group
 * up front keeps them exercising the same rows they always did, without
 * threading an explicit expand step through each one individually.
 */
function expandAllGroups(): void {
  for (const button of screen.getAllByRole('button')) {
    if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button)
  }
}

/** Expands a single group's section by its `deriveGroup()` prefix — cheaper than `expandAllGroups()` when the fixture has hundreds of single-param groups (e.g. `P1`..`P1276`) and only one group's rows actually matter to the assertion. */
function expandGroup(prefix: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${prefix}_`) }))
}

/** Stubs `fetch` for `core/paramMetadata.ts`'s same-origin metadata fetch — shared by the issue #13 (display name/description) and issue #14 (search-by-display-name) test blocks below. */
function mockMetaFetch(body: ParamMetaFile, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })),
  )
}

describe('ParamsPage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  describe('not connected', () => {
    it('shows the empty state; CTA calls connect() only while truly disconnected', () => {
      const calls: unknown[] = []
      useConnectionStore.setState({
        phase: 'disconnected',
        baud: 115200,
        paramStore: null,
        connect: (baud, opts) => {
          calls.push([baud, opts])
          return Promise.resolve()
        },
      })
      render(<ParamsPage />)

      expect(screen.getByText('Parameters live on the board')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Connect flight controller' }))
      expect(calls).toEqual([[115200, undefined]])
    })

    it('disables the CTA while connecting/lost (connect() would be a silent no-op)', () => {
      useConnectionStore.setState({ phase: 'connecting', paramStore: null })
      render(<ParamsPage />)
      expect(screen.getByRole('button', { name: 'Connect flight controller' })).toBeDisabled()
    })
  })

  describe('connected: load flow', () => {
    it('shows a Load button before any fetch, and the progress readout while fetching', async () => {
      const { transport, paramStore } = await makeConnectedParamStore()
      useConnectionStore.setState({ phase: 'connected', paramStore })
      render(<ParamsPage />)

      expect(screen.getByRole('button', { name: 'Load parameters' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Load parameters' }))
      await tick()

      transport.feed(paramValueFrame({ name: 'P0', value: 1, count: 2, index: 0 }))
      await tick()
      expect(screen.getByText('Fetching parameters… 1 / 2')).toBeInTheDocument()

      transport.feed(paramValueFrame({ name: 'P1', value: 2, count: 2, index: 1 }))
      await tick()

      expandAllGroups() // each group starts collapsed (issue #14) — expand to see the loaded rows
      expect(screen.getByText('P0')).toBeInTheDocument()
      expect(screen.getByText('P1')).toBeInTheDocument()
    })

    it('shows a distinct message + Retry for "no response at all", and retry re-sends the request', async () => {
      const { transport, paramStore } = await makeConnectedParamStore({ fetchSilenceMs: 50 })
      useConnectionStore.setState({ phase: 'connected', paramStore })
      render(<ParamsPage />)

      fireEvent.click(screen.getByRole('button', { name: 'Load parameters' }))
      await tick(50)

      expect(screen.getByText(/didn't respond/i)).toBeInTheDocument()
      expect(transport.sent).toHaveLength(1)

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await tick()
      expect(transport.sent).toHaveLength(2)
    })

    it('shows a distinct message for missing indices after gap-fill is exhausted', async () => {
      const { transport, paramStore } = await makeConnectedParamStore({
        fetchSilenceMs: 20,
        fetchRequestTimeoutMs: 20,
        fetchRetries: 0,
        fetchMaxRounds: 1,
      })
      useConnectionStore.setState({ phase: 'connected', paramStore })
      render(<ParamsPage />)

      fireEvent.click(screen.getByRole('button', { name: 'Load parameters' }))
      await tick()
      transport.feed(paramValueFrame({ name: 'P0', value: 1, count: 2, index: 0 }))
      await tick()
      await tick(20) // silence window
      await tick(20) // gap-fill attempt timeout -> rounds exhausted -> reject

      expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    })

    it('shows a distinct message when param_count drifts mid-fetch', async () => {
      const { transport, paramStore } = await makeConnectedParamStore()
      useConnectionStore.setState({ phase: 'connected', paramStore })
      render(<ParamsPage />)

      fireEvent.click(screen.getByRole('button', { name: 'Load parameters' }))
      await tick()
      transport.feed(paramValueFrame({ name: 'P0', value: 1, count: 2, index: 0 }))
      await tick()
      transport.feed(paramValueFrame({ name: 'P1', value: 1, count: 5, index: 1 }))
      await tick()

      expect(screen.getByText(/count changed mid-fetch/i)).toBeInTheDocument()
    })

    it('skips straight to the table if the ParamStore was already fetched in a prior mount', async () => {
      const { transport, paramStore } = await makeConnectedParamStore()
      await feedAll(transport, [{ name: 'ALREADY_FETCHED', value: 1 }])
      useConnectionStore.setState({ phase: 'connected', paramStore: null })
      // Simulate: fetchAll already ran once (paramStore.all is populated) before this mount.
      useConnectionStore.setState({ paramStore })

      render(<ParamsPage />)
      expect(screen.queryByRole('button', { name: 'Load parameters' })).not.toBeInTheDocument()
      expandAllGroups() // each group starts collapsed (issue #14) — expand to see the loaded row
      expect(screen.getByText('ALREADY_FETCHED')).toBeInTheDocument()
    })

    it('bug repro (issue #8): mounting mid a fetchAll() started elsewhere shows real pull progress, not a "1 of 1 shown" table masquerading as complete', async () => {
      const { transport, paramStore } = await makeConnectedParamStore()
      // Another page (e.g. Setup, which shares this ParamStore) triggers the
      // full-table pull first — this page never calls handleLoad() itself.
      const otherPagesFetch = paramStore.fetchAll()
      await tick()
      // Only 1 of 1277 has landed so far when the user switches to this page.
      transport.feed(paramValueFrame({ name: 'STAT_RUNTIME', value: 6693, count: 1277, index: 0 }))
      await tick()

      useConnectionStore.setState({ phase: 'connected', paramStore })
      render(<ParamsPage />)

      // Must show honest pull progress, not the table with a lying "1 of 1 shown".
      expect(screen.getByText('Fetching parameters… 1 / 1277')).toBeInTheDocument()
      expect(screen.queryByText('STAT_RUNTIME')).not.toBeInTheDocument()
      expect(screen.queryByText(/of .* shown/)).not.toBeInTheDocument()

      // The rest of the storm arrives (still triggered by the other page's call, not this one)...
      // Named with a shared `GRP{n}_` prefix (not a flat `P{i}`) so
      // `deriveGroup()` buckets them into ~26 realistically-sized sections
      // instead of 1276 one-param sections — real ArduPilot params always
      // share underscore-delimited prefixes (issue #14's collapsible
      // sections render every group with no pagination/cap, so a flat name
      // scheme here would make this single test render ~1300 individual
      // section buttons for no reason this test actually cares about).
      for (let i = 1; i < 1277; i++) {
        transport.feed(paramValueFrame({ name: `GRP${Math.floor(i / 50)}_P${i}`, value: i, count: 1277, index: i }))
      }
      await tick()
      await otherPagesFetch

      // ...and once it completes, the real table replaces the progress screen.
      expect(screen.queryByText(/Fetching parameters/)).not.toBeInTheDocument()
      expandGroup('STAT') // each group starts collapsed (issue #14) — expand just STAT_RUNTIME's single-param group
      expect(screen.getByText('STAT_RUNTIME')).toBeInTheDocument()
      expect(screen.getByText('1277 of 1277 shown')).toBeInTheDocument()
    })
  })

  // Issue #13 tracer bullet: additive param metadata (display name +
  // description) fetched same-origin after connect, plus the
  // version-mismatch/unknown-fw banner. The "fetch fails" case runs first
  // in this block deliberately — `AVAILABLE_METADATA_VERSIONS` currently
  // bundles exactly one version, so every scenario here resolves to the
  // same in-memory cache key in `core/paramMetadata.ts`; a rejected fetch
  // doesn't cache (covered on its own in paramMetadata.test.ts), but a
  // successful one does, so the fetch-failure case must run before any
  // success case primes that cache for the rest of the file.
  describe('parameter metadata (issue #13)', () => {
    async function renderLoaded(entries: Array<{ name: string; value: number; type?: number }>, fwVersion?: string) {
      const { transport, paramStore } = await makeConnectedParamStore()
      await feedAll(transport, entries)
      useConnectionStore.setState({ phase: 'connected', paramStore, identity: fwVersion ? { fwVersion } : null })
      render(<ParamsPage />)
      expandAllGroups() // each group starts collapsed (issue #14) — expand to see the loaded rows
      return { transport, paramStore }
    }

    it('a metadata fetch failure degrades the whole page to raw rendering, not an error state', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
      await renderLoaded([{ name: 'COMPASS_AUTO_ROT', value: 1 }], '4.6.3')
      await tick()

      // The table itself is entirely unaffected — same raw rendering as
      // if metadata never existed, no crash, no error banner.
      expect(screen.getByText('COMPASS_AUTO_ROT')).toBeInTheDocument()
      expect(screen.queryByText('Automatically check orientation')).not.toBeInTheDocument()
    })

    it('shows the generated display name + description on a matched row, and leaves an unmatched row exactly as before', async () => {
      mockMetaFetch({
        COMPASS_AUTO_ROT: {
          displayName: 'Automatically check orientation',
          description: 'Checks compass orientation after calibration.',
        },
      })
      await renderLoaded([
        { name: 'COMPASS_AUTO_ROT', value: 1 },
        { name: 'NOT_IN_METADATA', value: 0 },
      ], '4.6.3')
      await tick()

      expect(screen.getByText('Automatically check orientation')).toBeInTheDocument()
      expect(screen.getByText('Checks compass orientation after calibration.')).toBeInTheDocument()
      // Unmatched row: raw name renders, no metadata line — regression guard for the additive fallback.
      expect(screen.getByText('NOT_IN_METADATA')).toBeInTheDocument()
    })

    it('shows the version-mismatch banner (and no banner once dismissed) when fwVersion does not match the bundled branch', async () => {
      mockMetaFetch({ SOME_PARAM: { displayName: 'x', description: 'y' } })
      await renderLoaded([{ name: 'SOME_PARAM', value: 0 }], '5.1.0')
      await tick()

      expect(screen.getByText(/this vehicle reports 5\.1\.0/)).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      expect(screen.queryByText(/this vehicle reports 5\.1\.0/)).not.toBeInTheDocument()
    })

    it('shows the unknown-firmware banner when fwVersion never arrived', async () => {
      mockMetaFetch({ SOME_PARAM: { displayName: 'x', description: 'y' } })
      await renderLoaded([{ name: 'SOME_PARAM', value: 0 }], undefined)
      await tick()

      expect(screen.getByText(/Firmware version unknown/)).toBeInTheDocument()
    })
  })

  // Issue #14 (PA2): collapsible group sections replace pagination + the
  // GROUP_CHIP_MAX chip row entirely (PRD #12 §2.5).
  describe('search / collapsible group sections (issue #14)', () => {
    async function renderLoaded(entries: Array<{ name: string; value: number; type?: number }>) {
      const { transport, paramStore } = await makeConnectedParamStore()
      await feedAll(transport, entries)
      // paramStore.all is already populated (the frames above were fed before
      // this ever mounted) — the page detects that at mount and starts
      // straight in the 'loaded' table view, no "Load parameters" click needed.
      useConnectionStore.setState({ phase: 'connected', paramStore })
      render(<ParamsPage />)
      return { transport, paramStore }
    }

    it('no pagination anywhere: a large table renders as sections, not "Page X of Y"', async () => {
      const entries = Array.from({ length: 250 }, (_, i) => ({ name: `PARAM_${String(i).padStart(3, '0')}`, value: i }))
      await renderLoaded(entries)

      expect(screen.queryByText(/Page \d+ of \d+/)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Prev' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()
      // One collapsible section for the single PARAM group, all 250 counted.
      expect(screen.getByRole('button', { name: /^PARAM_ \(250\)/ })).toBeInTheDocument()
    })

    it('every group starts collapsed; expanding one shows its rows without affecting others', async () => {
      await renderLoaded([
        { name: 'ATC_RAT_PIT_P', value: 1 },
        { name: 'BATT_CAPACITY', value: 1 },
      ])

      expect(screen.getByRole('button', { name: /^ATC_ \(1\)/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^BATT_ \(1\)/ })).toBeInTheDocument()
      expect(screen.queryByText('ATC_RAT_PIT_P')).not.toBeInTheDocument()
      expect(screen.queryByText('BATT_CAPACITY')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /^ATC_/ }))
      expect(screen.getByText('ATC_RAT_PIT_P')).toBeInTheDocument()
      expect(screen.queryByText('BATT_CAPACITY')).not.toBeInTheDocument() // BATT section is untouched, still collapsed

      fireEvent.click(screen.getByRole('button', { name: /^ATC_/ })) // toggling again re-collapses it
      expect(screen.queryByText('ATC_RAT_PIT_P')).not.toBeInTheDocument()
    })

    it('search matches param.name by substring, case-insensitively', async () => {
      await renderLoaded([
        { name: 'ATC_RAT_PIT_P', value: 1 },
        { name: 'ATC_RAT_YAW_P', value: 1 },
        { name: 'BATT_CAPACITY', value: 1 },
      ])

      fireEvent.change(screen.getByPlaceholderText('Search name…'), { target: { value: 'yaw' } })
      expect(screen.getByText('ATC_RAT_YAW_P')).toBeInTheDocument()
      expect(screen.queryByText('ATC_RAT_PIT_P')).not.toBeInTheDocument()
      expect(screen.queryByText('BATT_CAPACITY')).not.toBeInTheDocument()
    })

    it('search also matches the metadata display name, case-insensitively, but never the description', async () => {
      // No mockMetaFetch call here on purpose: `core/paramMetadata.ts` caches
      // by version in a module-level Map, and `AVAILABLE_METADATA_VERSIONS`
      // has exactly one bundled version — the earlier "parameter metadata
      // (issue #13)" block above already primed that cache with
      // COMPASS_AUTO_ROT ("Automatically check orientation" / "Checks
      // compass orientation after calibration."), so a fresh mock here would
      // just be silently ignored in favor of the cached promise. Reusing
      // that entry both sidesteps the cache and doubles as the description
      // non-match proof (the word "calibration" only appears there).
      await renderLoaded([
        { name: 'COMPASS_AUTO_ROT', value: 1 },
        { name: 'ATC_RAT_YAW_P', value: 1 },
      ])
      await tick()

      fireEvent.change(screen.getByPlaceholderText('Search name…'), { target: { value: 'orientation' } })
      expect(screen.getByText('COMPASS_AUTO_ROT')).toBeInTheDocument() // matched via displayName, not the raw name
      expect(screen.queryByText('ATC_RAT_YAW_P')).not.toBeInTheDocument()

      fireEvent.change(screen.getByPlaceholderText('Search name…'), { target: { value: 'calibration' } })
      expect(screen.queryByText('COMPASS_AUTO_ROT')).not.toBeInTheDocument() // description-only text never matches
    })

    it('a non-empty query auto-expands matching groups and hides zero-match groups; clearing restores collapsed-by-default', async () => {
      await renderLoaded([
        { name: 'ATC_RAT_PIT_P', value: 1 },
        { name: 'BATT_CAPACITY', value: 1 },
      ])

      // A group the user expanded manually, before ever searching, is in play too.
      fireEvent.click(screen.getByRole('button', { name: /^BATT_/ }))
      expect(screen.getByText('BATT_CAPACITY')).toBeInTheDocument()

      fireEvent.change(screen.getByPlaceholderText('Search name…'), { target: { value: 'atc' } })
      // Matching group auto-expands with no click needed.
      expect(screen.getByText('ATC_RAT_PIT_P')).toBeInTheDocument()
      // Zero-match group is hidden entirely, not just collapsed — even though it was manually expanded a moment ago.
      expect(screen.queryByRole('button', { name: /^BATT_/ })).not.toBeInTheDocument()

      fireEvent.change(screen.getByPlaceholderText('Search name…'), { target: { value: '' } })
      // Clearing restores collapsed-by-default for every group — including
      // both the one the search had auto-expanded AND the one the user had
      // manually expanded before searching (PRD #12 §2.5's literal "restores
      // the collapsed-by-default state", not just "undoes what search did").
      expect(screen.queryByText('ATC_RAT_PIT_P')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^BATT_/ })).toBeInTheDocument()
      expect(screen.queryByText('BATT_CAPACITY')).not.toBeInTheDocument()
    })
  })

  describe('staging and the diff drawer', () => {
    async function renderLoaded(entries: Array<{ name: string; value: number; type?: number }>) {
      const { transport, paramStore } = await makeConnectedParamStore()
      await feedAll(transport, entries)
      // paramStore.all is already populated (the frames above were fed before
      // this ever mounted) — the page detects that at mount and starts
      // straight in the 'loaded' table view, no "Load parameters" click needed.
      useConnectionStore.setState({ phase: 'connected', paramStore })
      render(<ParamsPage />)
      expandAllGroups() // these tests exercise staging/write, not collapsing — see expandAllGroups' doc comment
      return { transport, paramStore }
    }

    it('staging an edit highlights the row and shows the pending count badge', async () => {
      await renderLoaded([{ name: 'THR_MIN', value: 0 }])

      expect(screen.getByText('Editor matches the board — edit any value to queue a change.')).toBeInTheDocument()

      const input = screen.getByDisplayValue('0')
      fireEvent.change(input, { target: { value: '0.5' } })
      fireEvent.blur(input)

      expect(screen.getByText('1 unsaved — the board still has the old values')).toBeInTheDocument()
      expect(screen.getByTitle('Modified — not yet written')).toBeInTheDocument()
    })

    it('"Revert all" clears every staged edit', async () => {
      await renderLoaded([{ name: 'THR_MIN', value: 0 }])
      const input = screen.getByDisplayValue('0')
      fireEvent.change(input, { target: { value: '0.5' } })
      fireEvent.blur(input)

      fireEvent.click(screen.getByRole('button', { name: 'Revert all' }))
      expect(screen.getByText('Editor matches the board — edit any value to queue a change.')).toBeInTheDocument()
    })

    it('opens the diff drawer via "Review & write" and discarding a row there un-stages it', async () => {
      await renderLoaded([{ name: 'THR_MIN', value: 0 }])
      const input = screen.getByDisplayValue('0')
      fireEvent.change(input, { target: { value: '0.5' } })
      fireEvent.blur(input)

      fireEvent.click(screen.getByRole('button', { name: 'Review & write' }))
      expect(screen.getByText('Write 1 parameter(s)?')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
      expect(screen.getByText('Editor matches the board — edit any value to queue a change.')).toBeInTheDocument()
    })

    it('a successful write shows "Written and verified" before the row clears from the drawer', async () => {
      const { transport, paramStore } = await renderLoaded([{ name: 'THR_MIN', value: 0 }])
      const input = screen.getByDisplayValue('0')
      fireEvent.change(input, { target: { value: '0.5' } })
      fireEvent.blur(input)
      fireEvent.click(screen.getByRole('button', { name: 'Review & write' }))
      fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
      await tick()

      transport.feed(paramValueFrame({ name: 'THR_MIN', value: 0.5, count: 1, index: 0 }))
      await tick()

      expect(within(screen.getByRole('dialog')).getByText('Written and verified')).toBeInTheDocument()
      expect(screen.getByText('1 unsaved — the board still has the old values')).toBeInTheDocument() // still pending until the display window elapses

      await tick(2000) // the transient 'ok' display window elapses

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument() // nothing left to review — the drawer auto-closes
      expect(screen.getByText('Editor matches the board — edit any value to queue a change.')).toBeInTheDocument()
      expect(paramStore.get('THR_MIN')?.value).toBeCloseTo(0.5, 5)
    })

    it('does not silently drop a fresh re-stage that lands during a prior success\'s "ok" display window', async () => {
      const { transport } = await renderLoaded([{ name: 'THR_MIN', value: 0 }])
      const input = screen.getByDisplayValue('0')
      fireEvent.change(input, { target: { value: '0.5' } })
      fireEvent.blur(input)
      fireEvent.click(screen.getByRole('button', { name: 'Review & write' }))
      fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
      await tick()
      transport.feed(paramValueFrame({ name: 'THR_MIN', value: 0.5, count: 1, index: 0 }))
      await tick() // THR_MIN now shows the transient 'ok' status, with a pending clear scheduled 2s out

      // The user edits it again before that 2s clear fires.
      const reeditedInput = screen.getByDisplayValue('0.5')
      fireEvent.change(reeditedInput, { target: { value: '0.75' } })
      fireEvent.blur(reeditedInput)
      expect(screen.getByText('1 unsaved — the board still has the old values')).toBeInTheDocument()

      await tick(2000) // the earlier write's scheduled clear fires now

      // The fresh 0.75 edit must survive — the stale scheduled clear must not
      // have wiped it out just because it shares the same param name.
      expect(screen.getByText('1 unsaved — the board still has the old values')).toBeInTheDocument()
      expect(screen.getByDisplayValue('0.75')).toBeInTheDocument()
    })

    it('write flow with mixed results: ok clears the row, mismatch/timeout stay marked red in the drawer', async () => {
      const { transport } = await renderLoaded([
        { name: 'OK_PARAM', value: 0 },
        { name: 'MISMATCH_PARAM', value: 500 },
        { name: 'TIMEOUT_PARAM', value: 0 },
      ])

      function stage(paramName: string, newValue: string): void {
        const input = screen.getByLabelText(paramName) // ParamRow's input carries aria-label={param.name} — unique per row, unlike display value
        fireEvent.change(input, { target: { value: newValue } })
        fireEvent.blur(input)
      }
      stage('OK_PARAM', '1')
      stage('MISMATCH_PARAM', '2000')
      stage('TIMEOUT_PARAM', '5')

      fireEvent.click(screen.getByRole('button', { name: 'Review & write' }))
      expect(screen.getByText('Write 3 parameter(s)?')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
      await tick() // OK_PARAM's PARAM_SET goes out

      const okSet = decodeSent(transport.sent.find((b) => decodeSent(b).msgid === PARAM_SET_MSGID && decodeSent(b).fields.param_id === 'OK_PARAM')!)
      expect(okSet.fields.param_value).toBeCloseTo(1, 5)
      transport.feed(paramValueFrame({ name: 'OK_PARAM', value: 1, count: 3, index: 0 }))
      await tick() // OK_PARAM's echo lands -> shows a transient 'ok' status (not cleared yet); MISMATCH_PARAM's PARAM_SET goes out

      // Per-row status is writing/ok/mismatch/timeout/busy — a success shows
      // "Written and verified" for a moment rather than vanishing instantly.
      expect(within(screen.getByRole('dialog')).getByText('OK_PARAM')).toBeInTheDocument()
      expect(within(screen.getByRole('dialog')).getByText('Written and verified')).toBeInTheDocument()

      transport.feed(paramValueFrame({ name: 'MISMATCH_PARAM', value: 999, count: 3, index: 1 })) // FC clamped
      await tick() // mismatch resolves -> TIMEOUT_PARAM's PARAM_SET goes out

      await tick(1500) // default setTimeoutMs elapses with no echo for TIMEOUT_PARAM
      await tick(2000) // OK_PARAM's transient 'ok' display window elapses -> it clears

      // OK_PARAM cleared entirely from the drawer (successes clear, after their
      // brief 'ok' display) — only the two failures remain listed there;
      // OK_PARAM's *table* row is untouched (it still exists, just no longer
      // highlighted as pending).
      const dialog = screen.getByRole('dialog')
      expect(within(dialog).queryByText('OK_PARAM')).not.toBeInTheDocument()
      expect(within(dialog).getByText('MISMATCH_PARAM')).toBeInTheDocument()
      expect(within(dialog).getByText('TIMEOUT_PARAM')).toBeInTheDocument()
      // Both failures stay listed, red, with distinguishing messages — never auto-retried.
      expect(screen.getByText('Board reports 999 (requested 2000)')).toBeInTheDocument()
      expect(screen.getByText('No confirmation from the board (timed out)')).toBeInTheDocument()
      expect(screen.getByText('2 unsaved — the board still has the old values')).toBeInTheDocument()
      // Only the two failed writes were ever sent as PARAM_SET (no retry of the timed-out one).
      expect(transport.sent.filter((b) => decodeSent(b).msgid === PARAM_SET_MSGID)).toHaveLength(3)
    })

    it('a disconnect mid-write-batch stops the loop instead of spamming a disposed ParamStore', async () => {
      const { transport, paramStore } = await renderLoaded([
        { name: 'FIRST_PARAM', value: 0 },
        { name: 'SECOND_PARAM', value: 0 },
      ])

      function stage(paramName: string, newValue: string): void {
        const input = screen.getByLabelText(paramName)
        fireEvent.change(input, { target: { value: newValue } })
        fireEvent.blur(input)
      }
      stage('FIRST_PARAM', '1')
      stage('SECOND_PARAM', '2')

      fireEvent.click(screen.getByRole('button', { name: 'Review & write' }))
      fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
      await tick() // FIRST_PARAM's PARAM_SET goes out; its set() is now awaiting an echo that will never come

      // The link drops while that first write is still in flight: teardown
      // disposes this exact ParamStore and disconnects the store.
      await act(async () => {
        paramStore.dispose()
        useConnectionStore.setState({ phase: 'disconnected', paramStore: null })
      })
      await tick()

      // Only FIRST_PARAM's write was ever ever sent — the loop stopped
      // instead of moving on to SECOND_PARAM against a disposed store.
      expect(transport.sent.filter((b) => decodeSent(b).msgid === PARAM_SET_MSGID)).toHaveLength(1)
      // Back at the not-connected view (phase !== 'connected'), with both
      // edits reported discarded — no orphaned drawer state left behind.
      expect(screen.getByText(/2 unsaved edit\(s\) were discarded/)).toBeInTheDocument()
    })
  })

  describe('unsaved-changes guard and disconnect', () => {
    it('registers a navigation guard while edits are pending, and clears it once they are gone', async () => {
      const { transport, paramStore } = await makeConnectedParamStore()
      await feedAll(transport, [{ name: 'THR_MIN', value: 0 }])
      useConnectionStore.setState({ phase: 'connected', paramStore })
      render(<ParamsPage />)
      expandAllGroups()

      expect(useNavigationStore.getState().guardNavigation).toBeNull()

      const input = screen.getByDisplayValue('0')
      fireEvent.change(input, { target: { value: '1' } })
      fireEvent.blur(input)

      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      expect(useNavigationStore.getState().guardNavigation).not.toBeNull()
      const allowed = useNavigationStore.getState().guardNavigation!('firmware')
      expect(confirmSpy).toHaveBeenCalled()
      expect(allowed).toBe(false)

      fireEvent.click(screen.getByRole('button', { name: 'Revert all' }))
      expect(useNavigationStore.getState().guardNavigation).toBeNull()
    })

    it('disconnecting with pending edits clears them and shows a discard warning', async () => {
      const { transport, paramStore } = await makeConnectedParamStore()
      await feedAll(transport, [{ name: 'THR_MIN', value: 0 }])
      useConnectionStore.setState({ phase: 'connected', paramStore })
      render(<ParamsPage />)
      expandAllGroups()

      const input = screen.getByDisplayValue('0')
      fireEvent.change(input, { target: { value: '1' } })
      fireEvent.blur(input)
      expect(screen.getByText('1 unsaved — the board still has the old values')).toBeInTheDocument()

      await act(async () => {
        useConnectionStore.setState({ phase: 'disconnected', paramStore: null })
      })

      expect(screen.getByText(/1 unsaved edit\(s\) were discarded/)).toBeInTheDocument()
      expect(useNavigationStore.getState().guardNavigation).toBeNull()
    })
  })
})
