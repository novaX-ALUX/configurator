import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

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
  {
    // mavlink-mappings is LGPL-licensed and metadata-only; docs/notes/decisions-m1.md
    // decisions 2/8 confine importing it to this one adapter file so the
    // dependency (and its license exposure) stays swappable behind `GeneratedDefs`.
    files: ['**/*.{ts,tsx}'],
    ignores: ['src/core/mavlink/defs.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['mavlink-mappings', 'mavlink-mappings/*'],
          message: 'mavlink-mappings may only be imported from src/core/mavlink/defs.ts (docs/notes/decisions-m1.md decisions 2 and 8).',
        }],
      }],
    },
  },
)
