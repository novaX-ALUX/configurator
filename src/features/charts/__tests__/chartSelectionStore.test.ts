import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store hydrates from localStorage once, at module evaluation — so every
// test re-imports a fresh module against its own pre-seeded storage.
async function freshStore() {
  vi.resetModules()
  return (await import('../chartSelectionStore')).useChartSelectionStore
}

const KEY = 'novax.charts.selectedSeries'

beforeEach(() => {
  localStorage.clear()
})

describe('chartSelectionStore', () => {
  it('fresh profile: defaults to the three attitude Series', async () => {
    const store = await freshStore()
    expect(store.getState().selectedIds).toEqual(['attitude.roll', 'attitude.pitch', 'attitude.yaw'])
  })

  it('toggle adds/removes a Series and persists each change', async () => {
    const store = await freshStore()
    store.getState().toggleSeries('power.voltage')
    expect(store.getState().selectedIds).toContain('power.voltage')
    expect(JSON.parse(localStorage.getItem(KEY)!)).toContain('power.voltage')

    store.getState().toggleSeries('attitude.yaw')
    expect(store.getState().selectedIds).not.toContain('attitude.yaw')
    expect(JSON.parse(localStorage.getItem(KEY)!)).not.toContain('attitude.yaw')
  })

  it('restores a stored selection across a reload (fresh module)', async () => {
    localStorage.setItem(KEY, JSON.stringify(['power.current', 'rc.ch3']))
    const store = await freshStore()
    expect(store.getState().selectedIds).toEqual(['power.current', 'rc.ch3'])
  })

  it('drops stored ids the catalog does not know (e.g. from an older build)', async () => {
    localStorage.setItem(KEY, JSON.stringify(['attitude.roll', 'gps.fixType', 42]))
    const store = await freshStore()
    expect(store.getState().selectedIds).toEqual(['attitude.roll'])
  })

  it('corrupt storage falls back to the default selection', async () => {
    localStorage.setItem(KEY, '{not json')
    const store = await freshStore()
    expect(store.getState().selectedIds).toEqual(['attitude.roll', 'attitude.pitch', 'attitude.yaw'])
  })

  it('an explicitly emptied selection stays empty — it is a choice, not a fresh profile', async () => {
    localStorage.setItem(KEY, JSON.stringify([]))
    const store = await freshStore()
    expect(store.getState().selectedIds).toEqual([])
  })
})
