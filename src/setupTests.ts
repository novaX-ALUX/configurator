import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// vite.config.ts doesn't set `test.globals: true`, so @testing-library/react's
// own automatic per-test cleanup (which detects a *global* `afterEach`) never
// registers — without this, multiple render() calls in the same test file
// pile up in the jsdom document instead of unmounting between tests.
afterEach(() => {
  cleanup()
})

// uPlot calls `matchMedia` at module load (devicePixelRatio tracking), and
// jsdom doesn't implement it — so any test whose import graph reaches
// ChartHost (e.g. App.test.tsx) needs this stub even though the chart host
// itself is stubbed in component tests (jsdom has no canvas; see issue #3's
// testing decisions). The `typeof` guard keeps this setup file loadable in
// node-environment tests (sitl.integration.test.ts), which have no `window`.
if (typeof window !== 'undefined' && window.matchMedia === undefined) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}
