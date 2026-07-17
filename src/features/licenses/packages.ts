/**
 * The third-party packages disclosed on the licenses page (issue #39, M1
 * Decision 3 LOCKED(a)). Kept out of LicensesPage.tsx so the component file
 * only exports components (react-refresh/only-export-components).
 */

/** Exact pin from package.json — LicensesPage.test.tsx asserts the two stay equal. */
export const MAVLINK_MAPPINGS_VERSION = '1.0.20-20240131-0'

/** Bundled runtime dependencies besides mavlink-mappings; all MIT-licensed. LicensesPage.test.tsx asserts this covers package.json's dependencies. */
export const MIT_PACKAGES = [
  { name: 'react', url: 'https://github.com/facebook/react' },
  { name: 'react-dom', url: 'https://github.com/facebook/react' },
  { name: 'i18next', url: 'https://github.com/i18next/i18next' },
  { name: 'react-i18next', url: 'https://github.com/i18next/react-i18next' },
  { name: 'uplot', url: 'https://github.com/leeoniya/uPlot' },
  { name: 'zustand', url: 'https://github.com/pmndrs/zustand' },
]
