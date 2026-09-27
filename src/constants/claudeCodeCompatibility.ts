/**
 * Claude Code billing compatibility values based on sub2api.
 * Reference: https://github.com/Wei-Shaw/sub2api
 * License: LGPL-3.0-or-later, Copyright (c) 2026 Wesley Liddick.
 */
// Keep in sync with the Claude Code version accepted by upstream billing validation.
export const CLAUDE_CODE_COMPAT_VERSION = '2.1.281'
export const CLAUDE_CODE_BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:'

export function formatClaudeCodeBillingHeader(options: {
  fingerprint: string
  entrypoint?: string
  workload?: string | null
}): string {
  const entrypoint = options.entrypoint ?? 'unknown'
  const workloadPair = options.workload ? ` cc_workload=${options.workload};` : ''
  return `${CLAUDE_CODE_BILLING_HEADER_PREFIX} cc_version=${CLAUDE_CODE_COMPAT_VERSION}.${options.fingerprint}; cc_entrypoint=${entrypoint}; cch=00000;${workloadPair}`
}
