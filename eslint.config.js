import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

const restrictedMavlinkMappings = {
  group: ['mavlink-mappings', 'mavlink-mappings/*'],
  message: 'mavlink-mappings may only be imported from src/core/mavlink/defs.ts (docs/notes/decisions-m1.md decisions 2 and 8).',
}

const restrictedUplot = {
  group: ['uplot', 'uplot/*'],
  message: 'uplot may only be imported from src/features/charts/ChartHost.tsx (docs/adr/0001-uplot-for-telemetry-charts.md).',
}

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  // Dependency-confinement rules. Flat config resolves a rule by "last
  // matching config wins", so the two confinements can't live in separate
  // whole-tree configs (the later would erase the earlier); instead one
  // whole-tree config carries both patterns, and each adapter file gets its
  // own config re-declaring only the OTHER confinement.
  //
  // - mavlink-mappings is LGPL-licensed and metadata-only; docs/notes/decisions-m1.md
  //   decisions 2/8 confine importing it to src/core/mavlink/defs.ts so the
  //   dependency (and its license exposure) stays swappable behind `GeneratedDefs`.
  // - uplot is confined to the chart-host component so the chart renderer
  //   stays swappable (docs/adr/0001-uplot-for-telemetry-charts.md).
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['src/core/mavlink/defs.ts', 'src/features/charts/ChartHost.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [restrictedMavlinkMappings, restrictedUplot],
      }],
    },
  },
  {
    files: ['src/core/mavlink/defs.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [restrictedUplot] }],
    },
  },
  {
    files: ['src/features/charts/ChartHost.tsx'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [restrictedMavlinkMappings] }],
    },
  },
)
