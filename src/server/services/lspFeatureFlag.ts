/**
 * Local feature-flag check for the editor-lsp-foundation work (Phase 3).
 *
 * The upstream `feature('FLAG')` import from `bun:bundle` is a build-time
 * constant gate baked into the vendored Anthropic CLI bundle — fork code
 * cannot register new flag names in that table without changing the
 * bundler config. So Phase 3 ships its own opt-in switch instead:
 *
 *   - dev (NODE_ENV !== 'production'): on by default
 *   - prod: opt-in via `CLAUDE_CODE_LSP` env var (truthy enables)
 *
 * Wrap any LSP-only code path in `if (isLspFeatureEnabled()) { ... }`.
 * The check is a pure function so unit tests can stub `process.env`
 * directly without mocking modules.
 *
 * _Requirements: 15.3 (Phase 3 task 18, adapted from spec — see PR
 * description for the bun:bundle vs local-flag rationale)._
 */

const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on'])

export function isLspFeatureEnabled(): boolean {
  const explicit = process.env.CLAUDE_CODE_LSP
  if (typeof explicit === 'string') {
    return TRUTHY_ENV_VALUES.has(explicit.trim().toLowerCase())
  }
  return process.env.NODE_ENV !== 'production'
}
