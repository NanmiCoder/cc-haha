import parser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Deliberately one rule.
 *
 * `bun run lint` was `tsc --noEmit` alone, which types the code but knows nothing
 * about React's rules. That gap let a real crash sit in `AskUserQuestion.tsx`: an
 * early return above two `useMemo` calls, so any instance whose question count
 * crossed zero threw "Rendered fewer/more hooks than expected" and took the message
 * list down with it. tsc cannot see that; this rule finds it in seconds.
 *
 * `rules-of-hooks` is the one React rule with no judgement in it — a conditional hook
 * is always a bug, never a style preference, so it can be an error without ever
 * needing a suppression. `exhaustive-deps` is left off on purpose: it currently has 27
 * hits here, most of them intentional, and a permanently-yellow lint is a lint nobody
 * reads. Turn it on only alongside the work to get it to zero.
 */
export default [
  { ignores: ['dist/**', 'electron-dist/**', 'build-artifacts/**', 'sidecars/**', 'src-tauri/**'] },
  {
    // The 13 `eslint-disable` comments in the tree name rules this config does not
    // enable, so ESLint 9 would flag every one of them as unused. They are not wrong,
    // they are dormant: each marks a dependency array that is deliberately incomplete.
    // Reporting them would either add 13 permanent warnings or push someone to delete
    // the only record of that intent, so leave them alone until the rule they name is
    // actually turned on.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
]
