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
