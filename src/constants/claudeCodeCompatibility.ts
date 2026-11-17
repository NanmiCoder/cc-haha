/**
 * Claude Code billing compatibility values based on sub2api.
 * Reference: https://github.com/Wei-Shaw/sub2api
 * License: LGPL-3.0-or-later, Copyright (c) 2026 Wesley Liddick.
 */
// Keep in sync with the Claude Code version accepted by upstream billing validation.
export const CLAUDE_CODE_COMPAT_VERSION = '2.1.321'
export const CLAUDE_CODE_BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:'

/**
 * Entrypoint reported to Anthropic (User-Agent and `cc_entrypoint`).
 *
 * This app is built on the Claude Code CLI, and upstream requests are meant to
 * be indistinguishable from that CLI's own. `CLAUDE_CODE_ENTRYPOINT` is
 * deliberately not used here: the desktop host sets it to `claude-desktop` as an
 * internal switch (managed OAuth context, env snapshot, trace capture), and that
 * value names Anthropic's own desktop app, which this is not.
 */
export const CLAUDE_CODE_WIRE_ENTRYPOINT = 'cli'

export function formatClaudeCodeBillingHeader(options: {
  fingerprint: string
  entrypoint?: string
  workload?: string | null
}): string {
  const entrypoint = options.entrypoint ?? CLAUDE_CODE_WIRE_ENTRYPOINT
  const workloadPair = options.workload ? ` cc_workload=${options.workload};` : ''
  return `${CLAUDE_CODE_BILLING_HEADER_PREFIX} cc_version=${CLAUDE_CODE_COMPAT_VERSION}.${options.fingerprint}; cc_entrypoint=${entrypoint}; cch=00000;${workloadPair}`
}
