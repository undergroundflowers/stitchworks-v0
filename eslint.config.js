import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `.claude/worktrees` holds throwaway git worktrees created when a background
  // task is spun off into its own copy of the repo. They contain a full second
  // (and third) checkout, which makes typescript-eslint see several candidate
  // tsconfig roots and fail to parse ANY file — so lint has to skip them.
  globalIgnores(['dist', '.claude/worktrees']),
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
  {
    // Colour literals belong in src/design/tokens.ts (or derive with
    // alpha()/darken()). Warn-only: ~350 legacy literals remain, and the
    // grep ratchet in scripts/check-color-literals.sh enforces the ceiling.
    files: ['src/pages/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}', 'src/shell/**/*.{ts,tsx}', 'src/App.tsx'],
    ignores: ['src/components/ProcessCodeView.tsx'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message: 'Use SW_COLORS / alpha() from src/design instead of hex literals.',
        },
      ],
    },
  },
])
