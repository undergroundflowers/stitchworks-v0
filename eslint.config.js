import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // eslint-plugin-react-hooks v7 adds several new, opinionated rules that
      // flag long-standing patterns across the existing UI (Tweaks panel,
      // canvas sprites, etc.). They're downgraded to warnings so they stay
      // visible for incremental cleanup without blocking the build or CI.
      // `rules-of-hooks` (genuine hook-order bugs) intentionally stays `error`.
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      // `only-export-components` is an HMR/Fast-Refresh DX rule (not a
      // correctness one) that fires on legitimate provider+hook files;
      // `no-useless-assignment` has false positives on intentional inits
      // (e.g. an event-loop end value defaulted before the loop runs). Warn.
      'react-refresh/only-export-components': 'warn',
      'no-useless-assignment': 'warn',
    },
  },
])
