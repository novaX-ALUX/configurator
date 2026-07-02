import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The repo is published to GitHub Pages under this path. Change this constant
// if the Pages project (or its base path) ever moves.
const GITHUB_PAGES_BASE = '/configurator/'

export default defineConfig({
  base: GITHUB_PAGES_BASE,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
  },
})
